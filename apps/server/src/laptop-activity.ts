import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LaptopActivity, LaptopHistory, LaptopSession, LiveLaptopWork } from '@mobile-ide/core';
import { isInside, resolveRoot, type PathPolicy } from './paths.js';
import { NotFoundError } from './errors.js';

const exec = promisify(execFile);
const UUID = /^[a-f0-9-]{36}$/i;
const MAX_BYTES = 2 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function clean(value: string, max = 180): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, max);
}

/** Read a bounded tail, discarding a partial first record and malformed/in-flight records. */
export function readJsonTail(file: string): RecordValue[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_BYTES);
    const buf = Buffer.alloc(Math.min(size, MAX_BYTES));
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.subarray(0, read).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.flatMap((line) => {
      try {
        return [record(JSON.parse(line))];
      } catch {
        return [];
      }
    });
  } finally {
    fs.closeSync(fd);
  }
}

interface IndexedSession {
  session: LaptopSession;
  file?: string;
}
interface Options {
  policy: PathPolicy;
  prefix: string;
  codexHome?: string;
  claudeHome?: string;
  procRoot?: string;
  panes?: () => Promise<string>;
}

export class LaptopActivityReader {
  private readonly codexHome: string;
  private readonly claudeHome: string;
  constructor(private readonly opts: Options) {
    this.codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    this.claudeHome = opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  }

  private allowed(cwd: string): boolean {
    if (!path.isAbsolute(cwd)) return false;
    try {
      resolveRoot(this.opts.policy, cwd);
      return true;
    } catch {
      return false;
    }
  }

  private codex(): IndexedSession[] {
    if (!fs.existsSync(this.codexHome)) return [];
    const file = fs
      .readdirSync(this.codexHome)
      .filter((s) => /^state_\d+\.sqlite$/.test(s))
      .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
    if (!file) return [];
    const db = new DatabaseSync(path.join(this.codexHome, file), { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT id, title, cwd, updated_at, rollout_path FROM threads
        WHERE archived = 0 AND source IN ('cli', 'vscode') ORDER BY updated_at DESC LIMIT 200`,
        )
        .all()
        .flatMap((r): IndexedSession[] => {
          const cwd = str(r.cwd),
            id = str(r.id);
          if (!UUID.test(id) || !this.allowed(cwd)) return [];
          return [
            {
              session: { id, source: 'codex', title: clean(str(r.title)) || 'Codex session', cwd, updatedAt: Number(r.updated_at) * 1000 },
              file: str(r.rollout_path),
            },
          ];
        });
    } finally {
      db.close();
    }
  }

  private claude(): IndexedSession[] {
    const file = path.join(this.claudeHome, 'history.jsonl');
    if (!fs.existsSync(file)) return [];
    const sessions = new Map<string, IndexedSession>();
    for (const r of readJsonTail(file)) {
      const id = str(r.sessionId),
        cwd = str(r.project),
        updatedAt = Number(r.timestamp);
      if (!UUID.test(id) || !this.allowed(cwd) || !Number.isFinite(updatedAt)) continue;
      const previous = sessions.get(id);
      if (previous && previous.session.updatedAt > updatedAt) continue;
      const transcript = path.join(this.claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      sessions.set(id, {
        session: { id, source: 'claude', title: clean(str(r.display)) || 'Claude session', cwd, updatedAt },
        file: transcript,
      });
    }
    return [...sessions.values()];
  }

  private index(): { entries: IndexedSession[]; warnings: string[] } {
    const entries: IndexedSession[] = [],
      warnings: string[] = [];
    for (const source of ['codex', 'claude'] as const) {
      try {
        entries.push(...this[source]());
      } catch {
        warnings.push(`${source === 'codex' ? 'Codex' : 'Claude'} history is temporarily unavailable.`);
      }
    }
    entries.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    return { entries, warnings };
  }

  async snapshot(): Promise<LaptopActivity> {
    const { entries, warnings } = this.index();
    const live: LiveLaptopWork[] = [];
    const panePids = new Set<number>();
    try {
      const output = this.opts.panes
        ? await this.opts.panes()
        : (
            await exec(
              'tmux',
              [
                'list-panes',
                '-a',
                '-F',
                '#{session_name}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}\t#{window_activity}\t#{pane_active}\t#{window_active}',
              ],
              { timeout: 2500, maxBuffer: MAX_BYTES },
            )
          ).stdout;
      for (const line of output.split('\n')) {
        const [name = '', pid, cwd = '', command = '', title = '', activity, paneActive, windowActive] = line.split('\t');
        // Only a session's selected pane is attachable through the existing phone terminal.
        if (!name.startsWith(`${this.opts.prefix}-`)) continue;
        panePids.add(Number(pid));
        if (paneActive !== '1' || windowActive !== '1' || !this.allowed(cwd)) continue;
        const terminalId = name.slice(this.opts.prefix.length + 1);
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalId)) continue;
        live.push({
          id: `terminal:${terminalId}`,
          terminalId,
          cwd,
          command: clean(command),
          title: clean(title) || path.basename(cwd),
          updatedAt: Number(activity) * 1000 || 0,
        });
      }
    } catch (error) {
      // tmux exits 1 when there is no server; that is an ordinary empty state.
      const message = error instanceof Error ? error.message : '';
      if (!/no server running|no sessions|error connecting/.test(message)) warnings.push('Live terminals could not be refreshed.');
    }
    // Native CLI sessions outside tmux can be detected, but their terminal cannot be attached retroactively.
    const procRoot = this.opts.procRoot ?? '/proc';
    try {
      const processes = new Map<number, { parent: number; args: string[]; cwd: string }>();
      for (const pid of fs
        .readdirSync(procRoot)
        .filter((p) => /^\d+$/.test(p))
        .slice(0, 8192)) {
        try {
          const dir = path.join(procRoot, pid);
          const status = fs.readFileSync(path.join(dir, 'status'), 'utf8');
          const parent = Number(status.match(/^PPid:\s*(\d+)/m)?.[1]);
          const args = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').split('\0').filter(Boolean);
          processes.set(Number(pid), { parent, args, cwd: fs.readlinkSync(path.join(dir, 'cwd')) });
        } catch {
          /* exited or belongs to another user */
        }
      }
      const agent = (args: string[]) =>
        /^(codex|claude)(\.js)?$/.test(path.basename(args[0] ?? '')) ||
        (/^node(js)?$/.test(path.basename(args[0] ?? '')) && /^(codex|claude)(\.js)?$/.test(path.basename(args[1] ?? '')));
      for (const [pid, p] of processes) {
        if (!agent(p.args) || p.args.some((a) => /^(app-server|exec|--print|-p|acp)$/.test(a)) || !this.allowed(p.cwd)) continue;
        let parent = p.parent,
          shared = panePids.has(pid),
          duplicate = false;
        const visited = new Set<number>();
        while (parent && !visited.has(parent)) {
          visited.add(parent);
          if (panePids.has(parent)) shared = true;
          const ancestor = processes.get(parent);
          if (!ancestor) break;
          if (agent(ancestor.args)) duplicate = true;
          parent = ancestor.parent;
        }
        if (shared || duplicate) continue;
        const command = p.args.slice(0, 2).some((a) => /claude/.test(path.basename(a))) ? 'Claude' : 'Codex';
        live.push({ id: `process:${pid}`, title: `${command} open on laptop`, command, cwd: p.cwd, updatedAt: 0 });
      }
    } catch {
      warnings.push('Native laptop processes could not be checked on this system.');
    }
    const priority = (work: LiveLaptopWork) => (work.terminalId && /codex|claude|opencode/i.test(work.command) ? 1 : 0);
    live.sort((a, b) => priority(b) - priority(a) || b.updatedAt - a.updatedAt);
    // Keep a useful history for both providers even when one has many newer sessions.
    const recent = ['codex', 'claude']
      .flatMap((source) => entries.filter((e) => e.session.source === source).slice(0, 12))
      .map((e) => e.session)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { live, recent, warnings };
  }

  history(source: string, id: string): LaptopHistory {
    const entry = this.index().entries.find((e) => e.session.source === source && e.session.id === id);
    if (!entry) throw new NotFoundError('Laptop session is no longer available');
    const messages: LaptopHistory['messages'] = [];
    let note = 'Recent saved messages only. This view does not control the laptop session.';
    try {
      const home = source === 'codex' ? this.codexHome : this.claudeHome;
      const file = fs.realpathSync(entry.file || '');
      const base = fs.realpathSync(path.join(home, source === 'codex' ? 'sessions' : 'projects'));
      if (!isInside(base, file)) throw new Error('Invalid transcript path');
      for (const r of readJsonTail(file)) {
        const payload = source === 'codex' ? record(r.payload) : record(r.message);
        if (source === 'codex' && (r.type !== 'response_item' || payload.type !== 'message')) continue;
        if (source === 'claude' && (r.isSidechain === true || !['user', 'assistant'].includes(str(r.type)))) continue;
        const role = payload.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = payload.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .map((c) => {
                    const block = record(c);
                    return ['text', 'input_text', 'output_text'].includes(str(block.type)) ? str(block.text) : '';
                  })
                  .filter(Boolean)
                  .join('\n')
              : '';
        if (text.trim()) messages.push({ role, text: text.slice(0, 12000) });
      }
    } catch {
      note = 'Full transcript unavailable. Showing saved prompt history where available.';
    }
    if (!messages.length && source === 'claude') {
      try {
        for (const r of readJsonTail(path.join(this.claudeHome, 'history.jsonl'))) {
          if (r.sessionId === id && r.project === entry.session.cwd && str(r.display))
            messages.push({ role: 'user', text: str(r.display).slice(0, 12000) });
        }
      } catch {
        /* the index may have changed since listing */
      }
    }
    return { session: entry.session, messages: messages.slice(-20), note };
  }
}
