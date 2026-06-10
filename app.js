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
  if (meta.model) l1.push(`model <b>${esc(meta.model)}</b>`);
  // line 2: backend + metrics (kept separate so line 1 doesn't get too long)
  const l2 = [];
  if (meta.backend) l2.push(esc(meta.backend));
  if (meta.ttfb) l2.push(`ttfb ${fmtDuration(meta.ttfb)}`);
  if (meta.ttft) l2.push(`ttft ${fmtDuration(meta.ttft)}`);
  if (meta.tokens) l2.push(`${esc(meta.tokens)} tok`);
  let html = l1.join(sep);
  if (l2.length) html += (l1.length ? "<br>" : "") + l2.join(sep);
  $("meta").innerHTML = html;
}

function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function classifyBackend(id) {
  const m = (id || "").toLowerCase();
  if (/(^|[^a-z])(gpt|o1|o3|o4|davinci|whisper|dall)/.test(m) || m.includes("openai")) return "openai provider api";
  if (m.includes("claude") || m.includes("anthropic")) return "anthropic provider api";
  return "ray + vllm";
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

    // headers received → the request is past the API and into the backend.
    // ttfb tells us how long the API/routing phase took; any further wait is the model.
    meta.ttfb = Math.round(performance.now() - reqT0);
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
