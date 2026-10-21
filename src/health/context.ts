import { Stride } from './gait';

// What the person was doing, minute by minute — shared by the day summary and the alert rules.

const MIN = 60000;

// Insole steps per minute = 2 x the strides of whichever foot detected more (one may drop out).
export const insoleStepsPerMinute = (strides: { R: Stride[]; L: Stride[] }): Map<number, number> => {
  const count = { R: new Map<number, number>(), L: new Map<number, number>() };
  for (const f of ['R', 'L'] as const) {
    for (const s of strides[f]) {
      const m = s.hs_ms - (s.hs_ms % MIN);
      count[f].set(m, (count[f].get(m) ?? 0) + 1);
    }
  }
  const out = new Map<number, number>();
  for (const m of new Set([...count.R.keys(), ...count.L.keys()])) out.set(m, 2 * Math.max(count.R.get(m) ?? 0, count.L.get(m) ?? 0));
  return out;
};

export interface ContextSpan { label: string; a: number; b: number }

// Walk / rickshaw / metro_bus spans from the one-tap toggles; a context still running ends at `now`.
export const contextSpans = (labels: { t: number; label: string }[], now: number): ContextSpan[] => {
  const spans: ContextSpan[] = [];
  const open: Record<string, number> = {};
  for (const l of [...labels].sort((x, y) => x.t - y.t)) {
    const m = l.label.match(/^(walk|rickshaw|metro_bus)_(start|stop)$/);
    if (!m) continue;
    if (m[2] === 'start') open[m[1]] = l.t;
    else if (open[m[1]] !== undefined) { spans.push({ label: m[1], a: open[m[1]], b: l.t }); delete open[m[1]]; }
  }
  for (const [label, a] of Object.entries(open)) spans.push({ label, a, b: now });
  return spans;
};

export const contextAt = (spans: ContextSpan[], m: number) => spans.find((c) => m >= c.a && m < c.b)?.label ?? null;

// The wrist band's optical HR can lock onto the arm-swing rhythm while walking and report the step
// rate instead of the pulse: |HR - insole steps/min| <= 6 for 2+ consecutive minutes (pipeline rule).
export const isCadenceLocked = (hrByMinute: Map<number, number>, steps: Map<number, number>, m: number) => {
  const cand = (k: number) => {
    const hr = hrByMinute.get(k), st = steps.get(k);
    return hr !== undefined && st !== undefined && st >= 80 && Math.abs(hr - st) <= 6;
  };
  return cand(m) && (cand(m - MIN) || cand(m + MIN));
};

// Not moving: under 10 band steps, no insole strides, and no walk/vehicle context in that minute.
export const isInactive = (bandSteps: Map<number, number>, steps: Map<number, number>, spans: ContextSpan[], m: number) =>
  (bandSteps.get(m) ?? 0) < 10 && !(steps.get(m) ?? 0) && contextAt(spans, m) === null;
