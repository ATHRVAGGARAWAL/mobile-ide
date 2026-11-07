/** Path helpers on forward-slash, root-relative paths (what the daemon's fs API speaks). */

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function extname(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** `abs` relative to `root` (both absolute, any slashes), or null when it lies outside. */
export function relativeTo(root: string, abs: string): string | null {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = abs.replace(/\\/g, '/');
  if (a === r) return '';
  if (!a.startsWith(r + '/')) return null;
  return a.slice(r.length + 1);
}

export function fileKey(root: string, path: string): string {
  return `${root}\0${path}`;
}

export function splitKey(key: string): { root: string; path: string } {
  const i = key.indexOf('\0');
  return { root: key.slice(0, i), path: key.slice(i + 1) };
}

/** `a/b/c/d/e.ts` → `a/…/d/e.ts` when longer than `max` characters. */
export function shortenPath(p: string, max = 48): string {
  if (p.length <= max) return p;
  const parts = p.split('/');
  if (parts.length <= 2) return '…' + p.slice(-(max - 1));
  const head = parts[0] ?? '';
  let tail = parts.slice(-2).join('/');
  let i = parts.length - 3;
  while (i > 0 && head.length + tail.length + parts[i]!.length + 4 <= max) {
    tail = `${parts[i]}/${tail}`;
    i--;
  }
  return `${head}/…/${tail}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
