// Supabase Edge Function: simulate-decision  (DEPLOYED · ACTIVE · verify_jwt=true)
// Project rgbgstcipidkrcjofins · POST /functions/v1/simulate-decision
//
// Server port of the client-verified Crossroads engine. Reproducible: identical
// inputs + seed -> identical output. Two modes:
//   A) { payload }     -> stateless compute, returns result (no DB write)
//   B) { decisionId }  -> assemble inputs under the caller's RLS, persist a
//                         finished `simulations` row, return { simulationId, result }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Crit = { id: string; name: string; weight: number; uncertainty: 'low'|'med'|'high'; cells: Record<string, number> };
type Opt = { id: string; name: string };
type Dec = { options: Opt[]; criteria: Crit[]; risk: number };

const BAND: Record<string, number> = { low: 1, med: 2, high: 3 };
let RNG: () => number = Math.random;
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
function tri(lo: number, ml: number, hi: number) {
  if (hi <= lo) return lo;
  ml = clamp(ml, lo, hi);
  const u = RNG(), c = (ml - lo) / (hi - lo);
  return u < c ? lo + Math.sqrt(u * (hi - lo) * (ml - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - ml));
}
function utility(p: number, risk: number) {
  p = clamp(p, 0, 1);
  const a = -risk * 3.5;
  if (Math.abs(a) < 1e-6) return p;
  return (1 - Math.exp(-a * p)) / (1 - Math.exp(-a));
}
const band = (c: Crit) => BAND[c.uncertainty] ?? 2;
const loOf = (c: Crit, o: string) => clamp((c.cells[o] ?? 0) - band(c), 0, 10);
const hiOf = (c: Crit, o: string) => clamp((c.cells[o] ?? 0) + band(c), 0, 10);
const normW = (cr: Crit[]) => { const t = cr.reduce((s, c) => s + (c.weight || 0), 0) || 1; return cr.map((c) => (c.weight || 0) / t); };

function simulate(dec: Dec, N: number) {
  const W = normW(dec.criteria), O = dec.options.length;
  const vals: number[][] = Array.from({ length: O }, () => []);
  const wins = new Array(O).fill(0);
  const meanU = Array.from({ length: O }, () => new Array(dec.criteria.length).fill(0));
  let sumMaxPerfect = 0;
  for (let t = 0; t < N; t++) {
    const tv = new Array(O).fill(0);
    let best = -Infinity, bi = 0;
    dec.options.forEach((o, oi) => {
      let v = 0;
      dec.criteria.forEach((c, ci) => {
        const u = utility(tri(loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, dec.risk);
        meanU[oi][ci] += u; v += W[ci] * u;
      });
      tv[oi] = v; vals[oi].push(v);
      if (v > best) { best = v; bi = oi; }
    });
    wins[bi]++; sumMaxPerfect += best;
  }
  const per = dec.options.map((o, oi) => {
    const arr = vals[oi].slice().sort((a, b) => a - b);
    const q = (p: number) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    return { id: o.id, name: o.name, mean, p10: q(0.1), p50: q(0.5), p90: q(0.9), pBest: wins[oi] / N };
  });
  for (let oi = 0; oi < O; oi++) for (let ci = 0; ci < dec.criteria.length; ci++) meanU[oi][ci] /= N;
  const baseline = Math.max(...per.map((p) => p.mean));
  const evpi = Math.max(0, sumMaxPerfect / N - baseline);
  const byEV = per.slice().sort((a, b) => b.mean - a.mean);
  return { per, byEV, evpi, baseline, meanU };
}
function dominance(dec: Dec) {
  const out: { winner: string; loser: string; loserId: string }[] = [];
  dec.options.forEach((a) => dec.options.forEach((b) => {
    if (a.id === b.id) return;
    let ge = true, gt = false;
    dec.criteria.forEach((c) => { const av = c.cells[a.id] ?? 0, bv = c.cells[b.id] ?? 0; if (av < bv) ge = false; if (av > bv) gt = true; });
    if (ge && gt) out.push({ winner: a.name, loser: b.name, loserId: b.id });
  }));
  return out;
}
function tornado(dec: Dec, sim: ReturnType<typeof simulate>) {
  const crit = dec.criteria;
  const leaderIdx = dec.options.findIndex((o) => o.id === sim.byEV[0].id);
  const evWith = (rawW: number[]) => {
    const t = rawW.reduce((s, x) => s + x, 0) || 1; const w = rawW.map((x) => x / t);
    const ev = dec.options.map((_, oi) => w.reduce((s, _w, ci) => s + w[ci] * sim.meanU[oi][ci], 0));
    const lead = ev[leaderIdx]; let best = -Infinity;
    ev.forEach((e, oi) => { if (oi !== leaderIdx && e > best) best = e; });
    return lead - best;
  };
  const base = crit.map((c) => c.weight || 0);
  const rows = crit.map((c, ci) => {
    const lo = base.slice(); lo[ci] = 0;
    const hi = base.slice(); hi[ci] = (base[ci] || 0.0001) * 2;
    const mLo = evWith(lo), mHi = evWith(hi);
    return { name: c.name, swing: Math.abs(mHi - mLo), flips: (mLo < 0) !== (mHi < 0) };
  });
  rows.sort((a, b) => b.swing - a.swing);
  return rows;
}
// EVPPI via nested Monte Carlo: value of learning ONE criterion before deciding.
function evppi(dec: Dec, M: number, K: number) {
  const W = normW(dec.criteria), crit = dec.criteria, opts = dec.options;
  const meanV = opts.map(() => 0); const Kb = Math.max(K, 200);
  for (let k = 0; k < Kb; k++) opts.forEach((o, oi) => {
    let v = 0; crit.forEach((c, ci) => v += W[ci] * utility(tri(loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, dec.risk));
    meanV[oi] += v;
  });
  for (let oi = 0; oi < opts.length; oi++) meanV[oi] /= Kb;
  const baseline = Math.max(...meanV);
  return crit.map((cT, cti) => {
    let outerMax = 0;
    for (let m = 0; m < M; m++) {
      const fixedU = opts.map((o) => utility(tri(loOf(cT, o.id), cT.cells[o.id] ?? 0, hiOf(cT, o.id)) / 10, dec.risk));
      const inner = opts.map(() => 0);
      for (let k = 0; k < K; k++) opts.forEach((o, oi) => {
        let v = W[cti] * fixedU[oi];
        crit.forEach((c, ci) => { if (ci !== cti) v += W[ci] * utility(tri(loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, dec.risk); });
        inner[oi] += v;
      });
      let mx = -Infinity; inner.forEach((s) => { const e = s / K; if (e > mx) mx = e; });
      outerMax += mx;
    }
    return { name: cT.name, value: Math.max(0, outerMax / M - baseline) };
  });
}
function hashStr(s: string) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function agg(values: number[], method: string) {
  if (!values.length) return undefined;
  if (method === 'median') { const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method === 'GET') return json({ ok: true, service: 'simulate-decision', engine: 'v1' });
  try {
    const body = await req.json().catch(() => ({}));
    const aggregation: string = body.aggregation ?? 'individual';
    const trials = clamp(Number(body.trials) || 6000, 100, 50000);
    const computeEvppi = body.computeEvppi !== false;

    let dec: Dec | null = null;
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false },
    });
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData?.user?.id ?? null;

    if (body.payload && Array.isArray(body.payload.options)) {
      dec = { options: body.payload.options, criteria: body.payload.criteria, risk: Number(body.payload.risk) || 0 };
    } else if (body.decisionId) {
      const decisionId = String(body.decisionId);
      const [d, opts, crit, weights, scores] = await Promise.all([
        supabase.from('decisions').select('risk').eq('id', decisionId).single(),
        supabase.from('options').select('id,name,position').eq('decision_id', decisionId).order('position'),
        supabase.from('criteria').select('id,name,uncertainty,default_weight,position').eq('decision_id', decisionId).order('position'),
        supabase.from('input_weights').select('participant_id,criterion_id,weight').eq('decision_id', decisionId),
        supabase.from('input_scores').select('participant_id,option_id,criterion_id,likely').eq('decision_id', decisionId),
      ]);
      if (d.error || !d.data) return json({ error: 'decision not found or not authorized' }, 404);
      const pid = body.participantId ? String(body.participantId) : null;
      const wRows = (weights.data ?? []).filter((r) => aggregation === 'individual' ? r.participant_id === pid : true);
      const sRows = (scores.data ?? []).filter((r) => aggregation === 'individual' ? r.participant_id === pid : true);
      const criteria: Crit[] = (crit.data ?? []).map((c) => {
        const ws = wRows.filter((w) => w.criterion_id === c.id).map((w) => Number(w.weight));
        const cells: Record<string, number> = {};
        (opts.data ?? []).forEach((o) => {
          const xs = sRows.filter((s) => s.criterion_id === c.id && s.option_id === o.id).map((s) => Number(s.likely));
          const a = agg(xs, aggregation); cells[o.id] = a !== undefined ? a : 5;
        });
        return { id: c.id, name: c.name, uncertainty: c.uncertainty, weight: agg(ws, aggregation) ?? Number(c.default_weight), cells };
      });
      dec = { options: (opts.data ?? []).map((o) => ({ id: o.id, name: o.name })), criteria, risk: Number(d.data.risk) || 0 };
      body.__decisionId = decisionId;
    }
    if (!dec || !dec.options?.length || !dec.criteria?.length) return json({ error: 'need >=1 option and >=1 criterion' }, 400);

    const seed = (body.seed != null) ? (Number(body.seed) >>> 0) : hashStr(JSON.stringify(dec) + aggregation + trials);
    RNG = mulberry32(seed);
    const sim = simulate(dec, trials);
    const dom = dominance(dec);
    const tor = tornado(dec, sim);
    let ev = null;
    if (computeEvppi && dec.options.length * dec.criteria.length <= 60) { RNG = mulberry32((seed ^ 0x9e3779b9) >>> 0); ev = evppi(dec, 120, 120).sort((a, b) => b.value - a.value); }
    const result = { perOption: sim.byEV, evpi: sim.evpi, dominance: dom, tornado: tor, evppi: ev, meta: { aggregation, trials, seed, engineVersion: 'v1' } };

    let simulationId: string | null = null;
    if (body.__decisionId && uid) {
      const ins = await supabase.from('simulations').insert({
        decision_id: body.__decisionId, participant_id: body.participantId ?? null,
        kind: aggregation === 'individual' ? 'individual' : 'group', aggregation, seed, trials,
        engine_version: 'v1', status: 'done', result, created_by: uid, completed_at: new Date().toISOString(),
      }).select('id').single();
      if (!ins.error) simulationId = ins.data.id;
    }
    return json({ simulationId, result });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
