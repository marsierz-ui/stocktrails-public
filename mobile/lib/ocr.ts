// On-device OCR via ML Kit. Replaces the PWA's Tesseract.js path. Requires a
// native dev build (the module throws a linking error in Expo Go). Port of the
// candidate-extraction heuristic in pwa/share.js.
import TextRecognition from '@react-native-ml-kit/text-recognition';

const ISIN = /\b[A-Z]{2}[A-Z0-9]{9}[0-9]\b/;
const NUMERIC_ONLY = /^[\d.,%+\-$\s]+$/;

export async function recognizeLines(uri: string): Promise<string[]> {
  const res = await TextRecognition.recognize(uri);
  const lines: string[] = [];
  res.blocks.forEach((b) => b.lines.forEach((l) => {
    if (l.text) lines.push(l.text);
  }));
  return lines;
}

// Keep ISINs and name-like strings (3-40 chars, not pure numbers/prices).
export function extractCandidates(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  lines.forEach((raw) => {
    const line = (raw || '').trim();
    const isin = line.match(ISIN);
    if (isin) {
      if (!seen.has(isin[0])) {
        seen.add(isin[0]);
        out.push(isin[0]);
      }
      return;
    }
    // Only word-like lines go to Yahoo search; lines with long digit runs (account numbers) stay here.
    if (!line || NUMERIC_ONLY.test(line) || !/[A-Za-z]{3,}/.test(line) || /\d{4,}/.test(line)) return;
    const t = line.replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 40) return;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  });
  return out;
}
