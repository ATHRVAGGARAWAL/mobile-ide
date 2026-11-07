# apps/server — implementation spec

Package `@mobile-ide/server`, ESM TypeScript, Node >= 22.5 (uses built-in `node:sqlite`). Bin: `mide`.
Depends on `@mobile-ide/core` (workspace) for all wire types — never redefine them. Validate every inbound
frame/body with the zod schemas from core.

## Commands (`src/cli.ts`, commander)
- `mide studio [--session <id>] [--no-open]` — open the Studio (the live editor for this machine) in a browser app-window: mints a 3-minute one-time code into the DB, builds `http://127.0.0.1:<port>/studio/#pair=<code>[&session=<id>]`, picks the browser (`studio.browser` or auto-detect), finds a display (own env, else `systemctl --user show-environment`) and spawns it detached. `--no-open` prints the URL instead (the code is still minted). Warns when no daemon answers.
- `mide serve [--port 4820] [--host 127.0.0.1] [--config ~/.mobile-ide/config.json]` — run the daemon.
- `mide pair [--name "iPhone"]` — talks to the running daemon over its loopback admin socket (or directly to the DB if not running) to mint a one-time pairing code (8 chars, 10-minute TTL), prints it plus a QR (`qrcode-terminal`) of `<publicUrl>/pair#<code>` where `publicUrl` comes from config (`publicUrl`, e.g. the tailscale serve URL) or falls back to `http://127.0.0.1:<port>`.
- `mide doctor` — checks: node version, each configured agent binary/adapter resolves and answers ACP `initialize` within 20 s, tmux present, `rg`/`git` present, tailscale present + `tailscale serve status`, linger enabled (`loginctl show-user $USER -p Linger`), DB writable. Prints a table; exit 1 on hard failures.
- `mide devices [--revoke <id>]`.
- `mide vapid [--rotate]` — create (or rotate) the Web Push VAPID key pair in the loaded config file and print the public key; the daemon does the same on first start when none is configured.
- `mide terminals [--kill <id> | --kill-all]` — list/kill the `<tmuxPrefix>-*` tmux sessions behind the Terminal tab (also `GET /api/terminals`, `DELETE /api/terminals/:id`).

## Config (`~/.mobile-ide/config.json`, created with defaults on first run; env `MIDE_HOME` overrides the dir)
```jsonc
{
  "serverName": "<hostname>",
  "port": 4820, "host": "127.0.0.1", "publicUrl": null,
  "projects": { "roots": ["~/"], "denylist": ["~/.ssh", "~/.gnupg", "~/.mobile-ide"] },
  "agents": {
    "opencode": { "name": "OpenCode", "command": "opencode", "args": ["acp"], "env": {} },
    "claude":   { "name": "Claude Code", "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"], "env": {} },
    "codex":    { "name": "Codex", "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp@1.8.0"], "env": { "CODEX_PATH": "" } }
  },
  "notifications": { "ntfy": { "server": "https://ntfy.sh", "topic": null }, "expo": { "enabled": true }, "webpush": { "vapidPublicKey": null, "vapidPrivateKey": null, "subject": "mailto:me@example.com" } },
  "terminal": { "shell": "$SHELL", "tmuxPrefix": "mide" },
  "limits": { "maxFileBytes": 1048576, "maxDiffBytes": 2097152, "eventReplayBatch": 500, "closedSessionRetentionDays": 30 },
  "trustProxy": false,
  "webApp": { "dir": null },
  "studio": { "autoOpen": true, "browser": null, "dir": null, "windowSize": "1480x920" }
}
```
`studio`: the laptop-side live editor served at `/studio/` (`apps/studio/dist`; `dir` overrides, else `<repo>/apps/studio/dist` from a checkout or `<MIDE_HOME>/studio`). `autoOpen` pops a browser app-window on every `session.created` unless a Studio is already connected over `/ws`; `browser` is the executable or short command to use (`"flatpak run com.brave.Browser"`), null = auto-detect Chromium-family → Firefox → `xdg-open`.
`MIDE_HOME` itself is always appended to the denylist. `closedSessionRetentionDays` prunes closed sessions (row + log) at boot; 0 keeps them.
Agent processes inherit the daemon's environment (so `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from the user's shell/settings still apply) plus per-agent `env`. Empty-string env values are dropped.

## Storage (`src/db.ts`, `node:sqlite` DatabaseSync, WAL mode, `~/.mobile-ide/mide.db`)
```
devices(id TEXT PK, name, platform, token_hash TEXT UNIQUE, created_at, last_seen, revoked_at)
pairing_codes(code_hash TEXT PK, created_at, expires_at, used_at)
sessions(id TEXT PK, agent, cwd, title, acp_session_id, status, mode_id, model, created_at, updated_at, last_seq INTEGER, closed_at)
events(session_id, seq INTEGER, ts, type, payload TEXT, PRIMARY KEY(session_id, seq))
permissions(id TEXT PK, session_id, turn_id, tool_call_id, request TEXT, status TEXT, option_id, resolved_by, created_at, resolved_at)
push_subscriptions(id TEXT PK, device_id, kind, payload TEXT, created_at)
turn_intents(id TEXT PK, session_id, prompt TEXT, started_at, status)   -- 'running' rows at boot = interrupted turns
```
Tokens: 32 random bytes base64url, stored as SHA-256 hex. Constant-time compare.

## HTTP (`src/http.ts`, Hono on `@hono/node-server`; the same `http.Server` hosts the `ws` upgrade)
Auth middleware: `Authorization: Bearer <token>` required on everything except `GET /api/health` (unauthenticated returns only `{ok, serverName, version}`) and `POST /api/pair`. Verify `Origin` on WS upgrades when present (allow same host as request Host, `localhost`, `127.0.0.1`, and anything under the configured publicUrl host).
Routes exactly as in `core/src/api.ts` (`API` table); request/response shapes are the zod types in `core/src/protocol.ts`:
- `POST /api/pair` `PairRequest` → `PairResponse` (burns the code; rate-limit 5/min/IP).
- `GET /api/me` → device summary. `GET /api/devices`, `DELETE /api/devices/:id`.
- `GET /api/agents` → `AgentInfo[]` (availability from the last initialize attempt; models from config `customModels` if present, plus whatever the agent advertises via config options).
- `GET /api/projects` → `ProjectInfo[]`: distinct session cwds (most recent first) + immediate git-repo children of configured roots (depth 2, skip node_modules/hidden), deduped. Include `isGit`, `branch`.
- `GET /api/sessions?status=` → `SessionSummary[]` (exclude closed unless `?all=1`). `POST /api/sessions` `CreateSessionRequest` → summary (201). `GET/PATCH/DELETE /api/sessions/:id` (DELETE = ACP `session/close` if supported, then mark closed).
- `GET /api/sessions/:id/events?after=<seq>&limit=<n>` → `EventEnvelope[]` (HTTP replay/pagination fallback).
- `GET /api/permissions/pending` → `PermissionRequest[]` across sessions.
- `GET /api/fs/tree?root=&path=` → `FsEntry[]` (one level; dirs first; include git status letters from a cached `git status --porcelain=v1 -z` per root, refreshed at most every 2 s). `GET /api/fs/file?root=&path=` → `FileContent` (size cap from config, binary sniff on first 8 KB, language from extension map). `GET /api/fs/search?root=&q=&limit=200` → `SearchMatch[]` via `rg --json --max-count 50 -n --column` (system `rg`; fall back to `@vscode/ripgrep` only if missing).
- `GET /api/git/status?root=` → `GitStatus`; `GET /api/git/diff?root=&path=&staged=0|1` → `GitDiff` (`git diff [--cached] -- <path>`; when no path, whole tree; cap bytes, `truncated` flag); `GET /api/git/log?root=&limit=30` → `GitLogEntry[]`.
- `PUT /api/fs/file` `WriteFileRequest` → `WriteFileResponse`: the Studio's save. `expectedMtime` must equal the file's current mtime (integer ms, as `FileContent.mtime` reports it) or the write fails with 409 `conflict`; temp-file + rename in the same directory; `createDirs` makes parents; same path policy and `maxFileBytes` cap as the read.
- `POST /api/studio/open` `StudioOpenRequest` → `StudioOpenResponse`: open the Studio window on the daemon's machine following `sessionId` (404 for an unknown one). `{ connected: true }` when a Studio is already connected (it follows the session itself); otherwise `opened` plus `reason`/`browser`. Never throws for "could not open" — the reason is data.
- `POST /api/push/register` `RegisterPushRequest`; `POST /api/push/test` sends a test notification to the calling device.
- `GET /studio/*` (unauthenticated static, like `/`): the Studio bundle; `/studio` → 301 `/studio/`; without a build every HTML navigation under `/studio/` gets a 503 "not built yet" page (never the phone app).
Path safety: every `root` must resolve inside an allowed project root and outside the denylist; every `path` is resolved under `root` after `realpath` and must stay inside. Reject otherwise (403).

## WebSocket `/ws` (`src/ws.ts`, `ws` package, `perMessageDeflate: false`)
Auth: subprotocol `mide.bearer.<token>` (see core `WS_AUTH_SUBPROTOCOL_PREFIX`) or `?token=`; on failure close with code 4401. Echo the chosen subprotocol back in the handshake. Server pings every 25 s; drop after 2 missed pongs.
Frames: parse with `ClientFrame`; respond per `ServerFrame`. `subscribe {afterSeq}` → stream `events` rows with `seq > afterSeq` in batches, then `replay.done {lastSeq}`, then live. Live broadcast happens only after the DB insert commits. `sessions.watch` → send `sessions.changed` now and whenever any summary changes (debounced 200 ms). `prompt`/`cancel`/`permission.respond`/`set_mode` → `ack {requestId}`; errors carry a message.
Live filesystem: `fs.watch {requestId, root, dir}` → `ack`, then `fs.changed {change: {root, dir, names, ts, gone?}}` whenever entries of that directory change (non-recursive; `dir` relative to `root`, echoed back normalized; a burst is one frame). `fs.unwatch {requestId, root, dir}` → `ack`. Idempotent per (root, dir) and socket; every watch ends with the socket. Paths go through the `/api/fs` policy; failures are failed acks (missing folder, outside the root, > 96 watches per client / 1024 per daemon). `gone: true` means the folder vanished and the watch is over. The `hello.clientName` `mide-studio` marks a Studio window (the launcher opens no second one while it is connected).

## Agent hosts (`src/agents/host.ts`, `src/agents/acp.ts`)
One `AgentHost` per configured agent id: lazily spawns the adapter process (`child_process.spawn`, stdio pipes, `cwd` = home), speaks ACP over stdio using `@agentclientprotocol/sdk` (read `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` for the exact client API; prefer the current non-deprecated surface; pin protocolVersion 1). Implement the Client side: `requestPermission` (persist → emit `permission.requested` → notify → await a promise resolved by `permission.respond`), `sessionUpdate` (normalize → append event), `readTextFile`/`writeTextFile` (serve from disk under the session cwd — allow, since agents like claude-agent-acp use them for edit review), `createTerminal`/`terminalOutput`/`waitForTerminalExit`/`killTerminal`/`releaseTerminal` (implement with `node-pty` or `child_process` so agents that need a terminal work; capture output into `TerminalContent.output`).
Multiplex: `initialize` once per process, then `session/new` per session with `cwd` and `mcpServers: []`. Track `acp_session_id`. If the process dies, mark its sessions `error` with a `session.error` event, and respawn lazily on next use; on session use after restart, try `session/load` (if `loadSession` capability) else `session/new` and emit a `session.status` note.
Normalization (ACP → `TimelineEvent`), per turn (`turnId` = uuid per `session/prompt`):
- `agent_message_chunk` text → `message.delta`; `agent_thought_chunk` → `thought.delta`; `user_message_chunk` during load → part of a synthesized `turn.started`.
- `tool_call` → `tool.call` (map `kind`, `status`, `content` (diff/terminal/content), `locations`, `rawInput`); `tool_call_update` → `tool.update`.
- `plan` → `plan`; `available_commands_update` → `commands.updated`; `current_mode_update` → `mode.changed`.
- `session/prompt` result `stopReason` → `turn.ended` (map `end_turn|max_tokens|max_turn_requests|refusal|cancelled`; thrown error → `turn.ended {stopReason:'error'}` + `session.error`).
- Emit `session.status` transitions: `starting` (spawn/new) → `idle`; `running` on prompt; `needs_you` when a permission is pending; back to `running`/`idle` on resolve.
Turn intents: insert `running` before `session/prompt`; mark `done`/`error` after. At boot, any `running` row → emit `session.error {message:'Turn interrupted by daemon restart', fatal:false}` and `session.status idle`, and resolve any `pending` permissions as `cancelled` with `by:'server'`.
Pre-warm: spawn + initialize each configured agent at boot (in parallel, non-fatal on failure) so first session creation is fast.

## Notifier (`src/notify.ts`)
`notify(deviceIds | 'all', {title, body, sessionId, kind:'permission'|'turn_done'|'error'})` fan-out to registered subscriptions: ntfy (POST `<server>/<topic>` with `Title`, `Tags`, `Click` = `<publicUrl>/session/<id>` when publicUrl set; also the config-level topic if set), Expo (`https://exp.host/--/api/v2/push/send`, batch, with `data:{sessionId}`), Web Push (`web-push` package, prune on 404/410). Triggers: `permission.requested` (always), `turn.ended` when the turn ran > 20 s or any tool call ran, `session.error`. Suppress duplicates per (session, kind) within 10 s.

## Terminal `/ws/terminal?id=&cwd=&cols=&rows=` (`src/terminal.ts`)
Each `id` maps to a tmux session `mide-<id>` (`tmux new-session -A -d -s mide-<id> -c <cwd>` then attach through `@lydell/node-pty` running `tmux attach -t mide-<id>`), so the shell survives socket drops and daemon restarts. Binary frames = raw bytes both ways; JSON text frames for `{type:'resize',cols,rows}`. Send the last 20 KB of scrollback on attach (`tmux capture-pane -p -S -2000`). If `@lydell/node-pty` fails to load, fall back to `child_process.spawn` of tmux with `script -q` and log a warning in `doctor`.

## Process behaviour
Log to stdout (structured one-line JSON, level via `MIDE_LOG=debug`). On SIGINT/SIGTERM: stop accepting sockets, send ACP `session/cancel` to running turns only if `MIDE_DRAIN=cancel` (default is to let turns finish up to 60 s), SIGINT children, close DB. Never crash on a single agent failure. `deploy/systemd/mobile-ide.service` (user unit): `ExecStart=%h/.local/bin/mide serve`, `Restart=always`, `RestartSec=3`, `TimeoutStopSec=90`, `KillMode=mixed`, `WantedBy=default.target`.

## Tests (`test/*.test.ts`, node:test + tsx)
1. Unit: normalization of sample ACP `session/update` payloads to TimelineEvents; path safety; token hashing.
2. Integration (real binaries, skipped with a clear message if the agent is unavailable): boot the daemon on a random port with `MIDE_HOME` in a temp dir; `POST /api/pair` with a code minted via the internal API; create an **OpenCode** session in a temp git repo containing one file; send prompt "Reply with exactly the word PONG and nothing else."; over WS assert ordered `turn.started`, ≥1 `message.delta`, `turn.ended` with strictly increasing `seq`; disconnect, reconnect with `afterSeq = 1`, assert the replay equals rows 2..lastSeq exactly; hit fs tree/file/search and git status/diff/log; assert `/api/health` shows the agent `ready`. Keep the prompt tiny (it costs real tokens). Provide `MIDE_TEST_AGENT=claude` to run the same flow against claude-agent-acp.
