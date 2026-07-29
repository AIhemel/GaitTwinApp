module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!(@react-native|react-native|@react-native-async-storage/async-storage|react-native-background-actions|react-native-ble-plx|react-native-fs|react-native-webview)/)',
  ],
};
