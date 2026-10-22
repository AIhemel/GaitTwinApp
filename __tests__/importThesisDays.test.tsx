import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { HealthEngine, STRIDE_COLS, healthEngine } from '../src/health/engine';
import { MINUTE_HEADER } from '../src/health/daySummary';
import { useHealthStore } from '../src/store/HealthStore';
import { TodayScreen } from '../src/screens/TodayScreen';
import { resetDailyStoreForTests } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';
import { readFixtureText, readRepoText } from '../testUtils/readFixtureFile';

// scripts/import_thesis_days.py turns thesis-pipeline days into the app's daily files. The fixture
// imported_2026-10-14/ is its real output for Hemel's day-7 sample, run through the real pipeline.
const D = '/mock/Downloads/GaitTwin/daily';
const FILES = ['minute_summary.csv', 'strides_R.csv', 'strides_L.csv', 'daily_summary.json'];

test("the import script writes exactly the app's columns", () => {
  const py = readRepoText('scripts/import_thesis_days.py');
  const grab = (name: string) => {
    const m = py.match(new RegExp(`${name} = \\(([\\s\\S]*?)\\)\\n`));
    return m![1].split('\n').map((l) => l.trim().replace(/^"|"$/g, '')).join('');
  };
  expect(grab('MINUTE_HEADER')).toBe(MINUTE_HEADER);
  expect(grab('STRIDE_COLS')).toBe(STRIDE_COLS.join(','));
});

describe('an imported thesis day on the phone', () => {
  let fs: ReturnType<typeof installMemFs>;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(2026, 9, 20, 12, 0), doNotFake: ['setImmediate', 'nextTick'] });
    fs = installMemFs();
    resetDailyStoreForTests();
    fs.dirs.add(D);
    fs.dirs.add(`${D}/2026-10-14`);
    for (const f of FILES) fs.files[`${D}/2026-10-14/${f}`] = readFixtureText(`imported_2026-10-14/${f}`);
  });
  afterEach(() => jest.useRealTimers());

  test('teaches the app its usual: walking, indoor air, water, upright time', async () => {
    const e = new HealthEngine();
    await e.start();
    const today = await e.compute();
    e.stop();
    const b = useHealthStore.getState().baselines!;
    expect(b.days).toEqual(['2026-10-14']);
    expect(b.gaitWalk.cadence.median).toBeGreaterThan(90); // Hemel's walk, ~102 steps/min
    expect(Object.keys(b.gaitSi)).toContain('floorStance');
    expect(b.envByPlace.indoor?.pm25?.days).toBe(1);
    expect(b.daily.waterMl?.median).toBe(336);
    expect(b.daily.uprightPct?.median).toBe(60);
    // one day is not enough for personal comparisons (3 needed): today shows no "usual" values yet
    expect(today.usual).toMatchObject({ days: 1, cadence: null, waterMl: null });
  });

  test('picking it on the Today tab shows its totals instead of the full dashboard', async () => {
    const e = new HealthEngine();
    jest.spyOn(healthEngine, 'listDays').mockResolvedValue(['2026-10-14']);
    jest.spyOn(healthEngine, 'compute').mockResolvedValue(null as any);
    const imported = await e.readDay('2026-10-14');
    useHealthStore.setState({ viewedDate: '2026-10-14', viewed: imported });
    let tree: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<TodayScreen />); });
    const strings: string[] = [];
    const walk = (n: any) => {
      if (n === null || n === undefined) return;
      if (typeof n === 'string') { strings.push(n); return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      (n.children ?? []).forEach(walk);
    };
    walk(tree!.toJSON());
    const text = strings.join(' ');
    expect(text).toContain('2026-10-14 · imported');
    expect(text).toContain('0.34 L');
    expect(text).toContain('112 / 111');
    await ReactTestRenderer.act(async () => { tree!.unmount(); });
  });
});

describe('pushed into the app folder', () => {
  const X = '/mock/External/import/daily';
  let fs: ReturnType<typeof installMemFs>;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(2026, 9, 20, 12, 0), doNotFake: ['setImmediate', 'nextTick'] });
    fs = installMemFs();
    resetDailyStoreForTests();
    fs.dirs.add(X);
    for (const date of ['2026-10-14', '2026-10-15']) {
      fs.dirs.add(`${X}/${date}`);
      for (const f of FILES) fs.files[`${X}/${date}/${f}`] = readFixtureText(`imported_2026-10-14/${f}`).replace(/2026-10-14/g, date);
    }
    // the app already recorded the 15th itself
    fs.dirs.add(`${D}/2026-10-15`);
    fs.files[`${D}/2026-10-15/daily_summary.json`] = JSON.stringify({ date: '2026-10-15', hydration: { totalMl: 999 } });
  });
  afterEach(() => jest.useRealTimers());

  test('at start-up the days are copied into daily/, an app-recorded day is kept, the drop folder is emptied', async () => {
    const e = new HealthEngine();
    await e.start();
    e.stop();
    expect(fs.files[`${D}/2026-10-14/strides_R.csv`]).toBe(readFixtureText('imported_2026-10-14/strides_R.csv'));
    expect(JSON.parse(fs.files[`${D}/2026-10-15/daily_summary.json`]).hydration.totalMl).toBe(999);
    expect(Object.keys(fs.files).some((p) => p.startsWith('/mock/External/import/daily/'))).toBe(false);
    expect(useHealthStore.getState().lastImport).toEqual({ imported: ['2026-10-14'], skipped: ['2026-10-15'] });
    expect(useHealthStore.getState().baselines!.days).toContain('2026-10-14');
  });
});
