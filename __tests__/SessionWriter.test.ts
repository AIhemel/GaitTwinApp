import RNFS from 'react-native-fs';
import { sessionWriter, STREAM_HEADERS, cell } from '../src/services/SessionWriter';

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

test('resuming a session folder whose files have an old header starts a new folder', async () => {
  dirs.add('/mock/Downloads/GaitTwin/S4');
  files['/mock/Downloads/GaitTwin/S4/gait.csv'] = 'old,header\n1,2\n';
  const result = await sessionWriter.open('S4');
  expect(result.renamed).toBe(true);
  expect(result.name).toMatch(/^S4_/);
});

test('cell() leaves missing values empty instead of writing 0', () => {
  expect(cell(null)).toBe('');
  expect(cell(NaN)).toBe('');
  expect(cell(0)).toBe('0');
  expect(cell(1.23456, 2)).toBe('1.23');
});
