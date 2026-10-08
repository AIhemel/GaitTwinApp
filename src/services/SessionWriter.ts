import RNFS from 'react-native-fs';

// One CSV per stream, one row per packet, inside one folder per recording session:
//   Downloads/GaitTwin/<session>/{gait,hydration,environment,posture,gps,events}.csv
// Every row carries its own timestamps, so streams with very different rates (gait ~100 Hz/foot,
// hydration 1 Hz, environment one 10 s average, posture on change) are aligned offline by utc_ms
// instead of being snapshotted onto a shared clock at record time.
// utc_ms is always Unix ms on the phone's clock: for 'millis' nodes the ClockSync estimate, for
// live environment/posture packets the phone receive time. device_* columns keep the node's raw value.
// Empty cells mean "not measured / invalid" — never 0.

export const GAITTWIN_DIR = `${RNFS.DownloadDirectoryPath}/GaitTwin`;

export const STREAM_HEADERS = {
  gait: 'side,rx_ms,device_ms,utc_ms,Pitch,Roll,Quat_I,Quat_J,Quat_K,Quat_Real,Yaw,Heel_FSR,Met1_FSR,Met5_FSR,Accel_X,Accel_Y,Accel_Z',
  hydration: 'rx_ms,device_ms,utc_ms,offline,Weight_g,Cap_mL,Fused_mL',
  // One row per 10 s averaging window; utc_ms = window end (phone receive time), device_utc_s =
  // the node's GPS-derived Unix seconds (blank until its first GPS time fix).
  environment: 'rx_ms,device_utc_s,utc_ms,co2_ppm,temp_c,rh_pct,pm1,pm25,pm10,dba,lat,lon',
  // One row per committed pose change (pose held 10 s; utc_ms is the commit, onset ≈ 10 s earlier).
  // utc_source: 'rx' live packet timed on arrival | 'device' replayed from the cushion's queue, timed
  // by its own clock | '' replayed with no clock set (utc_ms blank).
  posture: 'rx_ms,device_utc_s,utc_ms,utc_source,replayed,pose,pose_name',
  gps: 'utc_ms,lat,lon,accuracy_m,speed_mps,weather_temp_c,weather_rh_pct',
  events: 'rx_ms,node,event,device_ms,utc_ms,detail',
} as const;

export type StreamName = keyof typeof STREAM_HEADERS;
const STREAMS = Object.keys(STREAM_HEADERS) as StreamName[];

const FLUSH_INTERVAL_MS = 2000;
const SCAN_INTERVAL_MS = 60000;

// Formats a CSV cell: null/undefined/NaN become an empty cell.
export const cell = (x: number | string | null | undefined, digits?: number): string => {
  if (x === null || x === undefined) return '';
  if (typeof x === 'string') return x;
  if (!Number.isFinite(x)) return '';
  return digits === undefined ? String(x) : x.toFixed(digits);
};

const readFirstLine = async (path: string): Promise<string | null> => {
  try {
    const chunk = await RNFS.read(path, 4096, 0, 'utf8');
    const newlineIndex = chunk.indexOf('\n');
    return (newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : chunk).replace(/\r$/, '');
  } catch {
    return null;
  }
};

export interface OpenResult {
  dir: string;
  name: string;
  renamed: boolean;
}

class SessionWriter {
  private dir: string | null = null;
  private buffers: Record<StreamName, string[]> = { gait: [], hydration: [], environment: [], posture: [], gps: [], events: [] };
  private knownFiles = new Set<string>(); // paths whose header is already on disk
  private touched = new Set<string>(); // paths written since the last MediaStore scan
  // Every disk write goes through this chain, so appends to the same file never interleave.
  private writeChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private onError: (message: string | null) => void = () => {};

  setErrorHandler(handler: (message: string | null) => void) {
    this.onError = handler;
  }

  get isOpen(): boolean {
    return this.dir !== null;
  }

  get sessionDir(): string | null {
    return this.dir;
  }

  // Opens (or resumes) Downloads/GaitTwin/<name>/. Resuming is only safe if every existing
  // stream file still has the current header; otherwise a fresh suffixed folder is used so old
  // files are never appended with mismatched columns.
  async open(requestedName: string): Promise<OpenResult> {
    if (this.dir) await this.close();
    // Files may have been deleted/renamed via the session manager since they were last written.
    this.knownFiles.clear();
    let name = requestedName;
    let dir = `${GAITTWIN_DIR}/${name}`;
    let renamed = false;

    if ((await RNFS.exists(dir)) && !(await this.headersMatch(dir))) {
      name = `${requestedName}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      dir = `${GAITTWIN_DIR}/${name}`;
      renamed = true;
    }
    await RNFS.mkdir(dir);

    this.dir = dir;
    for (const s of STREAMS) this.buffers[s] = [];
    this.flushTimer = setInterval(() => { this.flush(); }, FLUSH_INTERVAL_MS);
    this.scanTimer = setInterval(() => { this.scanTouched(); }, SCAN_INTERVAL_MS);
    return { dir, name, renamed };
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.flushTimer = null;
    this.scanTimer = null;
    await this.flush();
    this.dir = null;
    await this.scanTouched();
  }

  // Cheap, synchronous: called for every gait packet. Dropped when no session is open.
  append(stream: StreamName, row: string) {
    if (this.dir) this.buffers[stream].push(row);
  }

  async flush(): Promise<void> {
    if (!this.dir) return;
    const dir = this.dir;
    await Promise.all(
      STREAMS.map((s) => {
        const rows = this.takeBuffer(s);
        return rows.length ? this.enqueue(this.pathFor(dir, s), s, rows).catch(() => {}) : Promise.resolve();
      })
    );
  }

  private takeBuffer(stream: StreamName): string[] {
    const rows = this.buffers[stream];
    this.buffers[stream] = [];
    return rows;
  }

  private pathFor(dir: string, stream: StreamName) {
    return `${dir}/${stream}.csv`;
  }

  private enqueue(path: string, stream: StreamName, rows: string[]): Promise<void> {
    const job = this.writeChain.then(async () => {
      try {
        const folder = path.slice(0, path.lastIndexOf('/'));
        let data = rows.join('\n') + '\n';
        if (!this.knownFiles.has(path)) {
          if (!(await RNFS.exists(folder))) await RNFS.mkdir(folder);
          if (!(await RNFS.exists(path))) data = `${STREAM_HEADERS[stream]}\n${data}`;
        }
        await RNFS.appendFile(path, data, 'utf8');
        this.knownFiles.add(path);
        this.touched.add(path);
        this.onError(null);
      } catch (e) {
        console.error(`Write failed for ${path}:`, e);
        // Put the rows back (ahead of anything newer) so the next flush retries them.
        if (this.dir !== null && path.startsWith(this.dir)) this.buffers[stream] = rows.concat(this.buffers[stream]);
        this.onError(`Could not write ${stream}.csv — rows are held in memory and retried every few seconds.`);
        throw e;
      }
    });
    this.writeChain = job.catch(() => {});
    return job;
  }

  private async headersMatch(dir: string): Promise<boolean> {
    for (const s of STREAMS) {
      const path = this.pathFor(dir, s);
      if (await RNFS.exists(path)) {
        if ((await readFirstLine(path)) !== STREAM_HEADERS[s]) return false;
        this.knownFiles.add(path);
      }
    }
    return true;
  }

  // Android's MediaStore only shows new file content (e.g. over USB) after a scan.
  private async scanTouched() {
    const paths = [...this.touched];
    this.touched.clear();
    await Promise.all(paths.map((p) => RNFS.scanFile(p).catch(() => {})));
  }
}

export const sessionWriter = new SessionWriter();
