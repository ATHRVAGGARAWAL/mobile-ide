# CLAUDE.md — working in this repository

mobile-ide lets you drive coding agents (Claude Code, Codex, OpenCode — anything that speaks the Agent Client Protocol) from an
iPhone: a Node daemon (`mide`) on the dev machine owns the agent sessions and persists every event; an Expo app (iOS + web/PWA)
is a thin, resumable client; the Studio (`apps/studio`) is the laptop's live editor — served by the daemon at `/studio/`, popped
open in a browser app-window when a session starts, showing files change as the agent edits them. Read `docs/STATUS.md` first (what exists and is verified), then `docs/ARCHITECTURE.md` (how it
fits together). `docs/PLAN.md` explains the decisions, `docs/SERVER_SPEC.md` / `docs/APP_SPEC.md` the intended behaviour,
`docs/RUNBOOK.md` the operator steps. If a `docs/WORKSPLIT*.md` names owners for a round that is in progress, edit only the
files listed under your name.

## Layout

```
packages/core        @mobile-ide/core  — the contract: zod wire protocol, REST path table, timeline reducer, reconnecting
                     WS client. No React / React Native imports. Built to dist/ (both apps import the build).
apps/server          @mobile-ide/server — the `mide` daemon (Node ≥ 22.13, ESM). src/ modules, test/ (node:test + tsx),
                     bin/mide.js → dist/cli.js.
apps/mobile          @mobile-ide/app — Expo SDK 57 + Expo Router. app/ routes, src/{state,components,dom,lib,theme}.
apps/studio          @mobile-ide/studio — the Studio: React DOM + CodeMirror 6, esbuild (build.mjs → dist/, served at /studio/).
                     src/{state,editor,components}, styles.css (tokens), qa/ (headless Chromium scenario + stub-agent daemon).
deploy/systemd       mobile-ide.service (user unit).
scripts/dev.sh       dev loop: core build + daemon (tsx watch) + `expo start --web`, one Ctrl-C.
docs/                PLAN, STATUS, ARCHITECTURE, SERVER_SPEC, APP_SPEC, RUNBOOK, WORKSPLIT*.
```

The repo path contains a space (`/home/athrv/mobile ide`) — quote it in every shell command. pnpm 11 workspace with
`nodeLinker: hoisted` (one flat `node_modules` at the root, required by Metro). Node 24 is what this machine runs.

## Commands

| What | Command |
|---|---|
| Install (once; never run casually — other people/agents may be mid-edit) | `pnpm install` |
| Build core + daemon, the Studio bundle, then export the web app to `apps/mobile/dist` | `pnpm build` (`pnpm build:server`, `pnpm build:studio`, `pnpm build:web`) |
| Typecheck / test everything | `pnpm typecheck` · `pnpm test` |
| Dev loop (daemon under `tsx watch` + Expo web, pairing link printed) | `pnpm dev -- [flags]` or `scripts/dev.sh [--no-watch] [--port N] [--app-port N] [--home DIR] [--server-only] [--app-only] [--no-pair]` |
| core | `pnpm --filter @mobile-ide/core build \| typecheck \| test \| dev` (`dev` = `tsc --watch`) |
| server | `pnpm --filter @mobile-ide/server build \| typecheck \| test \| dev` (`dev` = `tsx src/cli.ts serve`) |
| server, any command against scratch state | `MIDE_HOME=/tmp/mide pnpm --filter @mobile-ide/server exec tsx src/cli.ts doctor` |
| app | `pnpm --filter @mobile-ide/app typecheck \| web \| export:web \| doctor` (`cd apps/mobile && npx expo start --web`) |
| studio | `pnpm --filter @mobile-ide/studio build \| dev \| typecheck` (`dev` = esbuild watch; the daemon serves `dist/` live) |
| studio QA (no tokens) | `bash apps/studio/qa/daemon.sh && node apps/studio/qa/drive.mjs` (scratch daemon + stub agent, headless Chromium, screenshots) |
| daemon CLI (after `pnpm build`; link with `ln -sf "$PWD/apps/server/bin/mide.js" ~/.local/bin/mide`) | `mide serve` · `mide pair [--name X]` · `mide devices [--revoke ID]` · `mide vapid` · `mide terminals [--kill ID]` · `mide studio [--session ID] [--no-open]` · `mide doctor [--json]` |

Build order matters: the server and the app import `@mobile-ide/core` from `packages/core/dist` (package `exports`), so after
touching core run `pnpm --filter @mobile-ide/core build` before typechecking, testing or starting the others. `scripts/dev.sh`
does that for you. State lives in `~/.mobile-ide/` (`config.json`, `mide.db`, optional `env` for systemd); `MIDE_HOME`
redirects it — use a temp dir whenever you experiment.

Environment knobs: `MIDE_HOME`, `MIDE_LOG=debug|info|warn|error`, `MIDE_DRAIN=cancel` (cancel instead of waiting for turns on
shutdown), `MIDE_DRAIN_MS` (default 60000). The daemon logs one JSON object per line to stdout.

## Conventions

- **core is the contract.** Every wire type is a zod schema in `packages/core/src/protocol.ts`, every REST path is in
  `packages/core/src/api.ts`. Server and app import them and never redefine or widen them locally. To add a field: change core,
  rebuild it, then both sides. Additive changes only unless you bump `PROTOCOL_VERSION`.
- **zod at the boundaries, trust inside.** HTTP bodies go through `parseJsonBody(c, Schema)` (`routes/util.ts`), WS frames through
  `ClientFrame.parse`, the client parses `ServerFrame`, config through `ConfigSchema`, stored events are re-validated on read.
  Inside a process, typed values are trusted; do not sprinkle re-validation.
- **No React in core.** `packages/core` compiles with `types: []` and `lib: [ES2022, DOM]` (DOM only for the WebSocket types); it must
  keep working in Node, browsers and React Native.
- **ESM everywhere.** Relative imports in core and server end in `.js` (NodeNext); tests run the TS sources through `tsx`.
- **Strict TypeScript.** `strict` + `noUncheckedIndexedAccess`; no `any` — take `unknown` and narrow (`isRec`, `asString` helpers
  in `normalize.ts`); a non-null `!` needs a reason in a comment.
- **Event log rules** (`apps/server/src/sessions.ts`): `SessionManager` is the only writer. `append` = insert into SQLite (assigning
  the next dense `seq`) *then* `bus.emitEvent`. Anything the phone must see is an event, never a side channel, so replay reproduces
  the exact timeline. Events are immutable once written.
- **Agents never reach the UI raw.** ACP `session/update` payloads are normalized in `apps/server/src/agents/normalize.ts` — pure and
  lenient (odd payloads yield `null`, never throw). Adapter quirks are fixed there, not in components.
- **Permissions show the real command.** `PermissionRequest.rawInput` is carried verbatim from ACP to the phone and rendered in a
  monospace block; never summarize it away on the server. The app may *add* to it (a rendered diff, a relative title) but never
  drops it — the raw JSON stays one tap away.
- **Elicitations are permissions' twin.** ACP `elicitation/create` (Claude Code's `AskUserQuestion`, MCP forms, URL hand-offs) is
  persisted in `elicitations`, emitted as `elicitation.requested` / `elicitation.resolved`, answered over `elicitation.respond`, and
  validated with core's `validateElicitationContent` on both sides. The daemon advertises `clientCapabilities.elicitation
  { form, url }` — claude-agent-acp disables `AskUserQuestion` without it.
- **Every path is checked.** Client-supplied roots/paths go through `resolveRoot` / `resolveUnder` (`paths.ts`); ACP
  `fs/read_text_file` / `fs/write_text_file` are confined to the session cwd (`agents/host.ts`); `fs.watch` frames and
  `PUT /api/fs/file` use the same two functions.
- **The disk is a side channel.** `fs.changed` (`fswatch.ts`: directory watches, non-recursive, shared, coalesced, capped) is never
  written to a session's event log; replay reproduces the timeline, not the filesystem. Clients watch *directories* (rename-safe),
  never files.
- **Studio.** No React Native; only `@mobile-ide/core` + React DOM + CodeMirror. Every mutation goes through
  `src/state/controller.ts`; colours come from the tokens in `styles.css` (same warm neutrals + amber accent as the phone, light and dark);
  the editor's live path is `Doc.version` (disk content replaced) → minimal CodeMirror changes + `addLive` decorations, and
  `pendingEdits` → ghost decorations. The launcher (`apps/server/src/studio.ts`) must never throw and must never open a second
  window while a `mide-studio` client is connected.
- **Errors at the boundary.** Throw `HttpError` subclasses (`errors.ts`); `routes/util.ts` maps them (and zod / fs errors) to
  `{ error, code }`. Never let anything throw out of the `upgrade` listener or a bus listener.
- **Logging.** `createLogger({ mod })` and `log.info('dotted.event_name', { fields })`; no `console.log` in the server. Stack traces
  only at debug level (`errorInfo`).
- **Mobile.** Build screens from `src/components/ui` and `useTheme()` tokens (`src/theme.ts`; no hard-coded colours). The palette is
  monochrome with one accent (`ACCENT` in `src/theme/palette.ts`): `warning` *is* the accent, `success`/`info` are neutral tones, only
  `danger` adds a second hue — do not introduce new colours in components. State in the
  zustand stores under `src/state`, DOM components (`'use dom'` files in `src/dom`) stay thin: props in, callbacks out. Guard
  native-only modules with `Platform` so `npx expo export -p web` keeps working. Long lists use FlashList with stable keys. Every
  network action shows inline state; connection loss is a banner, not a modal.
- **Formatting.** 2 spaces, single quotes, semicolons, trailing commas, `(x) =>`, lines up to ~140 columns (`.editorconfig`,
  `.prettierrc`). Prettier is not installed and the tree was never bulk-formatted: format only files you changed
  (`npx prettier@3 --write <files>`) and never reformat files you did not touch — it destroys the review diff. Markdown is
  hand-formatted (prettier would re-pad every table); do not run it over docs.
- **Docs.** `docs/STATUS.md` is the source of truth for what exists and was verified — update it when you finish something.
- **Git.** Do not commit, branch or push unless asked; `main` has no commits yet.

## Running tests — and what costs money

- Free: `pnpm --filter @mobile-ide/core test`, `apps/server/test/unit*.test.ts` (incl. `unit-studio.test.ts`: watch registry,
  `fs.watch` frames, PUT, hosting, launcher), `apps/server/test/terminal.test.ts` (needs tmux; `MIDE_SKIP_TERMINAL_TESTS=1` to skip),
  `pnpm --filter @mobile-ide/app typecheck`, `expo export -p web`, `pnpm --filter @mobile-ide/studio typecheck && build`, the Studio QA
  (`apps/studio/qa/`, stub agent), and `mide doctor` (it only sends ACP `initialize`, no tokens).
- **Costs real tokens** through the user's own accounts: every `apps/server/test/e2e*.test.ts` boots a real daemon and runs one tiny
  agent turn ("Reply with exactly the word PONG…") against OpenCode by default. `MIDE_TEST_AGENT=claude|codex` runs the same flow
  against those adapters. `e2e-elicitation.test.ts` always uses Claude Code (one `AskUserQuestion` turn; skips when `claude` is not
  on PATH). `MIDE_SKIP_AGENT_TESTS=1 pnpm --filter @mobile-ide/server test` runs the whole suite without any agent.
- Rules: keep prompts tiny and count them (≤ 2 per scenario, never in a loop); never point tests at the real `~/.mobile-ide` —
  use `startServer({ home: tmpdir, overrides: { port: 0, projects: { roots: [tmpRepo] } } })` and `await close()` in `after`;
  keep `--test-concurrency=1` (agents, tmux and ports are shared); `MIDE_E2E_VERBOSE=1` streams daemon logs when debugging.
- Manual smoke without touching real state: `MIDE_HOME=$(mktemp -d) scripts/dev.sh --port 4821 --app-port 8082` (add
  `BROWSER=none` in a headless session), open the printed pairing link.
- Agent adapters are spawned in their own process groups; a hard kill of a test can orphan them — check `pgrep -af 'acp|opencode'`.

## How to add an agent

Any ACP v1 agent works with configuration alone — the daemon only needs stdio ndjson JSON-RPC with `initialize`, `session/new`,
`session/prompt`, `session/update` notifications and `session/request_permission` (optional: `session/load`, `session/cancel`,
`session/set_mode`, `elicitation/create` + `elicitation/complete`, model config options, the terminal capability,
`fs/read_text_file` / `fs/write_text_file`).

1. Add it to `~/.mobile-ide/config.json` and restart:
   ```jsonc
   "agents": { "gemini": { "name": "Gemini CLI", "command": "npx", "args": ["-y", "some-acp-adapter@1.2.3"], "env": {}, "customModels": [], "enabled": true } }
   ```
   `env` is layered over the daemon's environment (an empty string removes a variable); `customModels` extends the model picker;
   `enabled: false` hides it. Pin adapter versions in `args`. `mide doctor` grows an `Agent: <name>` row that spawns it and calls
   `initialize` (free); `GET /api/agents` and the new-session sheet pick it up automatically.
2. To make it a built-in default: `defaultAgents()` in `apps/server/src/config.ts` (mirror the sample in `apps/server/README.md` and
   `docs/SERVER_SPEC.md`); `AGENT_BINARY` in `apps/server/test/e2e.test.ts` so `MIDE_TEST_AGENT=<id>` knows which binary to require;
   a colour branch in `agentColor()` (`apps/mobile/src/theme.ts`) if the badge should not be neutral.
3. Check the normalization against real traffic: `cd apps/server && npx tsx test/fixtures/capture.ts <id> --out test/fixtures/<id>.json`
   records ONE prompt through the real adapter (costs tokens; temp paths and secret-looking env values are stripped). Add a case
   to `test/unit-adapters.test.ts`, and extend `agents/normalize.ts` only where the adapter's shapes differ (tool `kind`, `rawInput`
   for shell/edit tools, permission option kinds, stop reasons, usage).
4. Run the e2e once with `MIDE_TEST_AGENT=<id>` and record the result in `docs/STATUS.md`.
