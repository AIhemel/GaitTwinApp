import { readJson, recoverUnfinishedSessions, writeJsonAtomic, writeManifest } from '../src/services/SessionMeta';
import { installMemFs } from '../testUtils/memfs';

const G = '/mock/Downloads/GaitTwin';
let fs: ReturnType<typeof installMemFs>;

beforeEach(() => {
  fs = installMemFs();
  fs.dirs.add(G);
});

test('atomic write: goes through a temp file and leaves no temp behind', async () => {
  fs.files[`${G}/s/session.meta.json`] = '{"old":true}';
  await writeJsonAtomic(`${G}/s/session.meta.json`, { sessionId: 'abc' });
  expect(JSON.parse(fs.files[`${G}/s/session.meta.json`])).toEqual({ sessionId: 'abc' });
  expect(`${G}/s/session.meta.json.tmp` in fs.files).toBe(false);
});

test('a kill between unlink and rename is survivable: the temp copy is read back', async () => {
  fs.files[`${G}/s/session.meta.json.tmp`] = '{"sessionId":"tmp"}';
  expect(await readJson(`${G}/s/session.meta.json`)).toEqual({ sessionId: 'tmp' });
});

test('crash recovery: endTime from lastUpdate, endedBy recovered, manifest written; finished, active and non-session folders untouched', async () => {
  const mk = (name: string, meta: object) => {
    fs.dirs.add(`${G}/${name}`);
    fs.files[`${G}/${name}/session.meta.json`] = JSON.stringify(meta);
    fs.files[`${G}/${name}/gait.csv`] = 'side\nR\n';
  };
  mk('2026-10-14_0854_crashed', { sessionId: 'a', startTime: '2026-10-14T02:54:00Z', lastUpdate: '2026-10-14T03:40:00Z', endTime: null });
  mk('2026-10-14_1000_done', { sessionId: 'b', startTime: 's', endTime: '2026-10-14T05:00:00Z' });
  mk('2026-10-14_1100_active', { sessionId: 'c', startTime: 's', endTime: null });
  fs.dirs.add(`${G}/FitData`);

  const recovered = await recoverUnfinishedSessions(`${G}/2026-10-14_1100_active`);
  expect(recovered).toEqual(['2026-10-14_0854_crashed']);
  const meta = JSON.parse(fs.files[`${G}/2026-10-14_0854_crashed/session.meta.json`]);
  expect(meta).toMatchObject({ endTime: '2026-10-14T03:40:00Z', endedBy: 'recovered' });
  expect(JSON.parse(fs.files[`${G}/2026-10-14_0854_crashed/manifest.json`]).files.map((f: any) => f.name).sort())
    .toEqual(['gait.csv', 'session.meta.json']);
  expect(JSON.parse(fs.files[`${G}/2026-10-14_1100_active/session.meta.json`]).endTime).toBeNull();
});

test('manifest lists every file with its size and SHA-256', async () => {
  fs.dirs.add(`${G}/s`);
  fs.files[`${G}/s/gait.csv`] = 'abc';
  fs.files[`${G}/s/events.csv`] = 'de';
  await writeManifest(`${G}/s`, 'id-1');
  const m = JSON.parse(fs.files[`${G}/s/manifest.json`]);
  expect(m.sessionId).toBe('id-1');
  expect(m.files).toEqual(expect.arrayContaining([
    { name: 'gait.csv', bytes: 3, sha256: 'sha256-of-3' },
    { name: 'events.csv', bytes: 2, sha256: 'sha256-of-2' },
  ]));
});
