module.exports = {
  DownloadDirectoryPath: '/mock/Downloads',
  exists: jest.fn(() => Promise.resolve(false)),
  mkdir: jest.fn(() => Promise.resolve()),
  appendFile: jest.fn(() => Promise.resolve()),
  writeFile: jest.fn(() => Promise.resolve()),
  readFile: jest.fn(() => Promise.resolve('')),
  read: jest.fn(() => Promise.resolve('')),
  readDir: jest.fn(() => Promise.resolve([])),
  moveFile: jest.fn(() => Promise.resolve()),
  unlink: jest.fn(() => Promise.resolve()),
  scanFile: jest.fn(() => Promise.resolve()),
  stat: jest.fn(() => Promise.resolve({ mtime: new Date() })),
};
