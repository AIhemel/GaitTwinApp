import RNFS from 'react-native-fs';
import { STRIDE_COLS, Stride } from './gait';
import { PastDay } from './baselines';
import { DayMetrics, dayMetrics } from './trends';
import { FSR_FILE, FsrMinute, parseFsrRow } from './fsr';
import { ConnectionRow, StreamStatRow, parseConnectionRow, parseStreamStatRow } from './dayQuality';
import { DAILY_DIR, parseCsvText } from '../services/DailyStore';
import { CONNECTIONS_FILE, STREAM_STATS_FILE } from '../services/DailyLogs';
import { LABELS_FILE } from '../services/Labels.constants';
import { readJson, writeJsonAtomic } from '../services/SessionMeta';
import type { AlertResponse } from './notify';

// Reading a day back from Downloads/GaitTwin/daily/<date>/ — for the baselines, and for the Timeline,
// Gait, Trends and Data tabs (which show any recorded or imported day, not only today).

export const dayStartOfDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

const readRows = async (path: string): Promise<string[][]> =>
  ((await RNFS.exists(path)) ? parseCsvText(await RNFS.readFile(path, 'utf8')).slice(1).filter((r) => r.length > 1 || r[0]) : []);

// CSV rows as {column: value}, skipping rows with the wrong number of fields.
export const readCsvObjects = async (path: string): Promise<Record<string, string>[]> => {
  if (!(await RNFS.exists(path))) return [];
  const [head, ...rows] = parseCsvText(await RNFS.readFile(path, 'utf8'));
  if (!head) return [];
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};

export const readStrides = async (dir: string, side: 'R' | 'L'): Promise<Stride[]> =>
  (await readRows(`${dir}/strides_${side}.csv`)).map((f) => {
    const s = {} as Record<string, number>;
    STRIDE_COLS.forEach((c, i) => { s[c] = f[i] === '' || f[i] === undefined ? NaN : Number(f[i]); });
    return s as unknown as Stride;
  });

export const readPastDay = async (date: string): Promise<PastDay> => {
  const dir = `${DAILY_DIR}/${date}`;
  return {
    date,
    minutes: await readCsvObjects(`${dir}/minute_summary.csv`),
    strides: { R: await readStrides(dir, 'R'), L: await readStrides(dir, 'L') },
    summary: await readJson(`${dir}/daily_summary.json`),
  };
};

export interface AlertRow {
  id: string; t: number; rule: string; target: string; severity: string; delivered: boolean; reason: string; title: string; body: string;
  values: string; onsetMs: number | null; dueMs: number | null; // event times: empty in alerts logged before they were recorded
  response: AlertResponse | null; respondedAt: number | null;
}

const msOrNull = (s: string | undefined) => (s === undefined || s === '' || !Number.isFinite(Number(s)) ? null : Number(s));

// The day's alerts with the user's answer (the latest one, if an alert was answered twice).
export const readAlerts = async (date: string): Promise<AlertRow[]> => {
  const responses = new Map<string, [AlertResponse, number]>();
  for (const r of await readRows(`${DAILY_DIR}/${date}/alert_responses.csv`)) {
    const prev = responses.get(r[0]);
    if (r.length >= 3 && (!prev || Number(r[1]) >= prev[1])) responses.set(r[0], [r[2] as AlertResponse, Number(r[1])]);
  }
  return (await readRows(`${DAILY_DIR}/${date}/alerts.csv`)).filter((r) => r.length >= 9).map((r) => ({
    id: r[0], t: Number(r[1]), rule: r[2], target: r[3], severity: r[4], delivered: r[5] === '1', reason: r[6], title: r[7], body: r[8],
    values: r[9] ?? '', onsetMs: msOrNull(r[11]), dueMs: msOrNull(r[12]),
    response: responses.get(r[0])?.[0] ?? null, respondedAt: responses.get(r[0])?.[1] ?? null,
  }));
};

export const readLabels = async (date: string) =>
  (await readRows(`${DAILY_DIR}/${date}/${LABELS_FILE}`)).map((f) => ({ t: Number(f[0]), label: f[1], note: f.slice(2).join(',') }));

export interface DayFiles {
  date: string; dayStart: number;
  minutes: Record<string, string>[];
  strides: { R: Stride[]; L: Stride[] };
  summary: any | null;
  alerts: AlertRow[];
  labels: { t: number; label: string; note: string }[];
  connections: ConnectionRow[];
  streamStats: StreamStatRow[];
  fsr: FsrMinute[];
}

export const readDayFiles = async (date: string): Promise<DayFiles> => {
  const dir = `${DAILY_DIR}/${date}`;
  const past = await readPastDay(date);
  const keep = <T, >(xs: (T | null)[]) => xs.filter((x): x is T => x !== null);
  return {
    ...past,
    dayStart: dayStartOfDate(date),
    alerts: await readAlerts(date),
    labels: await readLabels(date),
    connections: keep((await readRows(`${dir}/${CONNECTIONS_FILE}`)).map(parseConnectionRow)),
    streamStats: keep((await readRows(`${dir}/${STREAM_STATS_FILE}`)).map(parseStreamStatRow)),
    fsr: keep((await readRows(`${dir}/${FSR_FILE}`)).map(parseFsrRow)),
  };
};

// Every day folder under daily/, oldest first.
export const listDailyDates = async (): Promise<string[]> => {
  if (!(await RNFS.exists(DAILY_DIR))) return [];
  return (await RNFS.readDir(DAILY_DIR)).filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map((e) => e.name).sort();
};

// A day the app itself was running (it wrote a day summary), as opposed to an imported thesis day.
export const isAppDay = async (date: string) => {
  const s = await readJson(`${DAILY_DIR}/${date}/daily_summary.json`);
  return !!s && !s.imported;
};

// Per-day trend values, cached in daily/<date>/day_metrics.json: a day's files are only re-read when
// one of them changed (size or time) since the cache was written.
const METRICS_VERSION = 1;
const METRIC_SOURCES = ['minute_summary.csv', 'strides_R.csv', 'strides_L.csv', 'daily_summary.json'];
export const METRICS_CACHE = 'day_metrics.json';

const stampOf = async (dir: string, windowStrides: number) => {
  const files = await RNFS.readDir(dir);
  const parts = METRIC_SOURCES.map((n) => {
    const f = files.find((x) => x.name === n);
    return f ? `${n}:${f.size}:${f.mtime ? new Date(f.mtime).getTime() : 0}` : `${n}:-`;
  });
  return `v${METRICS_VERSION};w${windowStrides};${parts.join(';')}`;
};

export const loadDayMetrics = async (dates: string[], windowStrides: number): Promise<DayMetrics[]> => {
  const out: DayMetrics[] = [];
  for (const date of dates) {
    const dir = `${DAILY_DIR}/${date}`;
    if (!(await RNFS.exists(dir))) continue;
    const stamp = await stampOf(dir, windowStrides);
    const cached = await readJson(`${dir}/${METRICS_CACHE}`);
    if (cached?.stamp === stamp && cached.metrics) {
      out.push(cached.metrics);
      continue;
    }
    const m = dayMetrics(await readPastDay(date), windowStrides);
    out.push(m);
    await writeJsonAtomic(`${dir}/${METRICS_CACHE}`, { stamp, metrics: m }).catch(() => {});
  }
  return out;
};
