import { appendDaily, csvText } from './DailyStore';
import { WindowStats } from './StreamMonitor';

// Per-day sensor logs for the Data tab, written whether or not a session is recording (a session's
// events.csv only covers the recording):
//   daily/<date>/connections.csv   every connect, disconnect, failed connect and node reboot
//   daily/<date>/stream_stats.csv  once a minute per connected node: packets, rate, loss, RSSI
// A node has a stream_stats row for every minute it was connected, so uptime = its row count.

export const CONNECTIONS_FILE = 'connections.csv';
export const CONNECTIONS_HEADER = 'utc_ms,node,event,detail';
export const STREAM_STATS_FILE = 'stream_stats.csv';
export const STREAM_STATS_HEADER = 'utc_ms,node,packets,rate_hz,loss_pct,rssi';

export const CONNECTION_EVENTS = new Set(['connected', 'disconnected', 'disconnected_by_user', 'connect_failed', 'reboot_detected']);

export const logConnection = (t: number, node: string, event: string, detail = '') =>
  appendDaily(CONNECTIONS_FILE, CONNECTIONS_HEADER, `${t},${node},${event},${csvText(detail)}`, t);

const f = (x: number | null, d = 1) => (x === null || !Number.isFinite(x) ? '' : x.toFixed(d));

export const logStreamStats = (t: number, node: string, w: WindowStats, rssi: number | null) =>
  appendDaily(STREAM_STATS_FILE, STREAM_STATS_HEADER, `${t},${node},${w.packets},${f(w.rateHz, 2)},${f(w.lossPct)},${rssi ?? ''}`, t);
