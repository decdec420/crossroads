// Crossroads — HOSTED, METERED MCP server (Supabase Edge Function: `mcp`)
//
// A remote Model Context Protocol endpoint over HTTP JSON-RPC, gated by an API key
// and metered per call against a monthly plan quota. Lets ANY AI agent ground a
// recommendation in a verifiable, reproducible decision computation instead of
// hallucinating one. Auth is the API key (verify_jwt is disabled); metering uses the
// service role to call the SECURITY DEFINER `mcp_meter` RPC.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ==ENGINE START==  (compact port of the client-verified Crossroads engine)
type Unc = "low" | "med" | "high";
type Model = "utility" | "prospect";
const BAND: Record<Unc, number> = { low: 1, med: 2, high: 3 };
const clampN = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function fnv(s: string): number { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
interface VP { model: Model; risk: number; rho: number; lambda: number; alpha: number; }
function vfn(p: number, vp: VP): number {
  p = clampN(p, 0, 1);
  if (vp.model === "prospect") {
    const raw = (q: number): number => { const d = q - vp.rho; return d >= 0 ? Math.pow(d, vp.alpha) : -vp.lambda * Math.pow(-d, vp.alpha); };
    const v0 = raw(0), v1 = raw(1); if (Math.abs(v1 - v0) < 1e-9) return p; return (raw(p) - v0) / (v1 - v0);
  }
  const a = -vp.risk * 3.5; if (Math.abs(a) < 1e-6) return p; return (1 - Math.exp(-a * p)) / (1 - Math.exp(-a));
}
function tri(r: () => number, lo: number, ml: number, hi: number): number {
  if (hi <= lo) return lo; ml = clampN(ml, lo, hi); const u = r(), c = (ml - lo) / (hi - lo);
  return u < c ? lo + Math.sqrt(u * (hi - lo) * (ml - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - ml));
}
interface Crit { id: string; name: string; weight: number; unc: Unc; cells: Record<string, number>; }
interface Dec { options: { id: string; name: string }[]; criteria: Crit[]; vp: VP; }
const loOf = (c: Crit, o: string): number => clampN((c.cells[o] ?? 0) - BAND[c.unc], 0, 10);
const hiOf = (c: Crit, o: string): number => clampN((c.cells[o] ?? 0) + BAND[c.unc], 0, 10);
const normW = (cr: Crit[]): number[] => { const t = cr.reduce((s, c) => s + (c.weight || 0), 0) || 1; return cr.map((c) => (c.weight || 0) / t); };
function simulate(d: Dec, N: number, seed: number) {
  const r = mulberry32(seed), W = normW(d.criteria), O = d.options.length;
  const vals: number[][] = Array.from({ length: O }, () => []), wins = new Array(O).fill(0);
  const meanU = Array.from({ length: O }, () => new Array(d.criteria.length).fill(0)); let smp = 0;
  for (let t = 0; t < N; t++) {
    let best = -Infinity, bi = 0;
    d.options.forEach((o, oi) => { let v = 0; d.criteria.forEach((c, ci) => { const u = vfn(tri(r, loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, d.vp); meanU[oi][ci] += u; v += W[ci] * u; }); vals[oi].push(v); if (v > best) { best = v; bi = oi; } });
    wins[bi]++; smp += best;
  }
  const per = d.options.map((o, oi) => { const arr = vals[oi].slice().sort((a, b) => a - b); const q = (p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]; const mean = arr.reduce((s, x) => s + x, 0) / arr.length; return { id: o.id, name: o.name, mean, p10: q(0.1), p90: q(0.9), pBest: wins[oi] / N }; });
  for (let oi = 0; oi < O; oi++) for (let ci = 0; ci < d.criteria.length; ci++) meanU[oi][ci] /= N;
  const baseline = Math.max(...per.map((p) => p.mean));
  return { per, byEV: per.slice().sort((a, b) => b.mean - a.mean), evpi: Math.max(0, smp / N - baseline), meanU };
}
function dominance(d: Dec): string[] {
  const out: string[] = [];
  d.options.forEach((a) => d.options.forEach((b) => { if (a.id === b.id) return; let ge = true, gt = false; d.criteria.forEach((c) => { const av = c.cells[a.id] ?? 0, bv = c.cells[b.id] ?? 0; if (av < bv) ge = false; if (av > bv) gt = true; }); if (ge && gt) out.push(b.name); }));
  return [...new Set(out)];
}
function tornado(d: Dec, sim: ReturnType<typeof simulate>) {
  const li = d.options.findIndex((o) => o.id === sim.byEV[0].id);
  const ev = (rw: number[]) => { const t = rw.reduce((s, x) => s + x, 0) || 1; const w = rw.map((x) => x / t); const e = d.options.map((_, oi) => w.reduce((s, _w, ci) => s + w[ci] * sim.meanU[oi][ci], 0)); let br = -Infinity; e.forEach((x, oi) => { if (oi !== li && x > br) br = x; }); return e[li] - br; };
  const base = d.criteria.map((c) => c.weight || 0);
  return d.criteria.map((c, ci) => { const lo = base.slice(); lo[ci] = 0; const hi = base.slice(); hi[ci] = (base[ci] || 1e-4) * 2; const a = ev(lo), b = ev(hi); return { criterion: c.name, swing: Math.abs(b - a), canFlip: a < 0 !== b < 0 }; }).sort((a, b) => b.swing - a.swing);
}
function evppi(d: Dec, M: number, K: number, seed: number) {
  const r = mulberry32(seed), W = normW(d.criteria), crit = d.criteria, opts = d.options, mv = opts.map(() => 0), Kb = Math.max(K, 200);
  for (let k = 0; k < Kb; k++) opts.forEach((o, oi) => { let v = 0; crit.forEach((c, ci) => { v += W[ci] * vfn(tri(r, loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, d.vp); }); mv[oi] += v; });
  for (let oi = 0; oi < opts.length; oi++) mv[oi] /= Kb;
  const baseline = Math.max(...mv);
  return crit.map((cT, cti) => {
    let om = 0;
    for (let m = 0; m < M; m++) {
      const fx = opts.map((o) => vfn(tri(r, loOf(cT, o.id), cT.cells[o.id] ?? 0, hiOf(cT, o.id)) / 10, d.vp));
      const inner = opts.map(() => 0);
      for (let k = 0; k < K; k++) opts.forEach((o, oi) => { let v = W[cti] * fx[oi]; crit.forEach((c, ci) => { if (ci !== cti) v += W[ci] * vfn(tri(r, loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, d.vp); }); inner[oi] += v; });
      let mx = -Infinity; inner.forEach((s) => { const e = s / K; if (e > mx) mx = e; }); om += mx;
    }
    return { criterion: cT.name, value: Math.max(0, om / M - baseline) * 100 };
  }).sort((a, b) => b.value - a.value);
}
interface AnalyzeArgs { title?: string; options: string[]; criteria: { name: string; weight?: number; uncertainty?: Unc }[]; scores: Record<string, Record<string, number>>; model?: Model; risk?: number; reference_point?: number; loss_aversion?: number; trials?: number; seed?: number; value_of_information?: boolean; }
function analyze(a: AnalyzeArgs, withVoI: boolean) {
  if (!Array.isArray(a.options) || a.options.length < 2) throw new Error("Provide at least 2 options.");
  if (!Array.isArray(a.criteria) || a.criteria.length < 1) throw new Error("Provide at least 1 criterion.");
  if (a.options.length > 12) throw new Error("Too many options (max 12) — narrow the field first.");
  if (a.criteria.length > 12) throw new Error("Too many criteria (max 12) — group or drop minor ones.");
  const options = a.options.map((name, i) => ({ id: "o" + i, name }));
  const warnings: string[] = [];
  const criteria: Crit[] = a.criteria.map((c, i) => {
    const cells: Record<string, number> = {};
    options.forEach((o) => { const s = a.scores?.[o.name]?.[c.name]; if (typeof s === "number" && isFinite(s)) cells[o.id] = clampN(s, 0, 10); else { cells[o.id] = 5; warnings.push(`No score for "${o.name}" on "${c.name}" — assumed 5/10.`); } });
    return { id: "c" + i, name: c.name, weight: c.weight ?? 50, unc: c.uncertainty ?? "med", cells };
  });
  const vp: VP = { model: a.model ?? "utility", risk: clampN(a.risk ?? 0, -1, 1), rho: clampN((a.reference_point ?? 5) / 10, 0, 1), lambda: clampN(a.loss_aversion ?? 2.25, 1, 4), alpha: 0.88 };
  const dec: Dec = { options, criteria, vp };
  const seed = a.seed != null ? a.seed >>> 0 : fnv(JSON.stringify({ o: a.options, c: a.criteria, s: a.scores, vp }));
  const trials = clampN(Math.round(a.trials ?? 6000), 500, 50000);
  const sim = simulate(dec, trials, seed);
  const dom = dominance(dec);
  const tor = tornado(dec, sim);
  // Bound EVPPI work (nested Monte Carlo ~ M*K*O*C^2) by a fixed compute budget.
  let voi: { criterion: string; value: number }[] = [];
  if (withVoI) {
    const O = dec.options.length, C = dec.criteria.length;
    const mk = Math.max(60, Math.min(140, Math.floor(Math.sqrt(12_000_000 / Math.max(1, O * C * C)))));
    voi = evppi(dec, mk, mk, (seed ^ 0x9e3779b9) >>> 0);
  }
  const sc = (v: number) => Math.round(v * 100);
  const ranking = sim.byEV.map((p) => ({ name: p.name, pBestPct: Math.round(p.pBest * 100), expectedValue: sc(p.mean), low: sc(p.p10), high: sc(p.p90) }));
  const lead = ranking[0], pB = sim.byEV[0].pBest;
  const confidence = pB >= 0.85 ? "confident" : pB >= 0.62 ? "leaning" : "toss-up";
  const researchFirst = voi.length && voi[0].value >= 0.4 ? voi[0].criterion : null;
  const flips = tor.filter((t) => t.canFlip).map((t) => t.criterion);
  const structured = { title: a.title ?? "(untitled)", leader: lead.name, confidence, trials, seed, model: vp.model, ranking, dominated: dom, evpi: Math.round(sim.evpi * 1000) / 10, valueOfInformation: voi.map((v) => ({ criterion: v.criterion, value: Math.round(v.value * 10) / 10 })), researchFirst, sensitivity: tor.map((t) => ({ criterion: t.criterion, canFlip: t.canFlip })), warnings };
  const phr = confidence === "confident" ? "a confident call" : confidence === "leaning" ? "a lean, not a lock" : "too close to call";
  let md = `Best bet: ${lead.name} — wins ${lead.pBestPct}% of ${trials.toLocaleString()} simulations (${phr}). EV ${lead.expectedValue}/100, 80% range ${lead.low}-${lead.high}.\n`;
  md += "Ranking: " + ranking.map((r, i) => `${i + 1}) ${r.name} ${r.pBestPct}%`).join("  ") + "\n";
  if (withVoI) md += researchFirst ? `Research first: ${researchFirst} (highest value of information).\n` : "Robust: no single unknown is worth resolving first.\n";
  if (flips.length) md += `Could flip if you reweight: ${flips.join(", ")}.\n`;
  if (dom.length) md += `Eliminable (dominated): ${dom.join(", ")}.\n`;
  return { content: [{ type: "text", text: md.trim() }], structuredContent: structured };
}
// ==ENGINE END==

const VERSION = "1.0.0";
const TOOLS = [
  {
    name: "crossroads_analyze_decision",
    description: "Rigorous multi-criteria decision analysis under uncertainty. Returns probability each option is best (Monte Carlo), dominance, sensitivity, and value-of-information (what to research first). Grounds a recommendation in a reproducible computation. Inputs: options[] (>=2), criteria[{name,weight 0-100,uncertainty low|med|high}], scores{[option]:{[criterion]:0-10}}. Optional: model 'utility'|'prospect', risk -1..1, reference_point, loss_aversion, trials, seed, value_of_information.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 12 }, criteria: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: { name: { type: "string" }, weight: { type: "number" }, uncertainty: { enum: ["low", "med", "high"] } }, required: ["name"] } }, scores: { type: "object", additionalProperties: { type: "object", additionalProperties: { type: "number" } } }, model: { enum: ["utility", "prospect"] }, risk: { type: "number" }, reference_point: { type: "number" }, loss_aversion: { type: "number" }, trials: { type: "integer" }, seed: { type: "integer" }, value_of_information: { type: "boolean" } }, required: ["options", "criteria", "scores"] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "crossroads_quick_compare",
    description: "Fast weighted compare with probability-of-best (no value-of-information). Inputs: options[] (>=2), criteria[{name,weight}], scores{[option]:{[criterion]:0-10}}.",
    inputSchema: { type: "object", properties: { options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 12 }, criteria: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: { name: { type: "string" }, weight: { type: "number" }, uncertainty: { enum: ["low", "med", "high"] } }, required: ["name"] } }, scores: { type: "object", additionalProperties: { type: "object", additionalProperties: { type: "number" } } } }, required: ["options", "criteria", "scores"] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const CORS: Record<string, string> = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, mcp-protocol-version", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function sha256hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function meter(rawKey: string, tool: string, billable: boolean): Promise<Record<string, unknown>> {
  if (!rawKey) return { ok: false, reason: "missing_key" };
  const { data, error } = await admin.rpc("mcp_meter", { p_key_hash: await sha256hex(rawKey), p_tool: tool, p_billable: billable });
  if (error) return { ok: false, reason: "meter_error" };
  return data as Record<string, unknown>;
}
const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(m: any, rawKey: string): Promise<unknown> {
  const { id, method, params } = m ?? {};
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "ping") return ok(id, {});
  if (method === "initialize") {
    const v = await meter(rawKey, "initialize", false);
    if (!v.ok) return err(id, -32001, "Unauthorized: invalid or missing API key");
    return ok(id, { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "crossroads-hosted-mcp", version: VERSION } });
  }
  if (method === "tools/list") {
    const v = await meter(rawKey, "tools/list", false);
    if (!v.ok) return err(id, -32001, "Unauthorized: invalid or missing API key");
    return ok(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = params?.name; const args = params?.arguments ?? {};
    const v = await meter(rawKey, name ?? "unknown", true);
    if (!v.ok) {
      if (v.reason === "quota_exceeded") return err(id, -32003, `Quota exceeded for plan '${v.plan}' (${v.calls}/${v.quota} this month). Upgrade for more.`);
      return err(id, -32001, "Unauthorized: invalid or missing API key");
    }
    try {
      if (name === "crossroads_analyze_decision") return ok(id, analyze(args, args.value_of_information !== false));
      if (name === "crossroads_quick_compare") return ok(id, analyze(args, false));
      return err(id, -32601, `Unknown tool: ${name}`);
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    }
  }
  return err(id, -32601, `Method not found: ${method}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return new Response(JSON.stringify({ ok: true, service: "crossroads-hosted-mcp", version: VERSION, transport: "http-jsonrpc" }), { headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  const authH = req.headers.get("authorization") ?? "";
  const rawKey = req.headers.get("x-api-key") ?? (authH.toLowerCase().startsWith("bearer ") ? authH.slice(7).trim() : "");
  let body: unknown;
  try { body = await req.json(); } catch { return new Response(JSON.stringify(err(null, -32700, "Parse error")), { headers: { ...CORS, "Content-Type": "application/json" } }); }

  const batch = Array.isArray(body);
  const msgs = batch ? (body as unknown[]) : [body];
  const responses: unknown[] = [];
  for (const m of msgs) { const r = await handle(m, rawKey); if (r !== null) responses.push(r); }
  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS });

  const payload = batch ? responses : responses[0];
  const text = JSON.stringify(payload);
  if ((req.headers.get("accept") ?? "").includes("text/event-stream")) {
    return new Response(`event: message\ndata: ${text}\n\n`, { headers: { ...CORS, "Content-Type": "text/event-stream" } });
  }
  return new Response(text, { headers: { ...CORS, "Content-Type": "application/json" } });
});
