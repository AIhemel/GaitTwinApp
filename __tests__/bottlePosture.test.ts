import { bottleEvents } from '../src/health/bottle';
import { postureSegments } from '../src/health/posture';
import { loadCsvGz, loadJson } from '../testUtils/fixtures';

test("bottle plateaus and drink events match the pipeline on Hemel's day-7 bottle stream", () => {
  const E = loadJson('bottle_expected.json');
  const h = loadCsvGz('hydration_hemel.csv.gz');
  const samples = h.rx_ms
    .map((rx, i) => ({ i, rx }))
    .filter(({ i }) => h.offline[i] === 0)
    .map(({ i, rx }) => ({
      t: Number.isNaN(h.utc_ms[i]) ? rx : h.utc_ms[i],
      fused: h.Fused_mL[i], weight: h.Weight_g[i], cap: h.Cap_mL[i] >= 499.5 ? null : h.Cap_mL[i],
    }));
  const { plateaus, events } = bottleEvents(samples);
  expect(plateaus.length).toBe(E.plateaus.length);
  plateaus.forEach((p, k) => {
    expect(p.t0).toBe(E.plateaus[k].t0_ms);
    expect(p.t1).toBe(E.plateaus[k].t1_ms);
    expect(p.level).toBeCloseTo(E.plateaus[k].level, 6);
    expect(p.n).toBe(E.plateaus[k].n);
  });
  expect(events.map((e) => [e.t, e.kind, e.lifted])).toEqual(E.events.map((e: any) => [e.t_ms, e.kind, e.lifted]));
  events.forEach((e, k) => expect(e.changeMl).toBeCloseTo(E.events[k].change_ml, 6));
});

test("posture segments match the pipeline on Hemel's day-7 cushion events", () => {
  const E = loadJson('posture_expected.json');
  // handoff/sample_data/hemel_day7_morning/posture.csv, all five rows: two replayed events with no
  // clock, one live LEAN_BACKWARD, one replayed LEAN_FORWARD timed by the cushion, one live STRAIGHT.
  const events = [
    { utcMs: null, pose: 'LEAN_BACKWARD', replayed: true },
    { utcMs: null, pose: 'STRAIGHT', replayed: true },
    { utcMs: 1791955941327, pose: 'LEAN_BACKWARD', replayed: false },
    { utcMs: 1791956887000, pose: 'LEAN_FORWARD', replayed: true },
    { utcMs: 1791957015400, pose: 'STRAIGHT', replayed: false },
  ];
  expect(postureSegments(events, E.windows)).toEqual(E.segments);
});
