// Wrist-band data from Health Connect (heart rate, SpO₂, steps, sleep), cleaned the way the thesis
// pipeline does it (daily_analysis.py: load_wearable, analyze_sleep):
//   - repeated syncs append identical rows -> drop duplicates
//   - several apps write overlapping steps -> pick ONE source per type, never sum across sources
//     (the band via Gadgetbridge when present, otherwise the source with the most rows)
//   - the band re-exports a growing sleep session -> keep the longest of overlapping copies, and join
//     parts less than 4 h apart into one night

export interface FitRowLite {
  start: string; // ISO
  end: string;
  dataType: string;
  value: number | null;
  sourceApp: string;
  extraJSON: string;
}

export interface HeartData {
  hrByMinute: Map<number, number>; // minute start (ms) -> mean bpm
  stepsByMinute: Map<number, number>;
  spo2: { t: number; v: number }[];
  sleep: SleepNight | null;
}

export interface SleepNight {
  start: number;
  end: number;
  inBedMin: number;
  asleepMin: number;
  stageMin: Record<string, number>;
  segments: [number, number][];
}

const SLEEP_STAGES: Record<number, string> = { 1: 'awake', 2: 'sleeping', 3: 'out_of_bed', 4: 'light', 5: 'deep', 6: 'rem', 7: 'awake_in_bed' };
const NOT_ASLEEP = ['awake', 'awake_in_bed', 'out_of_bed'];

const minuteOf = (ms: number) => ms - (ms % 60000);

export const dedupeRows = (rows: FitRowLite[]): FitRowLite[] => {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.start}|${r.end}|${r.dataType}|${r.sourceApp}|${r.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// The band (Gadgetbridge) if it wrote this type, otherwise the busiest source.
export const pickSource = (rows: FitRowLite[]): string | null => {
  if (!rows.length) return null;
  const band = rows.find((r) => r.sourceApp.includes('gadgetbridge'));
  if (band) return band.sourceApp;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.sourceApp, (counts.get(r.sourceApp) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

// analyze_sleep's night: sleep sessions ending after `dayStart` and starting before dayStart + 14 h.
const pickNight = (sessions: FitRowLite[], dayStart: number): SleepNight | null => {
  const ss = sessions
    .map((r) => ({ r, s: Date.parse(r.start), e: Date.parse(r.end), v: r.value ?? 0 }))
    .filter((x) => x.e > dayStart && x.s < dayStart + 14 * 3600000);
  if (!ss.length) return null;
  const parts: typeof ss = [];
  for (const x of [...ss].sort((a, b) => b.v - a.v)) if (!parts.some((p) => x.s < p.e && x.e > p.s)) parts.push(x);
  parts.sort((a, b) => a.s - b.s);
  const first = parts.reduce((bi, p, i) => (p.v > parts[bi].v ? i : bi), 0);
  const night = [parts[first]];
  for (const p of parts.slice(first + 1)) if (p.s - night[night.length - 1].e <= 4 * 3600000) night.push(p);
  for (const p of parts.slice(0, first).reverse()) if (night[0].s - p.e <= 4 * 3600000) night.unshift(p);
  const stageMin: Record<string, number> = {};
  for (const p of night) {
    let stages: any[] = [];
    try { stages = JSON.parse(p.r.extraJSON || '{}').stages ?? []; } catch { stages = []; }
    for (const st of stages) {
      const name = SLEEP_STAGES[st.stage] ?? 'unknown';
      stageMin[name] = (stageMin[name] ?? 0) + (Date.parse(st.endTime) - Date.parse(st.startTime)) / 60000;
    }
  }
  const asleepMin = Object.entries(stageMin).filter(([k]) => !NOT_ASLEEP.includes(k)).reduce((s, [, v]) => s + v, 0);
  return {
    start: night[0].s, end: night[night.length - 1].e,
    inBedMin: night.reduce((s, p) => s + p.v, 0),
    asleepMin, stageMin, segments: night.map((p) => [p.s, p.e] as [number, number]),
  };
};

export const buildHeartData = (allRows: FitRowLite[], dayStart: number, dayEnd: number): HeartData => {
  const rows = dedupeRows(allRows);
  const inDay = (r: FitRowLite) => { const t = Date.parse(r.start); return t >= dayStart && t < dayEnd; };

  const hrRows = rows.filter((r) => r.dataType === 'HEART_RATE' && r.value !== null);
  const hrSrc = pickSource(hrRows);
  const hrAcc = new Map<number, [number, number]>();
  for (const r of hrRows) {
    if (r.sourceApp !== hrSrc || !inDay(r)) continue;
    const m = minuteOf(Date.parse(r.start));
    const a = hrAcc.get(m) ?? [0, 0];
    hrAcc.set(m, [a[0] + (r.value as number), a[1] + 1]);
  }
  const stepRows = rows.filter((r) => r.dataType === 'STEPS' && r.value !== null);
  const stepSrc = pickSource(stepRows);
  const stepsByMinute = new Map<number, number>();
  for (const r of stepRows) {
    if (r.sourceApp !== stepSrc || !inDay(r)) continue;
    const m = minuteOf(Date.parse(r.start));
    stepsByMinute.set(m, (stepsByMinute.get(m) ?? 0) + (r.value as number));
  }
  return {
    hrByMinute: new Map([...hrAcc].map(([m, [s, n]]) => [m, s / n])),
    stepsByMinute,
    spo2: rows.filter((r) => r.dataType === 'OXYGEN_SATURATION' && r.value !== null && inDay(r))
      .map((r) => ({ t: Date.parse(r.start), v: r.value as number })).sort((a, b) => a.t - b.t),
    sleep: pickNight(rows.filter((r) => r.dataType === 'SLEEP_SESSION'), dayStart),
  };
};

// Parses the app's own Health Connect CSV (FitData/Fit_YYYY-MM-DD.csv), which quotes ExtraJSON.
export const parseFitCsv = (text: string): FitRowLite[] => {
  const out: FitRowLite[] = [];
  const lines = text.split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const f: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { f.push(cur); cur = ''; } else cur += c;
    }
    f.push(cur.replace(/\r$/, ''));
    if (f.length < 7) continue;
    out.push({ start: f[0], end: f[1], dataType: f[2], value: f[3] === '' ? null : Number(f[3]), sourceApp: f[5], extraJSON: f[6] });
  }
  return out;
};
