export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

export function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '' : p.slice(0, i);
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** Stable pretty-print of unknown JSON-ish input for the permission sheet / tool cards. */
export function stringifyInput(v: unknown, max = 20_000): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) + `\n… (${v.length - max} more chars)` : v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
  } catch {
    return String(v);
  }
}

/** For an `execute` tool, pull the literal command out of rawInput when present. */
export function commandOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== 'object') return null;
  const r = rawInput as Record<string, unknown>;
  const cmd = r.command ?? r.cmd ?? r.script;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) return cmd.map(String).join(' ');
  return null;
}

/** Remove ANSI escape sequences (CSI and OSC) from captured terminal output. */
export function stripAnsi(s: string): string {
  const csi = new RegExp('\\x1b\\[[0-9;?]*[ -/]*[@-~]', 'g');
  const osc = new RegExp('\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', 'g');
  return s.replace(csi, '').replace(osc, '');
}

export function pluralize(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}
