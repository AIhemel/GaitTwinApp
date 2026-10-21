import RNFS from 'react-native-fs';
import { GAITTWIN_DIR } from './SessionWriter';

// session.meta.json lifecycle:
//   start   -> written with endTime null
//   every 60 s while recording -> lastUpdate refreshed (so a crash loses at most a minute of "when")
//   stop    -> endTime + endedBy "user", then manifest.json (SHA-256 of every file)
//   crash   -> at the next app start, endTime = lastUpdate and endedBy "recovered"
// Every write is atomic (temp file, then rename), so a kill mid-write can't leave a truncated meta.

export const META_FILE = 'session.meta.json';
export const MANIFEST_FILE = 'manifest.json';
// Folders under Downloads/GaitTwin that are not recording sessions.
export const NON_SESSION_DIRS = ['FitData', 'daily'];

export const uuidV4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : 8 + (r % 4)).toString(16);
  });

export const writeTextAtomic = async (path: string, text: string) => {
  const tmp = `${path}.tmp`;
  await RNFS.writeFile(tmp, text, 'utf8');
  if (await RNFS.exists(path)) await RNFS.unlink(path);
  await RNFS.moveFile(tmp, path);
};

export const writeJsonAtomic = (path: string, obj: unknown) => writeTextAtomic(path, JSON.stringify(obj, null, 2));

// Reads a JSON file, falling back to its .tmp twin when a kill landed between unlink and rename.
export const readJson = async (path: string): Promise<any | null> => {
  for (const p of [path, `${path}.tmp`]) {
    try {
      if (await RNFS.exists(p)) return JSON.parse(await RNFS.readFile(p, 'utf8'));
    } catch {
      // try the next candidate
    }
  }
  return null;
};

export const writeManifest = async (dir: string, sessionId: string | null) => {
  const entries = await RNFS.readDir(dir);
  const files = [];
  for (const e of entries.filter((f) => f.isFile() && f.name !== MANIFEST_FILE && !f.name.endsWith('.tmp'))) {
    files.push({ name: e.name, bytes: Number(e.size), sha256: await RNFS.hash(e.path, 'sha256') });
  }
  await writeJsonAtomic(`${dir}/${MANIFEST_FILE}`, { sessionId, createdAt: new Date().toISOString(), files });
};

// Closes sessions the app never got to stop (killed, crashed, battery died). Skips `activeDir`.
export const recoverUnfinishedSessions = async (activeDir: string | null = null): Promise<string[]> => {
  if (!(await RNFS.exists(GAITTWIN_DIR))) return [];
  const recovered: string[] = [];
  for (const entry of await RNFS.readDir(GAITTWIN_DIR)) {
    if (!entry.isDirectory() || NON_SESSION_DIRS.includes(entry.name) || entry.path === activeDir) continue;
    const metaPath = `${entry.path}/${META_FILE}`;
    const meta = await readJson(metaPath);
    if (!meta || meta.endTime) continue;
    try {
      // Older sessions have no lastUpdate: the last write to any of their files is the best end time.
      let end = meta.lastUpdate ?? null;
      if (!end) {
        const files = await RNFS.readDir(entry.path);
        const newest = files.reduce((t, f) => Math.max(t, f.mtime?.getTime() ?? 0), 0);
        end = newest ? new Date(newest).toISOString() : meta.startTime;
      }
      meta.endTime = end;
      meta.endedBy = 'recovered';
      await writeJsonAtomic(metaPath, meta);
      await writeManifest(entry.path, meta.sessionId ?? null);
      recovered.push(entry.name);
    } catch (e) {
      console.warn(`Could not recover session ${entry.name}:`, e);
    }
  }
  return recovered;
};
