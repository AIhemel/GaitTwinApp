import React, { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import { ENV_BANDS, ENV_VARS, EnvVar, NO_DATA_COLOR, bandIndex } from '../../health/environment';
import { EnvVarSummary, fmtDuration } from '../../health/daySummary';

// 24-hour environment intensity strips: one row per variable, 5-minute cells coloured by category
// (PM2.5 by the EPA AQI bands), grey where nothing was measured. Under each strip: the day's average,
// low and high, and the time spent in each band.

const ROW_H = 22;
const HOURS = [0, 6, 12, 18, 24];

// Consecutive bins with the same band become one rectangle (fewer SVG nodes than 288 per row).
const runs = (v: EnvVar, bins: (number | null)[]) => {
  const out: { from: number; to: number; color: string }[] = [];
  bins.forEach((x, i) => {
    const color = x === null ? NO_DATA_COLOR : ENV_BANDS[v].bands[bandIndex(v, x)].color;
    const last = out[out.length - 1];
    if (last && last.color === color && last.to === i) last.to = i + 1;
    else out.push({ from: i, to: i + 1, color });
  });
  return out;
};

const hhmm = (ms: number | null) => (ms === null ? '' : new Date(ms).toTimeString().slice(0, 5));
const fmtVal = (v: EnvVar, x: number | null) => (x === null ? '—' : v === 'temp' || v === 'dba' ? x.toFixed(1) : x.toFixed(0));

const Strip = ({ v, s, width, nowBin }: { v: EnvVar; s: EnvVarSummary; width: number; nowBin: number | null }) => {
  const cell = width / 288;
  return (
    <Svg width={width} height={ROW_H}>
      {runs(v, s.bins).map((r) => (
        <Rect key={r.from} x={r.from * cell} y={0} width={(r.to - r.from) * cell} height={ROW_H} fill={r.color} />
      ))}
      {HOURS.slice(1, -1).map((h) => (
        <Line key={h} x1={h * 12 * cell} x2={h * 12 * cell} y1={0} y2={ROW_H} stroke="#ffffff" strokeWidth={1} />
      ))}
      {nowBin !== null && <Line x1={nowBin * cell} x2={nowBin * cell} y1={0} y2={ROW_H} stroke="#1a202c" strokeWidth={1.5} />}
    </Svg>
  );
};

export const EnvIntensityChart = ({ vars, isToday, tempOffsetC }: { vars: Record<EnvVar, EnvVarSummary>; isToday: boolean; tempOffsetC: number }) => {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const now = new Date();
  const nowBin = isToday ? Math.floor((now.getHours() * 60 + now.getMinutes()) / 5) : null;

  return (
    <View onLayout={onLayout}>
      {width > 0 && ENV_VARS.map((v) => {
        const s = vars[v];
        const meta = ENV_BANDS[v];
        return (
          <View key={v} style={styles.row}>
            <View style={styles.rowHead}>
              <Text style={styles.varName}>{meta.name}</Text>
              <Text style={styles.stats}>
                {s.minutes
                  ? `avg ${fmtVal(v, s.mean)} · low ${fmtVal(v, s.min)} · high ${fmtVal(v, s.max)} ${meta.unit} at ${hhmm(s.maxAt)}`
                  : 'not measured'}
              </Text>
            </View>
            <Strip v={v} s={s} width={width} nowBin={nowBin} />
            {s.minutes > 0 && (
              <View style={styles.bands}>
                {meta.bands.map((b, i) => (s.bandMinutes[i] ? (
                  <View key={b.label} style={styles.bandItem}>
                    <View style={[styles.swatch, { backgroundColor: b.color }]} />
                    <Text style={styles.bandText}>{b.label} {fmtDuration(s.bandMinutes[i])}</Text>
                  </View>
                ) : null))}
              </View>
            )}
          </View>
        );
      })}
      {width > 0 && (
        <View style={[styles.axis, { width }]}>
          {HOURS.map((h) => <Text key={h} style={styles.axisText}>{String(h).padStart(2, '0')}:00</Text>)}
        </View>
      )}
      <Text style={styles.note}>
        5-minute averages; grey = no data. PM2.5 colours are the US EPA air-quality bands. Temperature includes a
        {` ${tempOffsetC >= 0 ? '+' : ''}${tempOffsetC} °C`} correction for the node's self-heating, and the first 30 min after
        the node connects are left out (warm-up).
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { marginBottom: 12 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 },
  varName: { fontSize: 13, fontWeight: 'bold', color: '#2d3748' },
  stats: { fontSize: 11, color: '#4a5568', flexShrink: 1, textAlign: 'right', marginLeft: 8 },
  bands: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  bandItem: { flexDirection: 'row', alignItems: 'center', marginRight: 10, marginBottom: 2 },
  swatch: { width: 9, height: 9, borderRadius: 2, marginRight: 4 },
  bandText: { fontSize: 10.5, color: '#4a5568' },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { fontSize: 10, color: '#a0aec0' },
  note: { fontSize: 10.5, color: '#a0aec0', marginTop: 8 },
});
