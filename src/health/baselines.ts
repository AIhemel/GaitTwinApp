import { Stride } from './gait';
import { GaitWindow, gaitWindows } from './symmetry';

// Personal baselines (thresholds.json baseline_learning): your own "usual", learned from the last
// `windowDays` days of the app's daily files — median and MAD (median absolute deviation) per measure
// and context. Personal rules and "usual" comparisons only switch on once a measure has data from at
// least `minDays` different days. Robust z = (x - median) / (1.4826 * MAD); the MAD is floored per
// measure so a few very similar days can't make the alert hair-trigger.

export interface Stat { median: number; mad: number; n: number; days: number }
export type Place = 'indoor' | 'outdoor' | 'vehicle' | 'bedroom';
export const PLACES: Place[] = ['indoor', 'outdoor', 'vehicle', 'bedroom'];
export type EnvKey = 'pm25' | 'co2' | 'dba';

export interface Baselines {
  computedAt: number;
  days: string[]; // dates that contributed anything
  gaitSi: Record<string, Stat>; // per symmetry measure (floorStance, ...), over 60-stride windows
  gaitWalk: Record<'cadence' | 'strideS' | 'stanceR' | 'stanceL', Stat>; // per-walk medians
  sittingHr: Stat | null; // awake, not moving minutes
  sleepNights: { date: string; hr: number }[]; // mean sleeping HR per night, newest last
  envByPlace: Partial<Record<Place, Partial<Record<EnvKey, Stat>>>>;
  daily: Partial<Record<'steps' | 'awakeMeanHr' | 'sleepMeanHr' | 'waterMl' | 'uprightPct', Stat>>;
}

export interface PastDay {
  date: string;
  minutes: Record<string, string>[]; // minute_summary.csv rows
  strides: { R: Stride[]; L: Stride[] };
  summary: any | null; // daily_summary.json
}

// Smallest spread used in a robust z, so z stays meaningful when the past days were nearly identical.
export const MIN_SPREAD: Record<string, number> = { hr: 2, pm25: 5, co2: 50, dba: 3, si: 1 };

const med = (x: number[]) => {
  const s = [...x].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

// values: [day, value] pairs
export const robustStat = (values: [string, number][]): Stat | null => {
  const v = values.map(([, x]) => x).filter(Number.isFinite);
  if (!v.length) return null;
  const m = med(v);
  return { median: m, mad: med(v.map((x) => Math.abs(x - m))), n: v.length, days: new Set(values.map(([d]) => d)).size };
};

export const robustZ = (x: number, s: Stat, minSpread: number) => (x - s.median) / Math.max(1.4826 * s.mad, minSpread);

// The minute table's context column -> place class (no place model yet: toggles, walking and sleep).
export const placeOfContext = (context: string): Place =>
  context === 'sleep' ? 'bedroom'
    : context === 'rickshaw' || context === 'metro_bus' ? 'vehicle'
      : context === 'walk' || context === 'walking' ? 'outdoor' : 'indoor';

const num = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s));

// A minute-table row taken while sitting still and awake: no sleep, walk or vehicle, under 10 band
// steps, no insole strides, and no cadence lock. Its heart rate is the "sitting heart rate".
export const isRestingMinute = (m: Record<string, string>) =>
  !['sleep', 'walk', 'walking', 'rickshaw', 'metro_bus'].includes(m.context ?? '')
  && !(num(m.steps_band) >= 10) && !(num(m.steps_insole) > 0) && m.hr_cadence_lock !== '1';

// Walks: strides of either foot, split where nothing was detected for > 60 s.
export const walksOf = (strides: { R: Stride[]; L: Stride[] }) => {
  const all = [...strides.R, ...strides.L].sort((a, b) => a.hs_ms - b.hs_ms);
  const walks: [number, number][] = [];
  for (const s of all) {
    const w = walks[walks.length - 1];
    if (w && s.hs_ms - w[1] <= 60000) w[1] = s.hs_ms; else walks.push([s.hs_ms, s.hs_ms]);
  }
  return walks;
};

export interface WalkStat { start: number; end: number; wins: GaitWindow[]; strideS: number; cadence: number; stanceR: number; stanceL: number }

// Each walk long enough for at least one left/right window: its symmetry windows and medians.
export const walkStats = (strides: { R: Stride[]; L: Stride[] }, windowStrides: number): WalkStat[] => {
  const out: WalkStat[] = [];
  for (const [a, b] of walksOf(strides)) {
    const R = strides.R.filter((s) => s.hs_ms >= a && s.hs_ms <= b);
    const L = strides.L.filter((s) => s.hs_ms >= a && s.hs_ms <= b);
    const wins = gaitWindows(R, L, windowStrides);
    if (!wins.length) continue;
    const strideS = med([...R, ...L].map((s) => s.stride_s));
    out.push({
      start: a, end: b, wins, strideS, cadence: 120 / strideS,
      stanceR: med(wins.map((w) => w.med.floorStance.R as number)),
      stanceL: med(wins.map((w) => w.med.floorStance.L as number)),
    });
  }
  return out;
};

export const buildBaselines = (days: PastDay[], windowStrides = 60, now = Date.now()): Baselines => {
  const si: Record<string, [string, number][]> = {};
  const walk: Record<string, [string, number][]> = { cadence: [], strideS: [], stanceR: [], stanceL: [] };
  const sitting: [string, number][] = [];
  const env: Record<string, [string, number][]> = {};
  const daily: Record<string, [string, number][]> = {};
  const nights: { date: string; hr: number }[] = [];
  const used = new Set<string>();

  for (const day of days) {
    // ---- gait: symmetry per 60-stride block, and each walk's medians
    for (const w of walkStats(day.strides, windowStrides)) {
      for (const win of w.wins) for (const [k, v] of Object.entries(win.si)) if (v !== null) (si[k] ??= []).push([day.date, v]);
      used.add(day.date);
      walk.cadence.push([day.date, w.cadence]);
      walk.strideS.push([day.date, w.strideS]);
      walk.stanceR.push([day.date, w.stanceR]);
      walk.stanceL.push([day.date, w.stanceL]);
    }
    // ---- minutes: sitting heart rate, environment per place
    for (const m of day.minutes) {
      const hr = num(m.hr);
      if (Number.isFinite(hr) && isRestingMinute(m)) { sitting.push([day.date, hr]); used.add(day.date); }
      const place = placeOfContext(m.context ?? '');
      for (const k of ['pm25', 'co2_ppm', 'dba'] as const) {
        const v = num(m[k]);
        if (Number.isFinite(v)) { (env[`${place}.${k === 'co2_ppm' ? 'co2' : k}`] ??= []).push([day.date, v]); used.add(day.date); }
      }
    }
    // ---- daily totals
    const s = day.summary;
    if (s) {
      const steps = s.gait?.stepsBand ?? s.gait?.stepsInsole ?? null;
      const add = (k: string, v: number | null | undefined) => {
        if (v !== null && v !== undefined && Number.isFinite(v)) { (daily[k] ??= []).push([day.date, v]); used.add(day.date); }
      };
      if (steps) add('steps', steps);
      add('awakeMeanHr', s.heart?.awakeMeanHr);
      add('sleepMeanHr', s.heart?.sleepMeanHr);
      add('waterMl', s.hydration?.totalMl);
      add('uprightPct', s.posture?.uprightPct);
      if (Number.isFinite(s.heart?.sleepMeanHr)) nights.push({ date: day.date, hr: s.heart.sleepMeanHr });
    }
  }

  const stats = (o: Record<string, [string, number][]>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, robustStat(v)]).filter(([, v]) => v !== null)) as Record<string, Stat>;
  const envByPlace: Baselines['envByPlace'] = {};
  for (const [key, st] of Object.entries(stats(env))) {
    const [place, k] = key.split('.') as [Place, EnvKey];
    (envByPlace[place] ??= {})[k] = st;
  }
  return {
    computedAt: now,
    days: [...used].sort(),
    gaitSi: stats(si),
    gaitWalk: stats(walk) as Baselines['gaitWalk'],
    sittingHr: robustStat(sitting),
    sleepNights: nights.sort((a, b) => a.date.localeCompare(b.date)),
    envByPlace,
    daily: stats(daily),
  };
};

// The baseline value for sleeping HR: median of the last `nights` nights' means (thresholds.json).
export const sleepingHrBaseline = (b: Baselines | null, nights: number): { median: number; nights: number } | null => {
  const last = (b?.sleepNights ?? []).slice(-nights);
  return last.length ? { median: med(last.map((x) => x.hr)), nights: last.length } : null;
};

// A stat is usable for personal comparisons once it has data from enough different days.
export const usable = (s: Stat | null | undefined, minDays: number): s is Stat => !!s && s.days >= minDays;
