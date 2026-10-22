import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useHealthStore } from '../store/HealthStore';
import { healthEngine } from '../health/engine';
import { DaySummary, WalkSummary, fmtDuration } from '../health/daySummary';
import { AlertRow, DayFiles, readAlerts, readDayFiles } from '../health/history';
import { EnvIntensityChart } from '../components/today/EnvIntensityChart';
import { Bar, Card, Chip, Kv, Segmented, hhmm, n0, ui } from '../components/today/ui';
import { localDate } from '../services/DailyStore';
import { AlertSettingsScreen } from './AlertSettingsScreen';
import { EvaluationScreen } from './EvaluationScreen';
import { TimelineView } from './today/TimelineView';
import { TrendsView } from './today/TrendsView';
import { GaitDetailView } from './today/GaitDetailView';
import { DataQualityView } from './today/DataQualityView';
import { AlertResponse, RESPONSE_LABELS, recordResponse, snoozeRule } from '../health/notify';
import { RULE_DEFS_BY_ID } from '../config/alertRules';
import { resolvePolicy, resolveRule } from '../store/AlertRulesStore';

// The health-twin daily view (handoff/mockups/daily_report.html): what the sensors saw today, in plain
// sentences and a few numbers per domain. Values are computed on the phone by the health engine.
// Other views of the picked day: Timeline, Gait detail, Trends (7/30 days to that day) and Data quality.

type View_ = 'day' | 'timeline' | 'gait' | 'trends' | 'data';
const VIEWS: [View_, string][] = [['day', 'Day'], ['timeline', 'Timeline'], ['gait', 'Gait'], ['trends', 'Trends'], ['data', 'Data']];

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
      {w.vsUsual && <Text style={styles.small}>{w.vsUsual}</Text>}
    </View>
  );
};

const newestFirst = async (date: string) => (await readAlerts(date)).reverse();

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
  // "your usual" (null until enough days are recorded; older summaries have no usual section)
  const u = s.usual ?? null;
  const p = s.posture;
  const pChip: Chip | undefined = !p || p.uprightPct === null ? undefined
    : u?.uprightPct !== null && u?.uprightPct !== undefined
      ? (p.uprightPct < u.uprightPct - 15 ? { label: 'Less upright than usual', tone: 'warn' } : { label: 'Usual', tone: 'ok' })
      : p.uprightPct >= 60 ? { label: 'Mostly upright', tone: 'ok' } : { label: 'Often slouched or leaning', tone: 'warn' };
  const g = s.gait;
  const gChip: Chip | undefined = !g.walks.length ? undefined
    : g.walks.some((w) => w.uneven.length) ? { label: 'Uneven steps seen', tone: 'warn' } : { label: 'Even steps', tone: 'ok' };
  const hr = s.heart;
  const sleepDelta = hr.sleepMeanHr !== null && u?.sleepMeanHr ? hr.sleepMeanHr - u.sleepMeanHr : null;
  const hrChip: Chip | undefined = !hr.hrMinutes ? undefined
    : hr.restingHighMin >= 10 || (hr.minSpo2 !== null && hr.minSpo2 < 90) ? { label: 'Check alerts', tone: 'alert' }
      : sleepDelta !== null && sleepDelta > resolveRule('HR-5').params.deltaBpm ? { label: 'Above usual asleep', tone: 'warn' }
        : u?.sleepMeanHr || u?.awakeMeanHr ? { label: 'Usual', tone: 'ok' } : { label: 'No alerts', tone: 'ok' };
  const minDays = resolvePolicy().minBaselineDays;
  const usualLine = (label: string, v: number | null | undefined, fmt: (x: number) => string) => (v === null || v === undefined ? null : `${label} ${fmt(v)}`);
  const cov = s.coverage;
  const coverage: [string, number][] = [
    ['Right insole', cov.gaitR], ['Left insole', cov.gaitL], ['Environment', cov.environment], ['Cushion', cov.posture],
    ['Bottle', cov.bottle], ['Band HR', cov.heartRate], ['GPS', cov.gps],
  ];

  return (
    <>
      <View style={ui.card}>
        <Text style={styles.cardTitle}>Sensors recorded</Text>
        <View style={styles.coverage}>
          {coverage.map(([name, min]) => (
            <Text key={name} style={[styles.covItem, !min && styles.covOff]}>{name} {min ? fmtDuration(min) : '—'}</Text>
          ))}
        </View>
      </View>

      {(!u || u.days < minDays) && (
        <View style={ui.card}>
          <Text style={styles.small}>
            Learning your usual: {u?.days ?? 0} of {minDays} days recorded so far. After that, each card compares the day with your own usual range, and the personal alerts (sitting and sleeping heart rate, unusual air for a place) switch on.
          </Text>
        </View>
      )}

      {s.insights.length > 0 && (
        <Card title="Insights">
          {s.insights.map((t) => <Text key={t} style={styles.insight}>{t}</Text>)}
        </Card>
      )}

      <Card title="Environment" chip={envChip}>
        <EnvIntensityChart vars={env.vars} isToday={isToday} tempOffsetC={env.tempOffsetC} />
        {(u?.pm25Indoor || u?.co2Indoor) ? (
          <Text style={styles.small}>Your usual indoors: {[usualLine('PM2.5', u.pm25Indoor, (x) => `${x.toFixed(0)} µg/m³`), usualLine('CO₂', u.co2Indoor, (x) => `${x.toFixed(0)} ppm`)].filter(Boolean).join(' · ')}</Text>
        ) : null}
      </Card>

      <Card title="Movement & gait" chip={gChip}>
        <Kv items={[
          [String(g.stepsBand ?? g.stepsInsole), g.stepsBand !== null && g.stepsBand !== undefined ? 'steps (band)' : 'steps (insoles)'],
          [fmtDuration(g.walkingMin), 'walking (insoles)'], [String(g.walks.length), 'walks'],
        ]} />
        {u?.steps ? <Text style={styles.small}>Your usual: {Math.round(u.steps).toLocaleString()} steps a day{u.cadence ? `, walking at ${u.cadence.toFixed(0)} steps/min` : ''}.</Text> : null}
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
            <Text style={styles.small}>{h.verdict}{h.longestGapMin !== null ? ` Longest gap: ${fmtDuration(h.longestGapMin)}.` : ''}{u?.waterMl ? ` Your usual: ${(u.waterMl / 1000).toFixed(2)} L a day.` : ''}</Text>
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
            {p.uprightPct !== null && u?.uprightPct ? <Text style={styles.small}>Upright {p.uprightPct.toFixed(0)} % of the time; your usual {u.uprightPct.toFixed(0)} %.</Text> : null}
            <Text style={styles.small}>
              {Object.entries(p.byPose).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace('_', ' ').toLowerCase()} ${fmtDuration(v)}`).join(' · ')}
            </Text>
          </>
        )}
      </Card>

      <Card title="Heart" chip={hrChip}>
        {!hr.hrMinutes ? <Text style={styles.small}>No heart-rate data from the band yet.</Text> : (
          <>
            <Kv items={[
              [n0(hr.awakeMeanHr), u?.awakeMeanHr ? `awake avg (usual ${u.awakeMeanHr.toFixed(0)})` : 'awake avg bpm'],
              [n0(hr.sleepMeanHr), u?.sleepMeanHr ? `asleep avg (usual ${u.sleepMeanHr.toFixed(0)})` : 'sleeping avg bpm'],
              [`${n0(hr.maxHr)}`, `max bpm (${hhmm(hr.maxHrAt)})`],
            ]} />
            {sleepDelta !== null && sleepDelta > resolveRule('HR-5').params.deltaBpm && (
              <Text style={[styles.small, styles.warnText]}>
                Sleeping heart rate {hr.sleepMeanHr?.toFixed(0)} bpm, {sleepDelta.toFixed(0)} above your usual. This is often seen with stress, illness, heat or alcohol.
              </Text>
            )}
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

// Days imported from the thesis pipeline (scripts/import_thesis_days.py) carry only day totals: they
// exist to teach the app your usual; the full analysis of those days is in the pipeline's reports.
const ImportedDayView = ({ s }: { s: any }) => (
  <Card title={`${s.date} · imported`} chip={{ label: 'Thesis day', tone: 'info' }}>
    <Text style={styles.small}>
      Imported from the {s.source ?? 'thesis pipeline'} so the app knows your usual from the start. The full
      analysis of this day is in the pipeline's daily report.
    </Text>
    <Kv items={[
      [s.gait?.stepsBand ? String(Math.round(s.gait.stepsBand)) : '—', 'band steps'],
      [s.heart?.awakeMeanHr ? s.heart.awakeMeanHr.toFixed(0) : '—', 'awake avg bpm'],
      [s.heart?.sleepMeanHr ? s.heart.sleepMeanHr.toFixed(0) : '—', 'asleep avg bpm'],
    ]} />
    <Kv items={[
      [s.hydration?.totalMl !== null && s.hydration?.totalMl !== undefined ? `${(s.hydration.totalMl / 1000).toFixed(2)} L` : '—', 'water'],
      [s.posture?.uprightPct !== null && s.posture?.uprightPct !== undefined ? `${s.posture.uprightPct.toFixed(0)} %` : '—', 'upright'],
      [s.gait?.strides ? `${s.gait.strides.R} / ${s.gait.strides.L}` : '—', 'strides R / L'],
    ]} />
  </Card>
);

export const TodayScreen = () => {
  const today = useHealthStore((st) => st.today);
  const viewedDate = useHealthStore((st) => st.viewedDate);
  const viewed = useHealthStore((st) => st.viewed);
  const days = useHealthStore((st) => st.days);
  const [busy, setBusy] = useState(false);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [evalOpen, setEvalOpen] = useState(false);
  const [view, setView] = useState<View_>('day');
  const [files, setFiles] = useState<DayFiles | null>(null);
  const [version, setVersion] = useState(0); // bumped by pull-to-refresh: the other views re-read their files
  const alertsVersion = useHealthStore((st) => st.alertsVersion);
  const todayDate = localDate();
  const showing = viewedDate === null || viewedDate === todayDate ? today : viewed;
  const showingDate = viewedDate ?? todayDate;

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      useHealthStore.getState().setDays(await healthEngine.listDays());
      if (viewedDate === null || viewedDate === todayDate) await healthEngine.compute();
      setAlerts(await newestFirst(viewedDate ?? todayDate));
      setVersion((v) => v + 1);
    } catch (e) {
      console.warn('Today refresh failed:', e);
    } finally {
      setBusy(false);
    }
  }, [viewedDate, todayDate]);

  useEffect(() => { refresh(); }, [refresh]);
  // a new alert or an answer to one: re-read the list
  useEffect(() => { newestFirst(viewedDate ?? todayDate).then(setAlerts).catch(() => {}); }, [alertsVersion, viewedDate, todayDate]);
  // the Timeline, Gait and Data views read the picked day's files
  useEffect(() => {
    if (view === 'day' || view === 'trends') return;
    let alive = true;
    setFiles((f) => (f?.date === showingDate ? f : null));
    readDayFiles(showingDate)
      .then((f) => { if (alive) setFiles(f); })
      .catch((e) => console.warn('Day files read failed:', e));
    return () => { alive = false; };
  }, [view, showingDate, version, alertsVersion]);

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
      <EvaluationScreen visible={evalOpen} onClose={() => setEvalOpen(false)} />
      <View style={styles.topRow}>
        <Text style={styles.topHint}>Pull down to refresh</Text>
        <View style={styles.topLinks}>
          <TouchableOpacity onPress={() => setEvalOpen(true)}><Text style={styles.settingsLink}>Evaluation</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => setSettingsOpen(true)}><Text style={[styles.settingsLink, styles.topLinkGap]}>⚙ Alerts & reminders</Text></TouchableOpacity>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.days}>
        {dayChoices.map((d) => (
          <TouchableOpacity key={d} style={[styles.dayChip, d === showingDate && styles.dayChipOn]} onPress={() => pick(d)}>
            <Text style={[styles.dayText, d === showingDate && styles.dayTextOn]}>{d === todayDate ? 'Today' : d.slice(5)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      <Segmented options={VIEWS} value={view} onChange={setView} />
      {view === 'trends' ? <TrendsView endDate={showingDate} version={version} />
        : view !== 'day' ? (
          !files || files.date !== showingDate ? <View style={styles.empty}><ActivityIndicator /></View>
            : view === 'timeline' ? <TimelineView files={files} isToday={showingDate === todayDate} />
              : view === 'gait' ? <GaitDetailView files={files} />
                : <DataQualityView files={files} isToday={showingDate === todayDate} />
        )
          : showing && (showing as any).imported ? <ImportedDayView s={showing} /> : showing ? <SummaryView s={showing} isToday={showingDate === todayDate} alerts={alerts} onSettings={() => setSettingsOpen(true)} /> : (
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
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#2d3748', marginBottom: 4 },
  insight: { fontSize: 13, color: '#2d3748', marginBottom: 6, lineHeight: 18 },
  small: { fontSize: 12, color: '#4a5568', marginTop: 4, lineHeight: 17 },
  warnText: { color: '#a05a10' },
  okText: { color: '#1e7a3c' },
  walk: { borderTopWidth: 1, borderColor: '#edf2f7', paddingTop: 8, marginTop: 8 },
  walkTitle: { fontSize: 13, fontWeight: '600', color: '#2d3748' },
  big: { fontSize: 22, fontWeight: 'bold', color: '#2563eb' },
  unit: { fontSize: 13, color: '#a0aec0', fontWeight: 'normal' },
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
  topLinks: { flexDirection: 'row' },
  topLinkGap: { marginLeft: 16 },
});
