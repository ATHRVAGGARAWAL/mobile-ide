/**
 * Library entry point (`main` in package.json): embed or test the daemon without the CLI.
 * `bin/mide.js` loads `dist/cli.js` instead.
 */
export { startServer, DEFAULT_DRAIN_MS } from './app.js';
export type { AuthedEnv, RunningServer, ServerContext, StartServer, TerminalManagerLike, TerminalSession } from './context.js';
export { runDoctor, formatDoctorReport, formatCheck, formatSummary, DEFAULT_AGENT_TIMEOUT_MS } from './doctor.js';
export type { DoctorCheck, DoctorReport, DoctorOptions, DoctorStatus } from './doctor.js';
export { loadConfig, defaultConfig, ConfigSchema, mideHome, localUrl, publicOrLocalUrl } from './config.js';
export type { Config, AgentConfig, LoadedConfig } from './config.js';
export { Db } from './db.js';
export type { DeviceRow, SessionRow } from './db.js';
export { generatePairingCode, generateToken, PAIRING_CODE_TTL_MS } from './auth.js';
export { SERVER_VERSION } from './version.js';
