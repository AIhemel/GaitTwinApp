import RNFS from 'react-native-fs';

// In-memory filesystem behind the react-native-fs jest mock: enough of the API for the session,
// daily and alert writers. Call installMemFs() in beforeEach; it returns the backing maps.
export const installMemFs = () => {
  const files: Record<string, string> = {};
  const mtimes: Record<string, number> = {};
  const dirs = new Set<string>();
  const parentOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
  const touch = (p: string) => { mtimes[p] = Date.now(); };

  (RNFS.exists as jest.Mock).mockImplementation(async (p: string) => p in files || dirs.has(p));
  (RNFS.mkdir as jest.Mock).mockImplementation(async (p: string) => { dirs.add(p); });
  (RNFS.appendFile as jest.Mock).mockImplementation(async (p: string, d: string) => { files[p] = (files[p] ?? '') + d; touch(p); });
  (RNFS.writeFile as jest.Mock).mockImplementation(async (p: string, d: string) => { files[p] = d; touch(p); });
  (RNFS.readFile as jest.Mock).mockImplementation(async (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  });
  (RNFS.read as jest.Mock).mockImplementation(async (p: string) => files[p] ?? '');
  (RNFS.unlink as jest.Mock).mockImplementation(async (p: string) => {
    delete files[p];
    dirs.delete(p);
    for (const k of Object.keys(files)) if (k.startsWith(`${p}/`)) delete files[k];
  });
  (RNFS.moveFile as jest.Mock).mockImplementation(async (a: string, b: string) => {
    files[b] = files[a];
    mtimes[b] = mtimes[a];
    delete files[a];
  });
  (RNFS.readDir as jest.Mock).mockImplementation(async (dir: string) => {
    const names = new Set<string>();
    for (const p of [...Object.keys(files), ...dirs]) if (parentOf(p) === dir) names.add(p);
    return [...names].map((p) => ({
      name: p.slice(p.lastIndexOf('/') + 1),
      path: p,
      size: p in files ? files[p].length : 0,
      mtime: new Date(mtimes[p] ?? 0),
      isFile: () => p in files,
      isDirectory: () => dirs.has(p),
    }));
  });
  (RNFS.hash as jest.Mock).mockImplementation(async (p: string) => `sha256-of-${files[p]?.length ?? 0}`);
  return { files, dirs, mtimes };
};
