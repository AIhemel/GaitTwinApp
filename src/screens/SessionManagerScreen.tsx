import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, FlatList, TouchableOpacity, TextInput, Alert, StyleSheet } from 'react-native';
import { listSessions, renameSession, deleteSession, SessionInfo } from '../services/SessionService';

interface SessionManagerScreenProps {
  visible: boolean;
  onClose: () => void;
}

export const SessionManagerScreen = ({ visible, onClose }: SessionManagerScreenProps) => {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');

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

  const handleDelete = (fileName: string) => {
    Alert.alert(
      'Delete Session',
      `Permanently delete "${fileName}.csv"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSession(fileName);
              refresh();
            } catch {
              Alert.alert('Error', 'Could not delete this session.');
            }
          },
        },
      ]
    );
  };

  const startRename = (fileName: string) => {
    setRenamingFile(fileName);
    setRenameInput(fileName);
  };

  const confirmRename = async () => {
    if (!renamingFile) return;
    const newName = renameInput.trim();
    if (!newName || newName === renamingFile) {
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
            keyExtractor={(item) => item.fileName}
            refreshing={loading}
            onRefresh={refresh}
            ListEmptyComponent={<Text style={styles.empty}>No recorded sessions yet.</Text>}
            renderItem={({ item }) => (
              <View style={styles.sessionRow}>
                {renamingFile === item.fileName ? (
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
                      <Text style={styles.fileName}>{item.fileName}.csv</Text>
                      <Text style={styles.meta}>
                        {item.metadata?.startTime
                          ? new Date(item.metadata.startTime).toLocaleString()
                          : `Modified ${item.modifiedTime.toLocaleString()}`}
                        {' · '}{(item.size / 1024).toFixed(1)} KB
                      </Text>
                      {!item.metadata && <Text style={styles.metaWarning}>metadata unavailable</Text>}
                    </View>
                    <TouchableOpacity style={styles.smallBtn} onPress={() => startRename(item.fileName)}>
                      <Text style={styles.smallBtnText}>Rename</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.smallBtnDelete} onPress={() => handleDelete(item.fileName)}>
                      <Text style={styles.smallBtnText}>Delete</Text>
                    </TouchableOpacity>
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
  smallBtn: { backgroundColor: '#e2e8f0', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnCancel: { backgroundColor: '#cbd5e1', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnDelete: { backgroundColor: '#F44336', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnText: { fontSize: 12, fontWeight: 'bold', color: '#2d3748' },
  renameRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  renameInput: { flex: 1, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 6, paddingHorizontal: 10, height: 36 },
  closeButton: { backgroundColor: '#4a5568', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 },
});
