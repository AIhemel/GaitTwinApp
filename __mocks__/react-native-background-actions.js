module.exports = {
  start: jest.fn(() => Promise.resolve()),
  stop: jest.fn(() => Promise.resolve()),
  isRunning: jest.fn(() => false),
  updateNotification: jest.fn(() => Promise.resolve()),
};
