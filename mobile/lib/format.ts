export function money(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '-';
  return '$' + n.toFixed(2);
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || isNaN(n)) return '-';
  return (n * 100).toFixed(digits) + '%';
}

export function shortDate(ts: number): string {
  const d = new Date(ts);
  return d.getMonth() + 1 + '/' + d.getDate();
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

export function dwellLabel(ms: number): string {
  if (!ms) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  return (m / 60).toFixed(1) + 'h';
}

export const SENTIMENT_COLOR: Record<string, string> = {
  positive: '#1a7f37',
  neutral: '#9a6700',
  negative: '#cf222e',
};
