import { Canvas, Path, Circle } from '@shopify/react-native-skia';

export interface Slice {
  label: string;
  value: number;
  color: string;
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} 1 ${x1.toFixed(
    2
  )} ${y1.toFixed(2)}`;
}

export function Donut({ data, size, thickness = 18 }: { data: Slice[]; size: number; thickness?: number }) {
  const items = data.filter((d) => d.value > 0);
  const total = items.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;

  // A single 100% slice degenerates to a zero-length arc; draw a full ring.
  if (items.length === 1) {
    return (
      <Canvas style={{ width: size, height: size }}>
        <Circle cx={cx} cy={cy} r={r} style="stroke" strokeWidth={thickness} color={items[0].color} />
      </Canvas>
    );
  }

  let a = -Math.PI / 2;
  const segs = items.map((d) => {
    const a0 = a;
    const a1 = a + (d.value / total) * Math.PI * 2;
    a = a1;
    return { path: arcPath(cx, cy, r, a0, Math.max(a1, a0 + 0.0001)), color: d.color };
  });
  return (
    <Canvas style={{ width: size, height: size }}>
      {segs.map((s, i) => (
        <Path key={i} path={s.path} style="stroke" strokeWidth={thickness} color={s.color} />
      ))}
    </Canvas>
  );
}
