import {
  argmaxOf, gradient, interp, lowpass, median, percentile, rollingQuantileCentered, roundHalfEven,
} from './signal';

// Port of the thesis pipeline's stride detection (daily_analysis.py: foot_tilt, detect_strides,
// steady, and analyze_gait's quality gate). Same thresholds, same field names, checked against the
// Python output on the sample sessions (__tests__/gait.test.ts).

// One foot's samples, column arrays sorted by t (utc_ms), no duplicate t.
export interface GaitSeries {
  t: number[];
  pitch: number[];
  qI: number[]; qJ: number[]; qK: number[]; qR: number[];
  heel: number[]; met1: number[]; met5: number[];
  ax: number[]; ay: number[]; az: number[];
}

export interface Stride {
  hs_ms: number; // heel strike (pressure), utc ms
  stride_s: number;
  stance_pct: number; // pressure-based
  stance_s: number;
  swing_s: number;
  stance_imu_pct: number; // IMU-based: valid even when a pressure sensor was replaced
  stance_imu_s: number;
  swing_imu_s: number;
  pushoff_pct: number;
  tilt_range_deg: number;
  pitch_range_deg: number;
  peak_acc_ms2: number;
  heel_share: number; met1_share: number; met5_share: number;
  hs_imu_ms: number; // heel-strike impact (accelerometer)
  to_imu_ms: number;
  to_fsr_ms: number;
  bout: number;
}

// Column order of the per-day strides_R.csv / strides_L.csv files.
export const STRIDE_COLS: (keyof Stride)[] = [
  'hs_ms', 'stride_s', 'stance_pct', 'stance_s', 'swing_s', 'stance_imu_pct', 'stance_imu_s', 'swing_imu_s', 'pushoff_pct',
  'tilt_range_deg', 'pitch_range_deg', 'peak_acc_ms2', 'heel_share', 'met1_share', 'met5_share', 'hs_imu_ms', 'to_imu_ms', 'to_fsr_ms', 'bout',
];

export const emptySeries = (): GaitSeries => ({
  t: [], pitch: [], qI: [], qJ: [], qK: [], qR: [], heel: [], met1: [], met5: [], ax: [], ay: [], az: [],
});

const COLS = Object.keys(emptySeries()) as (keyof GaitSeries)[];

export const sliceSeries = (d: GaitSeries, a: number, b: number): GaitSeries => {
  const out = emptySeries();
  for (const c of COLS) out[c] = d[c].slice(a, b);
  return out;
};

// Foot tilt (deg) relative to the foot's flat, loaded orientation (independent of IMU mounting and heading).
export const footTilt = (d: GaitSeries): Float64Array => {
  const n = d.t.length;
  const gx = new Float64Array(n), gy = new Float64Array(n), gz = new Float64Array(n);
  const load = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = d.qI[i], y = d.qJ[i], z = d.qK[i], w = d.qR[i];
    let a = 2 * (x * z - w * y), b = 2 * (y * z + w * x), c = 1 - 2 * (x * x + y * y);
    const norm = Math.hypot(a, b, c);
    a /= norm; b /= norm; c /= norm;
    gx[i] = a; gy[i] = b; gz[i] = c;
    load[i] = d.heel[i] + d.met1[i] + d.met5[i];
  }
  const p75 = percentile(load, 75);
  const sel: number[][] = [[], [], []];
  for (let i = 0; i < n; i++) if (load[i] >= p75) { sel[0].push(gx[i]); sel[1].push(gy[i]); sel[2].push(gz[i]); }
  let rx = median(sel[0]), ry = median(sel[1]), rz = median(sel[2]);
  const rn = Math.hypot(rx, ry, rz);
  rx /= rn; ry /= rn; rz /= rn;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dot = Math.min(1, Math.max(-1, gx[i] * rx + gy[i] * ry + gz[i] * rz));
    out[i] = (Math.acos(dot) * 180) / Math.PI;
  }
  return out;
};

// detect_strides(d, fs, normalize): heel strikes are rising edges of the plantar load (sum of the 3
// FSRs) through adaptive hysteresis thresholds; IMU measures come from foot tilt and acceleration.
export const detectStrides = (d: GaitSeries, fs: number, normalize = false): { strides: Stride[]; heelStrikes: number } => {
  const n = d.t.length;
  const raw = [d.heel, d.met1, d.met5];
  const ch = raw.map((c) => Float64Array.from(c));
  const p95 = ch.map((c) => percentile(c, 95));
  if (normalize) {
    // each sensor between its own 5th and 95th percentile: removes range differences and preload
    const p5 = ch.map((c) => percentile(c, 5));
    ch.forEach((c, k) => { for (let i = 0; i < n; i++) c[i] = (c[i] - p5[k]) / Math.max(p95[k] - p5[k], 1); });
  } else {
    // a low-range replacement sensor would barely count in the sum: rescale it to the strongest one
    const pmax = Math.max(...p95);
    ch.forEach((c, k) => {
      if (p95[k] > 5 && p95[k] < 0.25 * pmax) for (let i = 0; i < n; i++) c[i] *= pmax / p95[k];
    });
  }
  const summed = new Float64Array(n);
  for (let i = 0; i < n; i++) summed[i] = ch[0][i] + ch[1][i] + ch[2][i];
  const load = lowpass(summed, fs);

  // adaptive thresholds: rolling 5th/95th percentiles over ~10 s, computed at ~10 Hz
  const step = Math.max(1, roundHalfEven(fs / 10));
  const sub: number[] = [];
  for (let i = 0; i < n; i += step) sub.push(load[i]);
  const win = Math.max(5, Math.trunc((10 * fs) / step));
  const mp = Math.floor(win / 4);
  const loS = rollingQuantileCentered(sub, win, mp, 0.05);
  const hiS = rollingQuantileCentered(sub, win, mp, 0.95);
  const subIdx = sub.map((_, i) => i);
  const rngG = percentile(load, 95) - percentile(load, 5);
  const onTh = new Float64Array(n), offTh = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = interp(i / step, subIdx, loS);
    const hi = Math.max(interp(i / step, subIdx, hiS), lo + 0.3 * rngG); // standing still: keep apart
    onTh[i] = lo + 0.55 * (hi - lo);
    offTh[i] = lo + 0.35 * (hi - lo);
  }
  const contact = new Uint8Array(n);
  let state = load[0] > onTh[0];
  for (let i = 0; i < n; i++) {
    if (state && load[i] < offTh[i]) state = false;
    else if (!state && load[i] > onTh[i]) state = true;
    contact[i] = state ? 1 : 0;
  }
  const hs: number[] = [];
  const to: number[] = [];
  for (let i = 1; i < n; i++) {
    if (contact[i] > contact[i - 1]) hs.push(i);
    else if (contact[i] < contact[i - 1]) to.push(i);
  }

  const t = d.t;
  const fsr = normalize ? ch : raw;
  const tilt = footTilt(d);
  const tSec = t.map((v) => v / 1000);
  const tiltRate = gradient(lowpass(tilt, fs), tSec);
  const acc = new Float64Array(n);
  for (let i = 0; i < n; i++) acc[i] = Math.sqrt(d.ax[i] ** 2 + d.ay[i] ** 2 + d.az[i] ** 2);

  const rangeIdx = (lo: number, hiExcl: number, from = 0, to2 = n): number[] => {
    const idx: number[] = [];
    for (let i = from; i < to2; i++) if (t[i] >= lo && t[i] < hiExcl) idx.push(i);
    return idx;
  };
  // Heel-strike impact: peak acceleration within -200..+150 ms of the pressure heel strike.
  const impact = (h: number): number => {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (t[i] >= t[h] - 200 && t[i] <= t[h] + 150) idx.push(i);
    return idx.length >= 5 ? t[argmaxOf(acc, idx)] : NaN;
  };
  // Push-off timing: impact to peak foot tilt (maximum plantarflexion), % of stride.
  const pushoff = (a: number, b: number): number => {
    const h = impact(a);
    if (Number.isNaN(h)) return NaN;
    const T = t[b] - t[a];
    const idx = rangeIdx(h, h + 0.9 * T);
    return idx.length >= 10 ? (100 * (t[argmaxOf(tilt, idx)] - h)) / T : NaN;
  };
  // IMU toe-off: push-off rotation rate falls to half its peak, before maximum plantarflexion.
  const toeOffImu = (a: number, b: number): number => {
    const T = t[b] - t[a];
    const m = rangeIdx(t[a] + 0.3 * T, t[a] + 0.9 * T);
    if (m.length < 10) return NaN;
    const pkEnd = m.indexOf(argmaxOf(tilt, m));
    const pk = m.slice(0, pkEnd + 1);
    if (pk.length < 4) return NaN;
    let i = argmaxOf(tiltRate, pk);
    let peak = -Infinity;
    for (const j of pk) peak = Math.max(peak, tiltRate[j]);
    while (i < b && tiltRate[i] > 0.5 * peak) i++;
    return i < b ? t[i] : NaN;
  };

  const strides: Stride[] = [];
  for (let k = 0; k + 1 < hs.length; k++) {
    const a = hs[k], b = hs[k + 1];
    const strideS = (t[b] - t[a]) / 1000;
    if (strideS < 0.7 || strideS > 2.0) continue; // outside the normal walking stride range
    const toes = to.filter((v) => v > a && v < b);
    if (toes.length !== 1) continue;
    const toe = toes[0];
    let pMin = Infinity, pMax = -Infinity, accMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    const share = [0, 0, 0];
    for (let i = a; i < b; i++) {
      pMin = Math.min(pMin, d.pitch[i]); pMax = Math.max(pMax, d.pitch[i]);
      accMax = Math.max(accMax, acc[i]);
      tMin = Math.min(tMin, tilt[i]); tMax = Math.max(tMax, tilt[i]);
      for (let c = 0; c < 3; c++) share[c] += fsr[c][i];
    }
    const shareSum = share[0] + share[1] + share[2];
    const hImu = impact(a);
    const toImu = toeOffImu(a, b);
    const stImu = toImu - hImu;
    const T = t[b] - t[a];
    strides.push({
      hs_ms: t[a], stride_s: strideS,
      stance_pct: (100 * (t[toe] - t[a])) / T,
      stance_s: (t[toe] - t[a]) / 1000, swing_s: (t[b] - t[toe]) / 1000,
      stance_imu_pct: (100 * stImu) / T, stance_imu_s: stImu / 1000, swing_imu_s: strideS - stImu / 1000,
      pushoff_pct: pushoff(a, b),
      tilt_range_deg: tMax - tMin,
      pitch_range_deg: pMax - pMin,
      peak_acc_ms2: accMax,
      heel_share: share[0] / shareSum, met1_share: share[1] / shareSum, met5_share: share[2] / shareSum,
      hs_imu_ms: hImu, to_imu_ms: toImu, to_fsr_ms: t[toe],
      bout: 0,
    });
  }
  // consecutive strides (heel strikes < 2.5 s apart) form one walking bout
  let bout = 0;
  strides.forEach((s, i) => {
    if (i > 0 && (s.hs_ms - strides[i - 1].hs_ms) / 1000 > 2.5) bout++;
    s.bout = bout;
  });
  return { strides, heelStrikes: hs.length };
};

// steady(): bouts of >= 10 strides without their first/last two, and only strides within +-15 % of the
// local (11-stride, centered) median — removes split or merged strides from detection errors.
export const steady = (strides: Stride[], tol = 0.15): Stride[] => {
  const byBout = new Map<number, Stride[]>();
  for (const s of strides) byBout.set(s.bout, [...(byBout.get(s.bout) ?? []), s]);
  const out: Stride[] = [];
  for (const group of byBout.values()) {
    const n = group.length;
    if (n < 10) continue;
    const kept = group.slice(2, n - 2);
    const med = rollingQuantileCenteredNoFill(kept.map((s) => s.stride_s), 11, 5);
    kept.forEach((s, i) => {
      if (!Number.isNaN(med[i]) && Math.abs(s.stride_s - med[i]) <= tol * med[i]) out.push(s);
    });
  }
  return out;
};

// pandas rolling(w, center=True, min_periods).median() WITHOUT bfill/ffill (as steady() uses it).
const rollingQuantileCenteredNoFill = (x: number[], w: number, mp: number): number[] => {
  const left = Math.floor(w / 2);
  const right = Math.ceil(w / 2) - 1;
  return x.map((_, i) => {
    const vals = x.slice(Math.max(0, i - left), Math.min(x.length, i + right + 1));
    return vals.length >= mp ? median(vals) : NaN;
  });
};

export interface GateInfo { samples: number; rateHz: number; gapFrac: number; gated: boolean }

// analyze_gait's quality gate: the rate over the time actually streamed must be >= minRate and gaps
// > 200 ms may cover at most maxGapFrac of the span; otherwise no strides (too sparse to segment).
export const gateSeries = (t: number[], minRateHz = 80, maxGapFrac = 0.1): GateInfo => {
  const n = t.length;
  if (n < 2) return { samples: n, rateHz: 0, gapFrac: 1, gated: true };
  const dur = (t[n - 1] - t[0]) / 1000;
  let gapS = 0;
  for (let i = 1; i < n; i++) if (t[i] - t[i - 1] > 200) gapS += (t[i] - t[i - 1]) / 1000;
  const rateHz = n / Math.max(1e-9, dur - gapS);
  const gapFrac = dur > 0 ? gapS / dur : 1;
  return { samples: n, rateHz, gapFrac, gated: rateHz < minRateHz || gapFrac > maxGapFrac };
};

// Strides that span a data gap (> 200 ms) are not real strides.
export const dropStridesOverGaps = (strides: Stride[], t: number[]): Stride[] => {
  const gapEnds: number[] = [];
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 200) gapEnds.push(t[i]);
  if (!gapEnds.length) return strides;
  return strides.filter((s) => !gapEnds.some((g) => g > s.hs_ms && g <= s.hs_ms + 1000 * s.stride_s));
};

// The whole of analyze_gait for one foot's series: dedupe, gate, detect, drop gap-spanning strides.
export const analyzeFoot = (d: GaitSeries, opts: { minRateHz?: number; maxGapFrac?: number; normalize?: boolean } = {}) => {
  const gate = gateSeries(d.t, opts.minRateHz, opts.maxGapFrac);
  if (gate.gated || d.t.length < 20) return { gate, strides: [] as Stride[], heelStrikes: 0 };
  const { strides, heelStrikes } = detectStrides(d, gate.rateHz, opts.normalize);
  return { gate, strides: dropStridesOverGaps(strides, d.t), heelStrikes };
};

export interface GaitSample {
  t: number; pitch: number; qI: number; qJ: number; qK: number; qR: number;
  heel: number; met1: number; met5: number; ax: number; ay: number; az: number;
}

export interface StreamWindowResult { strides: Stride[]; gate: GateInfo; fromMs: number; toMs: number }

// Live stride detection for one foot. detect_strides needs context on both sides of a stride (its
// thresholds are rolling 10 s percentiles and the filter is zero-phase), so the stream is analysed in
// overlapping windows: every `stepMs`, the data from `contextMs` before the last emitted point to the
// newest sample is analysed, and only strides whose heel strike is at least `contextMs` older than the
// newest sample are emitted. Each stride is therefore emitted once, with context on both sides, about
// 20 s after it happened. A gap > gapResetMs (disconnect) closes the current stretch.
export class GaitStream {
  private buf = emptySeries();
  private processedUntil: number | null = null;

  constructor(
    private readonly onResult: (r: StreamWindowResult) => void,
    private readonly opts = { stepMs: 10000, contextMs: 10000, gapResetMs: 5000, minRateHz: 80, maxGapFrac: 0.1, normalize: false },
  ) {}

  push(s: GaitSample) {
    const n = this.buf.t.length;
    const last = n ? this.buf.t[n - 1] : null;
    if (last !== null && s.t <= last) return; // duplicate or out of order (the pipeline drops these too)
    if (last !== null && s.t - last > this.opts.gapResetMs) this.flush();
    if (this.processedUntil === null) this.processedUntil = s.t;
    for (const c of COLS) this.buf[c].push(s[c]);
    if (s.t - this.processedUntil >= this.opts.stepMs + this.opts.contextMs) this.run(s.t - this.opts.contextMs);
  }

  // Analyse whatever is buffered and emit every remaining stride (on disconnect, or at a gap).
  flush() {
    const n = this.buf.t.length;
    if (n && this.processedUntil !== null) this.run(this.buf.t[n - 1] + 1);
    this.buf = emptySeries();
    this.processedUntil = null;
  }

  private run(emitUntil: number) {
    const from = this.processedUntil as number;
    const t = this.buf.t;
    let a = 0;
    while (a < t.length && t[a] < from - this.opts.contextMs) a++;
    const win = sliceSeries(this.buf, a, t.length);
    const res = analyzeFoot(win, this.opts);
    this.onResult({
      strides: res.strides.filter((s) => s.hs_ms >= from && s.hs_ms < emitUntil),
      gate: res.gate, fromMs: from, toMs: emitUntil,
    });
    this.processedUntil = emitUntil;
    // keep only what the next window needs as context
    let keep = 0;
    while (keep < t.length && t[keep] < emitUntil - this.opts.contextMs) keep++;
    if (keep > 0) this.buf = sliceSeries(this.buf, keep, t.length);
  }
}
