import RNFS from 'react-native-fs';
import { GAITTWIN_DIR } from './SessionWriter';

// Per-day files that exist whether or not a session is recording:
//   Downloads/GaitTwin/daily/YYYY-MM-DD/{labels,alerts}.csv
// (the health engine adds its minute table and summaries here later). Day = phone local date.

export const DAILY_DIR = `${GAITTWIN_DIR}/daily`;

export const localDate = (ms: number = Date.now()) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const dailyDir = (ms: number = Date.now()) => `${DAILY_DIR}/${localDate(ms)}`;

// CSV-safe text cell: quoted when it contains a comma, quote or newline.
export const csvText = (s: string | null | undefined): string => {
  if (s === null || s === undefined) return '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const knownFiles = new Set<string>();
let chain: Promise<void> = Promise.resolve();

// Appends one row to today's (or `ms`'s day's) file, writing the header first if the file is new.
// Writes are serialized, so concurrent appends can't interleave or double the header.
export const appendDaily = (file: string, header: string, row: string, ms: number = Date.now()): Promise<void> => {
  const dir = dailyDir(ms);
  const path = `${dir}/${file}`;
  const job = chain.then(async () => {
    let data = row + '\n';
    if (!knownFiles.has(path)) {
      if (!(await RNFS.exists(dir))) await RNFS.mkdir(dir);
      if (!(await RNFS.exists(path))) data = `${header}\n${data}`;
    }
    await RNFS.appendFile(path, data, 'utf8');
    knownFiles.add(path); // only once the header is really on disk
  });
  chain = job.catch((e) => console.error(`Daily write failed for ${path}:`, e));
  return job;
};

// Test hook: forget which files are known to exist.
export const resetDailyStoreForTests = () => {
  knownFiles.clear();
  chain = Promise.resolve();
};

// Splits CSV text into rows of fields, honouring "quoted, fields" and "" escapes. Header row included.
export const parseCsvText = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
};
