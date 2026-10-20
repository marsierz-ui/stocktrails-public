import { View } from 'react-native';
import { Canvas, Rect } from '@shopify/react-native-skia';
import { dayKey } from '../../lib/format';

// GitHub-style calendar heatmap: `weeks` columns x 7 rows, ending today.
export function Heatmap({
  counts,
  width,
  weeks = 17,
  base = '#ebedf0',
  accent = '#0969da',
}: {
  counts: Record<string, number>;
  width: number;
  weeks?: number;
  base?: string;
  accent?: string;
}) {
  const gap = 2;
  const cell = Math.max(4, Math.floor((width - gap * (weeks - 1)) / weeks));
  const height = cell * 7 + gap * 6;
  const max = Math.max(1, ...Object.values(counts));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Start at the Sunday of the earliest visible week.
  const start = new Date(today);
  start.setDate(start.getDate() - ((weeks - 1) * 7 + today.getDay()));

  const cells: { x: number; y: number; color: string }[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + dow);
      if (d > today) continue;
      const c = counts[dayKey(d.getTime())] || 0;
      const t = c / max;
      const color = c === 0 ? base : mix(base, accent, 0.25 + 0.75 * t);
      cells.push({ x: w * (cell + gap), y: dow * (cell + gap), color });
    }
  }

  return (
    <View style={{ width, height }}>
      <Canvas style={{ width, height }}>
        {cells.map((c, i) => (
          <Rect key={i} x={c.x} y={c.y} width={cell} height={cell} color={c.color} />
        ))}
      </Canvas>
    </View>
  );
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

function hex(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
