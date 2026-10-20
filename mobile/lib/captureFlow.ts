// Resolve a symbol to capture from free text/url (search) or a screenshot (OCR).
// Feeds the same captureSymbol() path used by manual entry.
import * as ImageManipulator from 'expo-image-manipulator';
import { searchSymbols, SymbolHit } from './prices';
import { recognizeLines, extractCandidates } from './ocr';

// Downscale before OCR to keep memory bounded (esp. the iOS share extension).
export async function downscale(uri: string): Promise<string> {
  const r = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 1080 } }], {
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return r.uri;
}

export async function symbolsFromText(text: string): Promise<SymbolHit[]> {
  return searchSymbols(text);
}

export async function symbolsFromImage(uri: string): Promise<{ candidates: string[]; hits: SymbolHit[] }> {
  const small = await downscale(uri);
  const lines = await recognizeLines(small);
  const candidates = extractCandidates(lines);
  const hits: SymbolHit[] = [];
  const seen = new Set<string>();
  for (const c of candidates.slice(0, 6)) {
    try {
      const res = await searchSymbols(c);
      res.forEach((h) => {
        if (!seen.has(h.symbol)) {
          seen.add(h.symbol);
          hits.push(h);
        }
      });
    } catch (e) {
      /* skip a failed candidate */
    }
    if (hits.length >= 12) break;
  }
  return { candidates, hits };
}
