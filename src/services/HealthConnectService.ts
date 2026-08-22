import RNFS from 'react-native-fs';
import {
  getSdkStatus,
  initialize,
  requestPermission,
  getGrantedPermissions,
  readRecords,
  getChanges,
  aggregateRecord,
  openHealthConnectSettings,
  SdkAvailabilityStatus,
} from 'react-native-health-connect';
import { HEALTH_DATA_TYPES, HealthDataTypeConfig } from '../config/HealthConnectRegistry';
import { useFitStore } from '../store/FitStore';

export { openHealthConnectSettings };

export const FIT_DIR = `${RNFS.DownloadDirectoryPath}/GaitTwin/FitData`;
const FIT_CSV_HEADER = 'Wall_Clock_Start_ISO,Wall_Clock_End_ISO,DataType,Value,Unit,SourceApp,ExtraJSON';
const INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // first-ever sync only looks back 7 days

interface FitRow {
  start: string;
  end: string;
  dataType: string;
  value: number | null;
  unit: string;
  sourceApp: string;
  extraJSON: string;
  detail?: Record<string, number>;
}

export interface FitFileMeta {
  fileName: string;
  recordCountByType: Record<string, number>;
  minTimestamp: string | null;
  maxTimestamp: string | null;
  lastUpdated: string;
}

// --- CSV / file helpers ---

const csvEscape = (field: string | number | null): string => {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const rowToCsvLine = (row: FitRow): string =>
  [row.start, row.end, row.dataType, row.value ?? '', row.unit, row.sourceApp, row.extraJSON]
    .map(csvEscape)
    .join(',');

const ensureFitDir = async () => {
  const exists = await RNFS.exists(FIT_DIR);
  if (!exists) await RNFS.mkdir(FIT_DIR);
};

const formatLocalDate = (d: Date): string => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const localMidnightISO = (d: Date): string =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).toISOString();

// Auto-rotates by local calendar date unless the user pins a custom name.
const currentFitFileName = (): string => {
  const override = useFitStore.getState().fitFileNameOverride;
  return override && override.trim().length > 0 ? override.trim() : `Fit_${formatLocalDate(new Date())}`;
};

const updateFitMeta = async (metaPath: string, fileName: string, newRows: FitRow[]) => {
  let meta: FitFileMeta;
  try {
    const exists = await RNFS.exists(metaPath);
    meta = exists
      ? JSON.parse(await RNFS.readFile(metaPath, 'utf8'))
      : { fileName, recordCountByType: {}, minTimestamp: null, maxTimestamp: null, lastUpdated: '' };
  } catch {
    meta = { fileName, recordCountByType: {}, minTimestamp: null, maxTimestamp: null, lastUpdated: '' };
  }

  for (const row of newRows) {
    meta.recordCountByType[row.dataType] = (meta.recordCountByType[row.dataType] || 0) + 1;
    if (!meta.minTimestamp || row.start < meta.minTimestamp) meta.minTimestamp = row.start;
    if (!meta.maxTimestamp || row.end > meta.maxTimestamp) meta.maxTimestamp = row.end;
  }
  meta.lastUpdated = new Date().toISOString();

  try {
    await RNFS.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to update Fit file metadata:', e);
  }
};

const appendFitRowsUnsafe = async (rows: FitRow[]) => {
  if (rows.length === 0) return;
  await ensureFitDir();

  const fileName = currentFitFileName();
  const csvPath = `${FIT_DIR}/${fileName}.csv`;
  const metaPath = `${FIT_DIR}/${fileName}.meta.json`;

  const fileExists = await RNFS.exists(csvPath);
  const content = (fileExists ? '' : FIT_CSV_HEADER + '\n') + rows.map(rowToCsvLine).join('\n') + '\n';

  await RNFS.appendFile(csvPath, content, 'utf8');
  await RNFS.scanFile(csvPath);
  await updateFitMeta(metaPath, fileName, rows);
};

// runSyncTick fires one syncOneType() per granted type in parallel, and every type writes to the
// same shared daily file — without serializing, concurrent exists()+appendFile() calls can each
// see "file doesn't exist" and each prepend a header, or one write can fail outright. A failed
// write correctly withholds that type's cursor advance (see drainChanges/backfillAndEstablishToken),
// but if the failure is caused by this same race recurring every tick, the cursor gets stuck and
// the same growing batch of changes gets re-fetched and re-appended forever. Serializing writes
// here removes the race at its source.
let fitWriteQueue: Promise<void> = Promise.resolve();

const appendFitRows = (rows: FitRow[]): Promise<void> => {
  const task = fitWriteQueue.then(() => appendFitRowsUnsafe(rows));
  // Absorb rejections here so one failed write doesn't permanently block the queue for
  // subsequent writes — the caller of appendFitRows still sees the original rejection via `task`.
  fitWriteQueue = task.catch(() => {});
  return task;
};

// --- Per-record-type value extraction (ground-truthed against the installed package's .d.ts,
// not guessed: physical-quantity fields come back as *Result wrapper objects, e.g.
// MassResult.inKilograms, not plain numbers) ---

const extractScalar = (id: string, record: any): { value: number | null; extra?: any; detail?: Record<string, number> } => {
  switch (id) {
    case 'STEPS': return { value: record.count };
    case 'DISTANCE': return { value: record.distance?.inMeters ?? null };
    case 'RESTING_HEART_RATE': return { value: record.beatsPerMinute };
    case 'BLOOD_PRESSURE': {
      const systolic = record.systolic?.inMillimetersOfMercury ?? null;
      const diastolic = record.diastolic?.inMillimetersOfMercury ?? null;
      const diastolicField = diastolic != null ? { diastolic } : undefined;
      return { value: systolic, extra: diastolicField, detail: diastolicField };
    }
    case 'ACTIVE_CALORIES_BURNED': return { value: record.energy?.inKilocalories ?? null };
    case 'TOTAL_CALORIES_BURNED': return { value: record.energy?.inKilocalories ?? null };
    case 'OXYGEN_SATURATION': return { value: record.percentage };
    case 'FLOORS_CLIMBED': return { value: record.floors };
    case 'VO2_MAX': return { value: record.vo2MillilitersPerMinuteKilogram, extra: { measurementMethod: record.measurementMethod } };
    case 'RESPIRATORY_RATE': return { value: record.rate };
    case 'BODY_TEMPERATURE': return { value: record.temperature?.inCelsius ?? null };
    case 'WEIGHT': return { value: record.weight?.inKilograms ?? null };
    case 'HEIGHT': return { value: record.height?.inMeters ?? null };
    default: return { value: null };
  }
};

const extractSampleValue = (id: string, sample: any): number | null => {
  if (id === 'HEART_RATE') return sample.beatsPerMinute ?? null;
  if (id === 'SPEED') return sample.speed?.inMetersPerSecond ?? null;
  return null;
};

// Health Connect SleepStageType codes: UNKNOWN=0, AWAKE=1, SLEEPING=2 (unstaged), OUT_OF_BED=3,
// LIGHT=4, DEEP=5, REM=6. Only the four clinically-meaningful stages get a breakdown bucket —
// UNKNOWN/SLEEPING(unstaged)/OUT_OF_BED are excluded, not lost (raw `stages` stays in ExtraJSON).
const SLEEP_STAGE_TO_DETAIL_KEY: Record<number, 'awakeMin' | 'lightMin' | 'deepMin' | 'remMin'> = {
  1: 'awakeMin',
  4: 'lightMin',
  5: 'deepMin',
  6: 'remMin',
};

const computeSleepStageBreakdown = (stages: any[] | undefined): Record<string, number> => {
  const totals = { deepMin: 0, lightMin: 0, remMin: 0, awakeMin: 0 };
  for (const s of stages ?? []) {
    const key = SLEEP_STAGE_TO_DETAIL_KEY[s.stage];
    if (!key) continue;
    totals[key] += (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()) / 60000;
  }
  return totals;
};

const extractSessionSummary = (id: string, record: any): { value: number | null; extra: any; detail?: Record<string, number> } => {
  const durationMin = (new Date(record.endTime).getTime() - new Date(record.startTime).getTime()) / 60000;
  if (id === 'SLEEP_SESSION') {
    // Faithful-but-partial: if the source device only reports generic unstaged sleep, this
    // breakdown comes back all-zero while durationMin stays correct — not a bug in this app.
    const stageBreakdown = computeSleepStageBreakdown(record.stages);
    return { value: durationMin, extra: { title: record.title, notes: record.notes, stages: record.stages, stageBreakdown }, detail: stageBreakdown };
  }
  if (id === 'EXERCISE_SESSION') {
    return {
      value: durationMin,
      extra: { title: record.title, notes: record.notes, exerciseType: record.exerciseType, segments: record.segments, laps: record.laps },
    };
  }
  return { value: null, extra: {} };
};

const buildRows = (config: HealthDataTypeConfig, records: any[]): FitRow[] => {
  const rows: FitRow[] = [];

  for (const record of records) {
    const sourceApp: string = record.metadata?.dataOrigin ?? '';

    if (config.shape === 'instant') {
      const { value, extra, detail } = extractScalar(config.id, record);
      rows.push({ start: record.time, end: record.time, dataType: config.id, value, unit: config.unit, sourceApp, extraJSON: extra ? JSON.stringify(extra) : '', detail });
    } else if (config.shape === 'interval') {
      const { value, extra, detail } = extractScalar(config.id, record);
      rows.push({ start: record.startTime, end: record.endTime, dataType: config.id, value, unit: config.unit, sourceApp, extraJSON: extra ? JSON.stringify(extra) : '', detail });
    } else if (config.shape === 'session') {
      const { value, extra, detail } = extractSessionSummary(config.id, record);
      rows.push({ start: record.startTime, end: record.endTime, dataType: config.id, value, unit: config.unit, sourceApp, extraJSON: JSON.stringify(extra), detail });
    } else if (config.shape === 'series') {
      // Exploded to one row per inner sample, not one row per HC record, to preserve fidelity.
      for (const sample of record.samples ?? []) {
        const value = extractSampleValue(config.id, sample);
        rows.push({ start: sample.time, end: sample.time, dataType: config.id, value, unit: config.unit, sourceApp, extraJSON: '' });
      }
    }
  }

  return rows;
};

// Picks the most-recent row by content end-time rather than assuming array order — neither
// readRecords' default ordering nor the Changes API's upsertion order is guaranteed to be
// chronological by content time.
const applyLatestFromRows = (config: HealthDataTypeConfig, rows: FitRow[]) => {
  if (rows.length === 0) return;
  const last = rows.reduce((a, b) => (b.end > a.end ? b : a));
  useFitStore.getState().setLatest(config.id, { value: last.value, unit: config.unit, timestamp: last.end, detail: last.detail });
};

// --- Sync: Health Connect's Changes API tracks insertions by cursor token, independent of a
// record's own content timestamps — unlike a timestamp watermark, it can't miss backdated data
// (e.g. a sleep session for last night, written only after waking up). A bounded historical
// readRecords() backfill still seeds each type once; after that, everything goes through
// getChanges(). ---

const backfillAndEstablishToken = async (config: HealthDataTypeConfig, priorWatermark: string | null) => {
  // Mint the token BEFORE reading history, so nothing written between "backfill query ends" and
  // "the changes cursor starts tracking" can fall into a gap.
  const tokenResult: any = await getChanges({ recordTypes: [config.recordType] });

  const queryEnd = new Date().toISOString();
  const startTime = priorWatermark ?? new Date(Date.now() - INITIAL_LOOKBACK_MS).toISOString();

  let allRecords: any[] = [];
  let pageToken: string | undefined;
  do {
    const result: any = await readRecords(config.recordType, {
      timeRangeFilter: { operator: 'between', startTime, endTime: queryEnd },
      ...(pageToken ? { pageToken } : {}),
    });
    allRecords = allRecords.concat(result.records);
    pageToken = result.pageToken;
  } while (pageToken);

  const rows = buildRows(config, allRecords);
  await appendFitRows(rows);
  applyLatestFromRows(config, rows);

  // Only persist the new cursor after the write above succeeded — if appendFitRows threw, we
  // never reach here, so the next tick retries this exact window and re-mints a token (harmless,
  // nothing was persisted from the failed attempt).
  await useFitStore.getState().setTypeSyncState(config.id, { changesToken: tokenResult.nextChangesToken, watermark: queryEnd });
};

const drainChanges = async (config: HealthDataTypeConfig, changesToken: string) => {
  let token = changesToken;
  let allUpserted: any[] = [];
  let hasMore = true;
  let expired = false;

  while (hasMore) {
    const result: any = await getChanges({ changesToken: token, recordTypes: [config.recordType] });
    if (result.changesTokenExpired) {
      expired = true;
      break;
    }
    allUpserted = allUpserted.concat(result.upsertionChanges.map((c: any) => c.record));
    // deletionChanges are drained (to keep the cursor advancing) but not applied to the CSV —
    // matches this app's existing append-only-CSV precedent.
    token = result.nextChangesToken;
    hasMore = result.hasMore;
  }

  if (expired) {
    // Lost the cursor. Fall back to backfill mode next tick, bounded by the watermark this
    // function kept fresh on every successful tick — at most one sync interval of re-scan, never
    // "since forever".
    const current = useFitStore.getState().typeSyncState[config.id]?.watermark ?? null;
    await useFitStore.getState().setTypeSyncState(config.id, { changesToken: null, watermark: current });
    return;
  }

  const rows = buildRows(config, allUpserted);
  await appendFitRows(rows);
  applyLatestFromRows(config, rows);

  await useFitStore.getState().setTypeSyncState(config.id, { changesToken: token, watermark: new Date().toISOString() });
};

const syncOneType = async (config: HealthDataTypeConfig) => {
  const syncState = useFitStore.getState().typeSyncState[config.id] ?? { changesToken: null, watermark: null };

  if (!syncState.changesToken) {
    await backfillAndEstablishToken(config, syncState.watermark);
  } else {
    await drainChanges(config, syncState.changesToken);
  }

  useFitStore.getState().setLastChecked(config.id, new Date().toISOString());
};

// --- Daily running totals for types where "value of the last individual record" is misleading
// (Steps/Distance/Calories/Floors Climbed arrive as many small interval records throughout the
// day — the tile should show "today so far," not "the last bucket"). Purely display-side: never
// touches appendFitRows or the sync cursors above. ---

const DAILY_TOTAL_RECORD_TYPES: Partial<Record<string, { extractTotal: (r: any) => number | null }>> = {
  STEPS: { extractTotal: (r) => r.COUNT_TOTAL ?? null },
  DISTANCE: { extractTotal: (r) => r.DISTANCE?.inMeters ?? null },
  ACTIVE_CALORIES_BURNED: { extractTotal: (r) => r.ACTIVE_CALORIES_TOTAL?.inKilocalories ?? null },
  TOTAL_CALORIES_BURNED: { extractTotal: (r) => r.ENERGY_TOTAL?.inKilocalories ?? null },
  FLOORS_CLIMBED: { extractTotal: (r) => r.FLOORS_CLIMBED_TOTAL ?? null },
};
export const DAILY_TOTAL_TYPE_IDS: string[] = Object.keys(DAILY_TOTAL_RECORD_TYPES);

const syncDailyTotal = async (config: HealthDataTypeConfig) => {
  const spec = DAILY_TOTAL_RECORD_TYPES[config.id];
  if (!spec) return;

  const now = new Date();
  const result: any = await aggregateRecord({
    recordType: config.recordType as any,
    timeRangeFilter: { operator: 'between', startTime: localMidnightISO(now), endTime: now.toISOString() },
  });
  useFitStore.getState().setDailyTotal(config.id, { value: spec.extractTotal(result), unit: config.unit, timestamp: now.toISOString() });
};

export const runSyncTick = async () => {
  const grantedIds = useFitStore.getState().permissionsGranted;
  if (grantedIds.length === 0) return;

  useFitStore.getState().setIsSyncing(true);

  const configs = HEALTH_DATA_TYPES.filter((c) => grantedIds.includes(c.id));
  const recordSyncPromises = configs.map((config) => syncOneType(config));
  const dailyTotalPromises = configs
    .filter((c) => DAILY_TOTAL_RECORD_TYPES[c.id])
    .map((config) => syncDailyTotal(config));

  const results = await Promise.allSettled([...recordSyncPromises, ...dailyTotalPromises]);

  const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (firstFailure) {
    console.error('Fit sync error:', firstFailure.reason);
    useFitStore.getState().setLastSyncError(String(firstFailure.reason?.message ?? firstFailure.reason));
  } else {
    useFitStore.getState().setLastSyncError(null);
  }

  useFitStore.getState().setLastSyncAt(new Date().toISOString());
  useFitStore.getState().setIsSyncing(false);
};

let fitSyncTimer: ReturnType<typeof setInterval> | null = null;

export const startFitAutoSync = () => {
  if (fitSyncTimer) return;

  if (useFitStore.getState().autoSyncEnabled) runSyncTick();

  const intervalMs = useFitStore.getState().syncIntervalMinutes * 60 * 1000;
  fitSyncTimer = setInterval(() => {
    if (useFitStore.getState().autoSyncEnabled) runSyncTick();
  }, intervalMs);
};

// Call after changing syncIntervalMinutes so the running timer picks up the new period.
export const restartFitAutoSync = () => {
  if (fitSyncTimer) {
    clearInterval(fitSyncTimer);
    fitSyncTimer = null;
  }
  startFitAutoSync();
};

// --- Init / permissions ---

export const initializeHealthConnect = async (): Promise<{ available: boolean; reason?: string }> => {
  try {
    const status = await getSdkStatus();
    if (status !== SdkAvailabilityStatus.SDK_AVAILABLE) {
      return {
        available: false,
        reason: status === SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED
          ? 'Health Connect needs to be updated from the Play Store.'
          : 'Health Connect is not available on this device.',
      };
    }
    const initialized = await initialize();
    return { available: initialized };
  } catch (e) {
    console.error('Health Connect initialization failed:', e);
    return { available: false, reason: 'Failed to initialize Health Connect.' };
  }
};

export const requestFitPermissions = async (): Promise<boolean> => {
  try {
    const desiredRecordTypes = new Set(HEALTH_DATA_TYPES.map((t) => t.recordType as string));
    desiredRecordTypes.add('BackgroundAccessPermission');

    const alreadyGranted = await getGrantedPermissions();
    const alreadyGrantedTypes = new Set(alreadyGranted.map((p) => p.recordType as string));
    const allAlreadyGranted = [...desiredRecordTypes].every((rt) => alreadyGrantedTypes.has(rt));

    let grantedTypes: Set<string>;
    if (allAlreadyGranted) {
      grantedTypes = alreadyGrantedTypes;
    } else {
      const permissions: any[] = [
        ...HEALTH_DATA_TYPES.map((t) => ({ accessType: 'read' as const, recordType: t.recordType })),
        { accessType: 'read' as const, recordType: 'BackgroundAccessPermission' as const },
      ];
      const granted = await requestPermission(permissions);
      grantedTypes = new Set(granted.map((p) => p.recordType as string));
    }

    const grantedIds = HEALTH_DATA_TYPES.filter((t) => grantedTypes.has(t.recordType)).map((t) => t.id);
    useFitStore.getState().setPermissionsGranted(grantedIds);
    return grantedIds.length > 0;
  } catch (e) {
    console.error('Health Connect permission request failed:', e);
    return false;
  }
};
