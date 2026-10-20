import { View } from 'react-native';
import { Canvas, Path, Circle } from '@shopify/react-native-skia';

export interface LineMarker {
  i: number;
  color: string;
}

export function LineChart({
  values,
  width,
  height,
  color = '#0969da',
  markers,
}: {
  values: number[];
  width: number;
  height: number;
  color?: string;
  markers?: LineMarker[];
}) {
  if (!values.length) return <View style={{ width, height }} />;
  const pad = 8;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - 2 * pad));
  const y = (val: number) => height - pad - ((val - min) / span) * (height - 2 * pad);
  let d = '';
  values.forEach((val, i) => {
    d += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(val).toFixed(1) + ' ';
  });
  return (
    <View style={{ width, height }}>
      <Canvas style={{ width, height }}>
        <Path path={d} style="stroke" color={color} strokeWidth={2} />
        {(markers || []).map((m, idx) => (
          <Circle key={idx} cx={x(m.i)} cy={y(values[m.i])} r={4} color={m.color} />
        ))}
      </Canvas>
    </View>
  );
}
