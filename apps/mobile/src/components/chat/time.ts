/**
 * Absolute timestamps for the chat timeline (lib/format's `relativeTime` covers list rows).
 * Locale-aware where Intl is available, with a plain HH:MM fallback for minimal runtimes.
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "14:32" / "2:32 PM" depending on the device locale. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "14:32" today, "Yesterday 14:32", otherwise "Sep 2, 14:32" (with the year once it differs). */
export function formatMessageTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const clock = formatClock(ts);
  if (sameDay(d, n)) return clock;
  const yesterday = new Date(n);
  yesterday.setDate(n.getDate() - 1);
  if (sameDay(d, yesterday)) return `Yesterday ${clock}`;
  let day: string;
  try {
    day = d.toLocaleDateString(undefined, d.getFullYear() === n.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return `${day}, ${clock}`;
}
