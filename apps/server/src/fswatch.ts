/**
 * Live filesystem for the Studio and the phone's file viewer: `fs.watch` on *directories*, non-recursive, shared and
 * reference-counted per real path, with the entry names of a burst coalesced into one notification.
 *
 * Why directories and not files: agents and editors replace files by writing a temp file and renaming it over the
 * original, which a per-file inotify watch silently loses (it follows the old inode). A watch on the parent sees every
 * create / modify / rename / delete of its entries. Why not recursive: a project tree with node_modules has hundreds of
 * thousands of directories; the client only needs the folders it is looking at (an open file's folder, an expanded
 * explorer folder), so the number of watches stays small and bounded (see the caps below).
 *
 * Nothing here is a session event: the disk is not part of the replayable timeline (docs/PLAN.md), so this is a side
 * channel like the terminal bytes.
 */
import fs from 'node:fs';
import type { FsChange } from '@mobile-ide/core';
import type { Unsubscribe } from './events.js';
import { createLogger, errorInfo } from './log.js';

const log = createLogger({ mod: 'fswatch' });

/** Changes that land within this window arrive as one `fs.changed` (a save is often 2–4 inotify events). */
export const COALESCE_MS = 40;
/** Watched directories per client connection. */
export const MAX_WATCHES_PER_CLIENT = 96;
/** Watched directories for the whole daemon (shared watchers count once). */
export const MAX_WATCHES_TOTAL = 1024;

export type DirListener = (change: FsChange) => void;

interface DirWatch {
  root: string;
  dir: string;
  watcher: fs.FSWatcher;
  listeners: Set<DirListener>;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

export class WatchLimitError extends Error {
  readonly code = 'watch_limit';
  constructor(message: string) {
    super(message);
    this.name = 'WatchLimitError';
  }
}

export class DirWatchRegistry {
  /** real absolute directory path → shared watch */
  private readonly watches = new Map<string, DirWatch>();

  get size(): number {
    return this.watches.size;
  }

  /**
   * Subscribe to changes of the entries of `realDir` (already validated by the path policy). `root`/`dir` are what the
   * client called it — they travel back in every notification. Throws when the directory cannot be watched (missing,
   * not a directory, inotify exhausted) or the daemon-wide cap is hit. The returned function ends this subscription;
   * the OS watcher closes when the last subscriber leaves.
   */
  watch(realDir: string, root: string, dir: string, listener: DirListener): Unsubscribe {
    let w = this.watches.get(realDir);
    if (!w) {
      if (this.watches.size >= MAX_WATCHES_TOTAL) throw new WatchLimitError(`too many watched directories (${MAX_WATCHES_TOTAL})`);
      const st = fs.statSync(realDir); // ENOENT / ENOTDIR surface to the caller
      if (!st.isDirectory()) throw new Error('not a directory');
      const created: DirWatch = {
        root,
        dir,
        watcher: null as unknown as fs.FSWatcher,
        listeners: new Set(),
        pending: new Set(),
        timer: null,
        closed: false,
      };
      created.watcher = fs.watch(realDir, { persistent: false }, (eventType, filename) => this.onEvent(created, eventType, filename));
      created.watcher.on('error', (err) => {
        log.debug('watch.error', { dir: realDir, ...errorInfo(err) });
        this.end(realDir, created, true);
      });
      w = created;
      this.watches.set(realDir, w);
      log.debug('watch.open', { dir: realDir, total: this.watches.size });
    }
    const watch = w;
    watch.listeners.add(listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      watch.listeners.delete(listener);
      if (watch.listeners.size === 0) this.end(realDir, watch, false);
    };
  }

  /** Close every watcher (shutdown). Listeners are not told — the sockets are going away anyway. */
  closeAll(): void {
    for (const [realDir, w] of this.watches) this.end(realDir, w, false);
  }

  private onEvent(w: DirWatch, _eventType: string, filename: string | Buffer | null): void {
    if (w.closed) return;
    const name = filename === null ? '' : typeof filename === 'string' ? filename : filename.toString('utf8');
    // A rename/delete of the directory itself reports with no filename on some kernels; treat it as a burst on '.'.
    w.pending.add(name);
    if (!w.timer) {
      w.timer = setTimeout(() => this.flush(w), COALESCE_MS);
      w.timer.unref?.();
    }
  }

  private flush(w: DirWatch): void {
    w.timer = null;
    if (w.closed) return;
    const names = [...w.pending].filter((n) => n !== '' && n !== '.').sort();
    const selfChanged = w.pending.has('') || w.pending.has('.');
    w.pending.clear();
    if (names.length === 0 && !selfChanged) return;
    const change: FsChange = { root: w.root, dir: w.dir, names, ts: Date.now() };
    for (const fn of w.listeners) {
      try {
        fn(change);
      } catch (err) {
        log.warn('watch.listener_failed', { dir: w.dir, ...errorInfo(err) });
      }
    }
  }

  /** Close the OS watcher; with `gone` every subscriber learns the watch ended (directory vanished / watcher failed). */
  private end(realDir: string, w: DirWatch, gone: boolean): void {
    if (w.closed) return;
    w.closed = true;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    try {
      w.watcher.close();
    } catch {
      /* already closed */
    }
    if (this.watches.get(realDir) === w) this.watches.delete(realDir);
    log.debug('watch.close', { dir: realDir, gone, total: this.watches.size });
    if (gone) {
      const change: FsChange = { root: w.root, dir: w.dir, names: [], gone: true, ts: Date.now() };
      for (const fn of w.listeners) {
        try {
          fn(change);
        } catch (err) {
          log.warn('watch.listener_failed', { dir: w.dir, ...errorInfo(err) });
        }
      }
    }
    w.listeners.clear();
  }
}
