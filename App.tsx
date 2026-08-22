import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, TextInput, ScrollView, Switch, Alert, Modal, FlatList, ActivityIndicator } from 'react-native';
import { useSensorStore } from './src/store/SensorStore';
import { useLocationStore } from './src/store/LocationStore';
import { useFitStore } from './src/store/FitStore';
import { startBackgroundOrchestrator, startRecordingSession, stopRecordingSession, setGpsTrackingLive, sendHydrationCommand } from './src/services/BackgroundOrchestrator';
import {
  initializeHealthConnect,
  requestFitPermissions,
  startFitAutoSync,
  restartFitAutoSync,
  openHealthConnectSettings,
  DAILY_TOTAL_TYPE_IDS,
} from './src/services/HealthConnectService';
import { NODES } from './src/config/NodeRegistry';
import { HEALTH_DATA_TYPES } from './src/config/HealthConnectRegistry';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Sparkline } from './src/components/Sparkline';
import { SessionManagerScreen } from './src/screens/SessionManagerScreen';
import { MapScreen } from './src/screens/MapScreen';
import { FitDataManagerScreen } from './src/screens/FitDataManagerScreen';

const scannerManager = new BleManager();
const NODE_LIST = Object.values(NODES) as Array<{ id: string; name: string }>;
const NODES_BY_ID = NODES as Record<string, { id: string; name: string }>;
const SYNC_INTERVAL_PRESETS = [5, 10, 15];

const isValidNumber = (s: string) => {
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  const n = Number(trimmed);
  return !isNaN(n) && isFinite(n);
};

const STATUS_META: Record<string, { color: string; label: string }> = {
  connected: { color: '#4CAF50', label: '🟢 Connected' },
  connecting: { color: '#F59E0B', label: '🟡 Connecting…' },
  reconnecting: { color: '#F59E0B', label: '🟠 Reconnecting…' },
};

const timeAgo = (iso: string): string => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} hr ago`;
};

const formatMin = (m: number | undefined): string => `${Math.round(m ?? 0)}m`;

export default function App() {
  const {
    activeInterests, nodeStatus, isRecording, isSyncing, fileName, nodeBindings,
    gait, gaitLeft, posture, hydration, environment,
    addInterest, removeInterest, setFileName, bindNode, loadBindings
  } = useSensorStore();

  // Scanner Modal States
  const [isModalVisible, setModalVisible] = useState(false);
  const [scanningNode, setScanningNode] = useState<string | null>(null);
  const [discoveredDevices, setDiscoveredDevices] = useState<Device[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // OTA Calibration Input States
  const [calibWeightInput, setCalibWeightInput] = useState('');
  const [calibCapacitanceInput, setCalibCapacitanceInput] = useState('');
  const [isSendingCommand, setIsSendingCommand] = useState(false);

  // Session Manager
  const [isSessionManagerVisible, setSessionManagerVisible] = useState(false);

  // GPS / Map
  const { gpsTrackingEnabled, locationError } = useLocationStore();
  const [isMapVisible, setMapVisible] = useState(false);

  // Fit tab / Health Connect
  const [activeTab, setActiveTab] = useState<'sensors' | 'fit'>('sensors');
  const [isFitManagerVisible, setFitManagerVisible] = useState(false);
  const [hcStatus, setHcStatus] = useState<{ available: boolean; reason?: string } | null>(null);
  const {
    permissionsGranted, latestByType, dailyTotals, lastCheckedByType, isSyncing: isFitSyncing, lastSyncAt, lastSyncError,
    autoSyncEnabled, syncIntervalMinutes, fitFileNameOverride,
    setAutoSyncEnabled, setSyncIntervalMinutes, setFitFileNameOverride, loadFitSettings,
  } = useFitStore();

  useEffect(() => {
    const bootSequence = async () => {
      await loadBindings(); // Load saved MAC addresses from yesterday
      await loadFitSettings();

      if (Platform.OS === 'android') {
        try {
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          ]);
          const scanGranted = granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED;
          const connectGranted = granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED;
          const locationGranted = granted['android.permission.ACCESS_FINE_LOCATION'] === PermissionsAndroid.RESULTS.GRANTED;

          if (scanGranted && connectGranted) {
            await startBackgroundOrchestrator();
          }
          if (!scanGranted || !connectGranted || !locationGranted) {
            Alert.alert(
              'Limited Functionality',
              'Bluetooth scanning/connection may not work without Scan, Connect, and Location permissions. You can grant these in system settings.'
            );
          }
        } catch (e) {
          console.error("Boot failed:", e);
        }

        try {
          const result = await initializeHealthConnect();
          setHcStatus(result);
          if (result.available) {
            const granted = await requestFitPermissions();
            if (granted) startFitAutoSync();
          }
        } catch (e) {
          console.error("Health Connect boot failed:", e);
          setHcStatus({ available: false, reason: 'Failed to initialize Health Connect.' });
        }
      }
    };
    bootSequence();

    return () => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    };
  }, []);

  const handleNodeToggle = (nodeId: string, isEnabled: boolean) => {
    if (isEnabled && !nodeBindings[nodeId]) {
      Alert.alert("Unbound Node", "Please assign a hardware device to this node first.");
      return;
    }
    isEnabled ? addInterest(nodeId) : removeInterest(nodeId);
  };

  const openScanner = (nodeId: string) => {
    setScanningNode(nodeId);
    setDiscoveredDevices([]);
    setScanError(null);
    setModalVisible(true);
    setIsScanning(true);

    scannerManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        setScanError(error.message || 'Bluetooth scan failed.');
        setIsScanning(false);
        return;
      }
      if (device && device.name) {
        setDiscoveredDevices(prev => {
          if (!prev.find(d => d.id === device.id)) return [...prev, device];
          return prev;
        });
      }
    });

    // Auto-stop scan after 10 seconds to save battery
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = setTimeout(() => {
      scannerManager.stopDeviceScan();
      setIsScanning(false);
      scanTimeoutRef.current = null;
    }, 10000);
  };

  const stopScan = () => {
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
      scanTimeoutRef.current = null;
    }
    scannerManager.stopDeviceScan();
    setIsScanning(false);
  };

  const assignDevice = (macAddress: string) => {
    if (scanningNode) {
      bindNode(scanningNode, macAddress);
      stopScan();
      setModalVisible(false);
    }
  };

  const beginRecording = async () => {
    const { gpsError, renamedTo } = await startRecordingSession();
    if (renamedTo) {
      Alert.alert(
        "New Session File Started",
        `"${fileName}" already existed with an older column layout, so recording continues in a new file: ${renamedTo}.csv — your old file was left untouched.`
      );
    }
    if (gpsError) {
      Alert.alert("GPS Tracking Unavailable", `Recording started, but GPS tracking could not start: ${gpsError}`);
    }
  };

  const toggleRecordingSession = () => {
    if (!isRecording) {
      if (activeInterests.length === 0) return Alert.alert("Warning", "Activate a node first.");

      const notLive = activeInterests.filter(id => nodeStatus[id] !== 'connected');
      if (notLive.length > 0) {
        const names = notLive.map(id => NODES_BY_ID[id]?.name ?? id).join(', ');
        Alert.alert(
          "Node(s) Not Connected",
          `${names} ${notLive.length > 1 ? 'are' : 'is'} active but not currently connected. Recording will log stale/zero values until it reconnects. Start anyway?`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Start Anyway", onPress: () => { beginRecording(); } },
          ]
        );
        return;
      }
      beginRecording();
    } else {
      stopRecordingSession();
      Alert.alert("Session Saved", `Data successfully written to Downloads/GaitTwin/${fileName}.csv`);
    }
  };

  const handleGpsToggle = async (enabled: boolean) => {
    const { gpsError } = await setGpsTrackingLive(enabled);
    if (gpsError) {
      Alert.alert("GPS Tracking Unavailable", gpsError);
    }
  };

  const runCalibrationCommand = async (command: string, successMessage: string) => {
    setIsSendingCommand(true);
    try {
      const ok = await sendHydrationCommand(command);
      Alert.alert(ok ? "Command Sent" : "Command Failed", ok ? successMessage : "Could not reach the hydration node. Check connection.");
      return ok;
    } finally {
      setIsSendingCommand(false);
    }
  };

  const droppedWhileRecording = isRecording
    ? activeInterests.filter(id => nodeStatus[id] !== 'connected')
    : [];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.logoCircle}><Text style={styles.logoText}>⚡</Text></View>
        <Text style={styles.title}>DHT Orchestrator</Text>
        <Text style={styles.subtitle}>Digital Health Twin Multi-Node Framework</Text>
      </View>

      {isSyncing && (
        <View style={styles.syncBanner}>
          <ActivityIndicator size="small" color="#FFF" />
          <Text style={styles.syncText}> Synchronizing Offline Data...</Text>
        </View>
      )}

      {droppedWhileRecording.length > 0 && (
        <View style={styles.warnBanner}>
          <Text style={styles.warnText}>
            ⚠ {droppedWhileRecording.map(id => NODES_BY_ID[id]?.name ?? id).join(', ')} disconnected — still recording (values may be stale)
          </Text>
        </View>
      )}

      {/* TAB BAR */}
      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabButton} onPress={() => setActiveTab('sensors')}>
          <Text style={[styles.tabButtonText, activeTab === 'sensors' && styles.tabButtonTextActive]}>Sensors</Text>
          {activeTab === 'sensors' && <View style={styles.tabIndicator} />}
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabButton} onPress={() => setActiveTab('fit')}>
          <Text style={[styles.tabButtonText, activeTab === 'fit' && styles.tabButtonTextActive]}>Fit</Text>
          {activeTab === 'fit' && <View style={styles.tabIndicator} />}
        </TouchableOpacity>
      </View>

      {activeTab === 'sensors' && (
      <ScrollView style={styles.scrollArea}>
        {/* CONNECTION POOL & BINDER */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Node Assignments</Text>
          {NODE_LIST.map((node) => {
            const isTargeted = activeInterests.includes(node.id);
            const status = nodeStatus[node.id] ?? 'disconnected';
            const macAddress = nodeBindings[node.id];
            const meta = STATUS_META[status] ?? {
              color: macAddress ? '#2196F3' : '#F44336',
              label: macAddress ? `🔗 Bound: ${macAddress}` : '🔴 Unassigned',
            };

            return (
              <View key={node.id} style={styles.nodeRow}>
                <View style={{flex: 1}}>
                  <Text style={styles.nodeName}>{node.name}</Text>
                  <Text style={[styles.nodeStatus, { color: meta.color }]}>{meta.label}</Text>
                </View>

                <TouchableOpacity style={styles.bindButton} onPress={() => openScanner(node.id)}>
                  <Text style={styles.bindButtonText}>{macAddress ? 'Rebind' : 'Bind'}</Text>
                </TouchableOpacity>

                <Switch value={isTargeted} onValueChange={(val) => handleNodeToggle(node.id, val)} />
              </View>
            );
          })}
        </View>

        {/* DATA CARDS */}
        <Text style={styles.sectionHeader}>Live Core Metrics</Text>

        <View style={styles.dataCard}>
          <Text style={styles.cardHeader}>Gait Analysis Node</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Pitch</Text>
              <Text style={styles.val}>{gait.pitch.toFixed(1)}°</Text>
              <Sparkline metricKey="gait.pitch" color="#2b6cb0" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Roll</Text>
              <Text style={styles.val}>{gait.roll.toFixed(1)}°</Text>
              <Sparkline metricKey="gait.roll" color="#2b6cb0" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Yaw</Text>
              <Text style={styles.val}>{gait.yaw.toFixed(1)}°</Text>
              <Sparkline metricKey="gait.yaw" color="#2b6cb0" />
            </View>
          </View>
          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Heel FSR</Text>
              <Text style={styles.val}>{gait.heel}</Text>
              <Sparkline metricKey="gait.heel" color="#805ad5" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Met1 FSR</Text>
              <Text style={styles.val}>{gait.mid}</Text>
              <Sparkline metricKey="gait.mid" color="#805ad5" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Met5 FSR</Text>
              <Text style={styles.val}>{gait.toe}</Text>
              <Sparkline metricKey="gait.toe" color="#805ad5" />
            </View>
          </View>
        </View>

        <View style={styles.dataCard}>
          <Text style={styles.cardHeader}>Gait Analysis Node (Left Foot)</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Pitch</Text>
              <Text style={styles.val}>{gaitLeft.pitch.toFixed(1)}°</Text>
              <Sparkline metricKey="gaitLeft.pitch" color="#2b6cb0" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Roll</Text>
              <Text style={styles.val}>{gaitLeft.roll.toFixed(1)}°</Text>
              <Sparkline metricKey="gaitLeft.roll" color="#2b6cb0" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Yaw</Text>
              <Text style={styles.val}>{gaitLeft.yaw.toFixed(1)}°</Text>
              <Sparkline metricKey="gaitLeft.yaw" color="#2b6cb0" />
            </View>
          </View>
          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Heel FSR</Text>
              <Text style={styles.val}>{gaitLeft.heel}</Text>
              <Sparkline metricKey="gaitLeft.heel" color="#805ad5" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Met1 FSR</Text>
              <Text style={styles.val}>{gaitLeft.mid}</Text>
              <Sparkline metricKey="gaitLeft.mid" color="#805ad5" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Met5 FSR</Text>
              <Text style={styles.val}>{gaitLeft.toe}</Text>
              <Sparkline metricKey="gaitLeft.toe" color="#805ad5" />
            </View>
          </View>
        </View>

        <View style={styles.dataCard}>
          <Text style={styles.cardHeader}>Posture Analysis Node</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}><Text style={styles.label}>Spine Angle</Text><Text style={styles.val}>{posture.spineAngle.toFixed(1)}°</Text></View>
          </View>
        </View>

        {/* HYDRATION DATA CARD (UPDATED METRICS) */}
        <View style={[styles.dataCard, isSyncing && { borderColor: '#3B82F6', borderWidth: 2 }]}>
          <Text style={styles.cardHeader}>Biometric Hydration Node (Fused System)</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Final Fused Vol</Text>
              <Text style={[styles.val, { fontSize: 24, color: '#2563EB' }]}>{hydration.fusedVolumeML.toFixed(1)} mL</Text>
              <Sparkline metricKey="hydration.fusedVolumeML" color="#2563EB" />
            </View>
          </View>
          <View style={[styles.grid, { marginTop: 10, borderTopWidth: 1, borderColor: '#edf2f7', paddingTop: 10 }]}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Load Cell Wt.</Text>
              <Text style={[styles.val, { fontSize: 16, color: '#805ad5' }]}>{hydration.weightGrams.toFixed(1)} g</Text>
              <Sparkline metricKey="hydration.weightGrams" color="#805ad5" />
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>FDC Capacitance</Text>
              <Text style={[styles.val, { fontSize: 16, color: '#d69e2e' }]}>{hydration.capVolumeML.toFixed(1)} mL</Text>
              <Sparkline metricKey="hydration.capVolumeML" color="#d69e2e" />
            </View>
          </View>
        </View>

        {/* OTA HYDRATION CALIBRATION PANEL */}
        {nodeStatus.HYDRATION === 'connected' && (
          <View style={[styles.dataCard, { backgroundColor: '#F1F5F9' }]}>
            <Text style={styles.cardHeader}>OTA Hydration Calibration</Text>

            <TouchableOpacity
              style={[styles.recordButton, { backgroundColor: '#0EA5E9', marginBottom: 15, opacity: isSendingCommand ? 0.6 : 1 }]}
              disabled={isSendingCommand}
              onPress={() => runCalibrationCommand("TARE", "Tare system initiated.")}
            >
              <Text style={styles.buttonText}>🔄 TARE SYSTEM</Text>
            </TouchableOpacity>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.otaInput}
                keyboardType="numeric"
                placeholder="Load Cell (g)"
                value={calibWeightInput}
                onChangeText={setCalibWeightInput}
              />
              <TouchableOpacity
                style={[styles.otaSendBtn, { opacity: isSendingCommand || !isValidNumber(calibWeightInput) ? 0.6 : 1 }]}
                disabled={isSendingCommand || !isValidNumber(calibWeightInput)}
                onPress={async () => {
                  if (!isValidNumber(calibWeightInput)) {
                    Alert.alert("Invalid Input", "Enter a valid numeric weight in grams.");
                    return;
                  }
                  const value = calibWeightInput.trim();
                  const ok = await runCalibrationCommand(`CAL_W:${value}`, `Calibrating weight to ${value}g`);
                  if (ok) setCalibWeightInput('');
                }}>
                <Text style={styles.buttonText}>CAL W</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.otaInput}
                keyboardType="numeric"
                placeholder="Capacitance (mL)"
                value={calibCapacitanceInput}
                onChangeText={setCalibCapacitanceInput}
              />
              <TouchableOpacity
                style={[styles.otaSendBtn, { opacity: isSendingCommand || !isValidNumber(calibCapacitanceInput) ? 0.6 : 1 }]}
                disabled={isSendingCommand || !isValidNumber(calibCapacitanceInput)}
                onPress={async () => {
                  if (!isValidNumber(calibCapacitanceInput)) {
                    Alert.alert("Invalid Input", "Enter a valid numeric capacitance volume in mL.");
                    return;
                  }
                  const value = calibCapacitanceInput.trim();
                  const ok = await runCalibrationCommand(`CAL_C:${value}`, `Calibrating capacitance to ${value}mL`);
                  if (ok) setCalibCapacitanceInput('');
                }}>
                <Text style={styles.buttonText}>CAL C</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.dataCard}>
          <Text style={styles.cardHeader}>Environmental Context Node</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}><Text style={styles.label}>Temperature</Text><Text style={styles.val}>{environment.temp.toFixed(1)}°C</Text></View>
            <View style={styles.gridItem}><Text style={styles.label}>Humidity</Text><Text style={styles.val}>{environment.humidity.toFixed(1)}%</Text></View>
          </View>
        </View>

        {/* GPS TRACKING & MAP */}
        <View style={styles.sectionCard}>
          <View style={styles.gpsToggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>GPS Tracking</Text>
              <Text style={styles.gpsHint}>Records your route, speed, and local weather during a session</Text>
            </View>
            <Switch value={gpsTrackingEnabled} onValueChange={handleGpsToggle} />
          </View>
          {locationError && <Text style={styles.gpsError}>⚠ {locationError}</Text>}
          <TouchableOpacity style={styles.sessionManagerButton} onPress={() => setMapVisible(true)}>
            <Text style={styles.sessionManagerButtonText}>🗺️ View Map</Text>
          </TouchableOpacity>
        </View>

        {/* BACKGROUND RECORDER */}
        <View style={styles.recordSection}>
          <Text style={styles.sectionTitleWhite}>Synchronous Flight Logger</Text>
          <TextInput style={styles.input} value={fileName} onChangeText={setFileName} placeholder="Enter custom CSV name" editable={!isRecording} />
          <TouchableOpacity style={[styles.recordButton, { backgroundColor: isRecording ? '#F44336' : '#4CAF50' }]} onPress={toggleRecordingSession}>
            <Text style={styles.buttonText}>{isRecording ? '🛑 STOP & FLUSH CSV' : '⏺️ START RECORDING'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.sessionManagerButton} onPress={() => setSessionManagerVisible(true)}>
            <Text style={styles.sessionManagerButtonText}>📁 Manage Recorded Sessions</Text>
          </TouchableOpacity>
        </View>

        {/* CREDITS */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Developed and designed by</Text>
          <Text style={styles.footerName}>Asraful Islam Hemel</Text>
          <Text style={styles.footerLab}>MAIM LAB, RMEDU</Text>
        </View>
      </ScrollView>
      )}

      {activeTab === 'fit' && (
      <ScrollView style={styles.scrollArea}>
        {!hcStatus?.available && (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Health Connect Unavailable</Text>
            <Text style={styles.gpsHint}>{hcStatus?.reason ?? 'Checking availability…'}</Text>
            <TouchableOpacity style={styles.sessionManagerButton} onPress={() => openHealthConnectSettings()}>
              <Text style={styles.sessionManagerButtonText}>Open Health Connect Settings</Text>
            </TouchableOpacity>
          </View>
        )}

        {hcStatus?.available && permissionsGranted.length === 0 && (
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>No Permissions Granted</Text>
            <Text style={styles.gpsHint}>Grant read access to fitness data in Health Connect to see it here.</Text>
            <TouchableOpacity
              style={styles.sessionManagerButton}
              onPress={async () => {
                const granted = await requestFitPermissions();
                if (granted) startFitAutoSync();
              }}
            >
              <Text style={styles.sessionManagerButtonText}>Grant Permissions</Text>
            </TouchableOpacity>
          </View>
        )}

        {hcStatus?.available && permissionsGranted.length > 0 && (
          <>
            <View style={styles.sectionCard}>
              <View style={styles.gpsToggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sectionTitle}>Auto Sync</Text>
                  <Text style={styles.gpsHint}>
                    {isFitSyncing ? 'Syncing…' : lastSyncAt ? `Last synced ${new Date(lastSyncAt).toLocaleTimeString()}` : 'Not yet synced'}
                  </Text>
                </View>
                <Switch value={autoSyncEnabled} onValueChange={setAutoSyncEnabled} />
              </View>
              {lastSyncError && <Text style={styles.gpsError}>⚠ {lastSyncError}</Text>}

              <View style={styles.inputRow}>
                {SYNC_INTERVAL_PRESETS.map((min) => (
                  <TouchableOpacity
                    key={min}
                    style={[styles.intervalPreset, syncIntervalMinutes === min && styles.intervalPresetActive]}
                    onPress={async () => {
                      await setSyncIntervalMinutes(min);
                      restartFitAutoSync();
                    }}
                  >
                    <Text style={[styles.intervalPresetText, syncIntervalMinutes === min && styles.intervalPresetTextActive]}>{min} min</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TextInput
                style={styles.input}
                value={fitFileNameOverride ?? ''}
                onChangeText={(v) => setFitFileNameOverride(v.trim().length > 0 ? v : null)}
                placeholder="Auto (today's date)"
              />
            </View>

            <Text style={styles.sectionHeader}>Fitness Data</Text>
            {HEALTH_DATA_TYPES.filter((t) => permissionsGranted.includes(t.id)).map((type) => {
              const latest = latestByType[type.id];
              const isDailyTotal = DAILY_TOTAL_TYPE_IDS.includes(type.id);
              const displayValue = isDailyTotal ? dailyTotals[type.id] : latest;
              const checkedAt = lastCheckedByType[type.id];

              return (
                <View key={type.id} style={styles.dataCard}>
                  <Text style={styles.cardHeader}>{type.label}{isDailyTotal ? ' (Today)' : ''}</Text>
                  <View style={styles.grid}>
                    <View style={styles.gridItem}>
                      <Text style={[styles.val, { color: type.color }]}>
                        {displayValue?.value != null ? displayValue.value.toFixed(1) : '—'} {type.unit}
                      </Text>

                      {type.id === 'BLOOD_PRESSURE' && latest?.detail?.diastolic != null && (
                        <Text style={styles.label}>Diastolic {latest.detail.diastolic.toFixed(0)} mmHg</Text>
                      )}

                      {type.id === 'SLEEP_SESSION' && latest?.detail && (
                        <Text style={styles.label}>
                          Deep {formatMin(latest.detail.deepMin)} · Light {formatMin(latest.detail.lightMin)} · REM {formatMin(latest.detail.remMin)} · Awake {formatMin(latest.detail.awakeMin)}
                        </Text>
                      )}

                      <Text style={styles.gpsHint}>
                        {checkedAt ? `Checked ${timeAgo(checkedAt)}` : 'Not yet checked'}
                        {latest ? ` · Latest data from ${new Date(latest.timestamp).toLocaleTimeString()}` : ' · No data yet'}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })}

            <TouchableOpacity style={styles.sessionManagerButton} onPress={() => setFitManagerVisible(true)}>
              <Text style={styles.sessionManagerButtonText}>📁 Manage Fit Data</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
      )}

      {/* SCANNER MODAL */}
      <Modal visible={isModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Select Hardware Device</Text>
            <Text style={{textAlign: 'center', marginBottom: 15}}>
              {scanError ? `⚠ ${scanError}` : isScanning ? 'Radar Active...' : 'Scan Complete'}
            </Text>

            <FlatList
              data={discoveredDevices}
              keyExtractor={(item) => item.id}
              renderItem={({item}) => (
                <TouchableOpacity style={styles.deviceRow} onPress={() => assignDevice(item.id)}>
                  <Text style={{fontWeight: 'bold'}}>{item.name || 'Unknown Device'}</Text>
                  <Text style={{fontSize: 12, color: '#666'}}>{item.id}</Text>
                </TouchableOpacity>
              )}
            />

            <TouchableOpacity style={styles.closeButton} onPress={() => { stopScan(); setModalVisible(false); }}>
              <Text style={{color: 'white', fontWeight: 'bold'}}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <SessionManagerScreen visible={isSessionManagerVisible} onClose={() => setSessionManagerVisible(false)} />
      <MapScreen visible={isMapVisible} onClose={() => setMapVisible(false)} />
      <FitDataManagerScreen visible={isFitManagerVisible} onClose={() => setFitManagerVisible(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9', padding: 15 },
  header: { alignItems: 'center', marginVertical: 20 },
  logoCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#2196F3', justifyContent: 'center', alignItems: 'center', marginBottom: 10, elevation: 4 },
  logoText: { fontSize: 30 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#1a202c' },
  subtitle: { fontSize: 13, color: '#718096', marginTop: 4 },
  syncBanner: { backgroundColor: '#3B82F6', padding: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 8, marginHorizontal: 5, marginBottom: 15 },
  syncText: { color: '#FFF', fontWeight: 'bold', marginLeft: 8 },
  warnBanner: { backgroundColor: '#F59E0B', padding: 10, borderRadius: 8, marginHorizontal: 5, marginBottom: 15 },
  warnText: { color: '#FFF', fontWeight: 'bold', textAlign: 'center' },
  scrollArea: { flex: 1 },
  sectionCard: { backgroundColor: '#fff', padding: 15, borderRadius: 12, marginBottom: 20, elevation: 2 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: '#2d3748', marginBottom: 10 },
  sectionTitleWhite: { fontSize: 16, fontWeight: 'bold', color: '#fff', marginBottom: 10 },
  sectionHeader: { fontSize: 18, fontWeight: 'bold', color: '#2d3748', marginVertical: 10, paddingLeft: 5 },
  nodeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#edf2f7' },
  nodeName: { fontSize: 15, fontWeight: '600', color: '#2d3748' },
  nodeStatus: { fontSize: 11, marginTop: 2, fontWeight: '600' },
  bindButton: { backgroundColor: '#e2e8f0', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, marginRight: 10 },
  bindButtonText: { fontSize: 12, fontWeight: 'bold', color: '#4a5568' },
  dataCard: { backgroundColor: '#fff', padding: 14, borderRadius: 12, marginBottom: 12, elevation: 1 },
  cardHeader: { fontSize: 14, fontWeight: 'bold', color: '#4a5568', borderBottomWidth: 1, borderColor: '#edf2f7', paddingBottom: 6, marginBottom: 8 },
  grid: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 4 },
  gridItem: { flex: 1, alignItems: 'center' },
  label: { fontSize: 11, color: '#a0aec0', marginBottom: 2 },
  val: { fontSize: 18, fontWeight: 'bold', color: '#2b6cb0' },
  recordSection: { backgroundColor: '#1a202c', padding: 15, borderRadius: 12, marginTop: 15, marginBottom: 20 },
  input: { backgroundColor: '#fff', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 14, color: '#2d3748' },
  recordButton: { padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  sessionManagerButton: { padding: 12, borderRadius: 8, alignItems: 'center', marginTop: 10, backgroundColor: '#2d3748' },
  sessionManagerButtonText: { color: '#fff', fontSize: 13, fontWeight: 'bold' },
  gpsToggleRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  gpsHint: { fontSize: 11, color: '#a0aec0', marginTop: 2 },
  gpsError: { fontSize: 12, color: '#d69e2e', marginBottom: 10, fontWeight: '600' },
  tabBar: { flexDirection: 'row', backgroundColor: '#fff', borderRadius: 12, marginBottom: 15, elevation: 2, overflow: 'hidden' },
  tabButton: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  tabButtonText: { fontSize: 14, fontWeight: '600', color: '#a0aec0' },
  tabButtonTextActive: { color: '#2196F3' },
  tabIndicator: { height: 3, width: '60%', backgroundColor: '#2196F3', borderRadius: 2, marginTop: 6 },
  intervalPreset: { flex: 1, backgroundColor: '#e2e8f0', paddingVertical: 8, borderRadius: 8, alignItems: 'center', marginRight: 8 },
  intervalPresetActive: { backgroundColor: '#2196F3' },
  intervalPresetText: { fontSize: 12, fontWeight: 'bold', color: '#4a5568' },
  intervalPresetTextActive: { color: '#fff' },
  inputRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  otaInput: { flex: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 15, height: 45, marginRight: 10, fontSize: 15 },
  otaSendBtn: { backgroundColor: '#10B981', paddingHorizontal: 20, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
  footer: { alignItems: 'center', paddingVertical: 25, borderTopWidth: 1, borderColor: '#e2e8f0', marginTop: 10 },
  footerText: { fontSize: 12, color: '#a0aec0' },
  footerName: { fontSize: 14, fontWeight: 'bold', color: '#4a5568', marginTop: 2 },
  footerLab: { fontSize: 12, fontWeight: '600', color: '#2196F3', marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalContent: { backgroundColor: '#fff', borderRadius: 15, padding: 20, maxHeight: '80%' },
  modalTitle: { fontSize: 20, fontWeight: 'bold', textAlign: 'center', marginBottom: 5 },
  deviceRow: { padding: 15, borderBottomWidth: 1, borderColor: '#eee' },
  closeButton: { backgroundColor: '#F44336', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 }
});
