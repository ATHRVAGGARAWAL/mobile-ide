/**
 * Live filesystem for the phone: directory watches over the daemon connection (`fs.watch` frames) and a hook that
 * re-runs a callback when entries of a folder change. The MideClient re-establishes watches after a reconnect, so a
 * component only registers once per (root, dir).
 */
import { useEffect } from 'react';
import type { FsChange } from '@mobile-ide/core';
import { useConnection } from '../state/connection';

type Listener = (change: FsChange) => void;
const listeners = new Set<Listener>();

/** Called by the connection store for every `fs.changed` frame. */
export function emitFsChange(change: FsChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch (err) {
      console.warn('[liveFs] listener failed', err);
    }
  }
}

function normalizeDir(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * Watch `dir` (relative to `root`, '' for the root) while mounted; `onChange` receives the changed entry names.
 * Pass `enabled: false` to pause (e.g. for binary files). Safe before the socket is open: the watch is queued.
 */
export function useDirWatch(
  root: string | null | undefined,
  dir: string,
  onChange: (names: string[], change: FsChange) => void,
  enabled = true,
): void {
  const client = useConnection((s) => s.client);
  const connected = useConnection((s) => s.state === 'open');
  useEffect(() => {
    if (!enabled || !root || !client) return;
    const wanted = normalizeDir(dir);
    const listener: Listener = (change) => {
      if (change.root !== root || change.dir !== wanted || change.gone) return;
      onChange(change.names, change);
    };
    listeners.add(listener);
    client.watchDir(root, wanted).catch((err) => console.warn('[liveFs] watch failed', err));
    return () => {
      listeners.delete(listener);
      client.unwatchDir(root, wanted);
    };
    // `connected` re-runs the effect after a reconnect with a *new* client instance (the store swaps it)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, root, dir, client, connected]);
}
