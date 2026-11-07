# Status — 2026-11-04

## Laptop activity on the phone home screen — 2026-11-04

- Added **Active now** and **Last session & recent work** above the home workflows. Active cards include shared tmux
  terminals, native laptop Codex/Claude CLI processes and running/needs-you Mobile IDE chats. Open terminals are explicitly
  labelled as open, not assumed to be generating. Swipe the active row; filter recent work by Codex, Claude or Mobile IDE.
- Shared-terminal cards use the selected pane's current folder/command and preserve the exact terminal ID when opening the
  Terminal tab. A project refresh preserves this selection even if the scanner has not listed that folder. The user's
  `palakpaglu` Codex shell now appears under its current project rather than its original `mobile ide` folder.
- Authenticated `/api/activity` reads Codex's local SQLite thread index, Claude's bounded history index and live tmux/process
  metadata. It respects project roots/denylist, excludes Codex internal/archived threads, deduplicates native launchers and
  shared descendants, coalesces refreshes and isolates provider errors. The phone refreshes every eight seconds while focused
  and foregrounded, on return and on pull-to-refresh, with visible failure/stale-data messages.
- `/api/activity/history` shows up to 20 recent saved user/assistant messages from bounded transcript tails; tool/reasoning
  payloads are omitted and transcript paths are confined to provider storage. Claude falls back to saved prompts when its
  transcript is absent (the current laptop has prompts but no Claude project transcripts). These are read-only views;
  native terminals started outside Mobile IDE cannot be attached retroactively. Local provider formats may change, and
  native process detection currently uses Linux `/proc`. History retains up to 12 sessions per provider.
- Verified all package and server-test typechecks, 183 passing tests (15 core, 165 server, 2 Studio, 1 mobile; 8 paid-agent
  tests skipped), including 10 activity tests for auth, filtering, current cwd/terminal identity, native-process deduplication,
  both transcript formats, missing transcripts, malformed/oversized logs, provider failures and symlink confinement.
  Full production build passed and the daemon was restarted with `KillMode=process`; all five shared shells survived,
  including `palakpaglu`'s Codex pane with its original PID. Public health/home and the new home bundle return 200; activity
  correctly requires authentication (401 without a token). Live metadata checks found both providers' history. Browser automation is unavailable;
  phone visual/device QA remains unverified.

## Phone photo attachments — 2026-11-04

- Chat's attachment button now exposes **Gallery** and **Files**, with previews and removal before sending. Both sources
  share resizing/conversion, a four-photo limit, a 20 MB source limit and a 5 MB prepared-photo limit. Unsupported files
  produce an error; cancelling a picker leaves the draft intact. Added the SDK-matched `expo-document-picker` dependency.
- The Terminal tab has **Add photos**, the same source choices/previews, and **Upload & paste**. Photos upload to unique
  `.mobile-ide-uploads/<id>.<extension>` files in the selected project. Quoted absolute paths are pasted into the existing
  prompt without Enter. Retry reuses successful uploads; changing projects/shells prevents a late upload from pasting into
  another terminal. Disconnection retains the selection for retry.
- Added authenticated `POST /api/fs/image` with shared request/response schemas, bounded canonical base64, image signature
  checks, project/denylist enforcement, symlink checks and exclusive file creation. Uploads never overwrite project files.
- Verified all package/server-test typechecks, full production build and 173 tests (15 core, 155 server, 2 Studio, 1 mobile;
  8 paid-agent tests skipped), including real upload/readback, auth, MIME/size rejection, symlink confinement and literal
  terminal-path quoting. Browser automation was unavailable; native iOS/Android pickers have not been exercised on a device.

## Desktop terminal sizing correction — 2026-11-03

- Removed the desktop client's `ignore-size` flag, which trapped Codex in the phone's 47×18 grid inside a 212×49 laptop
  window. Mirrored terminals now use tmux's `window-size largest`; the laptop fills its window, phone reconnects do not
  shrink it, and closing the laptop restores the phone-sized layout. A shared TUI has one grid; the phone displays a
  smaller viewport while the laptop is attached. Existing desktop clients are upgraded in place.
- Verified with a real tmux regression covering both viewport sizes, phone resize/reconnect, and laptop detach; 29 terminal
  and mirror tests pass, along with server/test typechecks and server build. Applied live to `palakpaglu`, keeping the same
  shell PID and Codex process running at 212×49.

## Laptop mirrors for phone work — 2026-11-03

- Studio opens on new sessions and resumed turns. With automatic following enabled, an existing Studio also switches to
  an older task when its next turn starts, without switching on every streamed update or approval response.
- Added opt-in `terminal.autoOpen` and enabled it on this laptop alongside `studio.autoOpen`. Phone terminal attachments open
  Ptyxis (or GNOME Terminal/Konsole/xterm) on the same tmux session. The shared shell follows the largest attached window.
  Concurrent requests, reconnects and daemon restarts do not create duplicate terminal windows.
- The systemd unit uses `KillMode=process`: the daemon still shuts down agent groups and terminal clients explicitly, while
  tmux servers/shells and desktop windows survive the service restart. An ungraceful daemon crash can leave child processes
  to clean up manually; this setting intentionally preserves independent terminal work.
- Live verification: opened the existing `palakpaglu` Codex shell and confirmed phone and desktop clients share its tmux
  session. Its shell PID and running Codex process survived the daemon restart; the phone reattached without a second desktop window.
- Verified all package typechecks, server test typecheck, server/Studio builds and 167 tests (15 core, 150 server, 2 Studio;
  8 paid-agent tests skipped). Desktop mirroring was checked through tmux's client registry; browser visual QA was unavailable.

## Project picker refresh — 2026-11-03

- Confirmed `/home/athrv/elc` is discovered as a Git project on `main`; it has no Mobile IDE sessions yet.
  The Sessions home screen lists sessions, not every project on disk.
- The shared Files/Changes/Terminal project picker now refreshes on every opening, keeping the existing list visible while
  loading. Previously it only loaded once, so repositories added later could remain missing until a manual refresh or reload.
- Verified mobile TypeScript and production web export; the updated build is served by the running daemon.

## Service recovery and connection reliability — 2026-11-02

- Restored the installed daemon: `mobile-ide.service` was disabled and inactive while the Cloudflare tunnel was running.
  Enabled startup and restarted the service; linger was already enabled. The tunnel unit now also requests the daemon at startup.
- Repaired the installed OpenCode 1.18.27 executable from the same npm package version. The previous executable was incomplete
  (110,738,706 bytes) and crashed before ACP initialization; its backup remains alongside the repaired binary.
- Both clients now recover from stalled WebSocket opens (10 seconds) and unanswered heartbeats (10 seconds after a ping).
  Recovery does not wait for a dead socket's close handshake; late callbacks from retired sockets are ignored, pending requests
  are rejected, and session/file subscriptions resume on the replacement connection. Repeated `connect()` calls are idempotent.
- Mobile shows **Retry now** during reconnection and clearer offline guidance. `mide doctor` warns about a stopped daemon or
  an enabled-but-inactive unit instead of presenting those conditions as healthy. Recovery instructions are in the runbook.
- Verified: all four package typechecks, server test typecheck, full production build (server, Studio, mobile web), 15 core tests,
  143 server tests passed with 8 real-agent tests skipped, and systemd unit validation. All three agents initialize successfully;
  no paid agent turns were run. Local mobile/Studio pages and entry assets return HTTP 200; public health and both pages return 200.
  Browser automation was unavailable, so visual and native-device QA were not performed in this pass.

## Built and verified
- Exposure without Tailscale (2026-09-03): hostel/campus Fortinet firewalls block Tailscale's control server and relays (the
  laptop shows `offline`, the phone cannot reach the ts.net URL). Verified working alternative: a Cloudflare quick tunnel
  (`cloudflared tunnel --url http://127.0.0.1:4820`) with `publicUrl` set to the trycloudflare.com URL — two devices paired and
  chatting through it. For a stable URL on an owned domain: `scripts/cloudflare-tunnel.sh <hostname>` (named tunnel, DNS route,
  `~/.cloudflared/config.yml`, `publicUrl`/`trustProxy`, `deploy/systemd/cloudflared-mide.service`, daemon restart, health check) —
  run end-to-end on this machine for `https://ide.athrv.dev` (zone athrv.dev): tunnel `mobile-ide` created, CNAME routed, four QUIC
  connections registered, `cloudflared-mide` user unit enabled + active, linger on, `/api/health` answers 200 through Cloudflare.
  `mide doctor` treats a non-ts.net https `publicUrl` as OK instead of warning about `tailscale serve`.
- `packages/core` — protocol (zod), REST path table (now incl. `/api/terminals`), timeline reducer (incl. elicitations, the
  waiting-for-approval state of gated tool calls and diffs borrowed from permission requests), reconnecting `MideClient` with
  per-session resume, shared elicitation validators. Tests 10/10.
- `apps/server` — `mide serve | pair | devices | vapid | terminals | doctor`. Hono REST (pairing, devices, agents, projects, sessions,
  events replay, permissions, fs tree/file/search, git status/diff/log, push register/test/vapid, terminals list/kill, health),
  `ws` protocol with SQLite-backed replay, ACP agent hosts (OpenCode native, Claude and Codex adapters) with normalization, durable
  permissions, durable elicitations (ACP `elicitation/create`: Claude Code's `AskUserQuestion`, MCP forms, URL hand-offs) and turn
  intents, tmux-backed terminals over `/ws/terminal`, notifier (ntfy / Expo / Web Push, VAPID keys generated on first start),
  graceful drain, post-listen space reclaim, systemd unit. The daemon also hosts the exported web app at `/` (`routes/static.ts`: MIME,
  ETag/304, brotli/gzip compressed once per file into a bounded cache, SPA fallback for `/pair#CODE` and `/session/<id>`,
  `frame-ancestors 'none'`), so `https://<laptop>.<tailnet>.ts.net/` opens the app and "Add to Home Screen" installs it.
  Tests: 154/154 with a real OpenCode, a real Claude Code and tmux (`unit`, `unit-adapters`, `unit-sessions`, `terminal`, `e2e` +
  `e2e-permissions` / `e2e-restart` / `e2e-crash` / `e2e-elicitation`); `MIDE_SKIP_AGENT_TESTS=1` reports 140 (132 run, 8 skipped) with
  tmux only, `MIDE_SKIP_AGENT_TESTS=1 MIDE_SKIP_TERMINAL_TESTS=1` 140 (131 run, 9 skipped) without any agent or tmux.
  `mide doctor`: 20 rows with the three default agents (17 fixed + one per enabled agent); all three answer ACP `initialize` in 1–2 s
  on this machine.
- Durability, proven by tests: permission round-trip with a real agent in a restrictive mode (`e2e-permissions.test.ts`: the literal
  command arrives in `rawInput`, allow and reject both complete the turn and resolve the DB row); daemon restart with the sessions
  list intact, identical replay and continuing `seq` (`e2e-restart.test.ts`, including the exact boot recovery order); adapter SIGKILL
  → `session.error` + status, next prompt respawns the host (`e2e-crash.test.ts`).
- Claude Code and Codex adapters: real `session/update` traffic captured once each (`test/fixtures/claude-agent-acp.json`,
  `codex-acp.json`, recorded with `fixtures/capture.ts`) and replayed through the normalizer and the core reducer in
  `unit-adapters.test.ts` (thought chunks, Bash/Edit `rawInput`, permission option kinds, `_meta` terminal output, usage/cost,
  late `session_info_update` titles).
- `apps/mobile` — Expo SDK 57 + Expo Router: Pair (paste/QR/server history), Sessions (needs-you inbox, grouped list, swipe/long-press
  actions), New session (agent/project/mode/model, collapsible model list), Chat (FlashList timeline, streaming markdown, tool cards
  with live duration and a waiting-for-approval state, diff/plan/thought cards, permission sheet with the verbatim command and the
  rendered change, elicitation card + sheet (chips/radio/checkbox/text/number/toggle fields, URL hand-off with host preview), sticky
  approval banner, composer with `/` and `@` suggestions, image attach, stop, mode selector, empty state with starter prompts), Files (tree with hidden-file toggle,
  natural sort, git roll-up, search with windowed excerpts, viewer with wrap/line numbers/text size, "Open in Changes"), Changes
  (status, unified diff sheet with per-hunk collapse and wrap, log), Terminal (xterm WebGL→DOM fallback, key row, font size,
  copy/paste, reconnect, new/close shell), Settings (server test/update check, per-channel notification status, theme, about,
  forget). Typecheck clean; `expo export -p web` and `expo-doctor` (21/21) succeed; every screen was driven end-to-end in headless
  Chromium against a live daemon serving the export (round-2 visual QA, both themes).

## Workflow UI rewrite — 2026-09-05

Four agents reviewed all authored source, tests, configuration and documentation before implementation. Mobile and Studio
now use warm graphite/paper themes, an amber accent, clearer typography and responsive navigation. The interaction plan and
ownership are in [UI_WORKFLOWS.md](UI_WORKFLOWS.md).

- Sessions: editable workflow starters, task-first creation, search and status filters, readable session cards and a unified
  question/approval inbox. Chat keeps follow-up drafts during a turn, blocks concurrent sending, retains exact permission
  options/input and uses explicit confirmation for always-allow decisions.
- Workspace: one project selection across Files, Changes and Terminal; Browse/Search and Review/History views; live file
  feedback; readable diff controls; explicit shell state and focused shell confirmations. Async results are isolated by
  project/file so old content cannot appear under a newly selected project.
- Pairing and Settings: the connection form comes first, with optional setup/device details; Settings separates Appearance,
  Notifications and Connection while retaining unfinished fields across category switches. Dark/light text contrast, web
  ARIA control states, keyboard focus, touch targets and Android dock hiding were addressed in integration review.
- Studio: Build/Fix/Review task creation, responsive Files/Editor/Agent panels, Activity/Review queue, saved-file diffs,
  session-specific drafts, accessible dialogs and existing live edit/save/conflict behavior.

Verified on the production web builds with isolated daemon state and the stub agent:

| Check | Result |
| --- | --- |
| TypeScript | Core, server, mobile and Studio pass. |
| Production builds | Core/daemon, Studio and Expo web export pass. |
| Core tests | 10 passed. |
| Daemon tests (`MIDE_SKIP_AGENT_TESTS=1`) | 141 passed, 8 real-agent tests skipped, 0 failures; includes real tmux. |
| Mobile browser workflows | 35 passed, 0 page exceptions; pairing/retry, Settings drafts, themes, task/attention flows, search, stop, live files, diffs/history, two-project isolation and terminal input. |
| Studio browser scenarios | 51 passed (26 live-editor checks + 25 workflow checks), 0 page exceptions; includes reconnect, approvals/questions, safe saves and conflict handling. |
| Visual inspection | Mobile at 320/390/1280px and Studio at 390/1480px; both themes. |

Reproduce browser checks using [mobile QA](../apps/mobile/qa/README.md) and [Studio QA](../apps/studio/qa/README.md).
Native iOS/Android keyboard, camera, clipboard and push integrations were not exercised on a device in this pass. No real
agent turns or deployment were performed. The package manifests and lockfile are unchanged.

## Review round 1 (4 lenses, 15 findings, all fixed)
Crash on malformed upgrade URL; ACP fs access confined to session cwd; process-group kill for npx-wrapped adapters and agent
commands; bounded WS send buffers; host respawn after JSON-RPC close; pairing rate limit no longer trusts client X-Forwarded-For
(`trustProxy` config); IPv6 origin check; stale subscription set after reconnect; server error frames separated from state
changes; request timeout 90 s; FlashList cell-recycling expand state; sheet vs keyboard; optimistic pending count; throttled
markdown re-render while streaming.

## Round 2 (ten owners, then visual QA + review lenses, then this fix pass)

### Added in round 2
Web app hosting from the daemon with a `Web app` doctor row and `pnpm build` exporting the app; durability e2e suites (above);
Claude/Codex fixtures + adapter unit tests; terminal quality (tmux status bar off, mouse on, 256 colours, resize propagation,
scrollable key row, font size, copy/paste, renderer fallback toast); notifications end-to-end (`mide vapid`, auto-generated VAPID keys,
ntfy/Expo/Web Push send paths, 404/410 pruning); Files/Changes polish (hidden files, sorting, middle-truncated paths, git roll-up,
viewer prefs, diff sheet at 90 %, pull-to-refresh, skeletons); Sessions/Chat polish (toast placement registry, empty chat, agent
label + timestamp, live tool durations, approval banner, six-line composer); Pair/Settings/native readiness (icons, splash, EAS notes);
repo docs (`CLAUDE.md`, `ARCHITECTURE.md`, `scripts/dev.sh`).

### Fixed in the round-2 review pass (38 findings)
Server:
- Agent-suggested titles are persisted and emit `session.renamed` (`SessionManager.patchSession` accepts `title`; `title_source` column:
  `default` → `prompt` → `agent`, `user` titles are locked). A session started without a title or first prompt is renamed from its first
  prompt, so the new-session placeholder is true and the chat header no longer prints the folder name twice.
- `boot()` never ends a finished turn twice (checks the log for `turn.ended` before replaying an interruption); the turn-intent
  completion chain has a `.catch`; `shutdown()` cancels the permission requests it is still awaiting before draining, so a session
  parked in `needs_you` no longer holds the stop for the full drain.
- `AgentHost.beginTurn` resets the runtime when `turn.started` cannot be persisted (no more wedged sessions / never-settling drain
  promises); `ensureSession` memoises in-flight recovery per session (two concurrent recoveries could unroute a running turn);
  agent-terminal records are dropped after their grace period (and immediately on shutdown), bounded per session, and reaped even
  for a superseded process generation.
- Notifier: `permission` is exempt from the 10 s dedupe (every distinct request buzzes) and the window only starts after a successful
  delivery; notifications carry `permissionId` (Click URL `/session/<id>?permission=<pid>`), and the app opens the sheet on tap.
- Web app: `Content-Security-Policy: frame-ancestors 'none'` + `X-Frame-Options: DENY` on every static/SPA/landing response;
  brotli/gzip results are cached per (file, size, mtime, encoding) with a shared in-flight compression, so repeated unauthenticated
  GETs of the bundles no longer cost a fresh compression each.
- `MIDE_HOME` is always denylisted for `/api/fs` (config.json holds the VAPID private key); auto-generated VAPID keys go to the config
  file that was actually loaded (`-c <path>`), so restarts no longer break Web Push subscriptions; the upgrade-failure log line no
  longer includes `?token=`; a device-supplied ntfy `server` must be https (or http on a loopback/private/tailnet host), with no
  credentials/query/fragment and never link-local.
- Terminals are reclaimable: `GET /api/terminals`, `DELETE /api/terminals/:id`, `mide terminals [--kill <id>|--kill-all]`, and a
  "Close shell" action in the app. Closed sessions are pruned after `limits.closedSessionRetentionDays` (default 30) at boot, followed
  by a WAL checkpoint (and VACUUM when something was deleted); the doctor's Database row shows size incl. WAL.
App:
- Tab bar labels no longer clip (56 px content height, 22 px icons, 11/14 labels). Composer: short running placeholder, a single
  Stop control, focus ring on the rounded box (also `TextField`). Project chips in the Files/Changes headers take the header's spare
  width and only truncate the name. Search excerpts are windowed around the match. File viewer: middle-truncated name, wrap icon
  shared with the diff sheet. Empty Sessions screen shows one CTA. Project picker and session menu show middle-truncated paths.
  Interactive chips reach a 44 pt target; the thought disclosure announces show/hide; code blocks no longer capture drags.
- Toasts: every tab registers a focus-aware anchor, toasts never render under the keyboard, two lines max, stale toasts leave on
  navigation; copy actions inside sheets close the sheet first (terminal) or confirm inline (diff patch).
- Settings: "Send test notification" is disabled until a channel is registered (the daemon's `no_subscriptions` maps to an info
  toast); the ntfy channel is bound to the device id, so a re-pair shows "Register again" instead of a false "Registered", and the
  button is never dead while a topic is present.
- New session / Pair pad for the iOS web keyboard; a long model list collapses behind "+N more"; a failed `subscribe` (purged session,
  DB error) ends the loading state with a message and Retry instead of spinning forever, and other server error frames surface as toasts.

### Verified (this pass)
`pnpm --filter @mobile-ide/core build && test` (3/3); `pnpm --filter @mobile-ide/server typecheck && build && test` (148 tests, real
OpenCode e2e included, 0 failures — the full suite ran once, then `e2e-restart` once more after its shutdown assertion was tightened); `pnpm --filter @mobile-ide/app typecheck`; `expo export -p web`; `expo-doctor` 21/21. A scratch
daemon serving the export was probed over HTTP: brotli index/bundle with `Content-Length`, second request served from the cache,
`ETag` → 304, SPA fallback and landing pages carry the frame headers, `/api/terminals` lists an adopted tmux session and `DELETE`
kills it (404 afterwards, 400 for a bad id, 401 without a token), ntfy servers on link-local / plain-http public hosts are refused.

## Round 3 (elicitation builder, then a visual QA + review pass of the approval flow, then this fix pass)

### Added in round 3
ACP elicitation end to end (`docs/ARCHITECTURE.md` §14): core `ElicitationRequest`/`ElicitationSchema`/`ElicitationContent`, events
`elicitation.requested` / `elicitation.resolved`, client frame `elicitation.respond`, reducer item kind `elicitation` with `needs_you` while
anything is pending, shared `validateElicitationContent` / `elicitationDefaults`; the daemon advertises `clientCapabilities.elicitation
{ form, url }` (claude-agent-acp 0.73.0 only enables `AskUserQuestion` with it), persists every request in the `elicitations` table before
the phone hears about it, notifies (kind `permission`, never deduped), validates form answers, closes url flows the agent finishes itself
(`elicitation/complete`), and cancels open ones on `session/cancel`, close, shutdown and boot; the app renders `ElicitationCard` /
`ElicitationSheet` / `ElicitationForm` (Send answer · Skip · Dismiss = accept · decline · cancel, optimistic + offline outbox) and counts
questions in the Needs-you badge (`SessionSummary.pendingPermissions` + `pendingElicitations`). `test/e2e-elicitation.test.ts` proves it
with ONE real Claude Code turn (the question arrived 8.6 s in as `question_0` ∈ {Red, Blue} + a free-text `question_0_custom`; the
answer "Blue" was accepted, the turn ended `end_turn` with "You answered Blue", replay == live stream).

### Fixed in the round-3 review pass (19 findings + one latent bug they exposed)
Server:
- `ntfyServerProblem` parses the host instead of string-matching one literal: `http://[::ffff:169.254.169.254]/` (which WHATWG URL
  serializes as `::ffff:a9fe:a9fe`) and every other IPv4-mapped / long-form spelling of a link-local address are refused
  (`routes/origin.ts` `isLinkLocalHost`).
- `sessions.title_source` is backfilled in `migrate()` (folder-named rows `default`, anything else `user`), so a title typed before the
  upgrade is never overwritten by the agent's first suggestion; the read-time guess is gone. `prompt()` decides the first-prompt rename
  on the row as it is *after* `beginTurn()` (a rename or agent title landing during an adapter spawn is no longer clobbered).
- No `VACUUM` on the boot path: the database runs `auto_vacuum = INCREMENTAL` (new files; older ones convert at their next VACUUM) and
  `SessionManager.maintain()` — scheduled right after `listen()` — releases pruned pages in place, falling back to a whole-file VACUUM
  only when an old file wastes ≥ 16 MB or a fifth of its size.
- Notifier dedupe reserves the (session, kind) key *before* the fan-out and releases it when nothing was delivered, so three turns ending
  while ntfy is slow buzz once, and a total failure still never silences the follow-up.
- `HEAD` on the web app negotiates the same encoding as `GET` (same ETag, `Content-Encoding`, the cached compressed length once known),
  so a HEAD-derived `If-None-Match` revalidates instead of missing forever.
- Sessions-list previews keep assistant text parts apart when a tool call / thought / question interrupts them
  ("…no output for it. Created `hello.txt`…").
- OpenCode's Edit tool never carries its diff (only the permission request does): the core reducer now shows a request's diff blocks on
  the gated tool card and keeps them across the completion update that replaces `content` with "Wrote file successfully."; tool items
  gated by an open request are `awaitingPermission`, and `startedTs` is stamped at the approval so durations mean run time.
App:
- Edit/write permissions: `filepath` is a recognised path key, the change text is left out of the details (the diff is rendered instead —
  a unified-diff string in `rawInput` is rendered through `DiffView` when no diff block exists), the sheet shows the diff *before* the
  literal input, titles are relative to the project with the folder as a caption, `oldText: ''` is labelled "New file", and the inline
  card summarizes "hello.txt +1 −0 new file" instead of 30 lines of escaped JSON; "Show full input" always reveals the complete raw
  input (nothing is ever dropped, only moved one tap away).
- Tool cards: "Waiting for approval" (hand icon, no spinner, no ticking timer) while a permission is open; the frozen duration is the
  command's run time; a location equal to the cwd (OpenCode reports it for every shell command) is neither counted as a file nor offered
  as a chip; `aria-expanded` on tool/thought/message disclosures (react-native-web maps `aria-*`, not `accessibilityState.expanded`).
- Latent bug exposed by the above: `snapshot()` shared the very same item objects across publishes, so `ToolCard`'s memo comparator
  compared a mutated object with itself and cards only refreshed thanks to the running timer's interval. Snapshots now shallow-clone
  items; the comparator works as designed.
- Tab bar labels really fit now: js-tabs pads each item by 5 px and wraps the icon in a 28 px box, so the 11/14 label had 9 px; the icon
  row is 24 px, the bar's own padding gone, item padding 3/1 — measured 14 px label boxes ending 9 px above the viewport bottom.
- Chat: the inline permission card no longer repeats the session title in its footer; the `needs_you` composer placeholder is one line at
  390 px; a stale `?permission=` / `?elicitation=` link (answered meanwhile) toasts "already answered" and scrolls to the card.
- Settings: the v1 → v2 store migration leaves `ntfyDeviceId` null (a v1 store cannot know which device registered the topic), so a
  re-paired device shows "Register again" instead of a false "Registered".

### Verified (this pass)
`pnpm --filter @mobile-ide/core build && test` (10/10); `pnpm --filter @mobile-ide/server typecheck && build && test` — the full suite
ran once with the real agents: 154 tests, 154 pass, 0 skipped, 62 s (OpenCode `e2e` / `e2e-permissions` / `e2e-restart` / `e2e-crash`,
Claude Code `e2e-elicitation`, real tmux); `MIDE_SKIP_AGENT_TESTS=1` 140 (132 run, 8 skipped); `pnpm --filter @mobile-ide/app typecheck`;
`expo export -p web`; `expo-doctor` 21/21. Headless Chromium (390×844, both themes, 21 checks each — `/tmp/mide-shots-r3fix`, driver and
stub in `_run/`) drove the export from a scratch daemon with a stub ACP agent replaying OpenCode's recorded bash/write shapes: tab labels
14 px inside the viewport; "Waiting for approval" with no timer, then `403ms` after a 6 s wait; no cwd chip; footer without the title;
short placeholder; `aria-expanded`; the edit card's diff summary; sheet order (NEW FILE → PATH), relative title + folder caption, "Show
full input" revealing the patch; the completed Edit card rendering the borrowed diff; the list preview "I'll create the file. Created
`hello.txt`…"; the stale-link toast; zero page errors.

## Round 4 (header under the status bar, monochrome restyle)

### Fixed
- **Chat header cut off / doubled space at the top and bottom (iOS home-screen web app).** Two causes. (1) `useWebKeyboardInset`
  treated any `innerHeight − visualViewport.height` band ≥ 40 px as a keyboard; standalone iOS reports the two a status bar apart at
  times, so the composer was lifted and the page sat scrolled. The band now counts only while a `textarea`/`input`/contenteditable has
  focus and is ≥ 100 px, the hook listens to `focusin`/`focusout`, and it pins `scrollTo(0, 0)` whenever the page is left scrolled.
  (2) On iOS 26.x the installed web app's page is 390×797 on a 390×844 screen with `env(safe-area-inset-top/bottom)` = 47/34
  (numbers read off the device via Settings → About): the page still starts under the status bar, so the 47 pt top inset is
  real, while iOS keeps the missing 47 pt at the *bottom* for the home-indicator band and still reports a 34 pt bottom inset —
  padding by it doubled the space under the composer. `src/lib/safeArea.ts` (`useSafeInsets` / `useSafeTop` /
  `measureWebViewport`) measures env itself, trusts the top value and drops the bottom one when the height iOS kept
  (`screen.height − innerHeight`) already covers it. `Screen`, `SessionHeader` (+10 pt so the title clears the glass edge), the
  chat composer, the tab bar, `Sheet` and `Toasts` use it; native is unchanged. Settings → Appearance has a web-only
  "Screen edges" control (`safeArea`: Auto · None · Top · Both, persisted) that forces a layout should a future iOS move the
  bands again; Settings → About shows `Viewport` and `Safe area` rows and the diagnostics copy includes them. (A first attempt
  that padded by the measured env value, then one that assumed the reserved band was at the top, both made it worse — hence
  the readout.)
- **Composer jumped while typing (web).** Every keystroke collapsed the textarea to 0 px to re-measure `scrollHeight`, and
  changing a focused field's height makes iOS scroll it into view; the field now reads `scrollHeight` as is while text grows and
  only collapses to shrink after deletions. The keyboard hook also re-measures and pins the page every frame for ~450 ms after
  focus changes, so iOS's own "scroll the field above the keyboard" and our padding settle in one motion instead of two hops.

- **Keyboard opened and closed again at once on every text field (web).** react-native-web's `ScrollView` calls
  `dismissKeyboard()` (blurs the focused element) on *every* scroll event when `keyboardDismissMode="on-drag"` — it cannot tell a
  drag from a layout scroll (`react-native-web/dist/exports/ScrollView/index.js:244`). The keyboard opening shrinks the viewport,
  the list emits a scroll, the field is blurred, the keyboard closes; the per-frame keyboard padding above made it deterministic.
  `KEYBOARD_DISMISS_ON_DRAG` (`src/lib/platform.ts`) is `none` on web and `interactive` / `on-drag` on iOS / Android; used by
  `TimelineList`, the pairing screen, the new-session sheet and file search.

### Restyled (monochrome, one accent)
- `src/theme/palette.ts` is now a zinc-neutral scale with a single accent (`ACCENT`: `#f97316` dark / `#d9480f` light). The `ThemeColors`
  keys are unchanged so every component still compiles: `success`/`info` resolve to neutral text tones, `warning` *is* the accent
  ("needs your attention"), `danger` is the only other hue (errors, destructive actions), diff add/del keep a muted green/red. Web shell
  (`+html.tsx`, `public/index.html`, manifest, `app.json`) backgrounds follow (`#09090b` / `#fafafa`). Radii tightened (8/12/16).
- `agentColor()` returns one neutral pair for every agent; `AgentBadge` is an outlined name chip / bordered initials tile.
  `statusColor()`: running + needs-you accent, error danger, everything else grey; `StatusChip` is dot + word, a filled pill only for
  running / needs you / error.
- `SessionHeader` rebuilt: back · title over one caption line "● Idle · Claude Code · project" · outlined mode chip · menu, on the page
  background with a hairline rule (no coloured badges). `ModeChip` outlined; user bubble is a quiet grey card with a hairline border;
  composer and `TextField` focus rings are neutral; `Button` `ghost` uses text colour, `success` is an inverted neutral (white-on-black
  in dark) so the accent stays for attention; `Card`/`Banner` info/success tones are neutral, warning is accent-soft; tab badge, plan
  progress, tool spinners and "waiting for approval" use the accent; terminal key row `armed` uses `--on-accent`.

### Verified (this pass)
`pnpm --filter @mobile-ide/app typecheck`; `expo export -p web` (to `/tmp/mide-web-export`); headless Chromium 390×844 screenshot of the
exported pairing screen (`/tmp/mide-shots-r4/pair-dark.png`) renders the neutral palette with the single orange accent, no page errors.
The safe-area rule is derived from the device readout above (env 47/34, reserved 47, page under the status bar) and still needs a
look on the phone after this build; the composer fix is reasoned from iOS behaviour, not measured.

## Round 5 (the Studio — the laptop's live editor)

### Added in round 5
- **`apps/studio` (`@mobile-ide/studio`)**: a desktop-class second client of the daemon (React DOM 19 + CodeMirror 6 + zustand +
  `@mobile-ide/core`; esbuild ESM bundle with lazily loaded languages, 2.3 MB across 252 files, ~190 kB brotli for the entry), served
  at `/studio/` and opened by the daemon in a dedicated browser app-window when a session starts. Explorer (git letters, pulse on
  agent-changed entries), tabs (sparkle = agent-opened, dirty dot, accent underline while an edit is pending), editor with a
  monochrome-plus-accent syntax theme, status line, session rail (agent · status · elapsed · mode · Follow files; activity feed with
  commands verbatim, clickable file chips, +N −M per edit; permission and question cards with real buttons; composer with Stop),
  ⌘K palette (files via a bounded crawl, sessions, commands), ⌘S/⌘W/⌘B/⌘J, resizable panels, light/dark, glass panels on a dot
  grid with the phone's zinc + single-accent palette (`docs/ARCHITECTURE.md` §15).
- **Two-phase live edits**: a `tool.call` with a diff opens the file and draws a *ghost* (old text struck through in place, the
  replacement in a dashed accent card, "waiting for approval" while a permission is open); when the write lands the document is
  patched in place from a line diff (cursor/scroll/undo survive), the inserted lines wash in the accent for 2.6 s, a red rule marks
  removals, the first change scrolls into view unless the user touched the editor in the last 1.5 s. Ghosts whose text is on disk
  disappear; completed edits and reconnects re-read the file.
- **Live filesystem in core + daemon**: `fs.watch` / `fs.unwatch` / `fs.changed` frames (directory watches, non-recursive, shared and
  reference-counted, 40 ms coalescing, caps 96/client and 1024/daemon, same path policy as `/api/fs`), `MideClient.watchDir/unwatchDir`
  re-established on reconnect. Not part of the session log (side channel like terminal bytes).
- **Checked writes**: `PUT /api/fs/file` (`WriteFileRequest`) with `expectedMtime` → 409 `conflict` on a stale token, temp-file +
  rename, `createDirs`; `FileContent.mtime`. The Studio's ⌘S; a disk change while dirty is a banner (take disk / keep mine).
- **Launcher**: `studio.ts` — `session.created` → app-mode window (Chromium-family native or Flatpak, Firefox, `xdg-open`; `studio.browser`
  override; own `--user-data-dir` and `--class=mide-studio` for native installs), unless a `mide-studio` client is connected
  (it follows the new session itself) or one was launched < 20 s ago; display from the daemon env or `systemctl --user
  show-environment`; one-time 3-minute pairing code in the URL fragment, redeemed by the page and kept in `localStorage`.
  `mide studio [--session id] [--no-open]`, `POST /api/studio/open`, `mide doctor` *Studio* row, config `studio.{autoOpen,browser,dir,windowSize}`.
- **Hosting**: `routes/static.ts` generalized to sites (`webAppSite`, `studioSite`): `/studio` → 301 `/studio/`, hashed
  `assets/*-HASH.*` immutable, JSON 404 for missing assets, a 503 "not built yet" page (never the phone app) when the bundle is missing.
- **Phone**: the file viewer watches its folder and re-reads the file when the agent writes it ("Updated just now" chip); session
  menu → *Open in Studio*.
- **Dev/QA**: `pnpm build` bundles the Studio; `scripts/dev.sh` runs `build.mjs --watch` (`--no-studio` to skip);
  `test/fixtures/stub-agent.ts` (scripted ACP agent: text, read, gated Edit that really writes, new-file Write, shell command);
  `apps/studio/qa/` (CDP driver + 24-check scenario); `test/unit-studio.test.ts`.

### Verified (round 5)
`pnpm --filter @mobile-ide/core build && test` (10/10); `pnpm --filter @mobile-ide/server typecheck && build && test` with
`MIDE_SKIP_AGENT_TESTS=1 MIDE_SKIP_TERMINAL_TESTS=1`: 149 tests, 140 pass, 9 skipped, 0 fail (incl. the new `unit-studio`: watch
registry coalescing/sharing/`gone`, `fs.watch` round trip + policy + unwatch, PUT atomic/409/create/403/401, `/studio` redirect +
missing page, `POST /api/studio/open` reasons, `--no-open` mints a redeemable code, launcher argv per browser kind);
`pnpm --filter @mobile-ide/app typecheck`; `pnpm --filter @mobile-ide/studio typecheck && build`. Headless Chromium (Playwright's
1234, 1480×920) drove the built Studio against a scratch daemon with the stub agent — `apps/studio/qa/drive.mjs`, 24/24 checks, zero
page exceptions, screenshots in `/tmp/mide-studio-qa/shots`: pairing from the launch URL, agent-opened tab, ghost with struck-through
text while waiting for approval, Allow from the rail, live wash on +3 −1, ghost gone, new-file tab, feed command + output, explorer
pulses + git letters, palette finds `src/greet.ts`, local edit + Ctrl-S on disk, external append applied live, conflict banner →
take disk version, light theme. On this desktop: `MIDE_HOME=<scratch> mide studio` opened Brave (Flatpak) in app mode, the window
paired itself (`pair.success` "Studio · Linux Brave"), said hello as `mide-studio`, subscribed and watched the repo; after a daemon
restart it reconnected on its own; a session created while it was connected logged `studio.auto_open.skipped (a studio is connected)`
and the window followed the new session. `mide doctor` shows `Studio  OK  …/apps/studio/dist (repo checkout, built N min ago) · flatpak
com.brave.Browser (app window) · wayland wayland-0 · auto-open on`.

### Not yet exercised (round 5)
- A live turn with a real agent in the Studio (the stub replays Claude Code's Edit/Write shapes: absolute paths, `oldText`/`newText`
  diff blocks, `rawInput.file_path`). Codex/OpenCode edit shapes flow through the same normalizer and the core reducer's
  `approvalDiffs`, so the ghost path is expected to work; not observed live.
- Auto-open from a *headless* daemon (systemd unit without a display): the `systemctl --user show-environment` path is implemented
  and doctor-reported, not run under the unit on this machine.
- The Flatpak app window shares Brave's default profile (no `--user-data-dir` through the sandbox); a native Chrome/Chromium gets the
  dedicated `mide-studio` profile and window class.

## Not yet exercised
- Native iOS build (needs Apple Developer Program; see RUNBOOK step 7): push registration, keyboard-controller, haptics, image picker,
  the native key row / toast anchors on device.
- Live Claude/Codex turns beyond the one-prompt fixture capture and the one-prompt elicitation proof (`MIDE_TEST_AGENT=claude|codex` runs
  the same e2e).
- The post-fix approval-flow QA used a stub agent replaying OpenCode's recorded shapes; the real-OpenCode run (`OPENCODE_CONFIG_CONTENT`
  with `permission.bash/edit: 'ask'`) is what produced the round-3 findings and was not repeated after the fixes. The xterm WebGL canvas
  renders blank in headless screenshots — a capture artifact (`--disable-gpu` shows the DOM renderer working).
- Elicitation url mode with the agent finishing first (`elicitation/complete` closing a pending request as accept by `agent`), multi-select
  / number / boolean fields and required-field errors are covered by unit tests and typecheck only; the browser QA used the shape
  claude-agent-acp emits (single select + optional free text).

## Known follow-ups
- Workspace pins TypeScript 5.9; Expo 57 prefers 6.x (excluded from `expo-doctor` version check).
- Dev-only require cycle between `state/sessions.ts` and `state/connection.ts`.
- Per-session event logs of *open* sessions are never trimmed (only closed sessions are pruned); a long-lived session keeps its full
  history on disk by design (replay correctness).
- Channels are not re-registered automatically after pairing again; Settings shows which ones need it.
- Questions whose details have been replayed appear directly in the Needs-you inbox. An unopened session whose question has
  not been replayed still uses a per-session fallback until opened (`GET /api/permissions/pending` returns permissions only).
- Databases created before round 3 stay in `auto_vacuum = NONE` until a full VACUUM converts them, which `maintain()` only runs once the
  waste is worth it (≥ 16 MB or a fifth of the file).
