import { Stride, steady } from './gait';
import { percentile } from './signal';
import { usable } from './baselines';
import { FootStats, SI_FLOORS, SI_NAMES, WalkOpts, WalkSummary, footStats, rebout, siRange, summariseWalks } from './daySummary';

// The Gait tab for one day: left vs right for each measure (with the symmetry index and your usual
// band, the same ranges the uneven-steps alert uses), every walk, and the stride-time distribution,
// optionally scaled for body size.
//
// Body-size scaling (as in the thesis's participant comparison): stride time / √(L / g), with leg
// length L = 0.53 × height. A longer leg swings more slowly like a longer pendulum, so this takes
// body size out when strides are compared between people (or with published values).

export const LEG_FRACTION = 0.53;
const G = 9.81;
const HIST_BIN_S = 0.05;

export interface MeasureDetail {
  key: string; name: string; unit: string; digits: number;
  R: number | null; L: number | null; si: number | null;
  centre: number; limit: number; personal: boolean; uneven: boolean;
}

export interface GaitDetail {
  strides: { R: number; L: number };
  steady: { R: number; L: number };
  measures: MeasureDetail[];
  cvPct: { R: number | null; L: number | null }; // stride-time variability over steady strides
  hist: { lo: number; binS: number; R: number[]; L: number[] } | null; // stride time, seconds
  legM: number | null; // estimated leg length, when the height is set
  scaleS: number | null; // √(L / g), seconds
  medianStrideS: { R: number | null; L: number | null };
  usualStrideS: number | null;
  walks: WalkSummary[];
}

const UNITS: Record<string, [string, number]> = {
  stanceImuPct: ['% of stride', 1], swingImuS: ['s', 2], pushoffPct: ['% of stride', 1], tiltRangeDeg: ['°', 0], strideS: ['s', 2],
};

const si = (r: number | null, l: number | null) => (r === null || l === null || r + l === 0 ? null : (100 * (r - l)) / (0.5 * (r + l)));

const cv = (xs: number[]) => {
  if (xs.length < 10) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  return (100 * sd) / m;
};

export const gaitDetail = (strides: { R: Stride[]; L: Stride[] }, opts: WalkOpts & { heightM: number | null }): GaitDetail => {
  const R = [...strides.R].sort((a, b) => a.hs_ms - b.hs_ms);
  const L = [...strides.L].sort((a, b) => a.hs_ms - b.hs_ms);
  const sR = steady(rebout(R));
  const sL = steady(rebout(L));
  const feet: Record<'R' | 'L', FootStats | null> = { R: footStats(rebout(R)), L: footStats(rebout(L)) };

  const measures: MeasureDetail[] = Object.keys(SI_FLOORS).map((k) => {
    const r = feet.R ? ((feet.R as any)[k] as number | null) : null;
    const l = feet.L ? ((feet.L as any)[k] as number | null) : null;
    const v = si(r, l);
    const rg = siRange(k, opts);
    return {
      key: k, name: SI_NAMES[k], unit: UNITS[k][0], digits: UNITS[k][1], R: r, L: l, si: v, ...rg,
      uneven: v !== null && Math.abs(v - rg.centre) > rg.limit,
    };
  });

  // stride-time histogram over all detected strides, 1st–99th percentile range in 0.05 s bins
  const all = [...R, ...L].map((s) => s.stride_s).filter(Number.isFinite);
  let hist: GaitDetail['hist'] = null;
  if (all.length >= 10) {
    const lo = Math.floor(percentile(all, 1) / HIST_BIN_S) * HIST_BIN_S;
    const hi = Math.ceil(percentile(all, 99) / HIST_BIN_S) * HIST_BIN_S;
    const n = Math.max(1, Math.min(60, Math.round((hi - lo) / HIST_BIN_S)));
    const count = (xs: Stride[]) => {
      const c = Array(n).fill(0);
      for (const s of xs) {
        const b = Math.floor((s.stride_s - lo) / HIST_BIN_S + 1e-9);
        if (b >= 0 && b < n) c[b]++;
      }
      return c;
    };
    hist = { lo, binS: HIST_BIN_S, R: count(R), L: count(L) };
  }

  const legM = opts.heightM ? LEG_FRACTION * opts.heightM : null;
  const gw = opts.baselines?.gaitWalk.strideS;
  const medianOf = (xs: Stride[]) => (xs.length ? percentile(xs.map((s) => s.stride_s), 50) : null);
  return {
    strides: { R: R.length, L: L.length },
    steady: { R: sR.length, L: sL.length },
    measures,
    cvPct: { R: cv(sR.map((s) => s.stride_s)), L: cv(sL.map((s) => s.stride_s)) },
    hist,
    legM,
    scaleS: legM ? Math.sqrt(legM / G) : null,
    medianStrideS: { R: medianOf(sR), L: medianOf(sL) },
    usualStrideS: usable(gw, opts.minBaselineDays ?? 3) ? gw.median : null,
    walks: summariseWalks(R, L, opts),
  };
};
