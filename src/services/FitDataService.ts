import RNFS from 'react-native-fs';
import { FIT_DIR, FitFileMeta } from './HealthConnectService';

export interface FitFileInfo {
  fileName: string;
  csvPath: string;
  size: number;
  modifiedTime: Date;
  metadata: FitFileMeta | null;
}

export const listFitFiles = async (): Promise<FitFileInfo[]> => {
  const dirExists = await RNFS.exists(FIT_DIR);
  if (!dirExists) return [];

  const entries = await RNFS.readDir(FIT_DIR);
  const csvEntries = entries.filter((e) => e.isFile() && e.name.endsWith('.csv'));

  const files = await Promise.all(csvEntries.map(async (entry) => {
    const fileName = entry.name.replace(/\.csv$/, '');
    const metaPath = `${FIT_DIR}/${fileName}.meta.json`;
    let metadata: FitFileMeta | null = null;

    try {
      if (await RNFS.exists(metaPath)) {
        const raw = await RNFS.readFile(metaPath, 'utf8');
        metadata = JSON.parse(raw);
      }
    } catch (e) {
      console.error(`Failed to read Fit metadata for ${fileName}:`, e);
    }

    return {
      fileName,
      csvPath: entry.path,
      size: entry.size,
      modifiedTime: entry.mtime ?? new Date(),
      metadata,
    };
  }));

  return files.sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
};

export const renameFitFile = async (oldFileName: string, newFileName: string): Promise<void> => {
  const oldCsvPath = `${FIT_DIR}/${oldFileName}.csv`;
  const newCsvPath = `${FIT_DIR}/${newFileName}.csv`;
  const oldMetaPath = `${FIT_DIR}/${oldFileName}.meta.json`;
  const newMetaPath = `${FIT_DIR}/${newFileName}.meta.json`;

  await RNFS.moveFile(oldCsvPath, newCsvPath);

  try {
    if (await RNFS.exists(oldMetaPath)) {
      await RNFS.moveFile(oldMetaPath, newMetaPath);
    }
  } catch (e) {
    console.error('Failed to rename Fit file metadata (non-fatal):', e);
  }
};

export const deleteFitFile = async (fileName: string): Promise<void> => {
  const csvPath = `${FIT_DIR}/${fileName}.csv`;
  const metaPath = `${FIT_DIR}/${fileName}.meta.json`;

  await RNFS.unlink(csvPath);

  try {
    if (await RNFS.exists(metaPath)) {
      await RNFS.unlink(metaPath);
    }
  } catch (e) {
    console.error('Failed to delete Fit file metadata (non-fatal):', e);
  }
};

// Parses the CSV for a per-type preview (used by FitDataManagerScreen). Reasonable for the
// day-sized files this app produces; not intended for arbitrarily large historical files.
export const loadFitFileValues = async (fileName: string): Promise<Record<string, number[]>> => {
  const csvPath = `${FIT_DIR}/${fileName}.csv`;
  const content = await RNFS.readFile(csvPath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  // A naive split(',') is safe here specifically because DataType (col 2) and Value (col 3)
  // never contain commas themselves — only SourceApp/ExtraJSON (cols 5-6, after these) can be
  // quoted/escaped. This is not a general-purpose CSV parser.
  const byType: Record<string, number[]> = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dataType = cols[2];
    const value = Number(cols[3]);
    if (!dataType || Number.isNaN(value)) continue;
    if (!byType[dataType]) byType[dataType] = [];
    byType[dataType].push(value);
  }
  return byType;
};
