import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { TodayScreen } from '../src/screens/TodayScreen';
import { useHealthStore } from '../src/store/HealthStore';
import { useAlertRulesStore } from '../src/store/AlertRulesStore';
import { healthEngine } from '../src/health/engine';
import { resetDailyStoreForTests } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';
import { readFixtureText } from '../testUtils/readFixtureFile';

// The Today tab's other views on a real day: Hemel's day 7, imported from the thesis pipeline, plus a
// connection log and pressure-sensor minutes as the app writes them.
const D = '/mock/Downloads/GaitTwin/daily/2026-10-14';
const textOf = (n: ReactTestRenderer.ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(2026, 9, 20, 12, 0), doNotFake: ['setImmediate', 'nextTick'] });
  const fs = installMemFs();
  resetDailyStoreForTests();
  fs.dirs.add(D);
  for (const f of ['minute_summary.csv', 'strides_R.csv', 'strides_L.csv', 'daily_summary.json']) {
    fs.files[`${D}/${f}`] = readFixtureText(`imported_2026-10-14/${f}`);
  }
  const t = new Date(2026, 9, 14, 7, 0).getTime();
  fs.files[`${D}/connections.csv`] = `utc_ms,node,event,detail\n${t},GAIT,connected,mtu=128\n${t + 3600000},GAIT,disconnected,\n`;
  fs.files[`${D}/stream_stats.csv`] = `utc_ms,node,packets,rate_hz,loss_pct,rssi\n${t + 60000},GAIT,3700,61.7,48.0,-80\n`;
  fs.files[`${D}/fsr_minutes.csv`] = `minute,side,samples,acc_sd,heel_p95,heel_zero,heel_sat,met1_p95,met1_zero,met1_sat,met5_p95,met5_zero,met5_sat\n${t},R,6700,6.5,3000,0.4,0,0,1,0,2900,0.4,0\n`;
  jest.spyOn(healthEngine, 'compute').mockResolvedValue(null as any);
  jest.spyOn(healthEngine, 'listDays').mockResolvedValue(['2026-10-14']);
  useHealthStore.setState({ viewedDate: '2026-10-14', viewed: JSON.parse(readFixtureText('imported_2026-10-14/daily_summary.json')), days: ['2026-10-14'] });
  useAlertRulesStore.setState({ profile: { sex: 'male', heightM: 1.7145, massKg: 77 } });
});
afterEach(() => jest.useRealTimers());

test('Timeline, Gait, Trends and Data views of a picked day', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<TodayScreen />); });
  const root = tree!.root;
  const texts = () => root.findAllByType(Text).map(textOf).join(' | ');
  const open = async (label: string) => {
    const btn = root.findAllByType(TouchableOpacity).find((b) => textOf(b) === label)!;
    await ReactTestRenderer.act(async () => { btn.props.onPress(); });
    await ReactTestRenderer.act(async () => { for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r)); });
    // the charts draw once they know their width
    await ReactTestRenderer.act(async () => {
      for (const n of root.findAll((x) => typeof x.props.onLayout === 'function')) n.props.onLayout({ nativeEvent: { layout: { width: 360, height: 100 } } });
    });
  };
  const svg = (type: string) => root.findAll((n) => (n.type as any) === type).length;

  expect(texts()).toContain('2026-10-14 · imported');

  await open('Timeline');
  expect(texts()).toContain('What you were doing');
  expect(texts()).toMatch(/Walking 9 min/);
  expect(texts()).toMatch(/Drink: \d+ mL/);
  expect(svg('Path')).toBeGreaterThan(0); // heart-rate line

  await open('Gait');
  expect(texts()).toContain('Left vs right');
  expect(texts()).toContain('112 / 111');
  expect(texts()).toContain('Scaled for body size');
  expect(texts()).toMatch(/Walks \(1\)/);
  const bodySize = root.findAllByType(TouchableOpacity).find((b) => textOf(b) === 'Scaled for body size')!;
  await ReactTestRenderer.act(async () => { bodySize.props.onPress(); });
  expect(texts()).toMatch(/leg length = 0\.53 × height = 0\.91 m/);

  await open('Trends');
  expect(texts()).toContain('Walking cadence');
  expect(texts()).toContain('336 mL'); // the day's water, latest value in the 7-day view
  expect(texts()).toContain('Usual range not learned yet');

  await open('Data');
  expect(texts()).toContain('Right insole');
  expect(texts()).toContain('link lost');
  expect(texts()).toContain('48 % lost');
  expect(texts()).toMatch(/Met1 \(big toe ball\) \| 100 % faulty/);
  await ReactTestRenderer.act(async () => { tree!.unmount(); });
});
