/** Icon + git-status decoration helpers for file lists. Pure functions, no React. */
import type React from 'react';
import type { Ionicons } from '@expo/vector-icons';
import type { FsEntry } from '@mobile-ide/core';
import { extname } from '../../lib/format';
import type { Theme } from '../../theme';

export type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'fish', 'lua', 'dart', 'scala', 'ex', 'exs', 'erl', 'hs', 'ml', 'clj', 'zig', 'nix', 'sql', 'graphql', 'gql',
  'vue', 'svelte', 'astro', 'prisma', 'r', 'jl', 'm', 'mm', 'css', 'scss', 'sass', 'less', 'html', 'htm',
]);
const CONFIG = new Set(['json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'plist', 'properties', 'gradle', 'tf', 'hcl']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'heic', 'avif']);
const DOC = new Set(['md', 'mdx', 'txt', 'rst', 'adoc', 'log', 'csv', 'tsv', 'pdf']);
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'cargo.lock', 'poetry.lock', 'gemfile.lock', 'bun.lockb', 'composer.lock']);

export interface EntryIcon {
  name: IoniconName;
  tone: 'accent' | 'muted' | 'text';
}

export function entryIcon(entry: Pick<FsEntry, 'name' | 'kind'>): EntryIcon {
  if (entry.kind === 'dir') return { name: 'folder', tone: 'accent' };
  if (entry.kind === 'symlink') return { name: 'link-outline', tone: 'muted' };
  if (entry.kind === 'other') return { name: 'document-outline', tone: 'muted' };
  const lower = entry.name.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.') || lower === 'makefile' || lower === 'justfile') return { name: 'terminal-outline', tone: 'text' };
  if (LOCKFILES.has(lower) || lower.endsWith('.lock')) return { name: 'lock-closed-outline', tone: 'muted' };
  const ext = extname(lower);
  if (CODE.has(ext)) return { name: 'code-slash-outline', tone: 'text' };
  if (CONFIG.has(ext)) return { name: 'options-outline', tone: 'text' };
  if (IMAGE.has(ext)) return { name: 'image-outline', tone: 'text' };
  if (DOC.has(ext)) return { name: 'document-text-outline', tone: 'text' };
  if (lower.startsWith('.')) return { name: 'options-outline', tone: 'muted' };
  return { name: 'document-outline', tone: 'text' };
}

/** Directories the daemon's search skips; dimmed in the tree so the eye lands on source. */
export function isVendoredName(name: string): boolean {
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === 'dist' ||
    name === 'build' ||
    name === '.expo' ||
    name === '.next' ||
    name === 'target' ||
    name === '__pycache__' ||
    name === '.venv' ||
    name === 'venv'
  );
}

export interface GitStatusMeta {
  letter: string;
  label: string;
  color: string;
}

/**
 * Map porcelain status letters (index + worktree, trimmed by the daemon; directories carry a
 * propagated "M" or "?") onto one letter + colour, following the VS Code convention.
 */
export function gitStatusMeta(letters: string | undefined, theme: Theme): GitStatusMeta | null {
  const s = (letters ?? '').trim();
  if (!s) return null;
  const c = theme.colors;
  if (s.includes('U') || s === 'AA' || s === 'DD') return { letter: '!', label: 'Conflict', color: c.danger };
  if (s.startsWith('?')) return { letter: 'U', label: 'Untracked', color: c.success };
  if (s.startsWith('!')) return { letter: 'I', label: 'Ignored', color: c.textFaint };
  if (s.includes('D')) return { letter: 'D', label: 'Deleted', color: c.danger };
  if (s.includes('R')) return { letter: 'R', label: 'Renamed', color: c.info };
  if (s.includes('C')) return { letter: 'C', label: 'Copied', color: c.info };
  if (s.includes('A')) return { letter: 'A', label: 'Added', color: c.success };
  if (s.includes('M') || s.includes('T')) return { letter: 'M', label: 'Modified', color: c.warning };
  return { letter: s.charAt(0), label: 'Changed', color: c.warning };
}
