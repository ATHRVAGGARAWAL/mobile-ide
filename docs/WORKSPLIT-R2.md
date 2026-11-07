# Round 2 — ten parallel owners (polish, completeness, proof)

Same rules as docs/WORKSPLIT.md: edit ONLY the files in your list (new files inside your own directories are fine), never run
`pnpm install` at the root unless a dependency is truly missing (`pnpm --filter <pkg> add <dep>` and report it), no git
state changes. Both packages currently typecheck clean and all tests pass (core 3/3, server 90/90, `expo export -p web` OK) —
keep it that way for your files. Read docs/STATUS.md first for what exists.

Headless browser for anyone who needs one (do not install anything): `require('/home/athrv/Desktop/docregister/node_modules/playwright-core')`
with `chromium.launch({ headless: true, executablePath: process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell' })`.
A reference driver from round 1 is at /tmp/mide-drive.js (reads /tmp/mide-test.env: PORT, WEBPORT, CODE, REPO). Serve the export with a tiny static server (SPA fallback) or reuse /tmp/mide-web-serve.js.

## Server
**R1 — Web app hosting + build pipeline** owns `apps/server/src/routes/static.ts` (new), `apps/server/src/http.ts` (mount only),
`apps/server/src/config.ts` (add `webApp: { dir: string | null }`), `apps/server/src/doctor.ts` (one row), root `package.json` scripts,
`docs/RUNBOOK.md`. Serve the exported Expo web build from the daemon so `https://<laptop>.ts.net/` opens the app: resolve
`config.webApp.dir` → else `<repo>/apps/mobile/dist` when the daemon runs from the repo (detect via `import.meta.url`) → else
`~/.mobile-ide/www`. Static files with correct MIME, `Cache-Control: no-cache` for `index.html`/`manifest`/`sw.js` and immutable for
hashed `_expo/` assets; SPA fallback to `index.html` for non-`/api`, non-`/ws` GETs that accept HTML (so `/pair#CODE` and `/session/<id>`
work); keep the existing JSON 404 for API paths; the round-1 HTML landing pages become the fallback only when no web build exists.
Root scripts: `build` also runs `pnpm --filter @mobile-ide/app run export:web`; add `"dev": ...` note. `mide doctor` row: web app
dir present + index.html age. RUNBOOK step 5: "open https://<laptop>.<tailnet>.ts.net/ in Safari → Add to Home Screen → open it → enter the code".
Verify with curl (index, an asset, a deep path, an API 404, `/ws` untouched).

**R2 — Durability proofs** owns `apps/server/test/e2e-permissions.test.ts`, `apps/server/test/e2e-restart.test.ts`,
`apps/server/test/e2e-crash.test.ts` (new) and fixes in `apps/server/src/sessions.ts`, `apps/server/src/app.ts`, `apps/server/src/db.ts`
only. (a) Permission round-trip with a real agent: run OpenCode with `OPENCODE_CONFIG_CONTENT` set to a JSON config that requires
approval for shell/edit tools (find the exact `permission` schema in OpenCode 1.18 docs or `opencode --help`/config schema at
https://opencode.ai/config.json), prompt "Run the shell command `echo hi` and tell me its output", assert a `permission.requested`
event arrives with the literal command in `rawInput`, answer via WS `permission.respond` allow_once, assert the turn completes and the
DB permission row is resolved; also test reject. (b) Restart: startServer → session → prompt → close server → startServer on the same
`home` → assert sessions list intact, events replay identical, a new prompt works (session/load or new-with-note) and `seq` continues.
(c) Adapter crash: after a session exists, SIGKILL the adapter child pid (find it via the host), assert `session.error` + status, then a
new prompt respawns the host and succeeds. Each test ≤ 2 tiny prompts. Skip cleanly when opencode is missing.

**R3 — Claude + Codex adapters** owns `apps/server/src/agents/*`. Run the e2e flow against `claude` and `codex` via the existing
`MIDE_TEST_AGENT` switch (one tiny prompt each; Claude uses the user's Azure proxy env; Codex via codex-acp bundled Codex reading
~/.codex/config.toml — if it cannot authenticate, set `CODEX_PATH=/home/athrv/.local/bin/codex` in the agent env in your test run and
document which works). Fix normalization/host gaps for those adapters (thought chunks, tool_call rawInput shapes for Bash/Edit,
permission option kinds, config options/model lists, stop reasons, usage). Add fixtures to `apps/server/test/fixtures/` (captured
real `session/update` payloads with secrets stripped) and unit tests in `apps/server/test/unit-adapters.test.ts` (new).

**R4 — Terminal quality (both sides)** owns `apps/server/src/terminal.ts`, `apps/mobile/app/(tabs)/terminal.tsx`,
`apps/mobile/src/components/terminal/*`, `apps/mobile/src/dom/TerminalView.tsx`. Server: `tmux set-option -t <session> status off`
(and `-g`? no, per session) so the status bar never renders on the phone; `mouse on`; 256-color/`TERM=xterm-256color`; resize
propagation. App: header must not truncate ("T..") — drop the tab title when the project chip is shown or use a compact layout;
key row horizontally scrollable with fade hint; font size setting (persisted); copy selection / paste button; WebGL → DOM renderer
fallback with a one-time toast; reconnect keeps scrollback; input focus after tapping keys (verify on web with the headless browser).

**R8 — Notifications end-to-end** owns `apps/server/src/notify.ts`, `apps/server/src/routes/push.ts`, `apps/server/test/notify.test.ts`
(new), `apps/server/src/cli.ts` (add `mide vapid` only). Test ntfy against a local fake HTTP server (assert Title/Tags/Click headers and
body), Expo push payload shape (fake exp.host), Web Push send via `web-push` against a fake endpoint and pruning on 404/410;
`mide vapid` generates and stores VAPID keys in config if absent (and the daemon auto-generates on first run when missing, logging once).
Dedupe window and trigger rules (permission always; turn_done only when > 20 s or any tool ran; error) covered by unit tests.

## Mobile
**R5 — Files + Changes polish** owns `apps/mobile/app/(tabs)/files.tsx`, `apps/mobile/app/file.tsx`, `apps/mobile/src/components/files/*`,
`apps/mobile/app/(tabs)/changes.tsx`, `apps/mobile/src/components/changes/*`, `apps/mobile/src/dom/DiffView.tsx`, `apps/mobile/src/dom/CodeView.tsx`.
Hide `.git` always and dotfiles by default with a "Show hidden" toggle (persisted); sort dirs first, natural order; long path
middle-truncation; folder git status roll-up; file viewer: wrap default on for prose, off for code, line numbers, sticky header with
path, "Open in Changes" when modified; diff sheet opens at 90% height with per-hunk collapse and a word-wrap toggle; large diff
truncation notice with "load full"; pull-to-refresh everywhere; skeleton loaders instead of spinners.

**R6 — Sessions + Chat polish** owns `apps/mobile/app/(tabs)/index.tsx`, `apps/mobile/app/session/[id].tsx`, `apps/mobile/src/components/chat/*`,
`apps/mobile/src/components/sessions/*`, `apps/mobile/src/components/ui/Toasts.tsx`. Toasts must not cover the large title (bottom
placement above the tab bar/composer, or top with safe-area offset and header awareness); chat empty state ("Send your first prompt"
plus 3 suggested prompts relevant to the repo: "Summarize this repo", "Run the tests", "What changed recently?"); assistant messages get a
subtle agent label + timestamp on long-press with Copy; tool cards show duration live; a sticky "Needs your approval" banner when a
permission is pending off-screen; composer grows to 6 lines then scrolls; send button disabled state clear; haptics guarded; unread dot
logic verified; session row swipe on native, long-press everywhere.

**R9 — Pair + Settings + native readiness** owns `apps/mobile/app/(auth)/pair.tsx`, `apps/mobile/app/(tabs)/settings.tsx`,
`apps/mobile/src/lib/notifications.ts`, `apps/mobile/src/lib/webpush.ts`, `apps/mobile/app.json`, `apps/mobile/eas.json`, `apps/mobile/assets/*`,
`apps/mobile/README.md`. Pair: QR scan button on native (expo-camera is NOT installed — only add it if `npx expo install expo-camera`
works without touching other packages; otherwise leave a clear "type the code" flow), paste-from-clipboard button, server URL history.
Settings: "Test connection", "Check for daemon update" (compare `/api/health` version to app), notification section explains each
channel with status; theme picker (system/dark/light); about. Generate real icon/splash PNGs programmatically (Node + `sharp` if present
in node_modules, else write SVG and rasterize with the headless browser) — a simple monochrome glyph on the theme background, 1024².
Fill `extra.eas.projectId` guidance in README (run `eas init`).

**R10 — Repo docs + dev ergonomics** owns `CLAUDE.md` (new, repo root), `README.md`, `docs/ARCHITECTURE.md` (new), `scripts/dev.sh` (new),
`.editorconfig`, `.prettierrc` (no reformatting of existing files). CLAUDE.md: layout, commands (build/typecheck/test per package,
`mide` CLI), conventions (core is the contract; zod at boundaries; no React in core), how to run e2e safely (costs tokens), how to add an
agent. ARCHITECTURE.md: module map of apps/server (each file, one line), event flow diagram (ASCII), WS protocol summary, DB schema,
security model, deployment topology. `scripts/dev.sh`: starts the daemon (dev, tsx) and `expo start --web` together with one Ctrl-C.

## Phase B (after all ten): visual QA + review lenses. Phase C: fix + final verification.
