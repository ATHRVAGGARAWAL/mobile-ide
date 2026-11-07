/** Persisted file-viewer preferences: line wrapping and text size. */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { plainStorage } from '../../state/storage';

export type ViewerFontSize = 'sm' | 'md' | 'lg';
export const VIEWER_FONT_PX: Record<ViewerFontSize, number> = { sm: 11, md: 12.5, lg: 14.5 };

interface ViewerPrefs {
  wrap: boolean;
  /** false until the user toggles wrap once; until then prose wraps and code scrolls */
  wrapTouched: boolean;
  fontSize: ViewerFontSize;
  setWrap: (wrap: boolean) => void;
  setFontSize: (size: ViewerFontSize) => void;
}

export const useViewerPrefs = create<ViewerPrefs>()(
  persist(
    (set) => ({
      wrap: false,
      wrapTouched: false,
      fontSize: 'md',
      setWrap: (wrap) => set({ wrap, wrapTouched: true }),
      setFontSize: (fontSize) => set({ fontSize }),
    }),
    {
      name: 'file-viewer',
      version: 1,
      storage: createJSONStorage(() => plainStorage),
      partialize: (s) => ({ wrap: s.wrap, wrapTouched: s.wrapTouched, fontSize: s.fontSize }),
    },
  ),
);

const PROSE_LANGUAGES = new Set(['markdown', 'mdx', 'text', 'log', 'csv', 'dotenv', 'ini']);

/** Explicit user choice wins; otherwise prose wraps and code scrolls horizontally. */
export function effectiveWrap(wrap: boolean, wrapTouched: boolean, language: string): boolean {
  return wrapTouched ? wrap : PROSE_LANGUAGES.has(language);
}
