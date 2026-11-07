/** REST route table shared by server and clients. All routes are prefixed with /api. */
export const API = {
  health: '/api/health',
  pair: '/api/pair',
  me: '/api/me',
  devices: '/api/devices',
  agents: '/api/agents',
  projects: '/api/projects',
  sessions: '/api/sessions',
  session: (id: string) => `/api/sessions/${encodeURIComponent(id)}`,
  sessionEvents: (id: string) => `/api/sessions/${encodeURIComponent(id)}/events`,
  pendingPermissions: '/api/permissions/pending',
  fsTree: '/api/fs/tree',
  /** GET -> FileContent; PUT WriteFileRequest -> WriteFileResponse (409 `conflict` when `expectedMtime` is stale) */
  fsFile: '/api/fs/file',
  /** POST UploadImageRequest -> UploadImageResponse: store a phone photo in the project for terminal agents. */
  fsImage: '/api/fs/image',
  fsSearch: '/api/fs/search',
  gitStatus: '/api/git/status',
  gitDiff: '/api/git/diff',
  gitLog: '/api/git/log',
  pushRegister: '/api/push/register',
  pushTest: '/api/push/test',
  /** GET -> PushVapidResponse; lets the installed PWA subscribe to Web Push. */
  pushVapid: '/api/push/vapid',
  /** GET -> TerminalInfo[] (the user's tmux-backed shells); DELETE terminal(id) kills one. */
  terminals: '/api/terminals',
  activity: '/api/activity',
  laptopHistory: '/api/activity/history',
  terminal: (id: string) => `/api/terminals/${encodeURIComponent(id)}`,
  ws: '/ws',
  wsTerminal: '/ws/terminal',
  /** the Studio — the laptop-side live editor the daemon hosts and pops open when a session starts */
  studio: '/studio/',
  /** POST { sessionId? } -> StudioOpenResponse: open (or focus) the Studio window on the daemon's machine */
  studioOpen: '/api/studio/open',
} as const;

/** `hello.clientName` the Studio identifies itself with; the daemon opens no second window while one is connected. */
export const STUDIO_CLIENT_NAME = 'mide-studio';

/** WebSocket subprotocol used to carry the bearer token (browsers cannot set headers). */
export const WS_AUTH_SUBPROTOCOL_PREFIX = 'mide.bearer.';

/** Default daemon port. */
export const DEFAULT_PORT = 4820;

export function wsUrl(baseUrl: string, path: string = API.ws): string {
  const u = new URL(path, baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}
