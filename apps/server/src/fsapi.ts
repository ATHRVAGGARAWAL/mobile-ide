/** File APIs: one-level tree, capped file read with binary sniff, search, and the Studio editor's checked write. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FileContent, FsEntry, SearchMatch, WriteFileRequest, WriteFileResponse } from '@mobile-ide/core';
import { ConflictError, BadRequestError } from './errors.js';
import type { GitService } from './git.js';
import { createLogger, errorInfo } from './log.js';
import { displayPath } from './paths.js';

const log = createLogger({ mod: 'fs' });

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  md: 'markdown',
  mdx: 'mdx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  m: 'objective-c',
  mm: 'objective-c',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  fish: 'fish',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'dotenv',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
  lua: 'lua',
  vim: 'viml',
  el: 'lisp',
  clj: 'clojure',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  ml: 'ocaml',
  scala: 'scala',
  dart: 'dart',
  r: 'r',
  jl: 'julia',
  zig: 'zig',
  nix: 'nix',
  tf: 'hcl',
  hcl: 'hcl',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  prisma: 'prisma',
  csv: 'csv',
  txt: 'text',
  log: 'log',
  lock: 'text',
  svg: 'xml',
  plist: 'xml',
  gradle: 'groovy',
  groovy: 'groovy',
  bat: 'bat',
  cmd: 'bat',
  diff: 'diff',
  patch: 'diff',
};

export function languageFor(filename: string): string {
  const base = path.basename(filename).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  if (base === 'makefile' || base === 'gnumakefile') return 'makefile';
  if (base.startsWith('.env')) return 'dotenv';
  if (base === '.gitignore' || base === '.dockerignore' || base === '.npmrc' || base === '.editorconfig') return 'ini';
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return LANGUAGES[ext] ?? 'text';
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i] ?? 0;
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32 && b !== 27)) suspicious++;
  }
  return suspicious / n > 0.3;
}

export async function listTree(root: string, dirAbs: string, git: GitService | null): Promise<FsEntry[]> {
  const st = await fs.promises.stat(dirAbs);
  if (!st.isDirectory()) throw new Error('not a directory');
  const dirents = await fs.promises.readdir(dirAbs, { withFileTypes: true });
  const statusMap = git ? await git.statusByPath(root).catch(() => new Map<string, string>()) : new Map<string, string>();
  const entries: FsEntry[] = [];
  for (const d of dirents) {
    const abs = path.join(dirAbs, d.name);
    const rel = displayPath(root, abs);
    let kind: FsEntry['kind'] = 'other';
    let size: number | undefined;
    let mtime: number | undefined;
    try {
      if (d.isSymbolicLink()) {
        kind = 'symlink';
        const target = await fs.promises.stat(abs).catch(() => null);
        if (target?.isDirectory()) kind = 'dir';
        else if (target?.isFile()) {
          kind = 'symlink';
          size = target.size;
          mtime = target.mtimeMs;
        }
      } else if (d.isDirectory()) kind = 'dir';
      else if (d.isFile()) {
        kind = 'file';
        const s = await fs.promises.stat(abs);
        size = s.size;
        mtime = s.mtimeMs;
      }
    } catch (err) {
      log.debug('tree.stat_failed', { abs, ...errorInfo(err) });
    }
    const entry: FsEntry = { name: d.name, path: rel, kind };
    if (size !== undefined) entry.size = size;
    if (mtime !== undefined) entry.mtime = Math.round(mtime);
    const gs = statusMap.get(rel);
    if (gs) entry.gitStatus = gs;
    entries.push(entry);
  }
  entries.sort((a, b) => {
    const ad = a.kind === 'dir' ? 0 : 1;
    const bd = b.kind === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
  return entries;
}

export async function readFileCapped(root: string, fileAbs: string, maxBytes: number): Promise<FileContent> {
  const st = await fs.promises.stat(fileAbs);
  if (!st.isFile()) throw new Error('not a file');
  const rel = displayPath(root, fileAbs);
  const fh = await fs.promises.open(fileAbs, 'r');
  try {
    const toRead = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    const data = buf.subarray(0, bytesRead);
    const binary = looksBinary(data);
    return {
      path: rel,
      content: binary ? '' : data.toString('utf8'),
      language: languageFor(fileAbs),
      size: st.size,
      truncated: !binary && st.size > maxBytes,
      binary,
      mtime: Math.round(st.mtimeMs),
    };
  } finally {
    await fh.close();
  }
}

/**
 * Write a text file for the Studio editor. Refuses to clobber: with `expectedMtime` the file on disk must still carry
 * that mtime (409 otherwise — the agent or another editor got there first; the client reloads and re-applies). Writes
 * go through a temp file + rename in the same directory so a watcher (and the agent) never sees a half-written file.
 */
export async function writeFileChecked(
  root: string,
  fileAbs: string,
  body: WriteFileRequest,
  maxBytes: number,
): Promise<WriteFileResponse> {
  if (Buffer.byteLength(body.content, 'utf8') > maxBytes) throw new BadRequestError(`file exceeds the ${maxBytes}-byte limit`);
  const existing = await fs.promises.stat(fileAbs).catch(() => null);
  if (existing && !existing.isFile()) throw new BadRequestError('not a file');
  if (existing && body.expectedMtime !== undefined && Math.round(existing.mtimeMs) !== body.expectedMtime) {
    throw new ConflictError('file changed on disk since it was read');
  }
  if (!existing) {
    if (body.expectedMtime !== undefined) throw new ConflictError('file no longer exists');
    if (body.createDirs) await fs.promises.mkdir(path.dirname(fileAbs), { recursive: true });
  }
  const tmp = path.join(path.dirname(fileAbs), `.${path.basename(fileAbs)}.mide-${process.pid}-${Date.now().toString(36)}~`);
  try {
    await fs.promises.writeFile(tmp, body.content, { encoding: 'utf8', mode: existing?.mode ?? 0o644 });
    await fs.promises.rename(tmp, fileAbs);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  const st = await fs.promises.stat(fileAbs);
  return { path: displayPath(root, fileAbs), size: st.size, mtime: Math.round(st.mtimeMs), created: !existing };
}

// ---------------------------------------------------------------------------- search
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.expo',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

let rgPath: string | null | undefined;
export function ripgrepPath(): string | null {
  if (rgPath === undefined) rgPath = which('rg');
  return rgPath;
}

function runCollect(
  cmd: string,
  args: string[],
  cwd: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      if (size >= maxBytes) return;
      chunks.push(c);
      size += c.length;
      if (size >= maxBytes) child.kill('SIGKILL');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout: '', code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code });
    });
  });
}

function clip(text: string): string {
  const t = text.replace(/\r?\n$/, '');
  return t.length > 400 ? t.slice(0, 397) + '...' : t;
}

export async function searchFiles(
  root: string,
  dirAbs: string,
  query: string,
  limit: number,
  git: GitService | null,
): Promise<SearchMatch[]> {
  const q = query.trim();
  if (!q) return [];
  const rg = ripgrepPath();
  if (rg) {
    const res = await runCollect(
      rg,
      ['--json', '--max-count', '50', '-n', '--column', '-S', '--no-messages', '-e', q, '--', dirAbs],
      root,
      16 * 1024 * 1024,
      20_000,
    );
    const out: SearchMatch[] = [];
    for (const line of res.stdout.split('\n')) {
      if (!line) continue;
      let msg: {
        type?: string;
        data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start?: number }[] };
      };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (msg.type !== 'match' || !msg.data) continue;
      const p = msg.data.path?.text;
      if (!p) continue;
      const text = msg.data.lines?.text ?? '';
      const start = msg.data.submatches?.[0]?.start ?? 0;
      const prefix = Buffer.from(text, 'utf8').subarray(0, start).toString('utf8');
      out.push({
        path: displayPath(root, path.resolve(root, p)),
        line: msg.data.line_number ?? 0,
        column: prefix.length + 1,
        text: clip(text),
      });
      if (out.length >= limit) break;
    }
    if (res.code === 0 || res.code === 1) return out;
    log.debug('search.rg_failed', { code: res.code });
  }
  if (git) {
    const info = await git.repoInfo(root).catch(() => ({ isGit: false }));
    if (info.isGit) {
      const relDir = path.relative(root, dirAbs) || '.';
      const res = await runCollect(
        'git',
        ['grep', '-n', '--column', '-I', '-i', '--max-count=50', '--untracked', '-e', q, '--', relDir],
        root,
        16 * 1024 * 1024,
        20_000,
      );
      if (res.code === 0 || res.code === 1) {
        const out: SearchMatch[] = [];
        for (const line of res.stdout.split('\n')) {
          const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(line);
          if (!m || !m[1]) continue;
          out.push({ path: m[1], line: Number(m[2]), column: Number(m[3]), text: clip(m[4] ?? '') });
          if (out.length >= limit) break;
        }
        return out;
      }
    }
  }
  return walkSearch(root, dirAbs, q, limit);
}

/** Pure-Node fallback: case-insensitive substring search over text files (skips vendored dirs). */
async function walkSearch(root: string, dirAbs: string, q: string, limit: number): Promise<SearchMatch[]> {
  const out: SearchMatch[] = [];
  const needle = q.toLowerCase();
  const deadline = Date.now() + 15_000;
  const stack = [dirAbs];
  let filesScanned = 0;
  while (stack.length && out.length < limit && Date.now() < deadline && filesScanned < 20_000) {
    const dir = stack.pop();
    if (!dir) break;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (out.length >= limit) break;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) stack.push(abs);
        continue;
      }
      if (!d.isFile()) continue;
      filesScanned++;
      try {
        const st = await fs.promises.stat(abs);
        if (st.size > 2 * 1024 * 1024) continue;
        const buf = await fs.promises.readFile(abs);
        if (looksBinary(buf)) continue;
        const lines = buf.toString('utf8').split('\n');
        let perFile = 0;
        for (let i = 0; i < lines.length && perFile < 50 && out.length < limit; i++) {
          const line = lines[i] ?? '';
          const idx = line.toLowerCase().indexOf(needle);
          if (idx < 0) continue;
          out.push({ path: displayPath(root, abs), line: i + 1, column: idx + 1, text: clip(line) });
          perFile++;
        }
      } catch {
        /* unreadable */
      }
    }
  }
  return out;
}
