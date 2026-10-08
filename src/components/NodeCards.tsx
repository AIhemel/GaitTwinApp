import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSensorStore } from '../store/SensorStore';
import { DeviceClock } from '../config/NodeRegistry';
import { poseName, POSTURE_SETTLE_MS } from '../protocol/NodePackets';
import { Sparkline } from './Sparkline';

// Each card subscribes to its own slice of the store only, so a gait update re-renders that one
// card instead of the whole app (the whole-app re-render per packet is what froze the UI with two
// gait nodes streaming).

const fmt = (v: number | null | undefined, digits: number, unit = '') =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit}`;

const clockTime = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleTimeString());

export const NodeStatsLine = React.memo(({ nodeId, deviceClock }: { nodeId: string; deviceClock: DeviceClock }) => {
  const stats = useSensorStore((state) => state.nodeStats[nodeId]);
  const status = useSensorStore((state) => state.nodeStatus[nodeId]);
  if (!stats) return null;

  // Low-rate nodes (environment every 10 s, posture on change): Hz would read as 0 most of the time.
  if (deviceClock === 'epoch_s') {
    if (!stats.packets) return null;
    return <Text style={styles.hint}>{stats.packets} packets · last {clockTime(stats.lastPacketAt)}</Text>;
  }
  if (status !== 'connected') return null;
  return (
    <Text style={[styles.hint, !stats.syncLocked && styles.hintWarn]}>
      {stats.rateHz} Hz · {stats.syncLocked ? 'clock synced' : 'clock sync settling…'}
    </Text>
  );
});

export const GaitCard = React.memo(({ slice, title }: { slice: 'gait' | 'gaitLeft'; title: string }) => {
  const g = useSensorStore((state) => state[slice]);
  return (
    <View style={styles.dataCard}>
      <Text style={styles.cardHeader}>{title}</Text>
      <View style={styles.grid}>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Pitch</Text>
          <Text style={styles.val}>{g.pitch.toFixed(1)}°</Text>
          <Sparkline metricKey={`${slice}.pitch`} color="#2b6cb0" />
        </View>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Roll</Text>
          <Text style={styles.val}>{g.roll.toFixed(1)}°</Text>
          <Sparkline metricKey={`${slice}.roll`} color="#2b6cb0" />
        </View>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Yaw</Text>
          <Text style={styles.val}>{g.yaw.toFixed(1)}°</Text>
          <Sparkline metricKey={`${slice}.yaw`} color="#2b6cb0" />
        </View>
      </View>
      <View style={styles.grid}>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Heel FSR</Text>
          <Text style={styles.val}>{g.heel}</Text>
          <Sparkline metricKey={`${slice}.heel`} color="#805ad5" />
        </View>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Met1 FSR</Text>
          <Text style={styles.val}>{g.mid}</Text>
          <Sparkline metricKey={`${slice}.mid`} color="#805ad5" />
        </View>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Met5 FSR</Text>
          <Text style={styles.val}>{g.toe}</Text>
          <Sparkline metricKey={`${slice}.toe`} color="#805ad5" />
        </View>
      </View>
    </View>
  );
});

export const HydrationCard = React.memo(() => {
  const hydration = useSensorStore((state) => state.hydration);
  const isSyncing = useSensorStore((state) => state.isSyncing);
  return (
    <View style={[styles.dataCard, isSyncing && styles.syncingCard]}>
      <Text style={styles.cardHeader}>Biometric Hydration Node (Fused System)</Text>
      <View style={styles.grid}>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Final Fused Vol</Text>
          <Text style={[styles.val, styles.valLarge]}>{hydration.fusedVolumeML.toFixed(1)} mL</Text>
          <Sparkline metricKey="hydration.fusedVolumeML" color="#2563EB" />
        </View>
      </View>
      <View style={[styles.grid, styles.gridDivided]}>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Load Cell Wt.</Text>
          <Text style={[styles.val, styles.valSmall, styles.purple]}>{hydration.weightGrams.toFixed(1)} g</Text>
          <Sparkline metricKey="hydration.weightGrams" color="#805ad5" />
        </View>
        <View style={styles.gridItem}>
          <Text style={styles.label}>FDC Capacitance</Text>
          <Text style={[styles.val, styles.valSmall, styles.amber]}>{hydration.capVolumeML.toFixed(1)} mL</Text>
          <Sparkline metricKey="hydration.capVolumeML" color="#d69e2e" />
        </View>
      </View>
    </View>
  );
});

export const PostureCard = React.memo(() => {
  const posture = useSensorStore((state) => state.posture);
  const status = useSensorStore((state) => state.nodeStatus.POSTURE);
  let hint: string;
  if (posture.pose !== null) {
    hint = posture.eventUtcMs === null
      ? 'Replayed from the cushion\'s queue; its clock wasn\'t set, so the time is unknown.'
      : `Held since ${clockTime(posture.eventUtcMs - POSTURE_SETTLE_MS)} (committed ${clockTime(posture.eventUtcMs)}${posture.replayed ? ', replayed' : ''})`;
  } else if (status === 'waiting') {
    hint = 'Cushion asleep (seat empty) or out of range.';
  } else {
    hint = 'A pose is reported once it has been held for 10 s.';
  }
  return (
    <View style={styles.dataCard}>
      <Text style={styles.cardHeader}>Posture Cushion Node</Text>
      <View style={styles.grid}>
        <View style={styles.gridItem}>
          <Text style={styles.label}>Pose</Text>
          <Text style={styles.val}>{posture.pose === null ? '—' : poseName(posture.pose)}</Text>
        </View>
      </View>
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
});

export const EnvironmentCard = React.memo(() => {
  const env = useSensorStore((state) => state.environment);
  const gps = env.latitude !== null && env.longitude !== null ? `${env.latitude.toFixed(5)}, ${env.longitude.toFixed(5)}` : 'no fix';
  return (
    <View style={styles.dataCard}>
      <Text style={styles.cardHeader}>Environmental Context Node</Text>
      <View style={styles.grid}>
        <View style={styles.gridItem}><Text style={styles.label}>CO₂</Text><Text style={styles.val}>{fmt(env.co2, 0, ' ppm')}</Text></View>
        <View style={styles.gridItem}><Text style={styles.label}>Temperature</Text><Text style={styles.val}>{fmt(env.temp, 1, '°C')}</Text></View>
        <View style={styles.gridItem}><Text style={styles.label}>Humidity</Text><Text style={styles.val}>{fmt(env.humidity, 1, '%')}</Text></View>
      </View>
      <View style={styles.grid}>
        <View style={styles.gridItem}><Text style={styles.label}>PM2.5</Text><Text style={styles.val}>{fmt(env.pm25, 0, ' µg/m³')}</Text></View>
        <View style={styles.gridItem}><Text style={styles.label}>PM10</Text><Text style={styles.val}>{fmt(env.pm10, 0, ' µg/m³')}</Text></View>
        <View style={styles.gridItem}><Text style={styles.label}>Noise</Text><Text style={styles.val}>{fmt(env.dba, 1, ' dBA')}</Text></View>
      </View>
      <Text style={styles.hint}>
        {env.receivedAt === null
          ? 'One 10 s average arrives every 10 s while connected.'
          : `10 s average ending ${clockTime(env.receivedAt)} · GPS ${gps} · node clock ${env.gpsClock ? 'GPS-synced' : 'not set'}`}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  dataCard: { backgroundColor: '#fff', padding: 14, borderRadius: 12, marginBottom: 12, elevation: 1 },
  syncingCard: { borderColor: '#3B82F6', borderWidth: 2 },
  cardHeader: { fontSize: 14, fontWeight: 'bold', color: '#4a5568', borderBottomWidth: 1, borderColor: '#edf2f7', paddingBottom: 6, marginBottom: 8 },
  grid: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 4 },
  gridDivided: { marginTop: 10, borderTopWidth: 1, borderColor: '#edf2f7', paddingTop: 10 },
  gridItem: { flex: 1, alignItems: 'center' },
  label: { fontSize: 11, color: '#a0aec0', marginBottom: 2 },
  val: { fontSize: 18, fontWeight: 'bold', color: '#2b6cb0' },
  valLarge: { fontSize: 24, color: '#2563EB' },
  valSmall: { fontSize: 16 },
  purple: { color: '#805ad5' },
  amber: { color: '#d69e2e' },
  hint: { fontSize: 11, color: '#a0aec0', marginTop: 2 },
  hintWarn: { color: '#d69e2e' },
});
