import { Stride, steady } from './gait';

// Left/right comparison over blocks of steady strides — shared by the uneven-steps alert (GA-1) and
// the personal baselines. Symmetry index SI % = 100 * (R - L) / (0.5 * (R + L)) (thresholds.json).

const median = (x: number[]) => {
  const s = x.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

export const SI_KEYS: [string, keyof Stride, string, (v: number) => string][] = [
  ['floorStance', 'stance_imu_pct', 'stance (time on the ground)', (v) => `${v.toFixed(1)} % of the stride`],
  ['floorSwing', 'swing_imu_s', 'swing time', (v) => `${v.toFixed(2)} s`],
  ['floorPushoff', 'pushoff_pct', 'push-off timing', (v) => `${v.toFixed(1)} % of the stride`],
  ['floorTilt', 'tilt_range_deg', 'foot tilt range', (v) => `${v.toFixed(0)}°`],
  ['floorStride', 'stride_s', 'stride time', (v) => `${v.toFixed(2)} s`],
];

export interface GaitWindow { start: number; end: number; si: Record<string, number | null>; med: Record<string, { R: number | null; L: number | null }> }

// Blocks of `windowStrides` steady right-foot strides, each compared with the left foot's steady strides
// in the same stretch of time (each foot's measures use only its own clock).
export const gaitWindows = (R: Stride[], L: Stride[], windowStrides: number): GaitWindow[] => {
  const rebout = (xs: Stride[]) => xs.map((s) => ({ ...s, bout: 0 })).map((s, i, arr) => {
    if (i > 0) s.bout = arr[i - 1].bout + ((s.hs_ms - arr[i - 1].hs_ms) / 1000 > 2.5 ? 1 : 0);
    return s;
  });
  // the first 5 strides of a walk are speeding up (thresholds.json gait_asymmetry.exclude)
  const sr = steady(rebout(R.slice(5)));
  const sl = steady(rebout(L.slice(5)));
  const out: GaitWindow[] = [];
  for (let k = 0; (k + 1) * windowStrides <= sr.length; k++) {
    const block = sr.slice(k * windowStrides, (k + 1) * windowStrides);
    const start = block[0].hs_ms;
    const end = block[block.length - 1].hs_ms + 1000 * block[block.length - 1].stride_s;
    const lb = sl.filter((s) => s.hs_ms >= start && s.hs_ms < end);
    if (lb.length < windowStrides / 2) continue; // left foot too sparse in this stretch
    const si: Record<string, number | null> = {};
    const med: Record<string, { R: number | null; L: number | null }> = {};
    for (const [key, col] of SI_KEYS) {
      const r = median(block.map((s) => s[col] as number));
      const l = median(lb.map((s) => s[col] as number));
      med[key] = { R: r, L: l };
      si[key] = r !== null && l !== null && r + l !== 0 ? (100 * (r - l)) / (0.5 * (r + l)) : null;
    }
    out.push({ start, end, si, med });
  }
  return out;
};

