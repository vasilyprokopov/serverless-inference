"use strict";

/* request path, left to right. kafka is an async branch off the api stage. */
const STAGES = ["prompt", "cloudflare", "lb", "traefik", "api/router", "executor", "backend", "stream"];
const EDGE = ["prompt", "cloudflare", "lb", "traefik"]; // illustrative pre-roll
const DEFAULT_BASE = "https://inference.do-ai.run/v1";
const REQUEST_TIMEOUT_MS = 90000; // abort if the API never sends a first byte

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const stageEls = {};
let running = false;

/* the key is shown as a fixed 5-dot mask so its real length is never visible;
   the actual value lives in realKey and is revealed only while the field is focused. */
let realKey = "";
const MASK = "•••••••••";
function maskKey() {
  const el = $("key");
  if (realKey) { el.type = "text"; el.value = MASK; }
  else { el.type = "password"; el.value = ""; }
}

/* ───────────────────────── build ───────────────────────── */
function build() {
  const pipe = $("pipeline");
  STAGES.forEach((id) => {
    const d = document.createElement("div");
    d.className = "stage";
    d.textContent = id;
    stageEls[id] = d;
    pipe.appendChild(d);
  });

  const branch = $("branch");
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "↳ async";
  branch.appendChild(label);
  const k = document.createElement("div");
  k.className = "stage";
  k.textContent = "kafka";
  stageEls.kafka = k;
  branch.appendChild(k);
}

/* ───────────────────────── stage state ───────────────────────── */
function clearStages() {
  Object.values(stageEls).forEach((e) => (e.className = "stage"));
}
function advanceTo(id, cls = "active") {
  const t = STAGES.indexOf(id);
  STAGES.forEach((sid, i) => {
    if (i < t) stageEls[sid].className = "stage reached";
  });
  stageEls[id].className = "stage " + cls;
}
function reached(id) { stageEls[id].className = "stage reached"; }

/* ───────────────────────── meta line ───────────────────────── */
const meta = {};
function renderMeta() {
  const sep = '<span class="sep"> · </span>';
  // line 1: routing identity
  const l1 = [];
  if (meta.target) l1.push(`router <b>${esc(meta.target)}</b>`);
  if (meta.task) l1.push(`task ${esc(meta.task)}`);
  if (meta.model) l1.push(`model <b>${esc(meta.model)}</b>${infoBadge(meta.info)}`);
  // line 2: backend + metrics (kept separate so line 1 doesn't get too long)
  const l2 = [];
  if (meta.backend) l2.push(esc(meta.backend));
  if (meta.ttft) l2.push(`ttft ${fmtDuration(meta.ttft)}`);
  if (meta.price) l2.push(`$${esc(meta.price.in)}/$${esc(meta.price.out)} per Mtok`);
  else if (meta.priceNote) l2.push(esc(meta.priceNote));
  if (meta.tokens) l2.push(`${esc(meta.tokens)} tok`);
  let html = l1.join(sep);
  if (l2.length) html += (l1.length ? "<br>" : "") + l2.join(sep);
  $("meta").innerHTML = html;
}

const fmtCtx = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n));

// info glyph + hover tooltip with catalog details for the resolved model
function infoBadge(info) {
  if (!info) return "";
  const bits = [];
  if (info.creator) bits.push(esc(info.creator));
  const ctxN = Number(info.ctx);
  if (Number.isFinite(ctxN) && ctxN > 0) bits.push(fmtCtx(ctxN) + " ctx");
  if (info.created) {
    const d = new Date(info.created);
    if (!isNaN(d)) bits.push("since " + d.toLocaleDateString("en-US", { month: "short", year: "numeric" }));
  }
  const title = info.name ? `<span class="tip-title">${esc(info.name)}</span>` : "";
  const desc = info.desc ? `<span class="tip-desc">${esc(info.desc)}</span>` : "";
  const row = bits.length ? `<span class="tip-row">${bits.join(" · ")}</span>` : "";
  if (!title && !desc && !row) return "";
  return `<span class="info" tabindex="0">` +
    `<svg class="info-ico" viewBox="0 0 32 32" width="13" height="13" aria-hidden="true">` +
      `<circle cx="16.5" cy="15.5" r="11.5" fill="#6355F8"></circle>` +
      `<rect x="15" y="14" width="3" height="8" rx=".8" fill="#fff"></rect>` +
      `<rect x="15" y="9" width="3" height="3" rx="1.5" fill="#fff"></rect>` +
    `</svg>` +
    `<span class="tip">${title}${desc}${row}</span>` +
  `</span>`;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/* ───────────────────────── pricing (from the public DO model catalog) ───────────────────────── */
const CATALOG_URL = "https://api.digitalocean.com/v2/gen-ai/models/catalog";
let pricing = [];
const normName = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// company prefixes that appear in the catalog name but usually NOT in the returned model id
const PROVIDERS = ["openai", "anthropic", "nvidia", "arcee", "google", "alibaba"];
function coreName(desc) {
  let n = (desc || "").trim().toLowerCase();
  for (const pv of PROVIDERS) { if (n.startsWith(pv + " ")) { n = n.slice(pv.length); break; } }
  return normName(n);
}

// catalog prices are per-token (e.g. 0.0000025); ×1e6 → $/Mtok, rounded and trimmed to a clean string
function toMtok(perToken) {
  if (perToken == null) return null;
  const n = perToken * 1e6;
  if (!Number.isFinite(n)) return null;
  return String(Math.round(n * 1e4) / 1e4);
}

// fetched once on first load; UI is unchanged — priceFor() reads from this list either way
async function loadPricing() {
  try {
    const r = await fetch(CATALOG_URL, { headers: { Accept: "application/json" } });
    if (!r.ok) return;
    const json = await r.json();
    pricing = (Array.isArray(json.data) ? json.data : []).map((m) => {
      const p = m.pricing || {};
      const inp = toMtok(p.input_price_per_million), out = toMtok(p.output_price_per_million);
      if (inp == null || out == null) return null;
      return {
        id: normName(m.model_id), core: coreName(m.name || ""), in: inp, out: out,
        name: m.name || m.model_id, desc: m.short_description || "",
        creator: m.creator || "", ctx: m.context_window || "", created: m.created_at || "",
      };
    }).filter((x) => x && x.id);
  } catch (_) {}
}

// pick the catalog entry whose key best matches the returned model id: contained either way,
// forward (id contains key) preferred, then the most specific key. returns the entry or null.
function bestMatch(id, key) {
  let best = null, bestEntry = null;
  for (const p of pricing) {
    const k = p[key];
    if (!k) continue;
    let cand = null;
    if (id.includes(k)) cand = { score: k.length, forward: 1, len: k.length };
    else if (k.includes(id)) cand = { score: id.length, forward: 0, len: k.length };
    if (!cand) continue;
    let better;
    if (!best) better = true;
    else if (cand.score !== best.score) better = cand.score > best.score;
    else if (cand.forward !== best.forward) better = cand.forward > best.forward;
    // same score & direction: forward → prefer the longer (more specific) key;
    // reverse (key contains id) → prefer the shorter key (closest to the id).
    else better = cand.forward === 1 ? cand.len > best.len : cand.len < best.len;
    if (better) { best = cand; bestEntry = p; }
  }
  return bestEntry;
}

// match the returned model id to a catalog entry: exact slug first, then slug containment
// (handles date/version suffixes), then a display-name fallback. null if nothing confident.
function matchModel(modelId) {
  const id = normName(modelId);
  if (id.length < 2) return null;
  for (const p of pricing) { if (p.id === id) return p; }
  return bestMatch(id, "id") || bestMatch(id, "core");
}

function priceFor(modelId) {
  const m = matchModel(modelId);
  return m ? { in: m.in, out: m.out } : null;
}

function classifyBackend(id) {
  const m = (id || "").toLowerCase();
  if (/(^|[^a-z])(gpt|o1|o3|o4|davinci|whisper|dall)/.test(m) || m.includes("openai")) return "proxied to openai provider api";
  if (m.includes("claude") || m.includes("anthropic")) return "proxied to anthropic provider api";
  return "ray + vllm hosted on DigitalOcean";
}

/* ───────────────────────── persistence ───────────────────────── */
const LS = "do-si-min";
function load() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS) || "{}"); } catch (_) {}
  if (s.key) { realKey = s.key; maskKey(); }
  if (s.model) $("model").value = s.model;
  $("base").value = s.base || DEFAULT_BASE;
}
function save() {
  try { localStorage.setItem(LS, JSON.stringify({ key: realKey, model: $("model").value, base: $("base").value })); } catch (_) {}
}

/* ───────────────────────── send ───────────────────────── */
async function send() {
  if (running) return;
  const key = realKey.trim();
  const model = $("model").value.trim();
  const prompt = $("prompt").value.trim();
  const base = ($("base").value.trim() || DEFAULT_BASE).replace(/\/+$/, "");
  if (!prompt) return;
  if (!key)   return fail("api/router", "no model access key");
  if (!model) return fail("api/router", "no model — type router:<name> or a model id");

  save();
  running = true;
  clearStages();
  const isRouter = model.toLowerCase().startsWith("router:");

  for (const k in meta) delete meta[k];
  if (isRouter) meta.target = model.replace(/^router:/i, ""); // show router name without the prefix
  renderMeta();
  setReply("…", true);

  const preroll = (async () => {
    for (const id of EDGE) { advanceTo(id); await sleep(240); }
  })();

  // dispatch the request in parallel with the edge animation, bounded by an
  // abort timeout so a hung / cold-starting backend surfaces instead of spinning.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const reqT0 = performance.now(); // request dispatch — ttft is measured from here
  const fetchP = fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true, stream_options: { include_usage: true } }),
    signal: ctrl.signal,
  });

  try {
    await preroll;
    // the request has cleared the edge; we are now waiting on the API to respond.
    // park here with a live counter so a long wait reads as "waiting", not "stuck".
    // phase 1 — waiting for response headers (the API accepting + routing the request).
    advanceTo("api/router");
    const tick = setInterval(() => setReply(`api/router · routing, waiting for response… ${fmtDuration(performance.now() - reqT0)}`, true), 250);

    let resp;
    try { resp = await fetchP; }
    finally { clearTimeout(timer); clearInterval(tick); }

    // headers received → the request is past the API and into the backend;
    // any further wait now is the model generating.
    if (isRouter) {
      const route = resp.headers.get("x-model-router-selected-route");
      meta.task = route || "(not exposed)";
    }
    renderMeta();

    if (!resp.ok) throw new HttpError(resp.status, await errText(resp));
    if (!resp.body) throw new Error("no readable stream in this browser");

    reached("api/router");
    advanceTo("executor"); reached("executor");
    advanceTo("backend");

    await consume(resp.body, reqT0);
    reached("stream");
  } catch (e) {
    onError(e);
  } finally {
    running = false;
  }
}

class HttpError extends Error { constructor(s, d) { super(d || `http ${s}`); this.status = s; } }
async function errText(r) {
  try { const t = await r.text(); try { const j = JSON.parse(t); return j.error?.message || j.message || t; } catch (_) { return t; } }
  catch (_) { return ""; }
}

/* ───────────────────────── sse ───────────────────────── */
async function consume(stream, t0) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "", first = true, shown = false;

  // phase 2 — headers are in, we're at the backend waiting for the model to emit
  // the first token. this counter makes a slow model read as "generating", not "stuck".
  let genTick = setInterval(() => setReply(`backend · model generating — first token in ${fmtDuration(performance.now() - t0)}`, true), 250);
  const stopGen = () => { clearInterval(genTick); genTick = null; };

  const reveal = (id) => {
    if (shown || !id) return;
    shown = true;
    reached("executor");
    advanceTo("backend");
    meta.model = id;
    meta.backend = classifyBackend(id);
    const m = matchModel(id);
    if (m) { meta.price = { in: m.in, out: m.out }; meta.info = m; }
    else meta.priceNote = pricing.length ? `no price for "${id}"` : "price catalog not loaded";
    renderMeta();
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch (_) { continue; }

        if (j.model) reveal(j.model);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          if (first) {
            first = false;
            stopGen();
            reached("backend");
            advanceTo("stream", "streaming");
            meta.ttft = Math.round(performance.now() - t0);
            renderMeta();
            acc = "";
          }
          acc += delta;
          setReply(acc, false);
        }
        if (j.usage) {
          const u = j.usage;
          meta.tokens = `${u.prompt_tokens ?? "?"}/${u.completion_tokens ?? "?"}`;
          renderMeta();
          advanceTo("kafka", "reached");
        }
      }
    }
  } finally {
    stopGen();
  }
  if (first) setReply(acc || "(no content)", !acc);
}

/* ───────────────────────── reply / errors ───────────────────────── */
function setReply(text, dim) {
  const r = $("reply");
  r.classList.toggle("dim", !!dim);
  r.textContent = text;
  if (!dim && running) r.insertAdjacentHTML("beforeend", '<span class="cursor"></span>');
}

function fail(stage, msg) {
  running = false;
  clearStages();
  stageEls[stage].className = "stage failed";
  setReply(msg, true);
}

function onError(e) {
  let stage = "api/router", msg = e.message || String(e);
  if (e && e.name === "AbortError") {
    msg = `no response in ${fmtDuration(REQUEST_TIMEOUT_MS)} — the model is likely cold-starting or the request is queued; try again`;
  } else if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) msg = "auth rejected — check the model access key";
    else if (e.status === 404) { stage = "backend"; msg = "not found — check model/router name and base url"; }
    else if (e.status === 429) msg = "rate limited — slow down and retry";
    else if (e.status >= 500) { stage = "backend"; msg = `backend error (${e.status}) — ${e.message}`; }
  } else if (e instanceof TypeError) {
    stage = "cloudflare";
    msg = "request blocked before any response — likely CORS (the API returned no Access-Control headers). a static page can't bypass it; put a small proxy in front (see README)";
  }
  clearStages();
  stageEls[stage].className = "stage failed";
  setReply(msg, true);
}

/* ───────────────────────── init ───────────────────────── */
function init() {
  build();
  load();
  loadPricing();
  setReply("", true);
  ["model", "base"].forEach((id) => $(id).addEventListener("change", save));

  const keyEl = $("key");
  keyEl.addEventListener("focus", () => { keyEl.type = "text"; keyEl.value = realKey; });
  keyEl.addEventListener("input", () => { realKey = keyEl.value; });
  keyEl.addEventListener("blur", () => { save(); maskKey(); });

  $("prompt").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); send(); }
  });
}
document.addEventListener("DOMContentLoaded", init);
