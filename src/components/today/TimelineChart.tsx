import React, { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { BINS, CTX_STYLE, Pin, Timeline } from '../../health/timeline';
import { ENV_BANDS, NO_DATA_COLOR, bandIndex } from '../../health/environment';
import { ui } from './ui';

// The day as stacked 24-hour rows sharing one time axis: activity ribbon, heart rate, PM2.5, steps,
// and event pins.

const HOURS = [0, 6, 12, 18, 24];
export const PIN_COLORS: Record<Pin['kind'], string> = { drink: '#2563eb', alert: '#d63b3b', tap: '#4a5568' };

const Grid = ({ width, height, light }: { width: number; height: number; light?: boolean }) => (
  <>
    {HOURS.slice(1, -1).map((h) => (
      <Line key={h} x1={(h / 24) * width} x2={(h / 24) * width} y1={0} y2={height} stroke={light ? '#e2e8f0' : '#ffffff'} strokeWidth={1} />
    ))}
  </>
);

const NowLine = ({ x, height }: { x: number | null; height: number }) =>
  (x === null ? null : <Line x1={x} x2={x} y1={0} y2={height} stroke="#1a202c" strokeWidth={1.5} />);

const RowHead = ({ title, right }: { title: string; right?: string }) => (
  <View style={[ui.between, styles.rowHead]}>
    <Text style={[ui.legendText, styles.rowTitle]}>{title}</Text>
    {right ? <Text style={ui.legendText}>{right}</Text> : null}
  </View>
);

// Consecutive bins with the same colour become one rectangle.
const colourRuns = (vals: (number | null)[], colour: (v: number | null) => string) => {
  const out: { from: number; to: number; color: string }[] = [];
  vals.forEach((v, i) => {
    const color = colour(v);
    const last = out[out.length - 1];
    if (last && last.color === color) last.to = i + 1; else out.push({ from: i, to: i + 1, color });
  });
  return out;
};

const pmColour = (v: number | null) => (v === null ? NO_DATA_COLOR : ENV_BANDS.pm25.bands[bandIndex('pm25', v)].color);

// Line through the 5-minute bins, broken wherever a bin has no value.
const linePath = (vals: (number | null)[], width: number, height: number, lo: number, hi: number) => {
  const cell = width / BINS;
  let d = '';
  let pen = false;
  vals.forEach((v, i) => {
    if (v === null) { pen = false; return; }
    const x = (i + 0.5) * cell;
    const y = height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4);
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return d.trim();
};

export const TimelineChart = ({ tl, nowMin }: { tl: Timeline; nowMin: number | null }) => {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const perMin = width / 1440;
  const nowX = nowMin === null ? null : nowMin * perMin;
  const cell = width / BINS;

  const hrVals = tl.hr.filter((v): v is number => v !== null);
  const hrLo = hrVals.length ? Math.floor(Math.min(...hrVals) / 10) * 10 : 0;
  const hrHi = hrVals.length ? Math.ceil(Math.max(...hrVals) / 10) * 10 : 1;
  const stepVals = tl.steps.filter((v): v is number => v !== null);
  const stepMax = stepVals.length ? Math.max(...stepVals) : 0;
  const pmVals = tl.pm25.filter((v): v is number => v !== null);

  return (
    <View onLayout={onLayout}>
      {width > 0 && (
        <>
          <RowHead title="What you were doing" />
          <Svg width={width} height={24}>
            {tl.context.map((c) => (
              <Rect key={c.from} x={c.from * perMin} y={0} width={(c.to - c.from) * perMin} height={24} fill={CTX_STYLE[c.kind].color} />
            ))}
            <Grid width={width} height={24} />
            <NowLine x={nowX} height={24} />
          </Svg>

          <RowHead title="Heart rate" right={hrVals.length ? `${hrLo}–${hrHi} bpm` : 'no band data'} />
          <Svg width={width} height={52}>
            <Rect x={0} y={0} width={width} height={52} fill="#f7fafc" />
            <Grid width={width} height={52} light />
            {hrVals.length > 0 && <Path d={linePath(tl.hr, width, 52, hrLo, hrHi)} stroke="#c53030" strokeWidth={1.5} fill="none" />}
            <NowLine x={nowX} height={52} />
          </Svg>

          <RowHead title="PM2.5" right={pmVals.length ? `${Math.round(Math.min(...pmVals))}–${Math.round(Math.max(...pmVals))} µg/m³` : 'not measured'} />
          <Svg width={width} height={14}>
            {colourRuns(tl.pm25, pmColour).map((r) => (
              <Rect key={r.from} x={r.from * cell} y={0} width={(r.to - r.from) * cell} height={14} fill={r.color} />
            ))}
            <Grid width={width} height={14} />
            <NowLine x={nowX} height={14} />
          </Svg>

          <RowHead title={tl.stepsSource === 'insoles' ? 'Steps (insoles)' : 'Steps'} right={stepMax ? `max ${Math.round(stepMax)} per 5 min` : 'none recorded'} />
          <Svg width={width} height={36}>
            <Rect x={0} y={0} width={width} height={36} fill="#f7fafc" />
            <Grid width={width} height={36} light />
            {stepMax > 0 && tl.steps.map((v, i) => (v ? (
              <Rect key={i} x={i * cell} y={36 - (v / stepMax) * 34} width={Math.max(1, cell - 0.4)} height={(v / stepMax) * 34} fill="#38a169" />
            ) : null))}
            <NowLine x={nowX} height={36} />
          </Svg>

          <RowHead title="Events" right={tl.pins.length ? `${tl.pins.length}` : 'none'} />
          <Svg width={width} height={16}>
            <Line x1={0} x2={width} y1={8} y2={8} stroke="#e2e8f0" strokeWidth={1} />
            {tl.pins.map((p, i) => (
              <Circle key={i} cx={((p.t - tl.dayStart) / 60000) * perMin} cy={8} r={p.kind === 'alert' ? 4.5 : 3.5} fill={PIN_COLORS[p.kind]} />
            ))}
            <NowLine x={nowX} height={16} />
          </Svg>

          <View style={[ui.axis, styles.axis, { width }]}>
            {HOURS.map((h) => <Text key={h} style={ui.axisText}>{String(h).padStart(2, '0')}:00</Text>)}
          </View>
        </>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  rowHead: { marginTop: 10, marginBottom: 3 },
  rowTitle: { fontWeight: 'bold', color: '#2d3748' },
  axis: { marginTop: 4 },
});
