/**
 * How far the on-screen keyboard overlaps the bottom of a container, so the accessory key row
 * can be padded up above it. Native: RN Keyboard frame events + measureInWindow. Web: the
 * visualViewport (never trust 100dvh on iOS Safari).
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, Platform, type KeyboardEvent, type View } from 'react-native';

type Measurable = Pick<View, 'measureInWindow'>;

export function useKeyboardInset(containerRef: RefObject<Measurable | null>): number {
  const [inset, setInset] = useState(0);
  const last = useRef(0);

  useEffect(() => {
    const apply = (keyboardTop: number | null) => {
      const el = containerRef.current;
      if (keyboardTop === null || !el) {
        if (last.current !== 0) {
          last.current = 0;
          setInset(0);
        }
        return;
      }
      el.measureInWindow((_x, y, _w, h) => {
        const overlap = Math.max(0, Math.round(y + h - keyboardTop));
        if (overlap !== last.current) {
          last.current = overlap;
          setInset(overlap);
        }
      });
    };

    if (Platform.OS === 'web') {
      const g = globalThis as unknown as {
        visualViewport?: { height: number; offsetTop: number; addEventListener: (t: string, cb: () => void) => void; removeEventListener: (t: string, cb: () => void) => void };
        innerHeight?: number;
      };
      const vv = g.visualViewport;
      if (!vv) return;
      const onChange = () => {
        const kbTop = vv.offsetTop + vv.height;
        // Only treat a shrunken visual viewport as a keyboard (ignore tiny toolbar jitters).
        const shrink = (g.innerHeight ?? kbTop) - kbTop;
        apply(shrink > 80 ? kbTop : null);
      };
      vv.addEventListener('resize', onChange);
      vv.addEventListener('scroll', onChange);
      onChange();
      return () => {
        vv.removeEventListener('resize', onChange);
        vv.removeEventListener('scroll', onChange);
      };
    }

    const onFrame = (e: KeyboardEvent) => apply(e.endCoordinates.screenY);
    const onHide = () => apply(null);
    const subs =
      Platform.OS === 'ios'
        ? [Keyboard.addListener('keyboardWillChangeFrame', onFrame), Keyboard.addListener('keyboardWillHide', onHide)]
        : [Keyboard.addListener('keyboardDidShow', onFrame), Keyboard.addListener('keyboardDidHide', onHide)];
    return () => {
      for (const s of subs) s.remove();
    };
  }, [containerRef]);

  return inset;
}
