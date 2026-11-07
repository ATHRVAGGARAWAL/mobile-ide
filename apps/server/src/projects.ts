/** Project discovery: cwds of existing sessions plus git repos under the configured roots (depth 2). */
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from '@mobile-ide/core';
import type { GitService } from './git.js';
import { createLogger, errorInfo } from './log.js';
import { isInside, realpathLenient, type PathPolicy } from './paths.js';

const log = createLogger({ mod: 'projects' });
const SKIP = new Set(['node_modules', 'Library', 'snap', 'go', '.local', '.cache', '.npm', '.pnpm-store', 'Applications']);
const MAX_ENTRIES_PER_DIR = 2000;
const CACHE_MS = 15_000;

export class ProjectScanner {
  private cache: { at: number; repos: string[] } | null = null;
  private inflight: Promise<string[]> | null = null;

  constructor(
    private readonly policy: PathPolicy,
    private readonly git: GitService,
  ) {}

  private async hasGit(dir: string): Promise<boolean> {
    try {
      await fs.promises.access(path.join(dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  private async children(dir: string): Promise<string[]> {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.debug('scan.readdir_failed', { dir, ...errorInfo(err) });
      return [];
    }
    const out: string[] = [];
    for (const d of dirents.slice(0, MAX_ENTRIES_PER_DIR)) {
      if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue;
      out.push(path.join(dir, d.name));
    }
    return out;
  }

  private allowed(dir: string): boolean {
    return !this.policy.denylist.some((d) => isInside(d, dir));
  }

  /** Git repositories under the roots: the root itself, its children, and grandchildren. */
  async repos(): Promise<string[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.repos;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const found = new Set<string>();
      for (const root of this.policy.roots) {
        if (!this.allowed(root)) continue;
        if (await this.hasGit(root)) {
          found.add(root);
          continue; // a repo root: do not descend into it
        }
        const level1 = await this.children(root);
        await Promise.all(
          level1.map(async (d1) => {
            if (!this.allowed(d1)) return;
            if (await this.hasGit(d1)) {
              found.add(d1);
              return;
            }
            for (const d2 of await this.children(d1)) {
              if (!this.allowed(d2)) continue;
              if (await this.hasGit(d2)) found.add(d2);
            }
          }),
        );
      }
      const repos = [...found].sort();
      this.cache = { at: Date.now(), repos };
      return repos;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async list(sessionCwds: { cwd: string; count: number; lastUsedAt: number }[]): Promise<ProjectInfo[]> {
    const byRoot = new Map<string, ProjectInfo>();
    for (const s of sessionCwds) {
      const real = realpathLenient(s.cwd);
      const existing = byRoot.get(real);
      if (existing) {
        existing.sessionCount += s.count;
        existing.lastUsedAt = Math.max(existing.lastUsedAt ?? 0, s.lastUsedAt);
        continue;
      }
      byRoot.set(real, { root: real, name: path.basename(real) || real, isGit: false, sessionCount: s.count, lastUsedAt: s.lastUsedAt });
    }
    for (const repo of await this.repos()) {
      if (!byRoot.has(repo)) byRoot.set(repo, { root: repo, name: path.basename(repo) || repo, isGit: true, sessionCount: 0 });
    }
    const infos = [...byRoot.values()];
    await Promise.all(
      infos.map(async (p) => {
        try {
          const info = await this.git.repoInfo(p.root);
          p.isGit = info.isGit;
          if (info.branch) p.branch = info.branch;
        } catch (err) {
          log.debug('repo_info.failed', { root: p.root, ...errorInfo(err) });
        }
      }),
    );
    infos.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
    return infos;
  }
}
