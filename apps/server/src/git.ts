/** Git helpers on top of the system `git` binary, with a short-lived status cache per root. */
import { spawn } from 'node:child_process';
import type { GitDiff, GitLogEntry, GitStatus } from '@mobile-ide/core';
import { createLogger, errorInfo } from './log.js';

const log = createLogger({ mod: 'git' });

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
}

/** Run git with a byte cap on stdout (the child is killed once the cap is exceeded). */
export function runGit(cwd: string, args: string[], opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<GitRunResult> {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      if (size + chunk.length > maxBytes) {
        out.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, code: null, truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr, code, truncated });
    });
  });
}

export interface StatusEntry {
  path: string;
  index: string;
  worktree: string;
  renamedFrom?: string;
}

interface CachedStatus {
  at: number;
  status: GitStatus;
  byPath: Map<string, string>;
}

const STATUS_TTL_MS = 2000;
const REPO_TTL_MS = 15_000;

export class GitService {
  private readonly statusCache = new Map<string, CachedStatus>();
  private readonly statusInflight = new Map<string, Promise<CachedStatus>>();
  private readonly repoCache = new Map<string, { at: number; isGit: boolean; branch: string | undefined }>();

  constructor(private readonly maxDiffBytes: number) {}

  async repoInfo(root: string): Promise<{ isGit: boolean; branch: string | undefined }> {
    const cached = this.repoCache.get(root);
    if (cached && Date.now() - cached.at < REPO_TTL_MS) return cached;
    let isGit = false;
    let branch: string | undefined;
    const res = await runGit(root, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 5000 });
    if (res.code === 0 && res.stdout.trim() === 'true') {
      isGit = true;
      const b = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
      if (b.code === 0) {
        const name = b.stdout.trim();
        branch = name === 'HEAD' ? undefined : name;
        if (!branch) {
          const sha = await runGit(root, ['rev-parse', '--short', 'HEAD'], { timeoutMs: 5000 });
          if (sha.code === 0 && sha.stdout.trim()) branch = `detached@${sha.stdout.trim()}`;
        }
      }
    }
    const info = { at: Date.now(), isGit, branch };
    this.repoCache.set(root, info);
    return info;
  }

  /** `git status --porcelain=v1 -z --branch`, cached for 2 s per root. */
  async status(root: string): Promise<GitStatus> {
    return (await this.cachedStatus(root)).status;
  }

  /** relative path (and every ancestor dir) → status letters, for tree decoration. */
  async statusByPath(root: string): Promise<Map<string, string>> {
    return (await this.cachedStatus(root)).byPath;
  }

  invalidate(root: string): void {
    this.statusCache.delete(root);
  }

  private cachedStatus(root: string): Promise<CachedStatus> {
    const cached = this.statusCache.get(root);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return Promise.resolve(cached);
    const inflight = this.statusInflight.get(root);
    if (inflight) return inflight;
    const p = this.loadStatus(root)
      .then((s) => {
        this.statusCache.set(root, s);
        return s;
      })
      .finally(() => this.statusInflight.delete(root));
    this.statusInflight.set(root, p);
    return p;
  }

  private async loadStatus(root: string): Promise<CachedStatus> {
    const res = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'], { maxBytes: 4 * 1024 * 1024 });
    const status: GitStatus = { entries: [] };
    const byPath = new Map<string, string>();
    if (res.code !== 0) {
      log.debug('status.failed', { root, stderr: res.stderr.slice(0, 200) });
      return { at: Date.now(), status, byPath };
    }
    const parsed = parsePorcelain(res.stdout);
    if (parsed.branch !== undefined) status.branch = parsed.branch;
    if (parsed.ahead !== undefined) status.ahead = parsed.ahead;
    if (parsed.behind !== undefined) status.behind = parsed.behind;
    status.entries = parsed.entries;
    for (const e of parsed.entries) {
      const letters = (e.index + e.worktree).trim() || 'M';
      byPath.set(e.path, letters);
      // propagate a single "M" (or "?" for fully untracked dirs) up the tree
      const parts = e.path.split('/');
      for (let i = parts.length - 1; i > 0; i--) {
        const dir = parts.slice(0, i).join('/');
        const cur = byPath.get(dir);
        const mark = letters === '??' ? '??' : 'M';
        if (cur === undefined) byPath.set(dir, mark);
        else if (cur === '??' && mark === 'M') byPath.set(dir, 'M');
      }
    }
    return { at: Date.now(), status, byPath };
  }

  async diff(root: string, relPath: string | undefined, staged: boolean): Promise<GitDiff> {
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (staged) args.push('--cached');
    if (relPath) args.push('--', relPath);
    let res = await runGit(root, args, { maxBytes: this.maxDiffBytes });
    let patch = res.stdout;
    if (res.code === 0 && patch === '' && relPath && !staged) {
      // untracked file: synthesize a diff against /dev/null so the Changes view can show it
      const st = await this.statusByPath(root);
      if (st.get(relPath) === '??') {
        res = await runGit(root, ['diff', '--no-ext-diff', '--no-color', '--no-index', '--', '/dev/null', relPath], { maxBytes: this.maxDiffBytes });
        patch = res.stdout;
      }
    } else if (res.code !== 0 && res.code !== 1 && !res.truncated) {
      log.debug('diff.failed', { root, relPath, stderr: res.stderr.slice(0, 200) });
    }
    const out: GitDiff = { staged, patch, truncated: res.truncated };
    if (relPath) out.path = relPath;
    return out;
  }

  async log(root: string, limit: number): Promise<GitLogEntry[]> {
    const res = await runGit(root, ['log', `-n${Math.max(1, Math.min(limit, 500))}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s', '--no-color']);
    if (res.code !== 0) return [];
    const out: GitLogEntry[] = [];
    for (const line of res.stdout.split('\n')) {
      if (!line) continue;
      const [hash, shortHash, author, at, ...rest] = line.split('\x1f');
      if (!hash || !shortHash) continue;
      out.push({ hash, shortHash, author: author ?? '', date: Number(at ?? 0) * 1000, subject: rest.join('\x1f') });
    }
    return out;
  }
}

export function parsePorcelain(raw: string): { branch?: string; ahead?: number; behind?: number; entries: StatusEntry[] } {
  const parts = raw.split('\0');
  const entries: StatusEntry[] = [];
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec === undefined || rec === '') continue;
    if (rec.startsWith('## ')) {
      const head = rec.slice(3);
      const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
      if (m) {
        branch = m[1]?.replace(/^No commits yet on /, '').replace(/^Initial commit on /, '');
        const brackets = m[3];
        if (brackets) {
          const a = /ahead (\d+)/.exec(brackets);
          const b = /behind (\d+)/.exec(brackets);
          if (a) ahead = Number(a[1]);
          if (b) behind = Number(b[1]);
        }
      }
      continue;
    }
    if (rec.length < 3) continue;
    const index = rec[0] ?? ' ';
    const worktree = rec[1] ?? ' ';
    const p = rec.slice(3);
    const entry: StatusEntry = { path: p, index, worktree };
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const from = parts[i + 1];
      if (from !== undefined) {
        entry.renamedFrom = from;
        i++;
      }
    }
    entries.push(entry);
  }
  const out: { branch?: string; ahead?: number; behind?: number; entries: StatusEntry[] } = { entries };
  if (branch !== undefined) out.branch = branch;
  if (ahead !== undefined) out.ahead = ahead;
  if (behind !== undefined) out.behind = behind;
  return out;
}

export function gitLogError(err: unknown): Record<string, unknown> {
  return errorInfo(err);
}
