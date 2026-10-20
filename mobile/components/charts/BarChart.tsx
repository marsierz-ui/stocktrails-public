import { View, Text } from 'react-native';
import { Canvas, RoundedRect } from '@shopify/react-native-skia';

export interface Bar {
  label: string;
  value: number;
  color?: string;
}

export function BarChart({
  data,
  width,
  height,
  color = '#0969da',
}: {
  data: Bar[];
  width: number;
  height: number;
  color?: string;
}) {
  const labelH = 18;
  const chartH = height - labelH;
  const pad = 6;
  const n = data.length || 1;
  const bw = Math.max(2, (width - pad * (n + 1)) / n);
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <View style={{ width, height }}>
      <Canvas style={{ width, height: chartH }}>
        {data.map((d, i) => {
          const bh = Math.max(0, (d.value / max) * (chartH - 4));
          const xPos = pad + i * (bw + pad);
          return (
            <RoundedRect
              key={i}
              x={xPos}
              y={chartH - bh}
              width={bw}
              height={bh}
              r={3}
              color={d.color || color}
            />
          );
        })}
      </Canvas>
      <View style={{ flexDirection: 'row', width, paddingHorizontal: pad }}>
        {data.map((d, i) => (
          <Text
            key={i}
            style={{ width: bw + pad, textAlign: 'center', fontSize: 10, color: '#888' }}
            numberOfLines={1}
          >
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}
