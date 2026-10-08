import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, FlatList, TouchableOpacity, TextInput, Alert, StyleSheet } from 'react-native';
import { listSessions, renameSession, deleteSession, SessionInfo } from '../services/SessionService';
import { useSensorStore } from '../store/SensorStore';

interface SessionManagerScreenProps {
  visible: boolean;
  onClose: () => void;
}

export const SessionManagerScreen = ({ visible, onClose }: SessionManagerScreenProps) => {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [renamingFile, setRenamingFile] = useState<SessionInfo | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const isRecording = useSensorStore((state) => state.isRecording);
  const activeFileName = useSensorStore((state) => state.fileName);
  // The session being recorded is still being written to; renaming/deleting it would break that.
  const isActive = (item: SessionInfo) => isRecording && !item.isLegacy && item.fileName === activeFileName;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listSessions();
      setSessions(list);
    } catch (e) {
      console.error('Failed to list sessions:', e);
      Alert.alert('Error', 'Could not read recorded sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const handleDelete = (session: SessionInfo) => {
    Alert.alert(
      'Delete Session',
      session.isLegacy
        ? `Permanently delete "${session.fileName}.csv"? This cannot be undone.`
        : `Permanently delete the "${session.fileName}" folder and all its CSVs? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSession(session);
              refresh();
            } catch {
              Alert.alert('Error', 'Could not delete this session.');
            }
          },
        },
      ]
    );
  };

  const startRename = (session: SessionInfo) => {
    setRenamingFile(session);
    setRenameInput(session.fileName);
  };

  const confirmRename = async () => {
    if (!renamingFile) return;
    const newName = renameInput.trim();
    if (!newName || newName === renamingFile.fileName) {
      setRenamingFile(null);
      return;
    }
    try {
      await renameSession(renamingFile, newName);
      setRenamingFile(null);
      refresh();
    } catch {
      Alert.alert('Error', 'Could not rename this session (name may already be in use).');
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={true}>
      <View style={styles.overlay}>
        <View style={styles.content}>
          <Text style={styles.title}>Recorded Sessions</Text>
          <Text style={styles.subtitle}>Downloads/GaitTwin/</Text>

          <FlatList
            data={sessions}
            keyExtractor={(item) => item.path}
            refreshing={loading}
            onRefresh={refresh}
            ListEmptyComponent={<Text style={styles.empty}>No recorded sessions yet.</Text>}
            renderItem={({ item }) => (
              <View style={styles.sessionRow}>
                {renamingFile?.path === item.path ? (
                  <View style={styles.renameRow}>
                    <TextInput
                      style={styles.renameInput}
                      value={renameInput}
                      onChangeText={setRenameInput}
                      autoFocus
                    />
                    <TouchableOpacity style={styles.smallBtn} onPress={confirmRename}>
                      <Text style={styles.smallBtnText}>Save</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.smallBtnCancel} onPress={() => setRenamingFile(null)}>
                      <Text style={styles.smallBtnText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fileName}>{item.isLegacy ? `${item.fileName}.csv` : `${item.fileName}/`}</Text>
                      {!item.isLegacy && (
                        <Text style={styles.meta}>{item.streams.length ? item.streams.join(' · ') : 'no data yet'}</Text>
                      )}
                      <Text style={styles.meta}>
                        {item.metadata?.startTime
                          ? new Date(item.metadata.startTime).toLocaleString()
                          : `Modified ${item.modifiedTime.toLocaleString()}`}
                        {' · '}{(item.size / 1024).toFixed(1)} KB
                      </Text>
                      {!item.metadata && <Text style={styles.metaWarning}>metadata unavailable</Text>}
                      {item.isLegacy && <Text style={styles.metaWarning}>legacy single-file format</Text>}
                    </View>
                    {isActive(item) ? (
                      <Text style={styles.recordingTag}>● Recording</Text>
                    ) : (
                      <>
                        <TouchableOpacity style={styles.smallBtn} onPress={() => startRename(item)}>
                          <Text style={styles.smallBtnText}>Rename</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.smallBtnDelete} onPress={() => handleDelete(item)}>
                          <Text style={styles.smallBtnText}>Delete</Text>
                        </TouchableOpacity>
                      </>
                    )}
                  </>
                )}
              </View>
            )}
          />

          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={{ color: 'white', fontWeight: 'bold' }}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  content: { backgroundColor: '#fff', borderRadius: 15, padding: 20, maxHeight: '85%' },
  title: { fontSize: 20, fontWeight: 'bold', textAlign: 'center' },
  subtitle: { fontSize: 12, color: '#a0aec0', textAlign: 'center', marginBottom: 10 },
  empty: { textAlign: 'center', color: '#a0aec0', paddingVertical: 20 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#eee' },
  fileName: { fontSize: 15, fontWeight: '600', color: '#2d3748' },
  meta: { fontSize: 11, color: '#a0aec0', marginTop: 2 },
  metaWarning: { fontSize: 11, color: '#d69e2e', marginTop: 2 },
  recordingTag: { fontSize: 12, fontWeight: 'bold', color: '#F44336', marginLeft: 8 },
  smallBtn: { backgroundColor: '#e2e8f0', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnCancel: { backgroundColor: '#cbd5e1', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnDelete: { backgroundColor: '#F44336', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnText: { fontSize: 12, fontWeight: 'bold', color: '#2d3748' },
  renameRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  renameInput: { flex: 1, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 6, paddingHorizontal: 10, height: 36 },
  closeButton: { backgroundColor: '#4a5568', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 },
});
