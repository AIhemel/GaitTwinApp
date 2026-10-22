import { PastDay, isRestingMinute, robustStat, walkStats } from './baselines';
import { leq } from './environment';

// Trends: one value per day for each headline measure, drawn against your usual range. The values are
// computed from the same daily files (and the same walk and resting-minute definitions) as the
// personal baselines, so a day that looks "unusual" here is unusual by the alerts' standard too.
//
// Usual range = median of the previous `windowDays` recorded days ± USUAL_K robust SDs, where robust
// SD = 1.4826 × MAD (median absolute deviation), floored at the measure's minSpread. Shown only once
// the measure has values from at least `minDays` days.

export const USUAL_K = 2;

export interface DayMetrics {
  date: string;
  steps: number | null; cadence: number | null; stanceSi: number | null;
  awakeHr: number | null; sleepHr: number | null; sittingHr: number | null;
  sleepH: number | null; waterMl: number | null; uprightPct: number | null;
  pm25: number | null; co2: number | null; dba: number | null;
}
export type MetricKey = Exclude<keyof DayMetrics, 'date'>;

export interface MetricDef {
  key: MetricKey; label: string; unit: string; digits: number; minSpread: number;
  group: 'Movement' | 'Heart & sleep' | 'Hydration & posture' | 'Environment';
  note: string;
}

export const TREND_METRICS: MetricDef[] = [
  { key: 'steps', label: 'Steps', unit: '', digits: 0, minSpread: 500, group: 'Movement', note: 'Band steps; insole steps on days without the band.' },
  { key: 'cadence', label: 'Walking cadence', unit: 'steps/min', digits: 0, minSpread: 2, group: 'Movement', note: 'Median over walks long enough for a left/right comparison.' },
  { key: 'stanceSi', label: 'Stance difference R vs L', unit: '%', digits: 1, minSpread: 1, group: 'Movement', note: 'Symmetry index of IMU stance time over 60-stride blocks; 0 = even.' },
  { key: 'sittingHr', label: 'Sitting heart rate', unit: 'bpm', digits: 0, minSpread: 2, group: 'Heart & sleep', note: 'Median HR while awake and not moving.' },
  { key: 'awakeHr', label: 'Awake heart rate', unit: 'bpm', digits: 0, minSpread: 2, group: 'Heart & sleep', note: 'Mean HR while awake (cadence-locked minutes removed).' },
  { key: 'sleepHr', label: 'Sleeping heart rate', unit: 'bpm', digits: 0, minSpread: 2, group: 'Heart & sleep', note: 'Mean HR during the night that ended that morning.' },
  { key: 'sleepH', label: 'Sleep', unit: 'h', digits: 1, minSpread: 0.25, group: 'Heart & sleep', note: 'Time asleep from the band.' },
  { key: 'waterMl', label: 'Water', unit: 'mL', digits: 0, minSpread: 150, group: 'Hydration & posture', note: 'Smart-bottle log.' },
  { key: 'uprightPct', label: 'Upright sitting', unit: '%', digits: 0, minSpread: 5, group: 'Hydration & posture', note: 'Share of cushion time sitting upright.' },
  { key: 'pm25', label: 'PM2.5 (day mean)', unit: 'µg/m³', digits: 0, minSpread: 5, group: 'Environment', note: 'Mean over the minutes the environment node measured.' },
  { key: 'co2', label: 'CO₂ (day mean)', unit: 'ppm', digits: 0, minSpread: 50, group: 'Environment', note: 'Mean over the minutes the environment node measured.' },
  { key: 'dba', label: 'Noise (day Leq)', unit: 'dBA', digits: 0, minSpread: 3, group: 'Environment', note: 'Energy average of the measured minutes.' },
];

const num = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s));
const finite = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : null);
const med = (x: number[]) => {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};
const col = (minutes: Record<string, string>[], k: string, keep: (m: Record<string, string>) => boolean = () => true) =>
  minutes.filter(keep).map((m) => num(m[k])).filter(Number.isFinite);

export const dayMetrics = (day: PastDay, windowStrides: number): DayMetrics => {
  const s = day.summary ?? {};
  const walks = walkStats(day.strides, windowStrides);
  const si = walks.flatMap((w) => w.wins.map((x) => x.si.floorStance)).filter((v): v is number => v !== null);
  const steps = finite(s.gait?.stepsBand) ?? (finite(s.gait?.stepsInsole) || null);
  const asleep = finite(s.sleep?.asleepMin);
  return {
    date: day.date,
    steps,
    cadence: med(walks.map((w) => w.cadence)),
    stanceSi: med(si),
    awakeHr: finite(s.heart?.awakeMeanHr),
    sleepHr: finite(s.heart?.sleepMeanHr),
    sittingHr: med(col(day.minutes, 'hr', isRestingMinute)),
    sleepH: asleep === null ? null : asleep / 60,
    waterMl: finite(s.hydration?.totalMl),
    uprightPct: finite(s.posture?.uprightPct),
    pm25: mean(col(day.minutes, 'pm25')),
    co2: mean(col(day.minutes, 'co2_ppm')),
    dba: leq(col(day.minutes, 'dba')),
  };
};

export interface UsualBand { median: number; lo: number; hi: number; days: number }

// Your usual range for one measure as of `asOf`: from the last `windowDays` recorded days before it.
export const usualBand = (
  metrics: DayMetrics[], key: MetricKey, asOf: string, opts: { windowDays: number; minDays: number },
): UsualBand | null => {
  const def = TREND_METRICS.find((m) => m.key === key)!;
  const past = metrics.filter((m) => m.date < asOf && m[key] !== null).sort((a, b) => b.date.localeCompare(a.date)).slice(0, opts.windowDays);
  const st = robustStat(past.map((m) => [m.date, m[key] as number]));
  if (!st || st.days < opts.minDays) return null;
  const half = USUAL_K * Math.max(1.4826 * st.mad, def.minSpread);
  return { median: st.median, lo: st.median - half, hi: st.median + half, days: st.days };
};

// The calendar days of a view: `n` days ending at `end` (YYYY-MM-DD, local).
export const lastDates = (end: string, n: number): string[] => {
  const [y, m, d] = end.split('-').map(Number);
  return [...Array(n)].map((_, i) => {
    const t = new Date(y, m - 1, d - (n - 1 - i));
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  });
};

export interface TrendPoint { date: string; value: number | null; outside: 'above' | 'below' | null }
export interface TrendSeries { def: MetricDef; points: TrendPoint[]; band: UsualBand | null; outsideDays: number; days: number }

export const trendSeries = (
  metrics: DayMetrics[], def: MetricDef, dates: string[], opts: { windowDays: number; minDays: number },
): TrendSeries => {
  const byDate = new Map(metrics.map((m) => [m.date, m]));
  const band = usualBand(metrics, def.key, dates[dates.length - 1], opts);
  const points = dates.map((date) => {
    const value = byDate.get(date)?.[def.key] ?? null;
    const outside = value === null || !band ? null : value > band.hi ? 'above' : value < band.lo ? 'below' : null;
    return { date, value, outside } as TrendPoint;
  });
  return {
    def, points, band,
    outsideDays: points.filter((p) => p.outside).length,
    days: points.filter((p) => p.value !== null).length,
  };
};
