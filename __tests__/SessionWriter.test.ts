import RNFS from 'react-native-fs';
import { sessionWriter, sessionFolderName, STREAM_HEADERS, cell } from '../src/services/SessionWriter';

// In-memory filesystem on top of the react-native-fs mock.
let files: Record<string, string>;
let dirs: Set<string>;
let failNextAppend: boolean;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {}); // failure tests log on purpose
  files = {};
  dirs = new Set();
  failNextAppend = false;
  (RNFS.exists as jest.Mock).mockImplementation(async (p: string) => p in files || dirs.has(p));
  (RNFS.mkdir as jest.Mock).mockImplementation(async (p: string) => { dirs.add(p); });
  (RNFS.appendFile as jest.Mock).mockImplementation(async (p: string, data: string) => {
    if (failNextAppend) {
      failNextAppend = false;
      throw new Error('disk full');
    }
    files[p] = (files[p] ?? '') + data;
  });
  (RNFS.read as jest.Mock).mockImplementation(async (p: string) => files[p] ?? '');
});

afterEach(async () => {
  await sessionWriter.close();
  jest.useRealTimers();
  consoleError.mockRestore();
});

const lines = (path: string) => files[path].trim().split('\n');

test('rows go to one CSV per stream, each with its header once', async () => {
  const { dir } = await sessionWriter.open('S1');
  sessionWriter.append('gait', 'R,1,2,3');
  sessionWriter.append('gait', 'L,4,5,6');
  sessionWriter.append('hydration', '7,8,9');
  await sessionWriter.flush();
  sessionWriter.append('gait', 'R,10,11,12');
  await sessionWriter.flush();

  expect(lines(`${dir}/gait.csv`)).toEqual([STREAM_HEADERS.gait, 'R,1,2,3', 'L,4,5,6', 'R,10,11,12']);
  expect(lines(`${dir}/hydration.csv`)).toEqual([STREAM_HEADERS.hydration, '7,8,9']);
  expect(files[`${dir}/environment.csv`]).toBeUndefined();
});

test('nothing is buffered while no session is open', async () => {
  sessionWriter.append('gait', 'R,1,2,3');
  const { dir } = await sessionWriter.open('S2');
  await sessionWriter.flush();
  expect(files[`${dir}/gait.csv`]).toBeUndefined();
});

test('a failed write is retried on the next flush without losing or reordering rows', async () => {
  const { dir } = await sessionWriter.open('S3');
  sessionWriter.append('gait', 'a');
  failNextAppend = true;
  await sessionWriter.flush();
  sessionWriter.append('gait', 'b');
  await sessionWriter.flush();
  expect(lines(`${dir}/gait.csv`)).toEqual([STREAM_HEADERS.gait, 'a', 'b']);
});

test('every start gets a new date-named folder; a same-minute restart gets _2, never the old folder', async () => {
  const at = new Date(2026, 9, 14, 10, 54);
  const first = await sessionWriter.open('morning walk!', at);
  expect(first.name).toBe('2026-10-14_1054_morning_walk');
  sessionWriter.append('gait', 'R,1');
  await sessionWriter.close();

  const second = await sessionWriter.open('morning walk!', at);
  expect(second.name).toBe('2026-10-14_1054_morning_walk_2');
  await sessionWriter.flush();
  expect(lines(`${first.dir}/gait.csv`)).toEqual([STREAM_HEADERS.gait, 'R,1']); // untouched
});

test('an empty label still gives a valid folder name', () => {
  expect(sessionFolderName('  ', new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02_0304_session');
});

test('files are written as UTF-8 without a byte-order mark', async () => {
  const { dir } = await sessionWriter.open('bom');
  sessionWriter.append('events', '1,APP,drink,,1,');
  await sessionWriter.flush();
  expect(files[`${dir}/events.csv`].charCodeAt(0)).not.toBe(0xfeff);
  expect((RNFS.appendFile as jest.Mock).mock.calls.every((c: any[]) => c[2] === 'utf8')).toBe(true);
});

test('cell() leaves missing values empty instead of writing 0', () => {
  expect(cell(null)).toBe('');
  expect(cell(NaN)).toBe('');
  expect(cell(0)).toBe('0');
  expect(cell(1.23456, 2)).toBe('1.23');
});
