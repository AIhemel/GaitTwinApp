import { UPRIGHT_POSES } from './posture';

// The Timeline tab: one day as one picture. A 24-hour ribbon of what you were doing (from the minute
// table's context and posture columns), with heart rate, PM2.5 and steps in 5-minute bins under it and
// pins for drinks, alerts and your own taps. Built from the day's files, so it works for any past day.

const MIN = 60000;
export const BINS = 288; // 5-minute bins
const BIN_MIN = 5;

export type CtxKind = 'sleep' | 'walk' | 'rickshaw' | 'metro_bus' | 'seated_upright' | 'seated_poor' | 'other' | 'none';

export const CTX_STYLE: Record<CtxKind, { label: string; color: string }> = {
  sleep: { label: 'Sleep', color: '#5a67d8' },
  walk: { label: 'Walking', color: '#38a169' },
  rickshaw: { label: 'Rickshaw', color: '#dd6b20' },
  metro_bus: { label: 'Metro / bus', color: '#d53f8c' },
  seated_upright: { label: 'Seated upright', color: '#319795' },
  seated_poor: { label: 'Seated, slouched or leaning', color: '#d69e2e' },
  other: { label: 'Awake, other', color: '#a0aec0' },
  none: { label: 'No data', color: '#edf2f7' },
};

export interface Pin { t: number; kind: 'drink' | 'alert' | 'tap'; text: string; severity?: string }

export interface Timeline {
  dayStart: number;
  context: { from: number; to: number; kind: CtxKind }[]; // minute indexes, [from, to)
  contextMin: Partial<Record<CtxKind, number>>;
  hr: (number | null)[];
  pm25: (number | null)[];
  steps: (number | null)[];
  stepsSource: 'band' | 'insoles' | null;
  pins: Pin[];
}

const DATA_COLS = ['hr', 'steps_band', 'steps_insole', 'co2_ppm', 'pm25', 'dba', 'posture', 'gps_speed_mps'];

const kindOf = (m: Record<string, string>): CtxKind => {
  const c = m.context ?? '';
  if (c === 'sleep') return 'sleep';
  if (c === 'walk' || c === 'walking') return 'walk';
  if (c === 'rickshaw' || c === 'metro_bus') return c;
  if (m.posture) return (UPRIGHT_POSES as string[]).includes(m.posture) ? 'seated_upright' : 'seated_poor';
  if (c || DATA_COLS.some((k) => m[k])) return 'other';
  return 'none';
};

const pretty = (label: string) => label.replace(/_/g, ' ');

export const buildTimeline = (
  dayStart: number,
  minutes: Record<string, string>[],
  alerts: { t: number; title: string; severity: string }[],
  labels: { t: number; label: string; note: string }[],
): Timeline => {
  const kinds: CtxKind[] = Array(1440).fill('none');
  const acc = { hr: [] as [number, number][], pm25: [] as [number, number][], steps: [] as number[] };
  for (let i = 0; i < BINS; i++) { acc.hr.push([0, 0]); acc.pm25.push([0, 0]); acc.steps.push(NaN); }
  const hasBand = minutes.some((m) => m.steps_band);
  const hasInsole = minutes.some((m) => m.steps_insole && Number(m.steps_insole) > 0);
  const stepCol = hasBand ? 'steps_band' : 'steps_insole';
  const pins: Pin[] = [];
  const bottleDrinks: number[] = [];

  for (const m of minutes) {
    const t = Date.parse(m.minute);
    const i = Math.round((t - dayStart) / MIN);
    if (!Number.isFinite(i) || i < 0 || i >= 1440) continue;
    kinds[i] = kindOf(m);
    const b = Math.floor(i / BIN_MIN);
    if (m.hr) { acc.hr[b][0] += Number(m.hr); acc.hr[b][1]++; }
    if (m.pm25) { acc.pm25[b][0] += Number(m.pm25); acc.pm25[b][1]++; }
    if (m[stepCol]) acc.steps[b] = (Number.isNaN(acc.steps[b]) ? 0 : acc.steps[b]) + Number(m[stepCol]);
    const ml = Number(m.water_ml);
    if (m.water_ml && ml > 0) { pins.push({ t, kind: 'drink', text: `${ml.toFixed(0)} mL` }); bottleDrinks.push(t); }
  }

  // a tapped drink within 10 min of a bottle drink is the same drink (as in the day summary)
  for (const l of labels) {
    if (l.label === 'drink') {
      if (!bottleDrinks.some((t) => Math.abs(t - l.t) <= 10 * MIN)) pins.push({ t: l.t, kind: 'drink', text: 'drink (tapped)' });
    } else {
      pins.push({ t: l.t, kind: 'tap', text: l.note ? `${pretty(l.label)}: ${l.note}` : pretty(l.label) });
    }
  }
  for (const a of alerts) pins.push({ t: a.t, kind: 'alert', text: a.title, severity: a.severity });

  const context: Timeline['context'] = [];
  const contextMin: Timeline['contextMin'] = {};
  kinds.forEach((k, i) => {
    const last = context[context.length - 1];
    if (last && last.kind === k) last.to = i + 1; else context.push({ from: i, to: i + 1, kind: k });
    if (k !== 'none') contextMin[k] = (contextMin[k] ?? 0) + 1;
  });

  const avg = ([s, n]: [number, number]) => (n ? s / n : null);
  return {
    dayStart, context, contextMin,
    hr: acc.hr.map(avg),
    pm25: acc.pm25.map(avg),
    steps: acc.steps.map((x) => (Number.isNaN(x) ? null : x)),
    stepsSource: hasBand ? 'band' : hasInsole ? 'insoles' : null,
    pins: pins.filter((p) => p.t >= dayStart && p.t < dayStart + 1440 * MIN).sort((a, b) => a.t - b.t),
  };
};
