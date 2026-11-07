/**
 * App/daemon version bookkeeping for Settings → "Check for daemon update".
 * The daemon and the app ship from the same monorepo with the same version number, so a
 * mismatch means one side was updated and the other was not.
 */
import Constants from 'expo-constants';
import { PROTOCOL_VERSION } from '@mobile-ide/core';
import { Platform } from 'react-native';
import { CLIENT_VERSION } from '../state/connection';

export { PROTOCOL_VERSION };

/** What the RUNBOOK tells you to run on the laptop. */
export const DAEMON_UPDATE_COMMAND = 'git pull && pnpm install && pnpm build && systemctl --user restart mobile-ide';

/** The version baked into this build (app.json → version), with the client protocol version as a fallback. */
export function appVersion(): string {
  const v = Constants.expoConfig?.version?.trim();
  return v && v.length > 0 ? v : CLIENT_VERSION;
}

export interface BuildInfo {
  version: string;
  /** iOS build number / Android versionCode, when the build carries one */
  build: string | null;
  sdk: string | null;
  runtime: string | null;
  /** 'bare' | 'standalone' | 'storeClient' (Expo Go) | 'web' */
  environment: string;
}

export function buildInfo(): BuildInfo {
  const cfg = Constants.expoConfig;
  const build = Platform.OS === 'ios' ? cfg?.ios?.buildNumber ?? null : Platform.OS === 'android' ? (cfg?.android?.versionCode != null ? String(cfg.android.versionCode) : null) : null;
  const runtime = typeof cfg?.runtimeVersion === 'string' ? cfg.runtimeVersion : null;
  return {
    version: appVersion(),
    build,
    sdk: cfg?.sdkVersion ?? null,
    runtime,
    environment: Platform.OS === 'web' ? 'web' : String(Constants.executionEnvironment ?? 'bare'),
  };
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/** Lenient semver parser: accepts `v1.2.3`, `1.2`, `1.2.3-beta.1`; returns null for anything else. */
export function parseSemver(raw: string): Semver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), prerelease: m[4] ?? null };
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1; // a release beats any prerelease of the same version
  if (b === null) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 when a < b, 0 when equal, 1 when a > b; null when either side is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  const p = comparePrerelease(x.prerelease, y.prerelease);
  return p === 0 ? 0 : p < 0 ? -1 : 1;
}

export type UpdateVerdict =
  | { kind: 'match'; daemon: string; app: string; title: string; detail: string }
  | { kind: 'daemon_behind'; daemon: string; app: string; title: string; detail: string; command: string }
  | { kind: 'app_behind'; daemon: string; app: string; title: string; detail: string }
  | { kind: 'unknown'; daemon: string; app: string; title: string; detail: string };

/** Compare the daemon's `/api/health` version with this build. */
export function compareDaemonAndApp(daemonVersion: string, app = appVersion(), platform: string = Platform.OS): UpdateVerdict {
  const daemon = daemonVersion.trim();
  const cmp = compareVersions(daemon, app);
  if (cmp === null) {
    return {
      kind: 'unknown',
      daemon,
      app,
      title: 'Cannot compare versions',
      detail: `The daemon reports "${daemon || '?'}" and this app is ${app}. Update both from the same checkout to be safe.`,
    };
  }
  if (cmp === 0) {
    return { kind: 'match', daemon, app, title: `Up to date — v${app}`, detail: 'The daemon and this app were built from the same version.' };
  }
  if (cmp < 0) {
    return {
      kind: 'daemon_behind',
      daemon,
      app,
      title: `Daemon v${daemon} is behind this app (v${app})`,
      detail: 'Update the daemon on your computer, then reconnect:',
      command: DAEMON_UPDATE_COMMAND,
    };
  }
  return {
    kind: 'app_behind',
    daemon,
    app,
    title: `This app (v${app}) is behind the daemon (v${daemon})`,
    detail:
      platform === 'web'
        ? 'Reload the app: the daemon serves the latest web build. If it still shows the old version, run `pnpm build` on the computer so the export is refreshed.'
        : 'Install the latest build of the app (EAS build / TestFlight). Until then some newer daemon features may not appear.',
  };
}
