/**
 * @format
 */

import { AppRegistry } from 'react-native';
import notifee from '@notifee/react-native';
import App from './App';
import { handleNotificationEvent } from './src/health/notify';
import { name as appName } from './app.json';

// Alert feedback buttons (Useful / Not useful / Wrong) pressed while the app's UI isn't running. Must be
// registered at startup, outside any component; App.tsx registers the same handler for the foreground.
notifee.onBackgroundEvent(handleNotificationEvent);

AppRegistry.registerComponent(appName, () => App);
