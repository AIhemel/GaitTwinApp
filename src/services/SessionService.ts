import RNFS from 'react-native-fs';
import { GAITTWIN_DIR } from './SessionWriter';

const SESSION_DIR = GAITTWIN_DIR;

export interface SessionMetadata {
  fileName: string;
  startTime: string;
  endTime?: string | null;
  appVersion: string;
  nodeBindings: Record<string, string | null>;
}

export interface SessionInfo {
  fileName: string; // session name: the folder name, or the CSV base name for legacy sessions
  path: string;
  // Current sessions are folders of per-stream CSVs; sessions recorded before that are a single
  // wide <name>.csv (+ <name>.meta.json) directly in Downloads/GaitTwin.
  isLegacy: boolean;
  streams: string[]; // CSVs inside a session folder, e.g. ['gait', 'hydration']
  size: number;
  modifiedTime: Date;
  metadata: SessionMetadata | null;
}

const readMetadata = async (metaPath: string, name: string): Promise<SessionMetadata | null> => {
  try {
    if (await RNFS.exists(metaPath)) return JSON.parse(await RNFS.readFile(metaPath, 'utf8'));
  } catch (e) {
    console.error(`Failed to read metadata for ${name}:`, e);
  }
  return null;
};

export const listSessions = async (): Promise<SessionInfo[]> => {
  const dirExists = await RNFS.exists(SESSION_DIR);
  if (!dirExists) return [];

  const entries = await RNFS.readDir(SESSION_DIR);

  const folders = entries.filter(e => e.isDirectory());
  const folderSessions = await Promise.all(folders.map(async (entry): Promise<SessionInfo> => {
    const files = await RNFS.readDir(entry.path).catch(() => []);
    const csvs = files.filter(f => f.isFile() && f.name.endsWith('.csv'));
    const newest = files.reduce((t, f) => Math.max(t, f.mtime?.getTime() ?? 0), entry.mtime?.getTime() ?? 0);
    return {
      fileName: entry.name,
      path: entry.path,
      isLegacy: false,
      streams: csvs.map(f => f.name.replace(/\.csv$/, '')),
      size: files.reduce((sum, f) => sum + (f.isFile() ? Number(f.size) : 0), 0),
      modifiedTime: new Date(newest),
      metadata: await readMetadata(`${entry.path}/session.meta.json`, entry.name),
    };
  }));

  const legacyCsvs = entries.filter(e => e.isFile() && e.name.endsWith('.csv'));
  const legacySessions = await Promise.all(legacyCsvs.map(async (entry): Promise<SessionInfo> => {
    const fileName = entry.name.replace(/\.csv$/, '');
    return {
      fileName,
      path: entry.path,
      isLegacy: true,
      streams: [],
      size: Number(entry.size),
      modifiedTime: entry.mtime ?? new Date(),
      metadata: await readMetadata(`${SESSION_DIR}/${fileName}.meta.json`, fileName),
    };
  }));

  return [...folderSessions, ...legacySessions].sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
};

export const renameSession = async (session: SessionInfo, newFileName: string): Promise<void> => {
  if (!session.isLegacy) {
    const target = `${SESSION_DIR}/${newFileName}`;
    if (await RNFS.exists(target)) throw new Error('A session with that name already exists');
    await RNFS.moveFile(session.path, target);
    return;
  }

  const oldMetaPath = `${SESSION_DIR}/${session.fileName}.meta.json`;
  const newMetaPath = `${SESSION_DIR}/${newFileName}.meta.json`;

  await RNFS.moveFile(session.path, `${SESSION_DIR}/${newFileName}.csv`);

  try {
    if (await RNFS.exists(oldMetaPath)) {
      await RNFS.moveFile(oldMetaPath, newMetaPath);
    }
  } catch (e) {
    console.error('Failed to rename session metadata (non-fatal):', e);
  }
};

export const deleteSession = async (session: SessionInfo): Promise<void> => {
  // RNFS.unlink removes a directory and everything in it.
  await RNFS.unlink(session.path);
  if (!session.isLegacy) return;

  const metaPath = `${SESSION_DIR}/${session.fileName}.meta.json`;
  try {
    if (await RNFS.exists(metaPath)) {
      await RNFS.unlink(metaPath);
    }
  } catch (e) {
    console.error('Failed to delete session metadata (non-fatal):', e);
  }
};
