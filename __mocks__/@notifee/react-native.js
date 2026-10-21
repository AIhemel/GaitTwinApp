const notifee = {
  requestPermission: jest.fn(() => Promise.resolve({ authorizationStatus: 1 })),
  createChannel: jest.fn(() => Promise.resolve('channel')),
  displayNotification: jest.fn(() => Promise.resolve('id')),
  cancelNotification: jest.fn(() => Promise.resolve()),
  onForegroundEvent: jest.fn(() => () => {}),
  onBackgroundEvent: jest.fn(),
};

module.exports = {
  __esModule: true,
  default: notifee,
  AndroidImportance: { DEFAULT: 3, HIGH: 4, LOW: 2, MIN: 1, NONE: 0 },
  EventType: { PRESS: 1, ACTION_PRESS: 2, DISMISSED: 0 },
  AndroidStyle: { BIGPICTURE: 0, BIGTEXT: 1, INBOX: 2, MESSAGING: 3 },
};
