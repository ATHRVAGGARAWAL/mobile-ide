/** Path helpers + navigation into the Files / Changes / Terminal surfaces for a session's cwd. */
import { router } from 'expo-router';
import { useProjects } from '../../state/projects';

function stripFileUri(path: string): string {
  if (!path.startsWith('file://')) return path;
  try {
    return decodeURIComponent(new URL(path).pathname);
  } catch {
    return path.slice('file://'.length);
  }
}

/** Make a tool/agent path relative to the session root when it lives inside it; otherwise return it unchanged. */
export function relativeToRoot(cwd: string, path: string): string {
  const p = stripFileUri(path);
  const root = cwd.replace(/\/+$/, '');
  if (root && (p === root || p.startsWith(root + '/'))) return p.slice(root.length + 1) || '.';
  return p;
}

/** Absolute form of a (possibly root-relative) path. */
export function absoluteInRoot(cwd: string, path: string): string {
  const p = stripFileUri(path);
  if (p.startsWith('/')) return p;
  return `${cwd.replace(/\/+$/, '')}/${p}`;
}

export function toFileUri(absPath: string): string {
  return 'file://' + absPath.split('/').map(encodeURIComponent).join('/');
}

/** Href for the file viewer (`app/file.tsx`, M4): `/file?root=&path=&line=`. */
export function fileHref(cwd: string, path: string, line?: number): { pathname: '/file'; params: Record<string, string> } {
  const params: Record<string, string> = { root: cwd, path: relativeToRoot(cwd, path) };
  if (line !== undefined && Number.isFinite(line) && line > 0) params.line = String(Math.floor(line));
  return { pathname: '/file', params };
}

export function openFile(cwd: string, path: string, line?: number): void {
  router.push(fileHref(cwd, path, line));
}

/** Select the session's project for the shared tabs and jump to one of them. */
export function openProjectTab(cwd: string, tab: 'files' | 'changes' | 'terminal'): void {
  if (cwd) useProjects.getState().select(cwd);
  router.push(`/(tabs)/${tab}`);
}
