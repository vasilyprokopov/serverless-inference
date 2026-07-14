"use strict";

/* Capacity Fit — turn a GPU benchmark row + a customer's TPM into
   "GPUs / 8-GPU nodes needed" plus a cost / revenue / margin readout.
   Data comes from tokenomics.csv (internal, git-ignored). To move the
   data to DigitalOcean Spaces later, change DATA_URL to the Spaces URL
   (and make sure that bucket serves permissive CORS headers). */
const DATA_URL = "tokenomics.csv";

const GPUS_PER_NODE = 8;
const MIN_PER_MONTH = 43200; // 30-day month, matches the sheet's monthly columns
const HRS_PER_MONTH = 720;   // 30 × 24, for GPU droplet cost

/* column indices in the cleaned tokenomics.csv. Only Input/Output toks/sec/gpu are
   *measured*; everything downstream is derived on the page. Token pricing is NOT in
   the table — it's a per-customer target entered on the page. The GPU droplet price
   is a per-GPU-type hardware cost, so it stays. */
const C = {
  model: 0, gpu: 1, precision: 2, workload: 3, config: 4, concurrency: 5,
  cache: 6, cacheHit: 7, inTps: 8, outTps: 9, dropletOnDemand: 10, dropletContract: 11,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* ───────────────────────── CSV parsing ─────────────────────────
   A real (RFC-4180-ish) parser: fields may be quoted, quoted fields may
   contain commas ("4,012.50") and newlines (the multi-line header), and
   "" is an escaped quote. Returns records (arrays of string cells). */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  // trailing field / row (file may not end in a newline)
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* "$8,504.47" / "4,012.50" / "58,060.80" → number; "-" / "" → null */
function parseNum(s) {
  if (s == null) return null;
  const t = String(s).replace(/[$,\s]/g, "").trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/* "10k/1k" → 10000, "115k" → 115000, "1000" → 1000 */
function parseTokCount(s) {
  const t = String(s || "").trim().toLowerCase();
  const m = t.match(/^([\d.]+)\s*([km]?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "k") n *= 1e3;
  else if (m[2] === "m") n *= 1e6;
  return n;
}

/* workload "10k/1k" → default input:output ratio, e.g. [10, 1] */
function workloadRatio(workload) {
  const parts = String(workload || "").split("/");
  if (parts.length < 2) return null;
  const a = parseTokCount(parts[0]), b = parseTokCount(parts[1]);
  if (!a || !b) return null;
  return [a, b];
}

/* ───────────────────────── formatting ───────────────────────── */
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const fmtMoney = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
const fmtRate = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;
const fmtPct0 = (n) => `${Math.round(n * 100)}%`;

// group an integer-ish field with thousands separators as the user types,
// keeping the caret in place relative to the digits.
const groupDigits = (s) => { const d = String(s).replace(/\D/g, ""); return d ? Number(d).toLocaleString("en-US") : ""; };
function formatThousands(el) {
  const before = el.value.slice(0, el.selectionStart == null ? el.value.length : el.selectionStart).replace(/\D/g, "").length;
  el.value = groupDigits(el.value);
  let pos = 0, seen = 0;
  while (pos < el.value.length && seen < before) { if (/\d/.test(el.value[pos])) seen++; pos++; }
  if (el.setSelectionRange) el.setSelectionRange(pos, pos);
}

function fmtTokens(n) {
  const abs = Math.abs(n);
  const f = (v, d) => v.toFixed(d).replace(/\.?0+$/, ""); // trim trailing zeros: 100.0→100, 4.32→4.32
  if (abs >= 1e12) return `${f(n / 1e12, 2)}T`;
  if (abs >= 1e9) return `${f(n / 1e9, 2)}B`;
  if (abs >= 1e6) return `${f(n / 1e6, 1)}M`;
  if (abs >= 1e3) return `${f(n / 1e3, 1)}K`;
  return fmtInt(n);
}

/* ───────────────────────── config rows ─────────────────────────
   The sheet mixes measured benchmark rows, an aspirational "target" row, and
   production "actuals" snapshots — and leaves many *calculated* cells (droplet
   price) blank. We keep only rows complete enough to drive BOTH capacity and
   cost/margin: measured throughput + token pricing + a GPU droplet price. The
   droplet price is a per-GPU-type constant, so we extrapolate it from a sibling
   row of the same GPU when blank. Rows still missing critical info are dropped. */
let configs = [];

// GPU family for extrapolation: "B300LCx8" → "B300", "MI350x8" → "MI350"
function gpuFamily(gpu) {
  return String(gpu || "").replace(/x\d+$/i, "").replace(/lc$/i, "").toUpperCase();
}

// measured lab run vs aspirational target vs measured production snapshot
function classify(model, cache) {
  if (/where we want to be/i.test(model)) return "target";
  if (cache === "Prefix Repetition") return "actuals"; // benchmark rows carry a "(x/y)" ratio
  return "benchmark";
}

// structural parse — measured throughput + GPU type + concurrency. Drops every
// blank / label row. Completeness (a droplet price) is enforced later, after
// droplet extrapolation.
function toRow(rec) {
  const inTps = parseNum(rec[C.inTps]);
  const outTps = parseNum(rec[C.outTps]);
  const concurrency = parseNum(rec[C.concurrency]);
  const gpu = (rec[C.gpu] || "").trim();
  if (!(inTps > 0) || !(outTps > 0) || !(concurrency > 0) || !gpu) return null;
  const model = (rec[C.model] || "").trim();
  const cache = (rec[C.cache] || "").trim();
  return {
    model, cache, gpu, family: gpuFamily(gpu),
    precision: (rec[C.precision] || "").trim(),
    workload: (rec[C.workload] || "").trim(),
    config: (rec[C.config] || "").trim(),
    concurrency, inTps, outTps, type: classify(model, cache),
    cacheHit: parseNum(rec[C.cacheHit]), // % baked into the benchmark (from Cache Scenario)
    droplet: {
      ondemand: parseNum(rec[C.dropletOnDemand]),
      contract: parseNum(rec[C.dropletContract]),
    },
    dropletEst: false,
  };
}

// fill blank droplet prices from another row of the same GPU type (exact first,
// then family), flagging the value as estimated so the readout can say so.
function extrapolateDroplet(rows) {
  const byGpu = {}, byFam = {};
  const seed = (map, k, d) => {
    if (!k) return;
    map[k] = map[k] || {};
    if (d.ondemand != null && map[k].ondemand == null) map[k].ondemand = d.ondemand;
    if (d.contract != null && map[k].contract == null) map[k].contract = d.contract;
  };
  for (const r of rows) { seed(byGpu, r.gpu, r.droplet); seed(byFam, r.family, r.droplet); }
  for (const r of rows) {
    for (const kind of ["ondemand", "contract"]) {
      if (r.droplet[kind] == null) {
        const v = (byGpu[r.gpu] && byGpu[r.gpu][kind]) ?? (byFam[r.family] && byFam[r.family][kind]);
        if (v != null) { r.droplet[kind] = v; r.dropletEst = true; }
      }
    }
  }
}

// a complete row needs a GPU droplet price (for cost); throughput is already
// guaranteed by toRow. Token pricing lives on the page, not the table.
function isComplete(r) {
  return r.droplet.ondemand != null && r.droplet.contract != null;
}

function configLabel(c) {
  const tag = c.type === "benchmark" ? "" : `[${c.type}] `;
  // include throughput so rows that differ only in it (e.g. two actuals snapshots)
  // stay distinguishable in the dropdown.
  const bits = [
    c.model, c.gpu, c.precision, c.workload, c.cache, `c=${c.concurrency}`,
    `${fmtInt(c.inTps)}/${fmtInt(c.outTps)} t/s`,
  ].filter((x) => x && x !== "");
  return tag + bits.join(" · ");
}

/* ───────────────────────── compute ───────────────────────── */
function compute(c, tpm, util, px, hours) {
  // the input:output split is a property of the benchmark (its Workload), not a page knob
  const [sa, sb] = workloadRatio(c.workload) || [1, 1];
  const inFrac = sa / (sa + sb), outFrac = sb / (sa + sb);
  const inputTPM = tpm * inFrac, outputTPM = tpm * outFrac; // tokens/min

  // sizing on COMBINED throughput (in+out co-measured at one workload mix),
  // rounded up to whole 8-GPU nodes — reproduces the sheet's TPM/nodes columns.
  // NB: sizing uses the *peak* per-minute TPM and is unaffected by active hours —
  // the fleet must handle the busy window even if it sits idle the rest of the day.
  const perGpuTps = c.inTps + c.outTps;
  const gpusRaw = tpm / (perGpuTps * 60);
  const gpusAtUtil = gpusRaw / util;
  const gpusNeeded = Math.ceil(gpusAtUtil);
  const nodesNeeded = Math.ceil(gpusAtUtil / GPUS_PER_NODE);
  const gpusProvisioned = nodesNeeded * GPUS_PER_NODE;

  // tokens/month & revenue scale with the duty cycle: a customer active only
  // `hours`/day produces tokens for `hours/24` of the month's minutes.
  const activeMin = MIN_PER_MONTH * (hours / 24);
  const inputMo = inputTPM * activeMin, outputMo = outputTPM * activeMin;
  const totalMo = inputMo + outputMo;

  // revenue from the customer's target token prices (per Mtok). Cache-hit fraction
  // comes from the benchmark row. Optional — no in/out price → revenue unknown.
  const cacheFrac = (c.cacheHit != null ? c.cacheHit : 0) / 100;
  let revenue = null;
  if (px && px.in != null && px.out != null) {
    const cacheRate = px.cache != null ? px.cache : px.in; // cache-hit price falls back to input
    const cachedIn = inputMo * cacheFrac, regularIn = inputMo * (1 - cacheFrac);
    revenue =
      (cachedIn / 1e6) * cacheRate +
      (regularIn / 1e6) * px.in +
      (outputMo / 1e6) * px.out;
  }
  const revPerGpuHr = revenue != null ? revenue / (gpusProvisioned * HRS_PER_MONTH) : null;

  return {
    inputTPM, outputTPM, gpusRaw, gpusNeeded, nodesNeeded, gpusProvisioned,
    inputMo, outputMo, totalMo, revenue, revPerGpuHr, cacheFrac,
  };
}

// cost/margin for one droplet-price basis. Cost is billed 24/7 (whole nodes),
// independent of utilization.
function costMargin(price, gpusProvisioned, revenue) {
  const cost = price != null ? gpusProvisioned * price * HRS_PER_MONTH : null;
  const margin = revenue != null && cost != null ? revenue - cost : null;
  const marginPct = margin != null && revenue > 0 ? margin / revenue : null;
  return { price, cost, margin, marginPct };
}

/* ───────────────────────── render ───────────────────────── */
function tile(label, value, sub) {
  return `<div class="tile"><div class="t-label">${esc(label)}</div>` +
    `<div class="t-value">${value}</div>` +
    (sub ? `<div class="t-sub">${sub}</div>` : "") + `</div>`;
}

function renderReadout(c) {
  const perNodeTpm = (c.inTps + c.outTps) * GPUS_PER_NODE * 60 / 1e6;
  const ratio = workloadRatio(c.workload);
  const split = ratio ? `${Math.round(ratio[0] / ratio[1])}:1` : "—";
  const sep = '<span class="sep"> · </span>';
  const line1 = [
    `measured throughput per GPU <b>${fmtInt(c.inTps)}</b> in <b>${fmtInt(c.outTps)}</b> out tok/s`,
    `per node <b>${perNodeTpm.toFixed(2)}M</b> tok/min`,
    `cache hit <b>${c.cacheHit != null ? c.cacheHit + "%" : "—"}</b>`,
  ].join(sep);
  const line2 = `droplet <b>${fmtRate(c.droplet.ondemand)}</b> on-demand / <b>${fmtRate(c.droplet.contract)}</b> contract per gpu-hr${c.dropletEst ? " · est." : ""}`;
  $("readout").innerHTML = line1 + "<br>" + line2;
}

function render() {
  const c = configs[+$("config").value];
  if (!c) return;

  const tpm = parseNum($("tpm").value);
  const utilPct = parseNum($("util").value);
  const util = utilPct != null && utilPct > 0 ? Math.min(utilPct, 100) / 100 : 0.75;
  const hoursVal = parseNum($("hours").value);
  const hours = hoursVal != null && hoursVal > 0 ? Math.min(hoursVal, 24) : 24;
  const px = { in: parseNum($("pin").value), out: parseNum($("pout").value), cache: parseNum($("pcache").value) };
  const actual = parseNum($("actual").value);

  if (tpm == null || tpm <= 0) {
    $("verdict").textContent = "";
    $("tiles").innerHTML = "";
    $("specs").innerHTML = "";
    $("compare").innerHTML = "";
    $("note").textContent = "enter the customer's TPM to size the fleet.";
    return;
  }

  const r = compute(c, tpm, util, px, hours);
  save();

  const headline =
    `Needs ${fmtInt(r.nodesNeeded)} node${r.nodesNeeded === 1 ? "" : "s"} ` +
    `(${fmtInt(r.gpusNeeded)} GPUs) to serve ${fmtTokens(tpm)} TPM ` +
    `(${fmtTokens(r.totalMo)} tokens/month) at ${fmtPct0(util)} utilization` +
    (hours < 24 ? `, active ${fmtInt(hours)}h/day.` : ".");

  // second line: how that tokens/month total breaks down — input:output split
  // (from the benchmark workload) and, within input, cached vs fresh (cache-hit %).
  const ratio = workloadRatio(c.workload);
  const split = ratio ? `${Math.round(ratio[0] / ratio[1])}:1` : "—";
  const sep = '<span class="sep"> · </span>';
  const inBreak = c.cacheHit != null
    ? ` (${fmtTokens(r.inputMo * r.cacheFrac)} cached · ${fmtTokens(r.inputMo * (1 - r.cacheFrac))} fresh)`
    : "";
  const stats = [
    `split <b>${split}</b>`,
    `input <b>${fmtTokens(r.inputMo)}</b>${inBreak}`,
    `output <b>${fmtTokens(r.outputMo)}</b>`,
  ].join(sep);
  $("verdict").innerHTML = esc(headline) + `<div class="verdict-sub">${stats}</div>`;

  // capacity + revenue tiles
  const tiles = [];
  tiles.push(tile("GPUs needed", `<b>${fmtInt(r.gpusNeeded)}</b>`,
    `${esc(c.gpu.replace(/x\d+$/i, ""))} · at ${fmtPct0(util)} util`));
  tiles.push(tile("GPU nodes needed", `<b>${fmtInt(r.nodesNeeded)}</b>`,
    ``));
  tiles.push(tile("tokens / month", fmtTokens(r.totalMo),));
  tiles.push(tile("revenue / month", r.revenue != null ? fmtMoney(r.revenue) : "—",
    r.revenue != null ? `` : "enter target token prices"));
  tiles.push(tile("revenue $/gpu-hr", r.revPerGpuHr != null ? fmtRate(r.revPerGpuHr) : "—",));
  $("tiles").innerHTML = tiles.join("");

  // second row — benchmark spec tiles (same size as above)
  const specs = [
    ["model", c.model.replace(/^[^/]*\//, "")], // drop org prefix: "zai-org/GLM5.2" → "GLM5.2"
    ["ISL / OSL", c.workload],
    ["cache hit", c.cacheHit != null ? c.cacheHit + "%" : "—"],
    ["concurrency", c.concurrency],
    ["precision", c.precision.toUpperCase()], // normalize casing: "Fp8" → "FP8"
  ].map(([l, v]) =>
    `<div class="tile spec"><div class="t-label">${esc(l)}</div><div class="t-value">${esc(String(v))}</div></div>`
  ).join("");
  $("specs").innerHTML = specs;

  // cost & margin — on-demand vs contract (vs optional actual) shown explicitly
  const bases = [
    { name: "on-demand", price: c.droplet.ondemand },
    { name: "contract", price: c.droplet.contract },
  ];
  if (actual != null && actual > 0) bases.push({ name: "actual", price: actual });
  $("compare").innerHTML = renderCompare(bases, r.revenue, r.gpusProvisioned);

  $("note").textContent = "Only Input/Output toks/sec/gpu are measured; capacity, tokens/month and " +
    "revenue are derived here. Cache-hit % and the input:output split come from the selected benchmark. " +
    "Sizing uses combined throughput at the peak TPM, rounded up to whole 8-GPU nodes, and is unaffected by " +
    "active hours. Cost is billed 24/7 regardless of utilization or active hours; tokens/month and revenue " +
    "scale with active hours/day (e.g. 12h → half). Target token prices are optional (blank → revenue and " +
    "margin are hidden).";
}

function renderCompare(bases, revenue, gpusProvisioned) {
  const rows = bases.filter((b) => b.price != null).map((b) => {
    const cm = costMargin(b.price, gpusProvisioned, revenue);
    const cls = cm.margin != null ? (cm.margin >= 0 ? "pos" : "neg") : "";
    return `<tr class="${cls}"><td>${esc(b.name)}</td><td>${fmtRate(b.price)}</td>` +
      `<td>${fmtMoney(cm.cost)}</td>` +
      `<td>${cm.margin != null ? fmtMoney(cm.margin) : "—"}</td>` +
      `<td>${cm.marginPct != null ? fmtPct(cm.marginPct) : "—"}</td></tr>`;
  }).join("");
  return `<table class="cmp"><thead><tr>` +
    `<th>droplet price</th><th>$/gpu-hr</th><th>cost / month</th><th>margin / month</th><th>margin %</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`;
}

/* ───────────────────────── persistence ───────────────────────── */
const LS = "do-si-capacity";
function save() {
  try {
    localStorage.setItem(LS, JSON.stringify({
      cfg: $("config").value, tpm: $("tpm").value, util: $("util").value, hours: $("hours").value,
      pin: $("pin").value, pout: $("pout").value, pcache: $("pcache").value, actual: $("actual").value,
    }));
  } catch (_) {}
}
function load() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS) || "{}"); } catch (_) {}
  return s;
}

/* ───────────────────────── config change ───────────────────────── */
function onConfigChange() {
  const c = configs[+$("config").value];
  if (!c) return;
  renderReadout(c);
  render();
}

/* ───────────────────────── init ───────────────────────── */
async function init() {
  const s = load();
  // defaults
  $("tpm").value = s.tpm || "5,000,000";
  $("util").value = s.util || "75";
  $("hours").value = s.hours || "24";
  $("pin").value = s.pin || "";
  $("pout").value = s.pout || "";
  $("pcache").value = s.pcache || "";
  $("actual").value = s.actual || "";

  try {
    const resp = await fetch(DATA_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const records = parseCSV(await resp.text());
    const rows = records.slice(1).map(toRow).filter(Boolean); // structural rows
    extrapolateDroplet(rows);                                 // fill calculated droplet prices
    configs = rows.filter(isComplete);                        // drop rows missing critical info
  } catch (e) {
    $("readout").innerHTML =
      `<span class="err">could not load ${esc(DATA_URL)} — ${esc(e.message)}. ` +
      `Serve over HTTP (see README) and make sure the benchmark CSV is present.</span>`;
    return;
  }

  if (!configs.length) {
    $("readout").innerHTML = `<span class="err">no benchmark rows found in ${esc(DATA_URL)}.</span>`;
    return;
  }

  const sel = $("config");
  configs.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = configLabel(c);
    sel.appendChild(o);
  });
  if (s.cfg != null && configs[+s.cfg]) sel.value = s.cfg;

  renderReadout(configs[+sel.value]);

  sel.addEventListener("change", onConfigChange);
  ["util", "hours", "pin", "pout", "pcache", "actual"].forEach((id) => $(id).addEventListener("input", render));
  $("tpm").addEventListener("input", () => { formatThousands($("tpm")); render(); });

  render();
}
document.addEventListener("DOMContentLoaded", init);
