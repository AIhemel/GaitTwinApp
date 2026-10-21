import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import RNFS from 'react-native-fs';
import { useHealthStore } from '../store/HealthStore';
import { healthEngine } from '../health/engine';
import { DaySummary, WalkSummary, fmtDuration } from '../health/daySummary';
import { EnvIntensityChart } from '../components/today/EnvIntensityChart';
import { DAILY_DIR, localDate, parseCsvText } from '../services/DailyStore';
import { AlertSettingsScreen } from './AlertSettingsScreen';
import { AlertResponse, RESPONSE_LABELS, RESPONSES_FILE, recordResponse, snoozeRule } from '../health/notify';
import { RULE_DEFS_BY_ID } from '../config/alertRules';

// The health-twin daily view (handoff/mockups/daily_report.html): what the sensors saw today, in plain
// sentences and a few numbers per domain. Values are computed on the phone by the health engine.

type Chip = { label: string; tone: 'ok' | 'info' | 'warn' | 'alert' };
const CHIP_COLORS: Record<Chip['tone'], [string, string]> = {
  ok: ['#e6f4ea', '#1e7a3c'], info: ['#e8f0fb', '#2b5c9e'], warn: ['#fdf1e3', '#a05a10'], alert: ['#fde8e8', '#b3261e'],
};

const hhmm = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : new Date(ms).toTimeString().slice(0, 5));
const n0 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(0));

const Card = ({ title, chip, children }: { title: string; chip?: Chip; children: React.ReactNode }) => (
  <View style={styles.card}>
    <View style={styles.cardHead}>
      <Text style={styles.cardTitle}>{title}</Text>
      {chip && (
        <View style={[styles.chip, { backgroundColor: CHIP_COLORS[chip.tone][0] }]}>
          <Text style={[styles.chipText, { color: CHIP_COLORS[chip.tone][1] }]}>{chip.label}</Text>
        </View>
      )}
    </View>
    {children}
  </View>
);

const Kv = ({ items }: { items: [string, string][] }) => (
  <View style={styles.kv}>
    {items.map(([v, k]) => (
      <View key={k} style={styles.kvItem}><Text style={styles.kvVal}>{v}</Text><Text style={styles.kvKey}>{k}</Text></View>
    ))}
  </View>
);

const Bar = ({ frac, color }: { frac: number; color: string }) => (
  <View style={styles.barBg}><View style={[styles.barFill, { width: `${Math.max(0, Math.min(1, frac)) * 100}%`, backgroundColor: color }]} /></View>
);

const WalkRow = ({ w }: { w: WalkSummary }) => {
  const feet = w.feet;
  return (
    <View style={styles.walk}>
      <Text style={styles.walkTitle}>{hhmm(w.start)}–{hhmm(w.end)} · {w.steps} steps · {n0(w.cadence)} steps/min</Text>
      {feet.R && feet.L ? (
        <Text style={styles.small}>
          Stance R {feet.R.stanceImuPct.toFixed(1)} % / L {feet.L.stanceImuPct.toFixed(1)} % · stride {w.strideS?.toFixed(2)} s · foot tilt R {feet.R.tiltRangeDeg.toFixed(0)}° / L {feet.L.tiltRangeDeg.toFixed(0)}°
        </Text>
      ) : null}
      <Text style={[styles.small, w.uneven.length ? styles.warnText : styles.okText]}>{w.feedback}</Text>
    </View>
  );
};

interface AlertRow { id: string; t: number; rule: string; severity: string; delivered: boolean; reason: string; title: string; body: string; response: AlertResponse | null }

const readCsv = async (path: string) => ((await RNFS.exists(path)) ? parseCsvText(await RNFS.readFile(path, 'utf8')).slice(1) : []);

const readAlerts = async (date: string): Promise<AlertRow[]> => {
  const responses = new Map<string, AlertResponse>();
  for (const r of await readCsv(`${DAILY_DIR}/${date}/${RESPONSES_FILE}`)) if (r.length >= 3) responses.set(r[0], r[2] as AlertResponse);
  const rows = (await readCsv(`${DAILY_DIR}/${date}/alerts.csv`)).filter((r) => r.length >= 9);
  return rows.map((r) => ({
    id: r[0], t: Number(r[1]), rule: r[2], severity: r[4], delivered: r[5] === '1', reason: r[6], title: r[7], body: r[8],
    response: responses.get(r[0]) ?? null,
  })).reverse();
};

const AlertItem = ({ a, date }: { a: AlertRow; date: string }) => {
  const [paused, setPaused] = useState(false);
  return (
    <View style={styles.alert}>
      <Text style={styles.alertTitle}>{hhmm(a.t)} · {a.title}</Text>
      <Text style={styles.small}>{a.body}</Text>
      {!a.delivered && <Text style={[styles.small, styles.muted]}>Not notified: {a.reason.replace('_', ' ')}.</Text>}
      <View style={styles.respRow}>
        {a.response ? <Text style={[styles.small, styles.okText]}>Your answer: {RESPONSE_LABELS[a.response]}</Text> : (
          (Object.keys(RESPONSE_LABELS) as AlertResponse[]).map((r) => (
            <TouchableOpacity key={r} style={styles.respBtn} onPress={() => recordResponse(a.id, a.rule, r, date)}>
              <Text style={styles.respText}>{RESPONSE_LABELS[r]}</Text>
            </TouchableOpacity>
          ))
        )}
        {RULE_DEFS_BY_ID[a.rule] && (
          <TouchableOpacity style={styles.respBtn} disabled={paused} onPress={() => { snoozeRule(a.rule, 60); setPaused(true); }}>
            <Text style={styles.respText}>{paused ? 'Paused 1 h' : 'Pause 1 h'}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const SummaryView = ({ s, isToday, alerts, onSettings }: { s: DaySummary; isToday: boolean; alerts: AlertRow[]; onSettings: () => void }) => {
  const env = s.environment;
  const pmMax = env.vars.pm25.max ?? 0;
  const co2Max = env.vars.co2.max ?? 0;
  const envChip: Chip | undefined = !env.vars.pm25.minutes && !env.vars.co2.minutes ? undefined
    : pmMax >= 150 || co2Max >= 1500 ? { label: 'Alert-level readings', tone: 'alert' }
      : env.pollutedMin >= 60 ? { label: `Polluted ${fmtDuration(env.pollutedMin)}`, tone: 'warn' }
        : { label: 'Within usual limits', tone: 'ok' };
  const h = s.hydration;
  const hChip: Chip | undefined = h.totalMl === null ? undefined
    : h.totalMl >= h.targetMl ? { label: 'Goal reached', tone: 'ok' }
      : h.verdict.startsWith('On track') ? { label: 'On track', tone: 'info' } : { label: 'Below goal', tone: 'warn' };
  const p = s.posture;
  const pChip: Chip | undefined = !p || p.uprightPct === null ? undefined
    : p.uprightPct >= 60 ? { label: 'Mostly upright', tone: 'ok' } : { label: 'Often slouched or leaning', tone: 'warn' };
  const g = s.gait;
  const gChip: Chip | undefined = !g.walks.length ? undefined
    : g.walks.some((w) => w.uneven.length) ? { label: 'Uneven steps seen', tone: 'warn' } : { label: 'Even steps', tone: 'ok' };
  const hr = s.heart;
  const hrChip: Chip | undefined = !hr.hrMinutes ? undefined
    : hr.restingHighMin >= 10 || (hr.minSpo2 !== null && hr.minSpo2 < 90) ? { label: 'Check alerts', tone: 'alert' } : { label: 'No alerts', tone: 'ok' };
  const cov = s.coverage;
  const coverage: [string, number][] = [
    ['Right insole', cov.gaitR], ['Left insole', cov.gaitL], ['Environment', cov.environment], ['Cushion', cov.posture],
    ['Bottle', cov.bottle], ['Band HR', cov.heartRate], ['GPS', cov.gps],
  ];

  return (
    <>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Sensors recorded</Text>
        <View style={styles.coverage}>
          {coverage.map(([name, min]) => (
            <Text key={name} style={[styles.covItem, !min && styles.covOff]}>{name} {min ? fmtDuration(min) : '—'}</Text>
          ))}
        </View>
      </View>

      {s.insights.length > 0 && (
        <Card title="Insights">
          {s.insights.map((t) => <Text key={t} style={styles.insight}>{t}</Text>)}
        </Card>
      )}

      <Card title="Environment" chip={envChip}>
        <EnvIntensityChart vars={env.vars} isToday={isToday} tempOffsetC={env.tempOffsetC} />
      </Card>

      <Card title="Movement & gait" chip={gChip}>
        <Kv items={[[String(g.stepsInsole), 'steps (insoles)'], [fmtDuration(g.walkingMin), 'walking'], [String(g.walks.length), 'walks']]} />
        {g.walks.map((w) => <WalkRow key={w.start} w={w} />)}
        {!g.walks.length && <Text style={styles.small}>No walk of 20+ strides recorded by the insoles.</Text>}
        {(g.gatedMin.R > 0 || g.gatedMin.L > 0) && (
          <Text style={[styles.small, styles.warnText]}>
            Insole data too sparse for step analysis (Bluetooth loss): {g.gatedMin.R ? `right ${fmtDuration(g.gatedMin.R)}` : ''}{g.gatedMin.R && g.gatedMin.L ? ', ' : ''}{g.gatedMin.L ? `left ${fmtDuration(g.gatedMin.L)}` : ''}.
          </Text>
        )}
      </Card>

      <Card title="Hydration" chip={hChip}>
        {h.totalMl === null ? <Text style={styles.small}>{h.verdict}</Text> : (
          <>
            <Text style={styles.big}>{(h.totalMl / 1000).toFixed(2)} L <Text style={styles.unit}>of {(h.targetMl / 1000).toFixed(1)} L</Text></Text>
            <Bar frac={h.totalMl / h.targetMl} color="#2563eb" />
            <Text style={styles.small}>{h.verdict}{h.longestGapMin !== null ? ` Longest gap: ${fmtDuration(h.longestGapMin)}.` : ''}</Text>
            {h.drinks.length > 0 && (
              <Text style={styles.small}>Drinks: {h.drinks.map((d) => `${hhmm(d.t)} ${d.ml !== null ? `${d.ml.toFixed(0)} mL` : '(tapped)'}`).join(' · ')}</Text>
            )}
          </>
        )}
        {h.history.some((d) => d.waterMl !== null) && (
          <View style={styles.history}>
            {h.history.map((d) => (
              <View key={d.date} style={styles.histRow}>
                <Text style={styles.histDate}>{d.date.slice(5)}</Text>
                <View style={styles.histBar}><Bar frac={(d.waterMl ?? 0) / h.targetMl} color={d.waterMl !== null && d.waterMl >= h.targetMl ? '#1e7a3c' : '#93b4ef'} /></View>
                <Text style={styles.histVal}>{d.waterMl === null ? '—' : `${(d.waterMl / 1000).toFixed(2)} L`}</Text>
              </View>
            ))}
          </View>
        )}
      </Card>

      <Card title="Posture" chip={pChip}>
        {!p ? <Text style={styles.small}>The posture cushion wasn't used.</Text> : (
          <>
            <Kv items={[[fmtDuration(p.uprightMin), 'upright'], [fmtDuration(p.poorMin), 'slouched / leaning'], [fmtDuration(p.longestSitMin), 'longest sitting']]} />
            {p.uprightPct !== null && <Bar frac={p.uprightPct / 100} color="#1e7a3c" />}
            <Text style={styles.small}>
              {Object.entries(p.byPose).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace('_', ' ').toLowerCase()} ${fmtDuration(v)}`).join(' · ')}
            </Text>
          </>
        )}
      </Card>

      <Card title="Heart" chip={hrChip}>
        {!hr.hrMinutes ? <Text style={styles.small}>No heart-rate data from the band yet.</Text> : (
          <>
            <Kv items={[[n0(hr.awakeMeanHr), 'awake avg bpm'], [n0(hr.sleepMeanHr), 'sleeping avg bpm'], [`${n0(hr.maxHr)}`, `max bpm (${hhmm(hr.maxHrAt)})`]]} />
            <Text style={styles.small}>
              {hr.restingHighMin ? `Above 120 bpm while not moving for ${fmtDuration(hr.restingHighMin)}. ` : 'No high heart rate at rest. '}
              {hr.minSpo2 !== null ? `Lowest SpO₂ ${hr.minSpo2.toFixed(0)} % at ${hhmm(hr.minSpo2At)} (${hr.spo2Readings} readings).` : 'No SpO₂ readings.'}
              {hr.cadenceLockMin ? ` ${hr.cadenceLockMin} min left out where the band read your step rhythm instead of your pulse.` : ''}
            </Text>
          </>
        )}
      </Card>

      <Card title="Sleep">
        {!s.sleep ? <Text style={styles.small}>No sleep record from the band for last night.</Text> : (
          <>
            <Kv items={[[fmtDuration(s.sleep.asleepMin), 'asleep'], [fmtDuration(s.sleep.inBedMin), 'in bed'], [`${hhmm(s.sleep.start)}–${hhmm(s.sleep.end)}`, 'night']]} />
            <Text style={styles.small}>
              {Object.entries(s.sleep.stageMin).filter(([, v]) => v >= 1).map(([k, v]) => `${k.replace(/_/g, ' ')} ${fmtDuration(v)}`).join(' · ')}
            </Text>
          </>
        )}
      </Card>

      <Card title={`Alerts ${isToday ? 'today' : 'that day'}`}>
        {!alerts.length ? <Text style={styles.small}>None.</Text> : alerts.map((a) => <AlertItem key={a.id} a={a} date={s.date} />)}
        <TouchableOpacity style={styles.settingsBtn} onPress={onSettings}>
          <Text style={styles.settingsText}>⚙ Alerts & reminders settings</Text>
        </TouchableOpacity>
      </Card>
      <Text style={styles.footer}>Updated {new Date(s.generatedAt).toLocaleTimeString()} · files in Downloads/GaitTwin/daily/{s.date}/</Text>
    </>
  );
};

export const TodayScreen = () => {
  const today = useHealthStore((st) => st.today);
  const viewedDate = useHealthStore((st) => st.viewedDate);
  const viewed = useHealthStore((st) => st.viewed);
  const days = useHealthStore((st) => st.days);
  const [busy, setBusy] = useState(false);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const alertsVersion = useHealthStore((st) => st.alertsVersion);
  const todayDate = localDate();
  const showing = viewedDate === null || viewedDate === todayDate ? today : viewed;
  const showingDate = viewedDate ?? todayDate;

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      useHealthStore.getState().setDays(await healthEngine.listDays());
      if (viewedDate === null || viewedDate === todayDate) await healthEngine.compute();
      setAlerts(await readAlerts(viewedDate ?? todayDate));
    } catch (e) {
      console.warn('Today refresh failed:', e);
    } finally {
      setBusy(false);
    }
  }, [viewedDate, todayDate]);

  useEffect(() => { refresh(); }, [refresh]);
  // a new alert or an answer to one: re-read the list
  useEffect(() => { readAlerts(viewedDate ?? todayDate).then(setAlerts).catch(() => {}); }, [alertsVersion, viewedDate, todayDate]);

  const pick = async (date: string) => {
    if (date === todayDate) {
      useHealthStore.getState().setViewed(null, null);
      return;
    }
    const s = await healthEngine.readDay(date);
    useHealthStore.getState().setViewed(date, s);
  };

  const dayChoices = [todayDate, ...days.filter((d) => d !== todayDate)].slice(0, 14);

  return (
    <ScrollView style={styles.scroll} refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} />}>
      <AlertSettingsScreen visible={settingsOpen} onClose={() => { setSettingsOpen(false); refresh(); }} />
      <View style={styles.topRow}>
        <Text style={styles.topHint}>Pull down to refresh</Text>
        <TouchableOpacity onPress={() => setSettingsOpen(true)}><Text style={styles.settingsLink}>⚙ Alerts & reminders</Text></TouchableOpacity>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.days}>
        {dayChoices.map((d) => (
          <TouchableOpacity key={d} style={[styles.dayChip, d === showingDate && styles.dayChipOn]} onPress={() => pick(d)}>
            <Text style={[styles.dayText, d === showingDate && styles.dayTextOn]}>{d === todayDate ? 'Today' : d.slice(5)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      {showing ? <SummaryView s={showing} isToday={showingDate === todayDate} alerts={alerts} onSettings={() => setSettingsOpen(true)} /> : (
        <View style={styles.empty}>
          {busy ? <ActivityIndicator /> : <Text style={styles.small}>No analysis for this day yet.</Text>}
        </View>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  days: { marginBottom: 12, flexGrow: 0 },
  dayChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 16, backgroundColor: '#e2e8f0', marginRight: 8 },
  dayChipOn: { backgroundColor: '#2196F3' },
  dayText: { fontSize: 13, fontWeight: '600', color: '#4a5568' },
  dayTextOn: { color: '#fff' },
  card: { backgroundColor: '#fff', padding: 14, borderRadius: 12, marginBottom: 12, elevation: 1 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#2d3748', marginBottom: 4 },
  chip: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 11, fontWeight: 'bold' },
  insight: { fontSize: 13, color: '#2d3748', marginBottom: 6, lineHeight: 18 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  kvItem: { flex: 1, alignItems: 'center' },
  kvVal: { fontSize: 17, fontWeight: 'bold', color: '#2b6cb0' },
  kvKey: { fontSize: 10.5, color: '#a0aec0', textAlign: 'center' },
  small: { fontSize: 12, color: '#4a5568', marginTop: 4, lineHeight: 17 },
  warnText: { color: '#a05a10' },
  okText: { color: '#1e7a3c' },
  walk: { borderTopWidth: 1, borderColor: '#edf2f7', paddingTop: 8, marginTop: 8 },
  walkTitle: { fontSize: 13, fontWeight: '600', color: '#2d3748' },
  big: { fontSize: 22, fontWeight: 'bold', color: '#2563eb' },
  unit: { fontSize: 13, color: '#a0aec0', fontWeight: 'normal' },
  barBg: { height: 8, backgroundColor: '#edf2f7', borderRadius: 4, overflow: 'hidden', marginTop: 6 },
  barFill: { height: 8, borderRadius: 4 },
  history: { marginTop: 10 },
  histRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  histDate: { width: 44, fontSize: 11, color: '#4a5568' },
  histBar: { flex: 1, marginHorizontal: 6, marginTop: -6 },
  histVal: { width: 52, fontSize: 11, color: '#4a5568', textAlign: 'right' },
  coverage: { flexDirection: 'row', flexWrap: 'wrap' },
  covItem: { fontSize: 11.5, color: '#2d3748', backgroundColor: '#edf2f7', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, marginRight: 6, marginBottom: 6 },
  covOff: { color: '#a0aec0' },
  empty: { padding: 30, alignItems: 'center' },
  footer: { fontSize: 10.5, color: '#a0aec0', textAlign: 'center', marginBottom: 24 },
  muted: { color: '#a0aec0' },
  alert: { borderTopWidth: 1, borderColor: '#edf2f7', paddingTop: 8, marginTop: 8 },
  alertTitle: { fontSize: 13, fontWeight: '600', color: '#2d3748' },
  respRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6, alignItems: 'center' },
  respBtn: { backgroundColor: '#edf2f7', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, marginRight: 6, marginBottom: 4 },
  respText: { fontSize: 12, fontWeight: '600', color: '#2d3748' },
  settingsBtn: { marginTop: 12, alignSelf: 'flex-start' },
  settingsText: { color: '#2196F3', fontWeight: 'bold', fontSize: 13 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  topHint: { fontSize: 11, color: '#a0aec0' },
  settingsLink: { color: '#2196F3', fontWeight: 'bold', fontSize: 13 },
});
