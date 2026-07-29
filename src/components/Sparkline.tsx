import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useChartStore } from '../store/ChartStore';

interface SparklineProps {
  metricKey: string;
  width?: number;
  height?: number;
  color?: string;
}

const SparklineImpl = ({ metricKey, width = 80, height = 24, color = '#2b6cb0' }: SparklineProps) => {
  const data = useChartStore((state) => state.history[metricKey]);

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
