import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { TodayScreen } from '../src/screens/TodayScreen';
import { useHealthStore } from '../src/store/HealthStore';
import { computeDay, EnvMinute } from '../src/health/daySummary';
import { buildHeartData } from '../src/health/heart';
import { analyzeFoot } from '../src/health/gait';
import { healthEngine } from '../src/health/engine';
import { loadFoot } from '../testUtils/fixtures';

const MIN = 60000;
const em = (pm25: number, co2: number, dba: number, temp: number): EnvMinute => ({
  co2: [co2, 1], temp: [temp, 1], rh: [50, 1], pm25: [pm25, 1], pm10: [pm25 * 1.3, 1], dbaEnergy: [10 ** (dba / 10), 1], warmup: false,
});

test('the Today tab renders a full day: environment chart, walks, hydration, posture, insights', async () => {
  const d0 = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const { summary } = computeDay({
    date: 'today', dayStart: d0, dayEnd: d0 + 864e5, now: d0 + 20 * 3600000,
    strides: { R: analyzeFoot(loadFoot('gait_hemel_R.csv.gz')).strides, L: analyzeFoot(loadFoot('gait_hemel_L.csv.gz')).strides },
    gaitMinutes: { R: [d0], L: [d0] }, gaitGatedMin: { R: 12, L: 0 },
    env: [...Array(600)].map((_, i) => [d0 + 8 * 3600000 + i * MIN, em(40 + (i % 200), 600 + i, 55 + (i % 30), 34)]),
    bottle: [], poseEvents: [{ utcMs: d0 + 9 * 3600000, pose: 'SLOUCH', replayed: false }],
    postureWindows: [[d0 + 9 * 3600000 - 10000, d0 + 10 * 3600000]],
    labels: [{ t: d0 + 12 * 3600000, label: 'drink', note: '' }], gps: [],
    heart: buildHeartData([], d0, d0 + 864e5),
    settings: { tempOffsetC: -5, leanForwardIsUpright: false, targetMl: 2000 }, previousDays: [{ date: '2026-10-20', waterMl: 1500 }],
  });
  jest.spyOn(healthEngine, 'compute').mockResolvedValue(summary);
  jest.spyOn(healthEngine, 'listDays').mockResolvedValue([]);
  useHealthStore.setState({ today: summary, viewedDate: null, viewed: null });

  let tree: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<TodayScreen />);
  });
  const strings: string[] = [];
  const walk = (n: any) => {
    if (n === null || n === undefined) return;
    if (typeof n === 'string') { strings.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    (n.children ?? []).forEach(walk);
  };
  walk(tree!.toJSON());
  const text = strings.join(' ');
  for (const s of ['Environment', 'PM2.5', 'Movement & gait', 'steps/min', 'Hydration', 'Posture', 'Insights', 'too sparse']) {
    expect(text).toContain(s);
  }
});
