import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useChartStore } from '../store/ChartStore';

interface SparklineProps {
  // Live mode: reads a rolling buffer from useChartStore by key.
  metricKey?: string;
  // Static mode: renders this array directly instead (e.g. values parsed from a saved file),
  // bypassing useChartStore entirely. Takes precedence over metricKey when provided.
  data?: number[];
  width?: number;
  height?: number;
  color?: string;
}

const SparklineImpl = ({ metricKey, data: staticData, width = 80, height = 24, color = '#2b6cb0' }: SparklineProps) => {
  // Hook is always called (rules of hooks) even in static mode; the store lookup is just unused then.
  const liveData = useChartStore((state) => (metricKey ? state.history[metricKey] : undefined));
  const data = staticData ?? liveData;

  if (!data || data.length < 2) {
    return <View style={[styles.container, { width, height }]} />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const barWidth = width / data.length;

  return (
    <View style={[styles.container, { width, height }]}>
      {data.map((value, index) => {
        const ratio = (value - min) / range;
        const barHeight = Math.max(2, ratio * height);
        return (
          <View
            key={index}
            style={{
              width: Math.max(1, barWidth - 1),
              height: barHeight,
              backgroundColor: color,
              marginRight: 1,
              alignSelf: 'flex-end',
              opacity: 0.4 + 0.6 * (index / data.length),
            }}
          />
        );
      })}
    </View>
  );
};

export const Sparkline = React.memo(SparklineImpl);

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'flex-end' },
});
