# Work split — ten parallel owners

Each owner edits ONLY the files listed under their name (plus new files inside their own directories). Read
docs/PLAN.md, docs/SERVER_SPEC.md or docs/APP_SPEC.md, packages/core/src/*, and the existing modules you depend
on BEFORE writing code. Import from `@mobile-ide/core` for every wire type. Do not run `pnpm install` unless a
dependency is missing; if so, add it with `pnpm --filter <pkg> add <dep>` and say so in your report.
Your package may not typecheck as a whole until the integrator wires everything; make YOUR files type-correct
against the contracts below (run `pnpm --filter <pkg> typecheck` and read only errors in your files).

## Server (`apps/server`) — contracts in `src/context.ts`, auth in `src/authn.ts`
Existing modules you build on (do not rewrite): `config.ts`, `db.ts`, `events.ts`, `sessions.ts` (SessionManager),
`agents/*` (AgentHost/AcpProcess/normalize), `projects.ts`, `git.ts`, `fsapi.ts`, `notify.ts`, `paths.ts`, `auth.ts`, `log.ts`, `errors.ts`.

**S1 — HTTP routes** owns `src/http.ts`, `src/routes/*.ts`. Export `createHttpApp(ctx: ServerContext): Hono<AuthedEnv>`.
All REST routes from core `API` with the shapes in core `protocol.ts` and behaviour in SERVER_SPEC "HTTP". Bearer auth
middleware via `authn.authenticate` (exempt: `GET /api/health` unauthenticated subset, `POST /api/pair`). Map
`HttpError` subclasses and zod errors to JSON `{error, code}`. Rate-limit pairing 5/min/IP (in-memory).
`POST /api/push/test` sends via `ctx.notifier`. `GET /api/health` full response when authed.

**S2 — WebSockets** owns `src/ws.ts`. Export `attachWebSockets(server, ctx)` per `AttachWebSockets`. One
`WebSocketServer({ noServer: true, perMessageDeflate: false })`; handle `server.on('upgrade')` for `/ws` and
`/ws/terminal` (anything else → 404 + destroy). Auth with `authn.credentialsFromRequest` + `authenticate`; on failure
respond HTTP 401 and destroy (clients see close 4401 only if the handshake completed — so do the handshake then
`close(4401)` when the token is present but invalid; refuse handshake when no token). Echo `selectedSubprotocol`.
Origin check per spec. `/ws`: full ClientFrame/ServerFrame protocol: hello→welcome; subscribe → replay
`ctx.sessions.events(id, afterSeq, batch)` in batches then `replay.done`, then live via `ctx.bus.onEvent` filtered
by subscriptions (guard against gaps: after replay, re-check `db.lastSeq` and replay the delta before going live);
`sessions.watch` → `sessions.changed` now + on `bus.onSessionsChanged` (debounce 200 ms); prompt/cancel/
permission.respond/set_mode → `ctx.sessions.*` → `ack`. Server ping 25 s, drop after 2 missed. `/ws/terminal?id&cwd&cols&rows`:
resolve cwd through `ctx.policy`, `ctx.terminals.attach`, binary frames ⇄ pty, text JSON `{type:'resize'}`; send
scrollback first; detach on close.

**S3 — Terminal** owns `src/terminal.ts`. Export `class TerminalManager implements TerminalManagerLike` with
constructor `(opts: { shell: string; tmuxPrefix: string; log: Logger })`. tmux session `<prefix>-<id>` created with
`tmux new-session -A -d -s <name> -c <cwd> -x <cols> -y <rows>` (validate id: `^[a-zA-Z0-9_-]{1,64}$`), attach via
`@lydell/node-pty` spawning `tmux attach-session -t <name>` with the given size; multiple attaches to the same id
share the tmux session (each attach = own pty). `scrollback()` = `tmux capture-pane -p -S -2000 -t <name>` (last 20 KB).
`kill` = `tmux kill-session`. Fallback when node-pty fails to load: `child_process.spawn('script', ['-qfc', 'tmux attach…', '/dev/null'])`
with a logged warning; `doctor()` reports which path is active. Unit-test `terminal.ts` with a real tmux if present (`test/terminal.test.ts`).

**S4 — CLI + bootstrap + ops** owns `src/app.ts`, `src/cli.ts`, `src/doctor.ts`, `src/index.ts`, `deploy/systemd/mobile-ide.service`,
`apps/server/README.md`. `app.ts` exports `startServer` per `StartServer`: load config, open Db, build EventBus,
GitService, ProjectScanner, PathPolicy (`buildPolicy`), Notifier, SessionManager (read its constructor), TerminalManager,
`createHttpApp`, `@hono/node-server` `serve({fetch, port, hostname})` obtaining the `http.Server`, `attachWebSockets`,
`sessions.boot()` then `prewarm()` in background; return `RunningServer` whose `close` stops sockets, drains sessions
(`sessions.shutdown`), `terminals.shutdown`, `db.close`. `cli.ts` (commander): `serve`, `pair [--name] [--ttl]`
(direct DB access with `db.createPairingCode`; print code, URL `<publicOrLocalUrl>/pair#<code>`, QR via qrcode-terminal),
`devices [--revoke id]`, `doctor`. SIGINT/SIGTERM → `close({drainMs: 60000, cancelTurns: process.env.MIDE_DRAIN==='cancel'})`.
`doctor.ts`: the checks in SERVER_SPEC (node version, each agent ACP initialize via `AcpProcess` with 20 s timeout,
tmux/rg/git/tailscale presence, `tailscale serve status`, linger, DB writable, node-pty load). Write the systemd unit
exactly as specified.

**S5 — Tests** owns `test/*.test.ts` except `test/terminal.test.ts`. `test/unit.test.ts`: normalizeUpdate on sample ACP
payloads (agent_message_chunk, tool_call with diff content, tool_call_update, plan, permission options), paths policy
traversal cases, token hashing/constant-time compare, `extractToken` cases. `test/e2e.test.ts`: uses `startServer`
with `home: tmpdir`, `overrides: { port: 0, host: '127.0.0.1', projects: { roots: [tmpRepo] } }` (check how config
overrides work in `config.ts`), mints a pairing code via `ctx.db.createPairingCode`, pairs over HTTP, then the OpenCode
flow in SERVER_SPEC "Tests" using the core `MideClient` (Node 24 has global WebSocket) — prompt
"Reply with exactly the word PONG and nothing else." Assert ordered seqs, replay equality, fs/git endpoints, health.
Skip (not fail) with a clear message when `opencode` is not on PATH or `MIDE_SKIP_AGENT_TESTS=1`. Use `--test-concurrency=1`.

## Mobile (`apps/mobile`) — Expo Router; existing: `src/components/ui/*`, `src/dom/*`, `src/state/*`, `src/lib/*`, `src/theme*`
Read `src/state/sessions.ts` (timelines, outbox, subscribe/ensure helpers), `src/state/api.ts` (typed REST), `src/state/connection.ts`
(MideClient lifecycle), `src/components/ui/index.ts` (the UI kit: Screen, Text, Button, Chip, StatusChip, Sheet, TextField, ListRow,
Card, EmptyState, Banner, Toasts…), `src/dom/*` (MarkdownView, DiffView, CodeView, TerminalView DOM components — `'use dom'`),
`src/lib/*`. Use them; do not fork them. All screens: dark/light via `useTheme()` tokens, loading/empty/error states, safe areas.

**M1 — App shell** owns `app/_layout.tsx`, `app/+html.tsx`, `app/index.tsx`, `app/+not-found.tsx`, `app/(auth)/_layout.tsx`,
`app/(auth)/pair.tsx`, `app/(tabs)/_layout.tsx`, `app/(tabs)/settings.tsx`, `src/lib/links.ts`, `src/lib/notifications.ts`,
`src/lib/webpush.ts`. Root layout: ThemeProvider, GestureHandlerRootView, KeyboardProvider (native only, guarded), fonts,
`bootstrapConnection()`, Toasts host, status bar. `index.tsx` redirects to `(auth)/pair` when not paired else `(tabs)`. Tabs:
Sessions (index), Files, Changes, Terminal, Settings with icons and a "needs you" badge from `useSessions`. Pair screen per
APP_SPEC (deep link `mobileide://pair?server=&code=`, web `?server=`/`#code`, standalone banner). Settings per spec incl.
push registration (`notifications.ts`: expo-notifications native only; `webpush.ts`: PushManager subscribe when standalone,
VAPID key from `/api/health` or settings), ntfy topic → `api.registerPush`, "Send test", forget server. Deep links
`mobileide://session/<id>` and `/session/<id>` (`links.ts` + `app.json` scheme already set).

**M2 — Sessions home + new session** owns `app/(tabs)/index.tsx`, `app/new-session.tsx`, `src/components/sessions/*`.
Per APP_SPEC "Sessions": header with server name + connection dot, "Needs you" list (uses `PermissionCard` from
`src/components/permissions` — contract below), grouped sessions (Running / Needs you / Idle / Error) with agent badge, title,
project, relative time, status chip, preview, unread dot (`useReadState`), pull-to-refresh, swipe/long-press → rename/close,
FAB → `new-session` modal: agent picker (`api.agents`, availability + reason), project picker (`useProjects`, recent + browse
via `api.fsTree`), title, mode (from agent info when available), first prompt → `useSessions.createSession` then `router.push`.

**M3 — Chat screen** owns `app/session/[id].tsx`, `src/components/chat/*` (TimelineList, UserBubble, AssistantMessage,
ThoughtBlock, ToolCard, PlanCard, TurnEnd, ErrorItem, JumpToLatest, Composer, SlashSuggestions, MentionSuggestions,
ModeSelector, SessionHeader, ImageAttachments). FlashList v2 with `maintainVisibleContentPosition`, stable keys (`item.id`),
render every `TimelineItem` kind; assistant markdown via `dom/MarkdownView` (streaming prop); tool card collapsed/expanded with
diff via `dom/DiffView`, terminal/output via `ui/CodeBlock`, locations → `router.push('/file?…')`; permission item renders
`PermissionCard` and opens `PermissionSheet` (M4 contract). Composer: multiline, `/` suggestions from `timeline.commands`,
`@` file search via `api.fsSearch`, image attach (expo-image-picker → base64 ImageBlock, downscale ≤1600px), send via
`useSessions.sendPrompt` (outbox handles offline), Stop → `cancel`. Header: title (rename), ModeSelector (`set_mode`), menu.
Mark read (`useReadState`) on view. Haptics on permission arrival/turn end.

**M4 — Permissions + Files** owns `src/components/permissions/*`, `app/(tabs)/files.tsx`, `app/file.tsx`, `src/components/files/*`.
CONTRACT (`src/components/permissions/index.ts`): `PermissionCard({ request: PermissionRequest; resolved?: {outcome, optionId?}; sessionTitle?: string; onPress(): void; compact?: boolean })`
and `PermissionSheet({ request: PermissionRequest | null; onClose(): void })` which itself calls `useSessions.respondPermission(sessionId, permissionId, outcome, optionId)`
(check the exact store method name) with optimistic state, shows the raw input verbatim in monospace (`stringifyInput`/`commandOf`
from `lib/format`), diff preview via `dom/DiffView`, buttons ordered allow_once, allow_always (confirm step), reject_once, reject_always.
Files tab: project picker (`useProjects`), breadcrumbs, `api.fsTree`, git status dots, search (`api.fsSearch`), file → `app/file.tsx`
(`api.fsFile`, `dom/CodeView`, wrap toggle, copy, jump to `?line=`, truncated notice).

**M5 — Changes + Terminal** owns `app/(tabs)/changes.tsx`, `app/(tabs)/terminal.tsx`, `src/components/changes/*`, `src/components/terminal/*`.
Changes: `api.gitStatus` (staged/unstaged sections, rename display), tap → `api.gitDiff` rendered by `dom/DiffView` (patch source),
whole-tree toggle, `api.gitLog` recent commits, pull-to-refresh, empty state. Terminal: wraps `dom/TerminalView` with
`wsUrl(serverUrl, API.wsTerminal)+?id&cwd&cols&rows`, token, project cwd from `useProjects`, stable per-project `id`
(persisted), accessory KeyRow (Esc, Tab, Ctrl modifier toggle, ⌃C, ⌃D, arrows, `|`, `-`, `~`) sending bytes through a
ref/imperative prop (extend `dom/TerminalView` props ONLY by adding optional props; coordinate by keeping existing ones),
reconnect button, status pill, fit on layout.

## Integrators (run after all ten)
**I-server**: make `apps/server` typecheck, `build`, and pass `test`; run the manual smoke in the old verify prompt; fix seams.
**I-mobile**: `pnpm --filter @mobile-ide/core build && pnpm --filter @mobile-ide/app typecheck && (cd apps/mobile && npx expo export -p web && npx expo-doctor)`; fix seams; confirm every route in APP_SPEC exists.
