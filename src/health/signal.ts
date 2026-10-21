// Numerical building blocks matching the NumPy / SciPy / pandas calls in the thesis pipeline
// (handoff/reference/pipeline/daily_analysis.py), so ported analyses give the same numbers.
// Each is checked against values computed by those libraries (__tests__/signal.test.ts).

// scipy.signal.butter(2, Wn) low-pass, Wn = cutoff / Nyquist.
export const butter2Lowpass = (wn: number): { b: number[]; a: number[] } => {
  const k = Math.tan((Math.PI * wn) / 2);
  const k2 = k * k;
  const norm = 1 / (1 + Math.SQRT2 * k + k2);
  const b0 = k2 * norm;
  return { b: [b0, 2 * b0, b0], a: [1, 2 * (k2 - 1) * norm, (1 - Math.SQRT2 * k + k2) * norm] };
};

// scipy.signal.lfilter for a 2nd-order section (a[0] = 1), with initial state z.
const lfilter2 = (b: number[], a: number[], x: ArrayLike<number>, z0: number, z1: number): Float64Array => {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b[0] * xi + z0;
    z0 = b[1] * xi + z1 - a[1] * yi;
    z1 = b[2] * xi - a[2] * yi;
    y[i] = yi;
  }
  return y;
};

// scipy.signal.lfilter_zi for a 2nd-order section: the steady state for a unit-step input.
const lfilterZi2 = (b: number[], a: number[]): [number, number] => {
  // (I - companion(a).T) zi = b[1:] - a[1:] * b[0]
  const m00 = 1 + a[1], m01 = -1, m10 = a[2], m11 = 1;
  const r0 = b[1] - a[1] * b[0], r1 = b[2] - a[2] * b[0];
  const det = m00 * m11 - m01 * m10;
  return [(r0 * m11 - m01 * r1) / det, (m00 * r1 - m10 * r0) / det];
};

// scipy.signal.filtfilt(b, a, x) with the defaults: odd extension of 3 * max(len(a), len(b)) samples
// at both ends, steady-state initial conditions, forward then backward pass (zero phase).
export const filtfilt = (b: number[], a: number[], x: ArrayLike<number>): Float64Array => {
  const n = x.length;
  const edge = 3 * Math.max(a.length, b.length);
  if (n <= edge) return Float64Array.from(x); // SciPy refuses series this short; leave it unfiltered
  const ext = new Float64Array(n + 2 * edge);
  for (let i = 0; i < edge; i++) ext[i] = 2 * x[0] - x[edge - i];
  for (let i = 0; i < n; i++) ext[edge + i] = x[i];
  for (let i = 0; i < edge; i++) ext[edge + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  const [zi0, zi1] = lfilterZi2(b, a);
  const fwd = lfilter2(b, a, ext, zi0 * ext[0], zi1 * ext[0]);
  fwd.reverse();
  const back = lfilter2(b, a, fwd, zi0 * fwd[0], zi1 * fwd[0]);
  back.reverse();
  return back.slice(edge, edge + n);
};

// The pipeline's lowpass(x, fs, fc=6): 2nd-order Butterworth, zero phase.
export const lowpass = (x: ArrayLike<number>, fs: number, fc = 6): Float64Array => {
  const { b, a } = butter2Lowpass(fc / (fs / 2));
  return filtfilt(b, a, x);
};

// Linear-interpolated quantile of an already sorted array (NumPy/pandas 'linear').
const sortedQuantile = (s: number[], q: number): number => {
  if (!s.length) return NaN;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

// numpy.percentile(x, p) (linear), NaN values ignored.
export const percentile = (x: ArrayLike<number>, p: number): number => {
  const s: number[] = [];
  for (let i = 0; i < x.length; i++) if (!Number.isNaN(x[i])) s.push(x[i]);
  s.sort((u, v) => u - v);
  return sortedQuantile(s, p / 100);
};

export const median = (x: ArrayLike<number>): number => percentile(x, 50);

// pandas Series.rolling(w, center=True, min_periods=mp).quantile(q).bfill().ffill():
// the window for index i covers [i - floor(w/2), i + ceil(w/2) - 1].
export const rollingQuantileCentered = (x: ArrayLike<number>, w: number, mp: number, q: number): Float64Array => {
  const n = x.length;
  const out = new Float64Array(n).fill(NaN);
  const left = Math.floor(w / 2);
  const right = Math.ceil(w / 2) - 1;
  for (let i = 0; i < n; i++) {
    const vals: number[] = [];
    for (let j = Math.max(0, i - left); j <= Math.min(n - 1, i + right); j++) if (!Number.isNaN(x[j])) vals.push(x[j]);
    if (vals.length >= mp) {
      vals.sort((u, v) => u - v);
      out[i] = sortedQuantile(vals, q);
    }
  }
  // bfill then ffill
  for (let i = n - 2; i >= 0; i--) if (Number.isNaN(out[i])) out[i] = out[i + 1];
  for (let i = 1; i < n; i++) if (Number.isNaN(out[i])) out[i] = out[i - 1];
  return out;
};

// numpy.interp(xq, xp, fp) for increasing xp; clamps outside the range.
export const interp = (xq: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number => {
  const n = xp.length;
  if (xq <= xp[0]) return fp[0];
  if (xq >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1; // eslint-disable-line no-bitwise
    if (xp[mid] <= xq) lo = mid; else hi = mid;
  }
  return fp[lo] + ((fp[hi] - fp[lo]) * (xq - xp[lo])) / (xp[hi] - xp[lo]);
};

// numpy.gradient(f, x) with a coordinate array (second order inside, first order at the edges).
export const gradient = (f: ArrayLike<number>, x: ArrayLike<number>): Float64Array => {
  const n = f.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  out[0] = (f[1] - f[0]) / (x[1] - x[0]);
  out[n - 1] = (f[n - 1] - f[n - 2]) / (x[n - 1] - x[n - 2]);
  for (let i = 1; i < n - 1; i++) {
    const h1 = x[i] - x[i - 1];
    const h2 = x[i + 1] - x[i];
    out[i] = (-h2 / (h1 * (h1 + h2))) * f[i - 1] + ((h2 - h1) / (h1 * h2)) * f[i] + (h1 / (h2 * (h1 + h2))) * f[i + 1];
  }
  return out;
};

// Python's round(): halves go to the even neighbour.
export const roundHalfEven = (v: number): number => {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

// Index of the first maximum (numpy.argmax) over x[i] for i in idx.
export const argmaxOf = (x: ArrayLike<number>, idx: number[]): number => {
  let best = -1;
  for (const i of idx) if (best < 0 || x[i] > x[best]) best = i;
  return best;
};
