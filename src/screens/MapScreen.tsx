import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { useLocationStore } from '../store/LocationStore';
import { MAP_HTML } from './mapHtml';

interface MapScreenProps {
  visible: boolean;
  onClose: () => void;
}

export const MapScreen = ({ visible, onClose }: MapScreenProps) => {
  const webViewRef = useRef<WebView>(null);
  const injectedCountRef = useRef(0);
  const isMapReadyRef = useRef(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const path = useLocationStore((state) => state.path);
  const currentPosition = useLocationStore((state) => state.currentPosition);
  const isTracking = useLocationStore((state) => state.isTracking);
  const gpsTrackingEnabled = useLocationStore((state) => state.gpsTrackingEnabled);
  const locationError = useLocationStore((state) => state.locationError);

  const injectPoint = (point: { latitude: number; longitude: number; temperatureC: number | null; humidityPct: number | null; speedMps: number | null }) => {
    const script = `window.addPoint(${point.latitude}, ${point.longitude}, ${point.temperatureC ?? 'null'}, ${point.humidityPct ?? 'null'}, ${point.speedMps ?? 'null'}); true;`;
    webViewRef.current?.injectJavaScript(script);
  };

  useEffect(() => {
    if (!visible || !isMapReadyRef.current) return;
    for (let i = injectedCountRef.current; i < path.length; i++) {
      injectPoint(path[i]);
    }
    injectedCountRef.current = path.length;
  }, [visible, path]);

  const handleLoadEnd = () => {
    isMapReadyRef.current = true;
    injectedCountRef.current = 0;
    for (const point of path) {
      injectPoint(point);
    }
    injectedCountRef.current = path.length;
    webViewRef.current?.injectJavaScript('window.fitToPath(); true;');
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'leaflet-load-failed' || data.type === 'js-error') {
        setMapError(data.message);
      } else if (data.type === 'map-ready') {
        setMapError(null);
      }
    } catch {
      // ignore malformed messages
    }
  };

  const speedKmh = currentPosition?.speedMps != null ? (currentPosition.speedMps * 3.6).toFixed(1) : null;
  const showEmptyHint = path.length === 0;

  return (
    <Modal visible={visible} animationType="slide">
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Route & Environment Map</Text>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>

        {isTracking && (
          <View style={styles.statusBar}>
            <Text style={styles.statusText}>
              🛰 Tracking · {path.length} points{speedKmh ? ` · ${speedKmh} km/h` : ''}
            </Text>
          </View>
        )}

        {!gpsTrackingEnabled && showEmptyHint && (
          <View style={styles.hintBar}>
            <Text style={styles.hintText}>Turn on GPS Tracking and start a recording session to see your route here.</Text>
          </View>
        )}
        {gpsTrackingEnabled && !isTracking && showEmptyHint && (
          <View style={styles.hintBar}>
            <Text style={styles.hintText}>GPS Tracking is on — start a recording session to begin plotting your route.</Text>
          </View>
        )}
        {isTracking && showEmptyHint && !locationError && (
          <View style={styles.hintBar}>
            <Text style={styles.hintText}>Waiting for a GPS fix… this can take a few seconds outdoors, longer indoors.</Text>
          </View>
        )}
        {locationError && (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>⚠ {locationError}</Text>
          </View>
        )}
        {mapError && (
          <View style={styles.errorBar}>
            <Text style={styles.errorText}>⚠ Map error: {mapError}</Text>
          </View>
        )}

        <WebView<{}>
          ref={webViewRef}
          originWhitelist={['*']}
          source={{ html: MAP_HTML }}
          onLoadEnd={handleLoadEnd}
          onMessage={handleMessage}
          style={styles.webview}
        />
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 15, borderBottomWidth: 1, borderColor: '#eee',
  },
  title: { fontSize: 16, fontWeight: 'bold', color: '#2d3748' },
  closeButton: { backgroundColor: '#4a5568', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  closeButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 12 },
  statusBar: { backgroundColor: '#2563EB', padding: 8 },
  statusText: { color: '#fff', textAlign: 'center', fontSize: 12, fontWeight: '600' },
  hintBar: { backgroundColor: '#EDF2F7', padding: 10 },
  hintText: { color: '#4a5568', textAlign: 'center', fontSize: 12 },
  errorBar: { backgroundColor: '#FEF3C7', padding: 10 },
  errorText: { color: '#92400E', textAlign: 'center', fontSize: 12, fontWeight: '600' },
  webview: { flex: 1 },
});
