import RNFS from 'react-native-fs';

const SESSION_DIR = `${RNFS.DownloadDirectoryPath}/GaitTwin`;

export interface SessionMetadata {
  fileName: string;
  startTime: string;
  appVersion: string;
  nodeBindings: Record<string, string | null>;
}

export interface SessionInfo {
  fileName: string;
  csvPath: string;
  size: number;
  modifiedTime: Date;
  metadata: SessionMetadata | null;
}

export const listSessions = async (): Promise<SessionInfo[]> => {
  const dirExists = await RNFS.exists(SESSION_DIR);
  if (!dirExists) return [];

  const entries = await RNFS.readDir(SESSION_DIR);
  const csvEntries = entries.filter(e => e.isFile() && e.name.endsWith('.csv'));

  const sessions = await Promise.all(csvEntries.map(async (entry) => {
    const fileName = entry.name.replace(/\.csv$/, '');
    const metaPath = `${SESSION_DIR}/${fileName}.meta.json`;
    let metadata: SessionMetadata | null = null;

    try {
      if (await RNFS.exists(metaPath)) {
        const raw = await RNFS.readFile(metaPath, 'utf8');
        metadata = JSON.parse(raw);
      }
    } catch (e) {
      console.error(`Failed to read metadata for ${fileName}:`, e);
    }

    return {
      fileName,
      csvPath: entry.path,
      size: entry.size,
      modifiedTime: entry.mtime ?? new Date(),
      metadata,
    };
  }));

  return sessions.sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
};

export const renameSession = async (oldFileName: string, newFileName: string): Promise<void> => {
  const oldCsvPath = `${SESSION_DIR}/${oldFileName}.csv`;
  const newCsvPath = `${SESSION_DIR}/${newFileName}.csv`;
  const oldMetaPath = `${SESSION_DIR}/${oldFileName}.meta.json`;
  const newMetaPath = `${SESSION_DIR}/${newFileName}.meta.json`;

  await RNFS.moveFile(oldCsvPath, newCsvPath);

  try {
    if (await RNFS.exists(oldMetaPath)) {
      await RNFS.moveFile(oldMetaPath, newMetaPath);
    }
  } catch (e) {
    console.error('Failed to rename session metadata (non-fatal):', e);
  }
};

export const deleteSession = async (fileName: string): Promise<void> => {
  const csvPath = `${SESSION_DIR}/${fileName}.csv`;
  const metaPath = `${SESSION_DIR}/${fileName}.meta.json`;

  await RNFS.unlink(csvPath);

  try {
    if (await RNFS.exists(metaPath)) {
      await RNFS.unlink(metaPath);
    }
  } catch (e) {
    console.error('Failed to delete session metadata (non-fatal):', e);
  }
};
