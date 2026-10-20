// Exposes the current OS share-intent payload (text / url / image file) to the
// Capture screen. Populated by useShareIntent in App.
import { createContext, useContext } from 'react';
import type { ShareIntent } from 'expo-share-intent';

export interface ShareCtx {
  shareIntent: ShareIntent;
  hasShareIntent: boolean;
  reset: () => void;
}

export const ShareContext = createContext<ShareCtx | null>(null);

export function useShare(): ShareCtx | null {
  return useContext(ShareContext);
}
