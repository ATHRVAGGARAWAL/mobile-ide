import type { DOMProps } from 'expo/dom';

/** Shared WebView settings for DOM components embedded in timeline cells: size to content, let the list scroll. */
export const INLINE_DOM: DOMProps = {
  matchContents: true,
  scrollEnabled: false,
  style: { backgroundColor: 'transparent' },
};
