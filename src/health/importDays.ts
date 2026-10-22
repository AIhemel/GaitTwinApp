import RNFS from 'react-native-fs';
import { DAILY_DIR } from '../services/DailyStore';
import { readJson } from '../services/SessionMeta';

// Thesis days converted by scripts/import_thesis_days.py are pushed into the app's own folder,
// Android/data/com.gaittwinapp/files/import/daily/<date>/, because Android (scoped storage) doesn't let
// the app read files in Downloads that another source created. At start-up they are copied into
// Downloads/GaitTwin/daily/ — now as the app's own files — and removed from the drop folder.

export const IMPORT_DIR = `${RNFS.ExternalDirectoryPath}/import/daily`;
const DAY_FILES = ['minute_summary.csv', 'strides_R.csv', 'strides_L.csv', 'daily_summary.json'];

export const importThesisDays = async (): Promise<{ imported: string[]; skipped: string[] }> => {
  const imported: string[] = [];
  const skipped: string[] = [];
  if (!RNFS.ExternalDirectoryPath || !(await RNFS.exists(IMPORT_DIR))) return { imported, skipped };
  for (const entry of await RNFS.readDir(IMPORT_DIR)) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const target = `${DAILY_DIR}/${entry.name}`;
    const existing = await readJson(`${target}/daily_summary.json`);
    if (existing && !existing.imported) {
      skipped.push(entry.name); // a day the app recorded itself is never replaced
    } else {
      if (!(await RNFS.exists(target))) await RNFS.mkdir(target);
      for (const f of await RNFS.readDir(entry.path)) {
        if (f.isFile() && DAY_FILES.includes(f.name)) await RNFS.writeFile(`${target}/${f.name}`, await RNFS.readFile(f.path, 'utf8'), 'utf8');
      }
      imported.push(entry.name);
    }
    await RNFS.unlink(entry.path);
  }
  return { imported, skipped };
};
