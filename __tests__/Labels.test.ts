import { logLabel, toggleContext, useLabelStore, LABELS_HEADER } from '../src/services/Labels';
import { sessionWriter } from '../src/services/SessionWriter';
import { resetDailyStoreForTests } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';

let fs: ReturnType<typeof installMemFs>;
const labelRows = () => {
  const p = Object.keys(fs.files).find((k) => k.endsWith('/labels.csv'))!;
  return fs.files[p].trim().split('\n');
};

beforeEach(() => {
  jest.useFakeTimers();
  fs = installMemFs();
  resetDailyStoreForTests();
  useLabelStore.setState({ active: null, lastTap: null });
});

afterEach(async () => {
  await sessionWriter.close();
  jest.useRealTimers();
});

test('taps go to the daily labels file even when not recording; notes with commas stay intact', async () => {
  await logLabel('drink', 'after lunch, 200 mL', 1000);
  expect(labelRows()).toEqual([LABELS_HEADER, '1000,drink,"after lunch, 200 mL"']);
});

test('contexts: one active at a time; starting another stops the first, tapping it again stops it', async () => {
  await toggleContext('walk', 1000);
  await toggleContext('rickshaw', 2000);
  await toggleContext('rickshaw', 3000);
  expect(labelRows().slice(1).map((r) => r.split(',').slice(0, 2).join(','))).toEqual([
    '1000,walk_start', '2000,walk_stop', '2000,rickshaw_start', '3000,rickshaw_stop',
  ]);
  expect(useLabelStore.getState().active).toBeNull();
});

test('during a session, taps also land in the session events.csv with node APP', async () => {
  const { dir } = await sessionWriter.open('labels');
  await logLabel('ac_on', '', 5000);
  await sessionWriter.flush();
  expect(fs.files[`${dir}/events.csv`]).toContain('5000,APP,ac_on,,5000,');
});
