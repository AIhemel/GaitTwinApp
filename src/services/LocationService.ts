import Geolocation from '@react-native-community/geolocation';
import { PermissionsAndroid, Platform } from 'react-native';
import { useLocationStore } from '../store/LocationStore';
import { sessionWriter, cell } from './SessionWriter';

let watchId: number | null = null;

// Only re-fetch weather if we've moved far enough or enough time has passed —
// Open-Meteo is free/keyless but weather doesn't change fast enough to justify
// hitting it on every GPS ping, and it's polite not to hammer a free API.
const WEATHER_REFRESH_DISTANCE_M = 1000;
const WEATHER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const haversineMeters = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

export const requestLocationPermission = async (): Promise<boolean> => {
  if (Platform.OS !== 'android') return true;

  const alreadyGranted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  if (alreadyGranted) return true;

  // Boot-time request may have been skipped/denied — ask again right when GPS is actually needed.
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return result === PermissionsAndroid.RESULTS.GRANTED;
};

const maybeRefreshWeather = async (latitude: number, longitude: number) => {
  const { currentWeather, setCurrentWeather } = useLocationStore.getState();
  const now = Date.now();

  const staleByTime = !currentWeather.fetchedAt || now - currentWeather.fetchedAt > WEATHER_REFRESH_INTERVAL_MS;
  const staleByDistance =
    currentWeather.fetchedLatitude === null ||
    currentWeather.fetchedLongitude === null ||
    haversineMeters(latitude, longitude, currentWeather.fetchedLatitude, currentWeather.fetchedLongitude) > WEATHER_REFRESH_DISTANCE_M;

  if (!staleByTime && !staleByDistance) return;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m`;
    const response = await fetch(url);
    const data = await response.json();
    setCurrentWeather({
      temperatureC: data?.current?.temperature_2m ?? null,
      humidityPct: data?.current?.relative_humidity_2m ?? null,
      fetchedAt: now,
      fetchedLatitude: latitude,
      fetchedLongitude: longitude,
    });
  } catch (e) {
    console.error('Weather fetch failed:', e);
  }
};

const recordPosition = (latitude: number, longitude: number, timestamp: number, speed: number | null, accuracy: number | null) => {
  const store = useLocationStore.getState();
  store.setCurrentPosition({ latitude, longitude, speedMps: speed });

  const { currentWeather } = store;
  // gps.csv: one row per fix, stamped with the fix's own time (Unix ms), not the time it was logged.
  sessionWriter.append('gps', `${timestamp},${latitude.toFixed(7)},${longitude.toFixed(7)},${cell(accuracy, 1)},${cell(speed, 2)},${cell(currentWeather.temperatureC, 1)},${cell(currentWeather.humidityPct, 1)}`);
  store.addTrackPoint({
    latitude,
    longitude,
    timestamp,
    speedMps: speed,
    temperatureC: currentWeather.temperatureC,
    humidityPct: currentWeather.humidityPct,
  });

  maybeRefreshWeather(latitude, longitude);
};

export interface StartTrackingResult {
  success: boolean;
  error?: string;
}

export const startLocationTracking = async (): Promise<StartTrackingResult> => {
  const hasPermission = await requestLocationPermission();
  if (!hasPermission) {
    const error = 'Location permission was not granted.';
    useLocationStore.getState().setLocationError(error);
    return { success: false, error };
  }

  useLocationStore.getState().setLocationError(null);

  if (watchId !== null) return { success: true };

  useLocationStore.getState().setTracking(true);

  // Grab an immediate fix so the map/CSV have a position right away, rather than waiting
  // for watchPosition's first (sometimes slow) callback.
  Geolocation.getCurrentPosition(
    (position) => recordPosition(position.coords.latitude, position.coords.longitude, position.timestamp, position.coords.speed, position.coords.accuracy),
    (error) => {
      console.error('GPS initial fix error:', error);
      useLocationStore.getState().setLocationError(error?.message || 'Could not get an initial GPS fix.');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
  );

  watchId = Geolocation.watchPosition(
    (position) => {
      useLocationStore.getState().setLocationError(null);
      recordPosition(position.coords.latitude, position.coords.longitude, position.timestamp, position.coords.speed, position.coords.accuracy);
    },
    (error) => {
      console.error('GPS error:', error);
      useLocationStore.getState().setLocationError(error?.message || 'GPS signal lost.');
    },
    { enableHighAccuracy: true, distanceFilter: 5, interval: 5000, fastestInterval: 2000 }
  );

  return { success: true };
};

export const stopLocationTracking = () => {
  if (watchId !== null) {
    Geolocation.clearWatch(watchId);
    watchId = null;
  }
  useLocationStore.getState().setTracking(false);
};
