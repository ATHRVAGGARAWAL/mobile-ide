import { useEffect, useRef, useState } from 'react';

/**
 * A copy of `value` that updates at most every `ms` (trailing edge included, so the last value always
 * lands). `ms <= 0` passes the value straight through — set it when streaming ends so the final text is
 * shown synchronously. `key` identifies what the value belongs to: when it changes (a recycled list cell
 * now showing another item) the new value is returned at once instead of the previous item's last sample.
 *
 * Used to stop a fast agent stream from re-marshalling a whole message across the DOM-component bridge
 * on every 16 ms store publish.
 */
export function useThrottledValue<T>(value: T, ms: number, key?: unknown): T {
  const [shown, setShown] = useState({ key, value });
  const latest = useRef({ key, value });
  latest.current = { key, value };
  const lastEmit = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const keyChanged = shown.key !== key;
    if (ms <= 0 || keyChanged) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      lastEmit.current = Date.now();
      setShown((cur) => (cur.key === key && cur.value === value ? cur : { key, value }));
      return;
    }
    const wait = ms - (Date.now() - lastEmit.current);
    if (wait <= 0) {
      lastEmit.current = Date.now();
      setShown((cur) => (cur.value === value ? cur : { key, value }));
      return;
    }
    if (timer.current) return; // a trailing flush is already scheduled; it reads latest.current
    timer.current = setTimeout(() => {
      timer.current = null;
      lastEmit.current = Date.now();
      setShown((cur) => (cur.key === latest.current.key && cur.value === latest.current.value ? cur : latest.current));
    }, wait);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, ms, key]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (ms <= 0 || shown.key !== key) return value;
  return shown.value;
}
