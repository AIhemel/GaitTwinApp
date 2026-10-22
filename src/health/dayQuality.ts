import { NODE_LABELS } from './dataQuality';
import { FsrMinute, FsrSideHealth, fsrHealth } from './fsr';
import { TEMP_WARMUP_MS } from './environment';

// The Data tab: how well each sensor recorded on one day. From the day's connections.csv and
// stream_stats.csv (written by the orchestrator, recording or not), fsr_minutes.csv (health engine),
// the minute table (band heart rate) and the day summary (data minutes, warm-up, sparse insole data).

const MIN = 60000;
export const QUALITY_NODES = ['GAIT', 'GAIT_LEFT', 'ENVIRONMENT', 'HYDRATION', 'POSTURE'];
const COVERAGE_KEY: Record<string, string> = { GAIT: 'gaitR', GAIT_LEFT: 'gaitL', ENVIRONMENT: 'environment', HYDRATION: 'bottle', POSTURE: 'posture' };
export const BAND_OFF_MIN = 30; // thresholds.json data_quality.band_not_worn_min

export interface ConnectionRow { t: number; node: string; event: string; detail: string }
export interface StreamStatRow { t: number; node: string; packets: number; rateHz: number | null; lossPct: number | null; rssi: number | null }

export interface NodeQuality {
  nodeId: string; name: string;
  connectedMin: number; // minutes with a stream_stats row (= connected during that minute)
  dataMin: number | null; // minutes in which data arrived (day summary coverage)
  disconnects: number; userOff: number; failedConnects: number; reboots: number;
  lossPct: number | null; rateHz: number | null; rssi: number | null; // medians over connected minutes
}

export interface DayQuality {
  logged: boolean; // false for days before the connection logs existed
  nodes: NodeQuality[];
  events: ConnectionRow[];
  warmups: { from: number; to: number }[];
  warmupMin: number | null;
  fsr: Record<'R' | 'L', FsrSideHealth | null>;
  band: { readings: number; wornMin: number; first: number; last: number; offGaps: { from: number; to: number }[] } | null;
  gatedMin: { R: number; L: number } | null;
}

const median = (x: number[]) => {
  if (!x.length) return null;
  const s = [...x].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

const numOrNull = (s: string | undefined) => (s === undefined || s === '' || !Number.isFinite(Number(s)) ? null : Number(s));

export const parseConnectionRow = (f: string[]): ConnectionRow | null =>
  f.length >= 3 && Number.isFinite(Number(f[0])) ? { t: Number(f[0]), node: f[1], event: f[2], detail: f.slice(3).join(',') } : null;

export const parseStreamStatRow = (f: string[]): StreamStatRow | null =>
  f.length >= 6 && Number.isFinite(Number(f[0]))
    ? { t: Number(f[0]), node: f[1], packets: Number(f[2]), rateHz: numOrNull(f[3]), lossPct: numOrNull(f[4]), rssi: numOrNull(f[5]) }
    : null;

export const dayQuality = (inp: {
  dayStart: number; end: number; // end = now for today, else the end of the day
  connections: ConnectionRow[]; streamStats: StreamStatRow[]; fsr: FsrMinute[];
  minutes: Record<string, string>[]; summary: any | null;
}): DayQuality => {
  const { connections, streamStats, summary } = inp;
  const nodes: NodeQuality[] = QUALITY_NODES.map((id) => {
    const st = streamStats.filter((r) => r.node === id);
    const ev = connections.filter((r) => r.node === id);
    const count = (e: string) => ev.filter((r) => r.event === e).length;
    const cov = summary?.coverage?.[COVERAGE_KEY[id]];
    return {
      nodeId: id, name: NODE_LABELS[id] ?? id,
      connectedMin: st.length,
      dataMin: typeof cov === 'number' ? cov : null,
      disconnects: count('disconnected'), userOff: count('disconnected_by_user'),
      failedConnects: count('connect_failed'), reboots: count('reboot_detected'),
      lossPct: median(st.map((r) => r.lossPct).filter((v): v is number => v !== null)),
      rateHz: median(st.map((r) => r.rateHz).filter((v): v is number => v !== null)),
      rssi: median(st.map((r) => r.rssi).filter((v): v is number => v !== null)),
    };
  });

  // the environment node's temperature reads high for 30 min after it connects (self-heating)
  const envEvents = connections.filter((r) => r.node === 'ENVIRONMENT' && (r.event === 'connected' || r.event.startsWith('disconnected')));
  const warmups: DayQuality['warmups'] = [];
  envEvents.forEach((r, i) => {
    if (r.event !== 'connected') return;
    const next = envEvents.slice(i + 1).find((x) => x.event !== 'connected');
    const to = Math.min(r.t + TEMP_WARMUP_MS, next ? next.t : Infinity, inp.end);
    if (to > r.t) warmups.push({ from: r.t, to });
  });

  // band wear: heart-rate readings no more than 30 min apart count as worn; longer gaps as off-wrist
  const hrTimes = inp.minutes.filter((m) => m.hr).map((m) => Date.parse(m.minute)).filter(Number.isFinite).sort((a, b) => a - b);
  let band: DayQuality['band'] = null;
  if (hrTimes.length) {
    let worn = 1;
    const offGaps: { from: number; to: number }[] = [];
    for (let i = 1; i < hrTimes.length; i++) {
      const gap = (hrTimes[i] - hrTimes[i - 1]) / MIN;
      if (gap <= BAND_OFF_MIN) worn += gap; else offGaps.push({ from: hrTimes[i - 1], to: hrTimes[i] });
    }
    band = { readings: hrTimes.length, wornMin: worn, first: hrTimes[0], last: hrTimes[hrTimes.length - 1], offGaps };
  }

  return {
    logged: connections.length > 0 || streamStats.length > 0,
    nodes,
    events: [...connections].sort((a, b) => a.t - b.t),
    warmups,
    warmupMin: typeof summary?.environment?.warmupMin === 'number' ? summary.environment.warmupMin : null,
    fsr: { R: fsrHealth(inp.fsr.filter((r) => r.side === 'R')), L: fsrHealth(inp.fsr.filter((r) => r.side === 'L')) },
    band,
    gatedMin: summary?.gait?.gatedMin ?? null,
  };
};
