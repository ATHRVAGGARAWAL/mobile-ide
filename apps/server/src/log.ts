/**
 * Structured one-line JSON logger. Level from MIDE_LOG (debug|info|warn|error), default info.
 * Everything goes to stdout so systemd/journald captures it.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const v = (process.env.MIDE_LOG ?? 'info').toLowerCase();
  return v in ORDER ? (v as LogLevel) : 'info';
}

let currentLevel: LogLevel = envLevel();
let sink: (line: string) => void = (line) => {
  process.stdout.write(line + '\n');
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Test hook: redirect output. */
export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

export function errorInfo(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { message: err.message, name: err.name };
    if (err.stack && currentLevel === 'debug') out.stack = err.stack;
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) out.code = code;
    return out;
  }
  return { message: String(err) };
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function write(level: LogLevel, scope: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...scope, ...fields };
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ ts: rec.ts, level, msg, unserializable: true });
  }
  sink(line);
}

export function createLogger(scope: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => write('debug', scope, m, f),
    info: (m, f) => write('info', scope, m, f),
    warn: (m, f) => write('warn', scope, m, f),
    error: (m, f) => write('error', scope, m, f),
    child: (fields) => createLogger({ ...scope, ...fields }),
  };
}

export const log = createLogger();
