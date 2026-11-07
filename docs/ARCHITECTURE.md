# Architecture

How the daemon, the shared protocol and the app fit together — *what runs where and why it is safe*. `docs/PLAN.md` has the
decisions and their alternatives; `docs/SERVER_SPEC.md` / `docs/APP_SPEC.md` the intended behaviour; `docs/STATUS.md` what is
verified. Paths are relative to the repository root.

## 1. Topology

```
  iPhone                                        dev machine (Fedora laptop today; a VPS on the same tailnet later)
 ┌────────────────────────────────┐            ┌─────────────────────────────────────────────────────────────────┐
 │ Expo app (iOS)  or  PWA        │  Tailscale │ tailscale serve ─ HTTPS, Let's Encrypt cert ──▶ 127.0.0.1:4820  │
 │ installed from Safari          │◀══════════▶│                                                                 │
 │ ntfy app (notifications)       │  WireGuard │ mide serve   systemd --user unit · Restart=always · loopback    │
 └────────────────────────────────┘            │  ├─ Hono REST      /api/*                                       │
              ▲                                │  ├─ static web app /  (exported Expo build, SPA fallback)       │
              │ ntfy.sh · exp.host ·           │  ├─ ws             /ws  events    /ws/terminal  pty bytes        │
              │ browser push service           │  ├─ SQLite         ~/.mobile-ide/mide.db  (WAL, append-only log)│
              │ (daemon → outbound POST;        │  ├─ AgentHost per agent id ── ACP over stdio ──▶ opencode acp   │
              │  Click → <publicUrl>/session/id)│  │                                          ──▶ claude-agent-acp → claude
              └────────────────────────────────│  │                                          ──▶ codex-acp → codex
                                               │  │     adapters inherit the daemon env (proxies, keys): billing unchanged
                                               │  └─ tmux sessions  mide-<id>   (outlive the daemon)             │
                                               └─────────────────────────────────────────────────────────────────┘
```

Nothing listens on a public interface. The phone never talks to an agent, a file or a git repository directly — only to the
daemon, which mediates everything through one bearer token per paired device.

## 2. Invariants

1. **The daemon owns sessions; clients are thin.** iOS cannot keep a socket alive in the background, so nothing important lives in
   the phone: it can be killed at any moment and rebuilt from the log.
2. **Everything the phone can see is a persisted event** with a dense, per-session, monotonic `seq`. The write to SQLite commits
   *before* the broadcast (`SessionManager.append`). No side channels.
3. **Clients resume with `subscribe { afterSeq }`** and get exactly the rows they missed, then live events. The reducer ignores
   duplicates, so replay/live overlap is harmless.
4. **Agents never reach the UI raw.** ACP `session/update` payloads become `TimelineEvent`s in `agents/normalize.ts`; every agent
   renders identically.
5. **`@mobile-ide/core` is the single contract** (zod schemas + REST path table). Both sides validate against it at their
   boundary and trust typed values inside.
6. **Permissions are durable and literal.** A request is written before the phone hears about it, stays `pending` until answered
   (hours later is fine while the process lives), and carries the agent's `rawInput` verbatim.
7. **Every filesystem path is policy-checked** (`paths.ts`): inside an allowed root, outside the denylist, symlinks resolved.

## 3. Process model

`mide serve` (`apps/server/src/cli.ts` → `app.ts startServer()`):

```
start:  config → Db → EventBus · GitService · PathPolicy · ProjectScanner · Notifier → SessionManager → TerminalManager
        → sessions.boot()  (close out turns/permissions interrupted by the last instance)
        → HTTP listen (@hono/node-server) → attachWebSockets(same http.Server) → prewarm agents (background, never fatal)
stop:   stop accepting → close WS clients (1001) → drain sessions (turns get MIDE_DRAIN_MS, default 60 s, then SIGINT adapters)
        → detach ptys (tmux keeps the shells) → close HTTP → close Db
```

One process, one SQLite file, N adapter child processes (one per agent kind, each multiplexing many ACP sessions), plus tmux
servers for the user's terminals. `unhandledRejection` is logged; `uncaughtException` triggers a short drain and exit so systemd
restarts a clean instance. Under systemd the daemon only sees the unit's `PATH` plus `~/.mobile-ide/env`.

## 4. Module map

### packages/core/src

| File | Role |
|---|---|
| `protocol.ts` | zod schemas for everything on the wire: content blocks, `SessionSummary`, `AgentInfo`, `ProjectInfo`, tool content, `PermissionRequest`, the `TimelineEvent` union, `EventEnvelope`, `ClientFrame`/`ServerFrame`, REST bodies, `HealthResponse`. `PROTOCOL_VERSION = 1`. |
| `api.ts` | `API` route table (`/api/...`, `/ws`, `/ws/terminal`), `WS_AUTH_SUBPROTOCOL_PREFIX = 'mide.bearer.'`, `DEFAULT_PORT`, `wsUrl()`. |
| `timeline.ts` | Pure reducer `applyEnvelope(state, env)`: envelopes → `TimelineItem[]` (user, assistant, thought, tool, plan, permission, elicitation, turn_end, error); tracks status, modes, slash commands, pending permissions and elicitations; drops `seq <= lastSeq`. A tool item gated by an open permission request is marked `awaitingPermission` (no spinner, timer paused), `startedTs` is stamped at the approval, and diff blocks that only the request carried (OpenCode) are kept on the tool card across content replacements. `describeTool()` labels. |
| `ws-client.ts` | `MideClient`: reconnecting WebSocket (backoff 0.5 s → 15 s + jitter, stops on close 4401), re-subscribes from the last applied seq, request/ack promises with a 90 s timeout, 20 s pings. |
| `index.ts` | Re-exports. |

### apps/server/src

| File | Role |
|---|---|
| `index.ts` | Library entry (`startServer`, `runDoctor`, `loadConfig`, `Db`, …) used by tests and embedders; `bin/mide.js` loads `dist/cli.js` instead. |
| `cli.ts` | commander program `mide serve · pair · devices · vapid · doctor`; for `serve`: signal handling (second signal = force), process guards, EADDRINUSE hint. |
| `app.ts` | `startServer()` wiring and the ordered `close()` described above; `port: 0` in overrides = ephemeral port (tests). |
| `context.ts` | `ServerContext` plus the interfaces modules are built against (`TerminalManagerLike`, `RunningServer`, `StartServer`, …). |
| `config.ts` | `ConfigSchema` (zod) with defaults, built-in agents (`defaultAgents()`), `loadConfig()` (creates `config.json` 0600 on first run, `MIDE_HOME`), `agentEnv()` (daemon env + per-agent env, `''` deletes), URL helpers. |
| `version.ts` | `SERVER_VERSION` from package.json. |
| `log.ts` | One-line JSON logger to stdout; level from `MIDE_LOG`; `createLogger({ mod })`, `errorInfo()`, test sink. |
| `errors.ts` | `HttpError` + `NotFound/Forbidden/BadRequest/Conflict`; `errorMessage()`. |
| `events.ts` | `EventBus`: in-process fan-out of persisted envelopes, session-list changes and agent-host state changes. |
| `auth.ts` | Random tokens (32 bytes base64url) and pairing codes (8 chars, unambiguous alphabet), SHA-256 hashing, constant-time compare, UUIDs. |
| `authn.ts` | Extract credentials (`Authorization: Bearer`, `?token=`, WS subprotocol); `authenticate(db, creds)` → device, touches `last_seen`. |
| `paths.ts` | `PathPolicy` (realpath'd roots/denylist), `resolveRoot`, `resolveUnder` (rejects `..` and symlink escapes), `displayPath`. |
| `db.ts` | `Db` over `node:sqlite`: schema + additive migrations (incl. the `title_source` backfill), devices, pairing codes, sessions, `appendEvent` (transactional dense `seq`), `eventsAfter`, permissions, elicitations, push subscriptions, turn intents; `auto_vacuum = INCREMENTAL` and `reclaimSpace()` for the post-prune space release. |
| `sessions.ts` | `SessionManager` — the only writer of the log: create/prompt/cancel/respondPermission/respondElicitation/setMode/rename/close, `boot()` recovery, `maintain()` (space reclaim after `listen()`), previews and turn stats, notification triggers, debounced `sessions.changed`, shutdown drain. |
| `agents/host.ts` | `AgentHost` (one per agent id): lazy spawn + `initialize`, many sessions per process, ACP client handlers (permissions → sink, `fs/*` confined to the session cwd, terminals), normalize → emit, `session/load` or `session/new` recovery after a crash or restart, exit handling. |
| `agents/acp.ts` | `AcpProcess`: spawn the adapter in its own process group, ndjson JSON-RPC over stdio via `@agentclientprotocol/sdk` (protocol v1), typed `initialize/newSession/loadSession/prompt/cancel/setMode/setConfigOption/close`, stderr tail, exit promise, `AcpTimeoutError`. |
| `agents/normalize.ts` | Pure, lenient ACP `session/update` → `TimelineEvent`: message/thought chunks, tool calls and updates (kind, status, diff/terminal/content, locations, `rawInput`), plans, commands, modes; `permissionRequest()`, `stopReason()`, `usageFromPrompt()`, model config options. |
| `agents/agent-terminals.ts` | Terminals the *agent* asks for (ACP `terminal/*`): plain child processes with captured, byte-capped output — separate from the user's tmux terminals. |
| `notify.ts` | `Notifier`: ntfy (`Title`/`Tags`/`Priority`/`Click` headers), Expo Push (batches of 100, prunes `DeviceNotRegistered`), Web Push (VAPID; prunes 404/410); 10 s dedupe per (session, kind). |
| `terminal.ts` | User terminals: one tmux session `<prefix>-<id>` per terminal id, one pty per attach (`@lydell/node-pty`, fallback `script(1)`), scrollback capture, alternate-screen filter, resize, `doctor()`. |
| `projects.ts` | `ProjectScanner`: session cwds + git repositories under the configured roots (depth 2, skip list), 15 s cache. |
| `git.ts` | `GitService` over the system `git`: porcelain status with a short cache, byte-capped diff (`truncated`), log, repo info. |
| `fsapi.ts` | One-level tree with git status letters, capped file read with binary sniff and language detection, search via `rg --json` (fallbacks: bundled ripgrep, `git grep`). |
| `doctor.ts` | `runDoctor()`: Node, config, DB, tmux/git/rg, node-pty, Tailscale + `serve`, `publicUrl`, linger, systemd PATH/unit, daemon, project roots, notifications, web app build, each agent's ACP `initialize`; table formatting. |
| `http.ts` | `createHttpApp()`: error → JSON mapping, 404 (JSON, or landing pages for HTML when no web build exists), hygiene headers, CORS, 32 MB body limit, bearer middleware (`/api/*` except `GET /api/health` and `POST /api/pair`), static web app middleware, route mounting. |
| `ws.ts` | Both upgrades on the shared `http.Server`: `/ws` (`EventsConnection` + `EventsHub`: replay, live fan-out, gap fill, `sessions.watch`) and `/ws/terminal` (`TerminalConnection`); `Heartbeat` (25 s ping, 2 misses); origin and token checks; backpressure limits. |
| `routes/util.ts` | `parseJsonBody` / query helpers, `toHttpError` + `errorResponse` (`{ error, code, issues? }`), `clientIp` (`trustProxy`). |
| `routes/rate-limit.ts` | Bounded in-memory sliding-window limiter (pairing: 5/min/IP). |
| `routes/origin.ts` | Origin allowlist shared by CORS and WS upgrades: request host, loopback, `publicUrl` host, `*.ts.net`, private/CGNAT ranges. |
| `routes/health.ts` | `GET /api/health`: public `{ ok, serverName, version }`; full `HealthResponse` when authenticated (401 for a bad token). |
| `routes/pairing.ts` | `POST /api/pair` (rate-limited; burns the code and creates the device in one transaction), `GET /api/me`, `GET /api/devices`, `DELETE /api/devices/:id`. |
| `routes/sessions.ts` | `GET /api/agents`, `GET /api/projects`, sessions CRUD (`PATCH` = rename and/or mode, `DELETE ?purge=1`), `GET /api/sessions/:id/events?after=&limit=`, `GET /api/permissions/pending`. |
| `routes/fs.ts` | `GET /api/fs/tree · file · search`, every path through `PathPolicy`. |
| `routes/git.ts` | `GET /api/git/status · diff · log` (400 `not_git` outside a work tree). |
| `routes/push.ts` | `POST /api/push/register` (expo · ntfy · webpush; a device-supplied ntfy server must be https, or http on a loopback/private/tailnet host, never link-local — parsed, so IPv4-mapped IPv6 spellings count too), `POST /api/push/test`, `GET /api/push/vapid`. |
| `routes/terminals.ts` | `GET /api/terminals` (the user's `<tmuxPrefix>-*` shells), `DELETE /api/terminals/:id` (kill one) — what the Terminal tab's "Close shell" and `mide terminals` use. |
| `routes/static.ts` | Serves the exported Expo web build (`config.webApp.dir` → `apps/mobile/dist` of the checkout → `~/.mobile-ide/www`): MIME, ETag/304, brotli/gzip compressed once per (file, mtime, encoding) into a bounded cache, `immutable` for hashed `_expo/` assets and `no-cache` for `index.html`/manifest/`sw.js`, `frame-ancestors 'none'` + `X-Frame-Options: DENY`, SPA fallback for HTML GETs; never touches `/api/*` or `/ws*`. |
| `routes/pages.ts` | Minimal HTML landing (`/`) and pairing (`/pair#CODE`) pages, used only when no web build is present. |

`apps/server/test`: `unit.test.ts` (normalization samples, path policy, token hashing, credential extraction, rate limiter…),
`unit-adapters.test.ts` (real claude-agent-acp / codex-acp traffic from `fixtures/*.json`, recorded with `fixtures/capture.ts`,
replayed through the normalizer and the core reducer), `unit-sessions.test.ts` (title policy, boot/shutdown, notifier dedupe, ntfy
server validation, static HEAD/compression, previews, space reclaim), `terminal.test.ts` (real tmux), `e2e.test.ts` (real daemon on a random port, pairing, REST + WS contracts, one tiny OpenCode
turn, replay equality), `e2e-permissions.test.ts` / `e2e-restart.test.ts` / `e2e-crash.test.ts` (durability: permission
round-trip, restart with intact replay, adapter SIGKILL and respawn), `e2e-elicitation.test.ts` (one real Claude Code `AskUserQuestion`
turn answered from the client), `helpers.ts` / `durability-helpers.ts`. Everything runs
with `node --test --import tsx --test-concurrency=1`; agent turns cost real tokens (see `CLAUDE.md`).

### apps/mobile

| Path | Role |
|---|---|
| `app/_layout.tsx` | Root: theme provider, gesture root, keyboard provider (native), connection bootstrap, toasts host, deep-link handling. |
| `app/index.tsx` → `(auth)/pair.tsx` or `(tabs)/` | Redirect by pairing state. Pair screen: server URL + code (prefilled from `mobileide://pair?server=&code=`, `/pair?server=…#CODE`, or a pasted link), connection probe, Add-to-Home-Screen banner on Safari. |
| `app/(tabs)/` | `index` Sessions (needs-you inbox, grouped list, actions) · `files` · `changes` · `terminal` · `settings`; `_layout` carries the needs-you badge. |
| `app/session/[id].tsx` | Chat: FlashList over `TimelineState.items`, streaming markdown, tool/diff/plan cards, permission sheet with the verbatim command, composer (`/` commands, `@` files, images), stop, mode selector, header menu. |
| `app/new-session.tsx`, `app/file.tsx`, `app/+html.tsx`, `app/+not-found.tsx` | New-session modal; file viewer (Shiki, wrap, line jump); web HTML shell with PWA tags; 404. |
| `src/state/` | zustand stores: `settings` (persisted; SecureStore on native, `localStorage` on web via `storage.ts`), `connection` (one `MideClient`, AppState-aware), `sessions` (summaries, per-session `TimelineState` via the core reducer, outbox, subscribe helpers), `projects`, `readState` (unread markers), `toast`; `api.ts` typed fetch over `API`. |
| `src/components/` | `ui` kit (Screen, Text, Button, Chip, StatusChip, Sheet, TextField, ListRow, Card, EmptyState, Banner, Toasts, …) and feature folders `chat`, `permissions`, `sessions`, `files`, `changes`, `terminal`. |
| `src/dom/` | `'use dom'` components rendered in a WebView on native and inline on web: `MarkdownView`, `DiffView`, `CodeView`, `TerminalView` (xterm + WebGL/DOM renderer over `/ws/terminal`), `domTheme`. |
| `src/lib/` | `links` (deep links, notification targets, deferred navigation), `notifications` (Expo push, native), `webpush` (PushManager when standalone), `format`, `haptics`, `clipboard`, `platform`, hooks. |
| `src/theme.ts`, `src/theme/` | Tokens for dark/light, `agentColor()`, `statusColor()`, `ThemeProvider`. |
| `public/`, `metro.config.js`, `app.json` | PWA manifest, `sw.js`, icons; Metro watches the workspace root and enables package `exports` so `@mobile-ide/core` resolves; scheme `mobileide`, bundle id `dev.mobileide.app`, `web.output: "single"`. |

## 5. Event flow

### 5.1 A prompt turn

```
 phone ──prompt{requestId,sessionId,blocks}──▶ ws.ts ──▶ SessionManager.prompt()
                                                            │ insertTurnIntent(turnId, 'running')          ← survives a crash
                                                            └▶ AgentHost.beginTurn()
                                                                 │ ensureSession(): spawn+initialize if needed, then
                                                                 │   session/load (if supported) or session/new
                                                                 │ emit turn.started  · setStatus running
                                                                 └▶ AcpProcess.prompt() ──session/prompt──▶ adapter ──▶ agent
 phone ◀──ack{requestId}── (the turn is running now; the rest arrives as events)

 agent ──session/update──▶ AcpProcess ──▶ AgentHost.handleUpdate() ──normalizeUpdate()──▶ sink.emit(event)
                                                                                           │ track(): previews, turn stats, notify
                                                                                           │ db.appendEvent() → seq        (commit)
                                                                                           └ bus.emitEvent(envelope)      (fan-out)
                                                                            EventsHub ──▶ every /ws subscribed to the session
 phone ◀──event{envelope}──  applyEnvelope() → items re-render (streaming bubbles append text)

 agent ──prompt result{stopReason}──▶ AgentHost: emit turn.ended{stopReason, usage} → finishTurnIntent('done'|'error')
                                                 setStatus idle (or needs_you) → debounced sessions.changed to watchers
```

Errors thrown by `session/prompt` become `session.error` + `turn.ended{stopReason:'error'}` — a turn always ends. A second prompt
while one runs is rejected with 409 `conflict`. `cancel` sends ACP `session/cancel` after answering the turn's pending permissions
as `cancelled` (ACP requires it); the agent then finishes with `stopReason: 'cancelled'`.

### 5.2 A permission round-trip

```
 agent ──session/request_permission{toolCall, options}──▶ AcpProcess ──▶ AgentHost ──▶ SessionManager.requestPermission()
        │ db.insertPermission(pending) → emit permission.requested{request incl. rawInput} → setStatus needs_you
        │ Notifier.notify('all', kind: 'permission')  → ntfy / Expo / Web Push, Click = <publicUrl>/session/<id>
        │ …the JSON-RPC request stays open; nothing times out…
 phone ──permission.respond{permissionId, outcome, optionId}──▶ ws.ts ──▶ respondPermission()
        │ validates the option, db.resolvePermission → emit permission.resolved{by: deviceId} → resolves the promise
 agent ◀──{outcome: selected, optionId}── continues the tool call; status back to running (or idle)
```

If the agent withdraws the request (turn cancelled) the promise is resolved `cancelled` by the abort signal. On daemon restart
`boot()` cancels every `pending` row with `by: 'server'` so no client waits on a request no process is holding.

### 5.3 Reconnect and replay

```
 phone (MideClient) reconnects → hello → for each remembered session: subscribe{sessionId, afterSeq = last applied seq}
 ws.ts subscribe():  rows = db.eventsAfter(afterSeq) in batches of limits.eventReplayBatch (500), yielding between batches
                     and pausing while the socket has > 1 MB unsent; live events for that session are held back meanwhile
                     → gap guard: re-read anything committed while replaying → replay.done{lastSeq} → live
 live delivery:      skips seq <= cursor (overlap); a seq jump (should never happen) is healed from the log (fillGap)
```

`afterSeq: -1` (or `0`) means "from the start" — seq 0 is `session.created`, which carries the modes the chat header needs. The
same semantics exist over HTTP (`GET /api/sessions/:id/events?after=&limit=`) for pagination or non-WS clients.

### 5.4 Restart and crash recovery

- **Daemon restart** — `sessions.boot()` runs, in this order: (1) cancel every pending permission — `permission.resolved{outcome:'cancelled', by:'server'}`,
  logged as `boot.stale_permission`; (2) mark `running` turn intents `error` and append `session.error{code:'interrupted'}` +
  `turn.ended{stopReason:'error'}` — unless the log already holds a `turn.ended` for that turn (the crash hit the window between
  the persisted `turn.ended` and the intent update), in which case the intent is simply marked `done`; (3) reset
  `running/needs_you/starting` sessions to `idle` with `session.status{detail:'Daemon restarted'}`; (4) prune closed sessions older
  than `limits.closedSessionRetentionDays` and checkpoint the WAL. Permissions go first so no timeline ever shows a turn ending while
  one of its requests is still open (asserted by `e2e-restart.test.ts`); sessions already in `error` are left alone until the next
  prompt. Space freed by the prune is handed back by `SessionManager.maintain()` right after `listen()` — never before the port is
  bound. The next prompt reopens the ACP session: `session/load` when the agent supports it (context preserved), else `session/new`
  with a status note that earlier turns are not visible to the agent. A graceful stop cancels the permission requests it is still
  awaiting an answer to (the same `by:'server'` outcome) *before* draining, so a turn parked on an unanswerable request cannot hold
  the shutdown for the full drain; rows left by a hard crash have no waiter and stay for boot().
- **Adapter crash** — `AcpProcess.exited` → `AgentHost.onProcessExit`: sessions bound to that process get `session.error{code:'agent_exited'}`
  and status `error`; the host state becomes `error` (visible in `/api/health` and `/api/agents`); the next use respawns lazily.
- **Interrupted turns while the daemon stays up** are the agent's problem: `stopReason` maps to `turn.ended`.

### 5.5 Session list

`sessions.changed` (full `SessionSummary[]`) goes to every socket that sent `sessions.watch`, at most every 200 ms, whenever a
session is created/renamed/closed, a turn starts or ends, a mode changes, or an agent host changes state.

## 6. WebSocket protocol (`/ws`)

**Upgrade.** Path must be `/ws` or `/ws/terminal` (else HTTP 404 and the socket is destroyed). `Origin`, when present, must pass
`routes/origin.ts`. The bearer token travels as the subprotocol `mide.bearer.<token>` (browsers cannot set headers; the server
echoes it back) or as `?token=`. No token → HTTP 401 before the handshake. Token present but invalid/revoked → the handshake
completes, then close **4401** so the client can distinguish "unauthorized" (stop retrying, re-pair) from a network failure.

**Frames** (`packages/core/src/protocol.ts`; every frame is one JSON text message):

| client → server | reply |
|---|---|
| `hello { protocolVersion, clientName, clientVersion }` | `welcome { protocolVersion, serverVersion, serverName, deviceId }` |
| `subscribe { sessionId, afterSeq ≥ -1 }` | `event { envelope }` × N (replay) → `replay.done { sessionId, lastSeq }` → live `event`s |
| `unsubscribe { sessionId }` | — |
| `sessions.watch` | `sessions.changed { sessions }` now and on every change (≤ 1 per 200 ms) |
| `prompt { requestId, sessionId, blocks[] }` | `ack { requestId, ok, error? }` once the turn has started (≤ 90 s client timeout) |
| `cancel { requestId, sessionId }` | `ack` |
| `permission.respond { requestId, sessionId, permissionId, outcome: selected\|cancelled, optionId? }` | `ack` |
| `elicitation.respond { requestId, sessionId, elicitationId, action: accept\|decline\|cancel, content? }` | `ack` (400-style `ack { ok: false }` when the answers fail the schema) |
| `set_mode { requestId, sessionId, modeId }` | `ack` |
| `ping { ts }` | `pong { ts }` |

Unsolicited server → client: `event`, `sessions.changed`, `error { message, code? }` (a protocol problem, e.g. unknown session in
`subscribe`; never a connection-state change). Malformed frames are answered with `error` and ignored.

**Liveness and backpressure.** Server pings every 25 s and terminates after 2 missed pongs; any inbound traffic counts as alive.
A live feed that backs up beyond 4 MB is dropped — the client reconnects and resumes cheaply from `afterSeq`. Replays pause while
more than 1 MB is unsent. Max payload 32 MB (prompts may carry base64 images). Revoked devices are cut at the next heartbeat.

**Close codes.** `4400` bad request · `4401` unauthorized · `4403` forbidden · `4404` not found · `1001` server shutting down ·
`1011` internal error.

**Terminal socket** (`/ws/terminal?id=&cwd=&cols=&rows=`). Same auth and origin rules; `cwd` goes through `PathPolicy`; `id`
matches `^[a-zA-Z0-9_-]{1,64}$` and maps to tmux session `mide-<id>` (created on demand, reused on reconnect). Binary frames are
raw pty bytes both ways; JSON text frames are control: `{type:'resize',cols,rows}`, `{type:'input',data}`, `{type:'ping'}`.
Non-JSON text is treated as keystrokes. The last 20 KB of scrollback is sent first. A viewer that cannot keep up (> 8 MB
buffered) is dropped; the tmux session keeps running.

## 7. REST surface

All under `/api`, JSON in and out, `Authorization: Bearer <token>` except where noted; errors are `{ error, code, issues? }`.

| Route | Purpose |
|---|---|
| `GET /health` | Public `{ ok, serverName, version }`; with a valid token also `uptimeSec`, per-agent `state`/`sessions`, session counts. |
| `POST /pair` | Public, 5/min/IP. `{ code, deviceName, platform? }` → `{ token, deviceId, serverName }`; the code is single-use, 10 min TTL. |
| `GET /me` · `GET /devices[?all=1]` · `DELETE /devices/:id` | Device summaries (never token hashes); revoking yourself logs you out. |
| `GET /agents` | `AgentInfo[]`: availability from the last `initialize`, models, capabilities. |
| `GET /projects` | Recent session cwds + git repos under the roots (`isGit`, `branch`, `sessionCount`). |
| `GET /sessions[?status=&all=1]` · `POST /sessions` · `GET/PATCH/DELETE /sessions/:id[?purge=1]` | Summaries; create (optional `initialPrompt`); rename / `modeId`; close (ACP `session/close` when supported; `purge` deletes the log). |
| `GET /sessions/:id/events?after=&limit=` | Replay/pagination fallback (same `after` semantics as `subscribe`). |
| `GET /permissions/pending[?sessionId=]` | Pending `PermissionRequest[]` across sessions — the "Needs you" inbox. |
| `GET /fs/tree?root=&path=` · `GET /fs/file?root=&path=` · `GET /fs/search?root=&q=&limit=` | One directory level with git status letters; capped read (`truncated`, `binary`, `language`); ripgrep matches. |
| `GET /git/status?root=` · `GET /git/diff?root=&path=&staged=0\|1` · `GET /git/log?root=&limit=` | Porcelain status; unified patch (byte-capped); recent commits. |
| `POST /push/register` · `POST /push/test` · `GET /push/vapid` | Register an Expo token / ntfy topic / Web Push subscription; send a test; public VAPID key. |
| `GET /terminals` · `DELETE /terminals/:id` | The tmux-backed shells behind the Terminal tab (`TerminalInfo[]`: id, cwd, live attaches); kill one. |

`GET /` and any non-API path serve the web app (or the fallback landing pages); `/pair` and `/session/<id>` deep links resolve
through the SPA fallback.

## 8. Storage (`~/.mobile-ide/mide.db`, `node:sqlite`)

PRAGMAs: `auto_vacuum = INCREMENTAL` (set before the schema, so databases created by the daemon release pruned pages in place;
an older file converts at its next full VACUUM), `journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`,
`busy_timeout = 5000`. Schema is created with `IF NOT EXISTS`; later columns are added by additive `ALTER TABLE` migrations in
`Db.migrate()` (`sessions.title_source` is backfilled: folder-named rows `default`, everything else `user`, so a pre-upgrade title
is never taken by an agent suggestion).

```sql
devices            (id TEXT PK, name, platform, token_hash TEXT UNIQUE, created_at, last_seen, revoked_at)
pairing_codes      (code_hash TEXT PK, created_at, expires_at, used_at)
sessions           (id TEXT PK, agent, cwd, title, acp_session_id, status, mode_id, model, created_at, updated_at,
                    last_seq INTEGER DEFAULT -1, closed_at, available_modes TEXT /*json*/, last_preview TEXT)
events             (session_id, seq INTEGER, ts, type, payload TEXT /*json TimelineEvent*/, PRIMARY KEY (session_id, seq))
permissions        (id TEXT PK, session_id, turn_id, tool_call_id, request TEXT /*json PermissionRequest*/,
                    status /*pending|selected|cancelled*/, option_id, resolved_by, created_at, resolved_at)
                    INDEX permissions_pending (status, session_id)
elicitations       (id TEXT PK, session_id, turn_id, tool_call_id, mode /*form|url*/, request TEXT /*json ElicitationRequest*/,
                    status /*pending|accept|decline|cancel*/, content TEXT /*json answers*/, resolved_by, created_at, resolved_at)
                    INDEX elicitations_pending (status, session_id)
push_subscriptions (id TEXT PK, device_id, kind /*expo|ntfy|webpush*/, payload TEXT /*json*/, created_at)
                    INDEX push_subscriptions_device (device_id)
turn_intents       (id TEXT PK /*= turnId*/, session_id, prompt, started_at, status /*running|done|error*/)
                    INDEX turn_intents_status (status)
```

- `appendEvent` runs in a `BEGIN IMMEDIATE` transaction: read `sessions.last_seq`, insert `seq = last_seq + 1`, update `last_seq`
  and `updated_at`. The log per session is therefore dense from `0` and never has holes.
- Tokens and pairing codes are stored only as SHA-256 hex; lookups compare digests in constant time.
- `eventsAfter` re-validates every payload with the core schema and skips (logs) corrupt rows instead of failing the replay.
- `turn_intents` rows in `running` at boot are the definition of "interrupted turn"; rows older than 7 days are pruned.
- `DELETE /api/sessions/:id?purge=1` removes the session's events, permissions and intents; a plain close keeps the log.

## 9. Security model

- **Network.** The daemon binds `127.0.0.1` (configurable) and is reached only through the tailnet; `tailscale serve` terminates
  TLS. No relay, no public port, no third-party account in the request path.
- **Pairing.** `mide pair` mints an 8-character code from an unambiguous alphabet (hashed at rest, 10-minute TTL, single use,
  burned atomically together with device creation). `POST /api/pair` is rate-limited 5/min per client IP; `trustProxy` must be
  enabled deliberately before `X-Forwarded-For` is honoured (only from loopback peers), so a direct caller cannot forge the key.
- **Device tokens.** 32 random bytes, base64url, shown once; stored hashed; revocable (`mide devices --revoke`, `DELETE /api/devices/:id`).
  Revocation ends HTTP access at the next request and WebSocket access at the next heartbeat/reconnect (close 4401).
- **Every route and both upgrades authenticate**, except the public health subset and pairing. Browser origins are checked for CORS
  and upgrades against the same allowlist (request host, loopback, `publicUrl` host, `*.ts.net`, private/CGNAT ranges); public
  internet origins are refused. Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`; the HTML fallback pages ship a strict CSP.
- **Filesystem.** Project roots come from config; the denylist defaults to `~/.ssh`, `~/.gnupg`, `~/.mobile-ide`. Every `root`
  and `path` is realpath'd and must stay inside an allowed root and outside the denylist (symlink escapes rejected). ACP
  `fs/read_text_file` and `fs/write_text_file` are confined to the session's cwd — an agent cannot read `~/.aws/credentials` from
  a project session. File reads and diffs are byte-capped.
- **Agents.** Adapters run as child processes in their own process groups with the daemon's environment (that is the point: the
  user's proxies and keys), spawned with `shell: false` from config-controlled command/args. Every tool call that needs approval
  is shown with its literal `rawInput`; `allow_always` requires a confirmation step in the app. `session/cancel` answers pending
  permissions as cancelled first, as ACP requires.
- **Terminals.** Terminal ids are validated; tmux targets use exact-match names; the pty runs as the daemon's user (this is a
  remote shell on purpose — access to it is exactly a paired device).
- **State on disk.** `~/.mobile-ide` is created `0700`, `config.json` `0600` (it may hold VAPID private keys and an ntfy topic);
  systemd environment lives in `~/.mobile-ide/env`. Logs never include tokens.
- **Not yet** (see `docs/PLAN.md` phase 4): passkeys for the web client, biometric confirmation for destructive tool calls, an audit
  log of executed commands.

## 10. Notifications

`Notifier.notify(target, { title, body, sessionId, kind })` fans out to every push subscription of the target devices plus the
config-level ntfy topic. Channels: **ntfy** (`POST <server>/<topic>` with `Title`, `Tags` bell/lock · warning · white_check_mark,
`Priority` high for permissions, `Click` = `<publicUrl>/session/<id>`), **Expo Push** (`exp.host`, batches of 100, `data`
carries `sessionId`/`url`, `DeviceNotRegistered` prunes the row), **Web Push** (`web-push` with the VAPID pair from config — generated
and persisted automatically on the first start when missing, `mide vapid` prints or `--rotate`s it; 404/410 prune the row; the service worker must show a visible notification or Safari revokes the
subscription). Triggers: `permission.requested` always; `turn.ended` when the turn took more than 20 s or ran a tool call (not on
`error`); `session.error` always. Duplicates per (session, kind) within 10 s are suppressed so a burst yields one buzz.

## 11. Terminals

Two unrelated kinds. **User terminals** (`terminal.ts`, Terminal tab): each id is a tmux session `mide-<id>`; the daemon attaches
a pty running `tmux attach-session` per WebSocket viewer, so several viewers share one shell, the shell survives socket drops and
daemon restarts, and `tmux capture-pane` provides scrollback on attach. **Agent terminals** (`agents/agent-terminals.ts`): when an
adapter uses the ACP terminal capability, the daemon runs the command as a plain child process with captured output and returns
it through `terminal/output` / `terminal/wait_for_exit`; the captured output is also attached to the tool card's `TerminalContent`.

## 12. Configuration and files on disk

`~/.mobile-ide/` (`MIDE_HOME` overrides): `config.json` (schema in `config.ts`; keys `serverName`, `port`, `host`, `publicUrl`,
`trustProxy`, `webApp.dir`, `studio.{autoOpen,browser,dir,windowSize}`, `projects.roots/denylist`, `agents.<id>`,
`notifications.{ntfy,expo,webpush}`, `terminal`, `limits`), `mide.db` (+ WAL files), `env` (systemd `EnvironmentFile`), `www/`
(optional copy of the web export), `studio/` (optional copy of the Studio bundle), `studio-profile/` (the Studio window's own
browser profile). The repository's
`deploy/systemd/mobile-ide.service` runs `%h/.local/bin/mide serve` with `Restart=always`, `TimeoutStopSec=90`, `KillMode=mixed`.

## 13. Web app delivery

The same daemon serves the exported Expo web build at `/` (`routes/static.ts`), so the phone has one origin for the app, the API
and both WebSockets — which is what lets the installed PWA and its service worker work without CORS tricks. The build is looked
up on every request (`webApp.dir` → `apps/mobile/dist` → `~/.mobile-ide/www`), so `pnpm build:web` is picked up live; hashed
bundles are immutable, `index.html` never caches. During development the Expo dev server on `:8081` serves the app instead and
talks to the daemon cross-origin, which the origin allowlist permits for loopback and tailnet hosts.

## 14. Elicitation — agent questions and URL hand-offs

ACP `elicitation/create` is how an agent asks the *user* something mid-turn: **form mode** (a flat JSON-schema object of
primitives — Claude Code's `AskUserQuestion`, MCP servers' questions) and **url mode** (send the user to a page, e.g. an
OAuth flow, and tell the client when it is done). The daemon advertises both in `initialize`
(`clientCapabilities.elicitation: { form: {}, url: {} }`, `agents/acp.ts`) — claude-agent-acp *disables* `AskUserQuestion`
altogether unless `form` is present, and renders each question as a string field with titled `oneOf` options (multi-select
questions as an `array` with `anyOf` items) plus an optional free-text `question_<n>_custom` "Other" field. Elicitations are
treated exactly like permissions: durable, literal, answered from the phone, never timing out while the process lives.

```
 agent ──elicitation/create{sessionId, mode:'form', message, requestedSchema}──▶ AcpProcess ──▶ AgentHost ──▶ SessionManager.requestElicitation()
        │ normalize (agents/normalize.ts: elicitationRequest — enum/oneOf/anyOf → `options`, unknown types → text)
        │ db.insertElicitation(pending) → emit elicitation.requested{request} → setStatus needs_you → Notifier (kind 'permission': always)
        │ …the JSON-RPC request stays open…
 phone ──elicitation.respond{elicitationId, action:'accept', content}──▶ ws.ts ──▶ respondElicitation()
        │ validateElicitationContent(schema, content) (core; the form runs the same check before sending) → 400 on a bad answer
        │ db.resolveElicitation → emit elicitation.resolved{action, content, by: deviceId} → resolves the promise
 agent ◀──{action:'accept', content}── folds the answers into the tool input; status back to running (or idle)
```

- **Wire (core `protocol.ts`).** `ElicitationRequest { elicitationId, sessionId, turnId, toolCallId?, mode: 'form'|'url', message,
  schema?, url?, createdAt }`; `ElicitationSchema { title?, description?, properties: Record<name, ElicitationProperty>, required[] }`
  with `ElicitationProperty` = `string` (optional `options`, min/maxLength, pattern, format) | `number` | `integer` (min/max) |
  `boolean` | `array` (multi-select `options`, min/maxItems), each with `title`/`description`/`default`. Events
  `elicitation.requested { request }` and `elicitation.resolved { elicitationId, action: accept|decline|cancel, content?, by? }`;
  client frame `elicitation.respond { requestId, sessionId, elicitationId, action, content? }` → `ack`. `SessionSummary.pendingPermissions`
  counts pending elicitations too (it is "items waiting for you", which is what the tab badge and the Needs-you inbox show);
  `pendingElicitations` says how many of them are questions. `validateElicitationContent` / `elicitationDefaults` are shared pure helpers.
- **Reducer (core `timeline.ts`).** Item kind `elicitation { request, resolved? }`, `pendingElicitations[]`, `elicitationIndex`; status is
  `needs_you` while any permission *or* elicitation is open, and returns to `running`/`idle` on the last answer.
- **Actions.** `accept` = answered (form) / opened (url); `decline` = "skip" — claude-agent-acp tells the model the user skipped and the
  turn continues; `cancel` = dismissed — the tool call is aborted. The sheet offers all three (Send answer · Skip · Dismiss, the last
  behind a confirm step), as the spec requires.
- **Cancellation, like permissions.** `SessionManager.cancel` answers open elicitations `cancel` before ACP `session/cancel`;
  `closeSession` and `shutdown()` cancel the ones this process is awaiting (`by: 'server'`); `boot()` cancels stale `pending` rows before
  ending interrupted turns, so no timeline shows a turn ending while a question is open; the agent withdrawing the request
  (`$/cancel_request`) resolves it `cancel` through the abort signal.
- **url mode.** The phone shows the host and the full URL before anything opens, warns when it is not HTTPS, and sends `accept` at the
  moment of consent (the agent may finish the flow itself). `elicitation/complete { elicitationId }` from the agent closes a still-pending
  url request as `accept` with `by: 'agent'` (matched per agent on the agent's own id); unknown or already-answered ids are ignored.
  Request-scoped elicitations (`requestId`, before any session) have no phone to go to and are dismissed with a warning log; modes the
  daemon did not advertise are declined.
- **Storage.** `elicitations (id PK, session_id, turn_id, tool_call_id, mode, request JSON, status pending|accept|decline|cancel,
  content JSON, resolved_by, created_at, resolved_at)` + index `(status, session_id)`; purged with the session.
- **Notifications.** Same path as permissions (`kind: 'permission'`, no dedupe, priority high); the Click URL carries the elicitation id as
  `?permission=<id>`, and the chat screen opens the matching elicitation sheet (it also honours `?elicitation=<id>`).
- **App.** `src/components/elicitation/`: `ElicitationCard` (inline timeline card; status, question, answer once resolved),
  `ElicitationSheet` (form or URL panel, validation with the shared helper, optimistic answer + revert, offline queue through the
  outbox, "answered from another device" handling), `ElicitationForm` (chips for short undescribed options, radio/checkbox rows
  otherwise, text/number fields, toggles). `state/sessions.ts` mirrors `respondPermission` (`respondElicitation`, `elicitationSubmit`).
- **Proof.** `test/e2e-elicitation.test.ts` runs ONE real Claude Code turn ("Use your AskUserQuestion tool to ask me whether I prefer red
  or blue…"): asserts `elicitation.requested` with an enum schema offering both colours, the parked state (status, counts, DB row, push),
  refused bad answers (value outside the options, unknown field, wrong type, unknown id), the accepted answer (`by`, DB content, status
  back to `running`), `turn.ended end_turn` with "blue" in the reply, replay equality and the reducer's rendering. Skips when `claude`
  is not on PATH or `MIDE_SKIP_AGENT_TESTS=1`.

## 15. The Studio — the laptop's live editor

The phone drives the agent; the laptop *shows* it. `apps/studio` (`@mobile-ide/studio`) is a second, desktop-class client of the
same daemon: a React DOM + CodeMirror 6 page bundled by esbuild (`build.mjs` → `apps/studio/dist`, ESM with code splitting so the
editor's languages load lazily), served by the daemon at `/studio/` (`routes/static.ts`, the same static-site middleware as the
phone app with a `/studio` prefix, its own build location list — `studio.dir` → `<repo>/apps/studio/dist` → `~/.mobile-ide/studio`
— and a "not built yet" page instead of falling through to the phone app). No React Native, no Expo: it imports only
`@mobile-ide/core` (protocol, reducer, `MideClient`), which is the whole point of "core is the contract".

```
 phone: prompt ──▶ daemon ──▶ agent                       laptop screen
                     │  tool.call {kind:'edit', diff}        ┌─────────────────────────────────────────────┐
                     ├──── /ws event ─────────────────────▶  │ Studio  (browser --app window, /studio/)    │
                     │                                       │  · opens the file, draws the diff as a ghost │
                     │  agent writes the file                │  · fs.changed → re-reads → patches the doc, │
                     │  inotify (fs.watch on the folder)     │    changed lines glow, scrolls into view     │
                     └──── /ws fs.changed ──────────────────▶│  · rail: feed, approvals, composer           │
                                                             └─────────────────────────────────────────────┘
```

**Pop-up.** `StudioLauncher` (`studio.ts`) listens on the bus for `session.created`. When `studio.autoOpen` is on, no `/ws` client
has said hello as `mide-studio`, and a display is reachable, it spawns a browser detached from the daemon: a Chromium-family
browser in `--app=<url>` mode (no tabs or URL bar, `--class=mide-studio`, a dedicated `--user-data-dir` for native installs so the
Studio is its own process and taskbar entry; Flatpak browsers get the app window inside their default profile), else Firefox
`--new-window`, else `xdg-open`. `studio.browser` overrides the choice (`"flatpak run com.brave.Browser"`, a path, …). A
connected Studio is never duplicated — it follows the new session by itself (auto-switch) — and a 20 s cooldown covers the window
that is still starting. `mide studio [--session id] [--no-open]` and `POST /api/studio/open` (the phone's "Open in Studio") use the
same `openStudio()`; every reason a window did not appear is in the result and the log. Headless daemons (systemd, SSH) get the
display from `systemctl --user show-environment` when their own environment has none; `mide doctor`'s *Studio* row reports bundle,
browser and display.

**Auth.** The launch URL is `http://127.0.0.1:<port>/studio/#pair=<code>&session=<id>` — loopback (the launcher runs where the
daemon runs; no tailnet or TLS involved) with a one-time pairing code that lives 3 minutes. The page redeems it once
(`POST /api/pair`, device "Studio · Linux Brave", platform `studio`), keeps the device token in `localStorage` of that origin, and
scrubs the fragment. Later launches reuse the token; the unused code expires. The code is visible in the browser's argv for a
moment, which is acceptable on the user's own machine — the token itself never is.

**Live filesystem** (`fswatch.ts`, frames `fs.watch` / `fs.unwatch` / `fs.changed` in core). Clients watch *directories*, not
files, non-recursively: the folder of every open file and every expanded explorer folder. Directories because agents and editors
replace files by write-temp-and-rename, which a per-file inotify watch silently loses; non-recursive because a tree with
`node_modules` has hundreds of thousands of directories and the client only looks at a handful. Watchers are shared and
reference-counted per real path (`DirWatchRegistry`), a burst is coalesced into one frame (40 ms), and there are caps (96 per
client, 1024 per daemon). Paths go through the same `resolveRoot`/`resolveUnder` policy as `/api/fs`. The disk is *not* part of a
session's event log: `fs.changed` is a side channel like terminal bytes, so replay still reproduces the timeline exactly. The phone's
file viewer uses the same frames to re-read a file the moment the agent writes it.

**Two-phase live edit.** A `tool.call` of kind `edit` with a diff block is known before the write. The Studio opens the file (with
"Follow files" on), finds `oldText` in the document and draws a *ghost*: the doomed text struck through in place, the replacement in
a dashed accent card below it, labelled "incoming · waiting for approval" while a permission request is open (approve/reject from
the rail, or from the phone). When the folder watch reports the write, the file is re-read and the document is *patched* — a line
diff (`diff` package) becomes one CodeMirror transaction, so cursor, scroll and undo history survive — with the inserted lines
washed in the accent for ~2.6 s, a thin red rule where lines were removed, and the first change scrolled into view unless the user
touched the editor in the last 1.5 s. Ghosts whose result is now on disk disappear. Completion updates also trigger a re-read
(the inotify burst can beat the ACP update or vice versa), and a reconnect re-reads every open file.

**Editing from the laptop.** `PUT /api/fs/file` (`WriteFileRequest`) saves with `expectedMtime` as the optimistic-concurrency
token: a stale value is a 409 `conflict`, never a clobber; writes go temp-file-and-rename so watchers (and the agent) never see a
half-written file. A disk change while the buffer is dirty raises a banner (take disk version / keep mine) instead of silently
replacing the user's text.

**Studio UI.** One zinc palette with the same single accent as the phone (`styles.css` tokens, light and dark), glass panels on a
dot-grid field, an explorer (git letters, a pulse on entries the agent just changed), tabs (sparkle = opened by the agent, dirty
dot, accent underline while a ghost is pending), the editor with a restrained mostly-monochrome syntax theme, a status line
("agent wrote +3 −1", live dot), a session rail (agent · status · elapsed, mode select, the activity feed with commands verbatim
and clickable file chips, permission and question cards with real buttons, a composer), a ⌘K palette (files — bounded crawl of
the repo — sessions and commands) and keyboard shortcuts (⌘S save, ⌘W close, ⌘B/⌘J panels). Preferences and the theme persist in
`localStorage`.
