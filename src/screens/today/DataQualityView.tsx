import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { dayQuality, BAND_OFF_MIN, NodeQuality } from '../../health/dayQuality';
import { FSR_FAULTY_FRACTION, FSR_KEYS, FSR_NAMES, FsrSideHealth } from '../../health/fsr';
import { NODE_LABELS } from '../../health/dataQuality';
import { DayFiles } from '../../health/history';
import { fmtDuration } from '../../health/daySummary';
import { Bar, Card, Chip, hhmm, n0, ui } from '../../components/today/ui';

// Data quality for one day (FEATURE_HEALTH_TWIN.md §6 screen 7): how long each sensor was connected
// and delivering data, disconnections, the environment node's warm-up, faulty insole pressure
// sensors and band wear time.

const EVENT_NAMES: Record<string, string> = {
  connected: 'connected', disconnected: 'link lost', disconnected_by_user: 'switched off by you',
  connect_failed: 'connect failed', reboot_detected: 'node restarted',
};

const NodeRow = ({ n, dayMin }: { n: NodeQuality; dayMin: number }) => {
  const lossy = n.lossPct !== null && n.lossPct >= 10;
  return (
    <View style={ui.divider}>
      <View style={ui.between}>
        <Text style={styles.node}>{n.name}</Text>
        <Text style={ui.legendText}>{n.connectedMin ? `connected ${fmtDuration(n.connectedMin)}` : 'not connected'}</Text>
      </View>
      <Bar frac={n.connectedMin / dayMin} color="#4299e1" />
      <Text style={ui.small}>
        {n.dataMin !== null ? `Data in ${fmtDuration(n.dataMin)}. ` : ''}
        {n.disconnects ? `${n.disconnects} link loss${n.disconnects > 1 ? 'es' : ''}. ` : n.connectedMin ? 'No link losses. ' : ''}
        {n.userOff ? `Switched off ${n.userOff}×. ` : ''}
        {n.failedConnects ? `${n.failedConnects} failed connect${n.failedConnects > 1 ? 's' : ''}. ` : ''}
        {n.reboots ? `Restarted ${n.reboots}×. ` : ''}
      </Text>
      {n.connectedMin > 0 && (
        <Text style={[ui.small, lossy && ui.warnText]}>
          {n.rateHz !== null ? `${n.rateHz >= 1 ? n.rateHz.toFixed(0) : n.rateHz.toFixed(2)} packets/s` : ''}
          {n.lossPct !== null ? ` · ${n.lossPct.toFixed(0)} % lost` : ''}
          {n.rssi !== null ? ` · signal ${n.rssi} dBm` : ''} (medians per minute)
        </Text>
      )}
    </View>
  );
};

const FsrSide = ({ side, h }: { side: 'R' | 'L'; h: FsrSideHealth | null }) => (
  <View style={ui.divider}>
    <Text style={styles.node}>{side === 'R' ? 'Right' : 'Left'} insole</Text>
    {!h ? <Text style={ui.small}>No minutes with the foot moving.</Text> : (
      <>
        <Text style={ui.tiny}>{fmtDuration(h.movingMin)} with the foot moving</Text>
        {FSR_KEYS.map((k) => {
          const s = h.sensors[k];
          const bad = s.faultyPct >= 100 * FSR_FAULTY_FRACTION;
          const some = s.faultyPct >= 10;
          return (
            <View key={k} style={styles.fsrRow}>
              <Text style={[ui.small, styles.fsrName]}>{FSR_NAMES[k]}</Text>
              <Text style={[ui.small, styles.fsrVal, bad ? ui.alertText : some ? ui.warnText : ui.okText]}>
                {s.faultyPct < 0.5 ? 'OK' : `${s.faultyPct.toFixed(0)} % faulty`}
                {s.dropout ? ` · dropout ${s.dropout} min` : ''}{s.lowRange ? ` · low range ${s.lowRange} min` : ''}
              </Text>
            </View>
          );
        })}
        {FSR_KEYS.some((k) => h.sensors[k].faultyPct >= 100 * FSR_FAULTY_FRACTION) && (
          <Text style={[ui.small, ui.warnText]}>
            A sensor was faulty in over {100 * FSR_FAULTY_FRACTION} % of moving minutes: pressure-based stance and loading
            for this foot are not reliable. Stance, swing and push-off from the motion sensor are unaffected.
          </Text>
        )}
      </>
    )}
  </View>
);

export const DataQualityView = ({ files, isToday }: { files: DayFiles; isToday: boolean }) => {
  const [allEvents, setAllEvents] = useState(false);
  const { q, end } = useMemo(() => {
    const e = isToday ? Date.now() : files.dayStart + 24 * 3600000;
    return {
      end: e,
      q: dayQuality({
        dayStart: files.dayStart, end: e, connections: files.connections, streamStats: files.streamStats, fsr: files.fsr,
        minutes: files.minutes, summary: files.summary,
      }),
    };
  }, [files, isToday]);
  const dayMin = Math.max(1, (end - files.dayStart) / 60000);
  const events = allEvents ? q.events : q.events.slice(-12);
  const lossy = q.nodes.filter((n) => n.lossPct !== null && n.lossPct >= 10);
  const chip: Chip | undefined = !q.logged ? undefined
    : lossy.length ? { label: `Data loss: ${lossy.map((n) => n.name.toLowerCase()).join(', ')}`, tone: 'warn' }
      : { label: 'No major loss', tone: 'ok' };

  return (
    <>
      <Card title="Sensors" chip={chip}>
        {!q.logged && (
          <Text style={[ui.small, ui.muted]}>
            Connection logs start with this app version; for this day only the data minutes are known.
          </Text>
        )}
        {q.nodes.map((n) => <NodeRow key={n.nodeId} n={n} dayMin={dayMin} />)}
        {q.gatedMin && (q.gatedMin.R > 0 || q.gatedMin.L > 0) && (
          <Text style={[ui.small, ui.warnText]}>
            Insole data too sparse for step analysis: right {fmtDuration(q.gatedMin.R)}, left {fmtDuration(q.gatedMin.L)} (below
            80 packets/s or over 10 % gaps).
          </Text>
        )}
      </Card>

      {q.events.length > 0 && (
        <Card title={`Connection log (${q.events.length})`}>
          {events.map((e, i) => (
            <Text key={`${e.t}-${i}`} style={ui.small}>
              {hhmm(e.t)} · {NODE_LABELS[e.node] ?? e.node} {EVENT_NAMES[e.event] ?? e.event}
              {e.event === 'connect_failed' && e.detail ? ` (${e.detail.replace(/^.*error=/, '')})` : ''}
            </Text>
          ))}
          {q.events.length > 12 && (
            <TouchableOpacity onPress={() => setAllEvents(!allEvents)}>
              <Text style={styles.link}>{allEvents ? 'Show the last 12' : `Show all ${q.events.length}`}</Text>
            </TouchableOpacity>
          )}
        </Card>
      )}

      <Card title="Environment node warm-up">
        <Text style={ui.small}>
          The node's temperature reads high for the first 30 min after it starts (self-heating), so those minutes are left
          out of temperature.{q.warmupMin !== null ? ` ${fmtDuration(q.warmupMin)} excluded on this day.` : ''}
        </Text>
        {q.warmups.map((w) => <Text key={w.from} style={ui.small}>{hhmm(w.from)}–{hhmm(w.to)}</Text>)}
      </Card>

      <Card title="Insole pressure sensors">
        <FsrSide side="R" h={q.fsr.R} />
        <FsrSide side="L" h={q.fsr.L} />
        <Text style={ui.tiny}>
          Rated each minute the foot was moving. Dropout = no signal, or zero in over half the samples (loose connection);
          low range = signal under 10 % of the foot's strongest sensor (e.g. a replacement sensor). Readings at the 4095
          maximum are normal for these sensors and are not counted as faults.
        </Text>
      </Card>

      <Card title="Band (heart rate)">
        {!q.band ? <Text style={ui.small}>No heart rate from the band on this day.</Text> : (
          <>
            <Text style={ui.small}>
              Worn about {fmtDuration(q.band.wornMin)} ({n0((100 * q.band.wornMin) / dayMin)} % of the {isToday ? 'day so far' : 'day'}):
              {' '}{q.band.readings} minutes with a reading, first {hhmm(q.band.first)}, last {hhmm(q.band.last)}.
            </Text>
            {q.band.offGaps.length > 0 && (
              <Text style={ui.small}>
                No reading for over {BAND_OFF_MIN} min (off the wrist, or not synced): {q.band.offGaps.map((g) => `${hhmm(g.from)}–${hhmm(g.to)}`).join(', ')}.
              </Text>
            )}
          </>
        )}
        <Text style={ui.tiny}>
          Readings no more than {BAND_OFF_MIN} min apart count as worn. Band data reaches the phone through Health Connect, so
          the last hour may still be missing.
        </Text>
      </Card>
    </>
  );
};

const styles = StyleSheet.create({
  node: { fontSize: 13, fontWeight: '600', color: '#2d3748' },
  fsrRow: { flexDirection: 'row', justifyContent: 'space-between' },
  fsrName: { flex: 1 },
  fsrVal: { flex: 1.3, textAlign: 'right' },
  link: { color: '#2196F3', fontWeight: 'bold', fontSize: 12.5, marginTop: 8 },
});
