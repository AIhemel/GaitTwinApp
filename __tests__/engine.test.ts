import RNFS from 'react-native-fs';
import { HealthEngine } from '../src/health/engine';
import { resetDailyStoreForTests, localDate } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';

const MIN = 60000;
let fs: ReturnType<typeof installMemFs>;

beforeEach(() => {
  // mid-afternoon, so "20 minutes ago" is still today
  jest.useFakeTimers({ now: new Date(2026, 9, 14, 15, 0), doNotFake: ['setImmediate', 'nextTick'] });
  fs = installMemFs();
  resetDailyStoreForTests();
});

afterEach(() => jest.useRealTimers());

test('today survives an app restart: environment, bottle, posture and labels are reloaded from disk', async () => {
  const now = Date.now();
  const a = new HealthEngine();
  await a.start();
  for (let i = 0; i < 5; i++) a.onEnvironment(now - (10 - i) * MIN, { co2: 900 + i, temperature: 35, humidity: 50, pm1: 30, pm25: 60, pm10: 80, dba: 60 });
  a.onEnvironment(now - 3 * MIN, { co2: 950, temperature: 35, humidity: 50, pm1: 0, pm25: 0, pm10: 0, dba: 60 }); // no PM frame
  a.onConnection('POSTURE', true, now - 20 * MIN);
  a.onPosture(now - 19 * MIN, 'SLOUCH', false);
  a.onLabel(now - 15 * MIN, 'drink', '');
  for (let i = 0; i < 70; i++) a.onBottle(now - 70 * 1000 + i * 1000, 400, 400, 390);
  await a.runTick(); // flushes bottle samples
  const first = await a.compute();
  a.stop();

  const dir = `/mock/Downloads/GaitTwin/daily/${localDate(now)}`;
  expect(Object.keys(fs.files).filter((p) => p.startsWith(dir)).map((p) => p.slice(dir.length + 1)).sort())
    .toEqual(['alerts.csv', 'bottle.csv', 'daily_summary.json', 'engine_state.json', 'minute_summary.csv']);
  // the bottle is in use but nothing drunk by 15:00: the "behind on water" rule fired in the tick
  expect(fs.files[`${dir}/alerts.csv`]).toContain(',HY-2,pace,nudge,');
  expect(first.environment.vars.pm25.minutes).toBe(5); // the all-zero PM minute is missing, not clean air
  expect(first.environment.vars.co2.minutes).toBe(6);

  // "restart": a fresh engine reads everything back (labels.csv is written by the label service)
  fs.files[`${dir}/labels.csv`] = `utc_ms,label,note\n${now - 15 * MIN},drink,\n`;
  const b = new HealthEngine();
  await b.start();
  const second = await b.compute();
  b.stop();
  expect(second.environment.vars.co2).toMatchObject({ minutes: 6, max: 950 });
  expect(second.posture?.byPose.SLOUCH).toBeCloseTo(19 + 10 / 60, 3); // onset 10 s before the commit
  expect(second.hydration.drinks).toHaveLength(1);
  expect(second.coverage.bottle).toBeGreaterThan(0);
  expect((RNFS.writeFile as jest.Mock).mock.calls.some((c) => String(c[0]).endsWith('minute_summary.csv.tmp'))).toBe(true);
});

test('a pose held across midnight continues into the new day from 00:00', async () => {
  const e = new HealthEngine();
  await e.start();
  const t = Date.now();
  e.onConnection('POSTURE', true, t - 10 * MIN);
  e.onPosture(t - 9 * MIN, 'STRAIGHT', false);
  jest.setSystemTime(new Date(2026, 9, 15, 0, 30)); // the app keeps running past midnight
  await e.runTick();
  const next = await e.compute();
  e.stop();
  expect(next.date).toBe('2026-10-15');
  expect(next.posture?.byPose.STRAIGHT).toBeCloseTo(30, 3);
});
