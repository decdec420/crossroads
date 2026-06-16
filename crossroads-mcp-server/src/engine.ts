/**
 * Crossroads decision engine — pure, dependency-free, deterministic when seeded.
 *
 * Multi-criteria decision analysis under uncertainty:
 *  - each score is widened into a triangular distribution by its stated confidence
 *  - a value function (risk-adjusted utility OR prospect-theory loss aversion) maps it to value
 *  - Monte Carlo gives P(best) + expected value + an 80% credible interval per option
 *  - deterministic dominance flags options beaten on every criterion
 *  - a weight tornado shows what could flip the winner
 *  - nested Monte Carlo computes EVPPI — which unknown is worth resolving first
 */

export type Uncertainty = "low" | "med" | "high";
export type Model = "utility" | "prospect";

export interface CriterionIn {
  name: string;
  weight: number;
  uncertainty: Uncertainty;
}

export interface AnalyzeInput {
  title?: string;
  options: string[];
  criteria: CriterionIn[];
  scores: Record<string, Record<string, number>>;
  model: Model;
  risk: number;
  reference_point: number;
  loss_aversion: number;
  trials: number;
  seed?: number;
  value_of_information: boolean;
}

export interface OptionResult {
  name: string;
  pBest: number; // 0..1
  pBestPct: number; // 0..100, rounded
  expectedValue: number; // 0..100, rounded
  low: number; // p10, 0..100
  high: number; // p90, 0..100
}

export interface InfoValue {
  criterion: string;
  value: number; // 0..100 scale (utils x100)
}

export interface Sensitivity {
  criterion: string;
  swing: number;
  canFlip: boolean;
}

export interface AnalyzeResult {
  title: string;
  leader: string;
  confidence: "confident" | "leaning" | "toss-up";
  trials: number;
  seed: number;
  model: Model;
  ranking: OptionResult[];
  dominated: string[];
  evpi: number; // 0..100
  valueOfInformation: InfoValue[];
  researchFirst: string | null;
  sensitivity: Sensitivity[];
  warnings: string[];
  markdown: string;
}

interface Crit {
  id: string;
  name: string;
  weight: number;
  uncertainty: Uncertainty;
  cells: Record<string, number>;
}
interface Opt {
  id: string;
  name: string;
}
interface ValueParams {
  model: Model;
  risk: number;
  rho: number;
  lambda: number;
  alpha: number;
}
interface Dec {
  options: Opt[];
  criteria: Crit[];
  vp: ValueParams;
}

const BAND: Record<Uncertainty, number> = { low: 1, med: 2, high: 3 };
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Maps a normalized performance p in [0,1] to value in [0,1]. */
function valueFn(p: number, vp: ValueParams): number {
  p = clamp(p, 0, 1);
  if (vp.model === "prospect") {
    // Prospect-theory value: gains vs. losses around a reference point, losses
    // weighted by lambda (~2.25). Normalized to [0,1] so weighted aggregation stays comparable.
    const raw = (q: number): number => {
      const d = q - vp.rho;
      return d >= 0 ? Math.pow(d, vp.alpha) : -vp.lambda * Math.pow(-d, vp.alpha);
    };
    const v0 = raw(0);
    const v1 = raw(1);
    if (Math.abs(v1 - v0) < 1e-9) return p;
    return (raw(p) - v0) / (v1 - v0);
  }
  // Exponential (constant absolute risk aversion) utility. risk<0 = averse (concave).
  const a = -vp.risk * 3.5;
  if (Math.abs(a) < 1e-6) return p;
  return (1 - Math.exp(-a * p)) / (1 - Math.exp(-a));
}

function triangular(rng: () => number, lo: number, ml: number, hi: number): number {
  if (hi <= lo) return lo;
  ml = clamp(ml, lo, hi);
  const u = rng();
  const c = (ml - lo) / (hi - lo);
  return u < c ? lo + Math.sqrt(u * (hi - lo) * (ml - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - ml));
}

const band = (c: Crit): number => BAND[c.uncertainty] ?? 2;
const loOf = (c: Crit, o: string): number => clamp((c.cells[o] ?? 0) - band(c), 0, 10);
const hiOf = (c: Crit, o: string): number => clamp((c.cells[o] ?? 0) + band(c), 0, 10);
const normWeights = (cr: Crit[]): number[] => {
  const t = cr.reduce((s, c) => s + (c.weight || 0), 0) || 1;
  return cr.map((c) => (c.weight || 0) / t);
};

interface SimOut {
  per: { id: string; name: string; mean: number; p10: number; p50: number; p90: number; pBest: number }[];
  byEV: SimOut["per"];
  evpi: number;
  meanU: number[][];
}

function simulate(dec: Dec, N: number, seed: number): SimOut {
  const rng = mulberry32(seed);
  const W = normWeights(dec.criteria);
  const O = dec.options.length;
  const vals: number[][] = Array.from({ length: O }, () => []);
  const wins = new Array<number>(O).fill(0);
  const meanU = Array.from({ length: O }, () => new Array<number>(dec.criteria.length).fill(0));
  let sumMaxPerfect = 0;
  for (let t = 0; t < N; t++) {
    let best = -Infinity;
    let bi = 0;
    const tv = new Array<number>(O).fill(0);
    dec.options.forEach((o, oi) => {
      let v = 0;
      dec.criteria.forEach((c, ci) => {
        const u = valueFn(triangular(rng, loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, dec.vp);
        meanU[oi][ci] += u;
        v += W[ci] * u;
      });
      tv[oi] = v;
      vals[oi].push(v);
      if (v > best) {
        best = v;
        bi = oi;
      }
    });
    wins[bi]++;
    sumMaxPerfect += best;
  }
  const per = dec.options.map((o, oi) => {
    const arr = vals[oi].slice().sort((a, b) => a - b);
    const q = (p: number): number => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    return { id: o.id, name: o.name, mean, p10: q(0.1), p50: q(0.5), p90: q(0.9), pBest: wins[oi] / N };
  });
  for (let oi = 0; oi < O; oi++) for (let ci = 0; ci < dec.criteria.length; ci++) meanU[oi][ci] /= N;
  const baseline = Math.max(...per.map((p) => p.mean));
  const evpi = Math.max(0, sumMaxPerfect / N - baseline);
  return { per, byEV: per.slice().sort((a, b) => b.mean - a.mean), evpi, meanU };
}

function dominance(dec: Dec): { winner: string; loser: string }[] {
  const out: { winner: string; loser: string }[] = [];
  dec.options.forEach((a) =>
    dec.options.forEach((b) => {
      if (a.id === b.id) return;
      let ge = true;
      let gt = false;
      dec.criteria.forEach((c) => {
        const av = c.cells[a.id] ?? 0;
        const bv = c.cells[b.id] ?? 0;
        if (av < bv) ge = false;
        if (av > bv) gt = true;
      });
      if (ge && gt) out.push({ winner: a.name, loser: b.name });
    })
  );
  return out;
}

function tornado(dec: Dec, sim: SimOut): Sensitivity[] {
  const crit = dec.criteria;
  const leaderIdx = dec.options.findIndex((o) => o.id === sim.byEV[0].id);
  const evWith = (rawW: number[]): number => {
    const t = rawW.reduce((s, x) => s + x, 0) || 1;
    const w = rawW.map((x) => x / t);
    const ev = dec.options.map((_, oi) => w.reduce((s, _w, ci) => s + w[ci] * sim.meanU[oi][ci], 0));
    const lead = ev[leaderIdx];
    let best = -Infinity;
    ev.forEach((e, oi) => {
      if (oi !== leaderIdx && e > best) best = e;
    });
    return lead - best;
  };
  const base = crit.map((c) => c.weight || 0);
  const rows = crit.map((c, ci) => {
    const lo = base.slice();
    lo[ci] = 0;
    const hi = base.slice();
    hi[ci] = (base[ci] || 0.0001) * 2;
    const mLo = evWith(lo);
    const mHi = evWith(hi);
    return { criterion: c.name, swing: Math.abs(mHi - mLo), canFlip: mLo < 0 !== mHi < 0 };
  });
  rows.sort((a, b) => b.swing - a.swing);
  return rows;
}

/** EVPPI via nested Monte Carlo: value of learning ONE criterion before deciding. */
function evppi(dec: Dec, M: number, K: number, seed: number): InfoValue[] {
  const rng = mulberry32(seed);
  const W = normWeights(dec.criteria);
  const crit = dec.criteria;
  const opts = dec.options;
  const meanV = opts.map(() => 0);
  const Kb = Math.max(K, 200);
  for (let k = 0; k < Kb; k++)
    opts.forEach((o, oi) => {
      let v = 0;
      crit.forEach((c, ci) => {
        v += W[ci] * valueFn(triangular(rng, loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, dec.vp);
      });
      meanV[oi] += v;
    });
  for (let oi = 0; oi < opts.length; oi++) meanV[oi] /= Kb;
  const baseline = Math.max(...meanV);
  return crit.map((cT, cti) => {
    let outerMax = 0;
    for (let m = 0; m < M; m++) {
      const fixedU = opts.map((o) =>
        valueFn(triangular(rng, loOf(cT, o.id), cT.cells[o.id] ?? 0, hiOf(cT, o.id)) / 10, dec.vp)
      );
      const inner = opts.map(() => 0);
      for (let k = 0; k < K; k++)
        opts.forEach((o, oi) => {
          let v = W[cti] * fixedU[oi];
          crit.forEach((c, ci) => {
            if (ci !== cti)
              v += W[ci] * valueFn(triangular(rng, loOf(c, o.id), c.cells[o.id] ?? 0, hiOf(c, o.id)) / 10, dec.vp);
          });
          inner[oi] += v;
        });
      let mx = -Infinity;
      inner.forEach((s) => {
        const e = s / K;
        if (e > mx) mx = e;
      });
      outerMax += mx;
    }
    return { criterion: cT.name, value: Math.max(0, outerMax / M - baseline) * 100 };
  });
}

/** Run the full analysis from agent-friendly input. */
export function analyze(input: AnalyzeInput): AnalyzeResult {
  const warnings: string[] = [];
  const options: Opt[] = input.options.map((name, i) => ({ id: "o" + i, name }));
  const criteria: Crit[] = input.criteria.map((c, i) => {
    const cells: Record<string, number> = {};
    options.forEach((o) => {
      const s = input.scores?.[o.name]?.[c.name];
      if (typeof s === "number" && isFinite(s)) cells[o.id] = clamp(s, 0, 10);
      else {
        cells[o.id] = 5;
        warnings.push(`No score for "${o.name}" on "${c.name}" — assumed 5/10 (neutral).`);
      }
    });
    return { id: "c" + i, name: c.name, weight: c.weight, uncertainty: c.uncertainty, cells };
  });
  const vp: ValueParams = {
    model: input.model,
    risk: clamp(input.risk, -1, 1),
    rho: clamp(input.reference_point / 10, 0, 1),
    lambda: clamp(input.loss_aversion, 1, 4),
    alpha: 0.88,
  };
  const dec: Dec = { options, criteria, vp };

  const seed =
    input.seed != null
      ? input.seed >>> 0
      : hashString(JSON.stringify({ o: input.options, c: input.criteria, s: input.scores, vp }));
  const trials = clamp(Math.round(input.trials), 500, 50000);

  const sim = simulate(dec, trials, seed);
  const dom = dominance(dec);
  const tor = tornado(dec, sim);
  const ev = input.value_of_information ? evppi(dec, 140, 140, (seed ^ 0x9e3779b9) >>> 0).sort((a, b) => b.value - a.value) : [];

  const sc = (v: number): number => Math.round(v * 100);
  const ranking: OptionResult[] = sim.byEV.map((p) => ({
    name: p.name,
    pBest: p.pBest,
    pBestPct: Math.round(p.pBest * 100),
    expectedValue: sc(p.mean),
    low: sc(p.p10),
    high: sc(p.p90),
  }));
  const leader = ranking[0];
  const confidence: AnalyzeResult["confidence"] =
    leader.pBest >= 0.85 ? "confident" : leader.pBest >= 0.62 ? "leaning" : "toss-up";
  const dominated = [...new Set(dom.map((d) => d.loser))];
  const researchFirst = ev.length && ev[0].value >= 0.4 ? ev[0].criterion : null;

  const confPhrase =
    confidence === "confident" ? "a confident call" : confidence === "leaning" ? "a lean, not a lock" : "too close to call";
  const lines: string[] = [];
  lines.push(`# Decision: ${input.title || "(untitled)"}`);
  lines.push(
    `**Best bet: ${leader.name}** — wins **${leader.pBestPct}%** of ${trials.toLocaleString()} simulations (${confPhrase}). Expected value ${leader.expectedValue}/100, 80% range ${leader.low}–${leader.high}.`
  );
  lines.push("");
  lines.push("## Ranking");
  ranking.forEach((r, i) => lines.push(`${i + 1}. ${r.name} — ${r.pBestPct}% to be best · EV ${r.expectedValue}/100 (${r.low}–${r.high})`));
  if (input.value_of_information) {
    lines.push("");
    lines.push("## What to research first (value of information)");
    if (researchFirst) {
      ev.forEach((e) => lines.push(`- ${e.criterion}: ${e.value.toFixed(1)}${e.criterion === researchFirst ? "  ← resolve this first" : ""}`));
    } else {
      lines.push("- Robust: no single unknown is worth much to resolve — the decision holds across what you don't know.");
    }
  }
  const flips = tor.filter((t) => t.canFlip).map((t) => t.criterion);
  lines.push("");
  lines.push(`## What it hinges on`);
  lines.push(flips.length ? `Changing your weight on **${flips.join(", ")}** could flip the winner.` : `The winner is stable across reasonable changes in weights.`);
  if (dominated.length) {
    lines.push("");
    lines.push(`## Eliminable`);
    lines.push(`Dominated (beaten on every criterion): ${dominated.join(", ")}.`);
  }
  lines.push("");
  lines.push(
    `_Method: ${trials.toLocaleString()} Monte-Carlo trials, ${vp.model === "prospect" ? "prospect-theory (loss-averse)" : "risk-adjusted utility"} value model, seed ${seed} (reproducible)._`
  );
  if (warnings.length) {
    lines.push("");
    lines.push(`> Note: ${warnings.length} missing score(s) defaulted to 5/10.`);
  }

  return {
    title: input.title || "(untitled)",
    leader: leader.name,
    confidence,
    trials,
    seed,
    model: vp.model,
    ranking,
    dominated,
    evpi: Math.round(sim.evpi * 100 * 10) / 10,
    valueOfInformation: ev.map((e) => ({ criterion: e.criterion, value: Math.round(e.value * 10) / 10 })),
    researchFirst,
    sensitivity: tor.map((t) => ({ criterion: t.criterion, swing: Math.round(t.swing * 1000) / 1000, canFlip: t.canFlip })),
    warnings,
    markdown: lines.join("\n"),
  };
}
