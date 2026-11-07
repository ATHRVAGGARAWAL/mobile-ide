/**
 * Path safety. Every project `root` must resolve (realpath) inside an allowed root and
 * outside the denylist; every `path` under it must stay inside after realpath.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.js';
import { ForbiddenError } from './errors.js';

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  // `..` and `../x` escape; a child literally named `..foo` does not — compare path segments, not a string prefix.
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** realpath that tolerates a missing leaf (resolves the deepest existing ancestor). */
export function realpathLenient(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(realpathLenient(parent), path.basename(abs));
  }
}

export interface PathPolicy {
  /** realpath'd allowed roots */
  roots: string[];
  /** realpath'd denied prefixes */
  denylist: string[];
}

export function buildPolicy(roots: string[], denylist: string[]): PathPolicy {
  return {
    roots: roots.map((r) => realpathLenient(expandHome(r))),
    denylist: denylist.map((r) => realpathLenient(expandHome(r))),
  };
}

/**
 * Validate a project root the client asked for. Returns its realpath.
 * Throws ForbiddenError when outside allowed roots or inside a denylisted dir.
 */
export function resolveRoot(policy: PathPolicy, requested: string): string {
  if (typeof requested !== 'string' || requested.trim() === '') throw new ForbiddenError('root required');
  const real = realpathLenient(expandHome(requested.trim()));
  if (!policy.roots.some((r) => isInside(r, real))) throw new ForbiddenError('root is outside the allowed project roots');
  if (policy.denylist.some((d) => isInside(d, real))) throw new ForbiddenError('root is denylisted');
  return real;
}

/**
 * Resolve a relative path under an already-validated root. Symlinks are followed and
 * the result must stay inside the root (and outside the denylist).
 */
export function resolveUnder(policy: PathPolicy, root: string, rel: string | undefined): string {
  const cleaned = (rel ?? '').replace(/^\/+/, '');
  const joined = path.resolve(root, cleaned);
  if (!isInside(root, joined)) throw new ForbiddenError('path escapes root');
  const real = realpathLenient(joined);
  if (!isInside(root, real)) throw new ForbiddenError('path escapes root (symlink)');
  if (policy.denylist.some((d) => isInside(d, real))) throw new ForbiddenError('path is denylisted');
  return real;
}

/** Path shown to clients: relative to root with forward slashes. */
export function displayPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}
