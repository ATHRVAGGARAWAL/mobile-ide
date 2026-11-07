# @mobile-ide/studio — the Studio

The laptop-side live editor for mobile-ide: a desktop-class web app the daemon serves at `/studio/` and pops open in a dedicated
browser app-window the moment a session starts. It follows the agent through your code — files open as the agent touches them, an
announced edit is drawn in place (struck-through old text, the replacement in a dashed card) before it lands, and the written lines
glow when the file changes on disk. Approve tool calls, answer questions, send prompts and edit/save files from the laptop too.

The workspace uses warm graphite and paper themes with an amber accent. Start directly from **New session**: choose a Build,
Fix, or Review starting point, project, agent, optional model, and task. Activity keeps the conversation in order; Review keeps
every unresolved approval and question together, plus the project's changed files. Form answers and message drafts stay with
their own requests and sessions while you navigate. Offline state is a banner, and sending resumes when the connection returns.

Files has a Changes view; choosing a change opens its working-tree or staged diff beside the agent. Code remains editable with
the existing safe-save and conflict flow. Narrow windows use Files / Editor / Agent navigation, with pending-request counts.
Dialogs trap keyboard focus and restore it on close; editor tabs and panel dividers also work from the keyboard. Earlier activity
can be loaded in batches, and a Latest updates button returns to the newest event after scrolling back.

- **Stack:** React DOM 19, CodeMirror 6 (`@codemirror/language-data` for lazily loaded languages), zustand, `diff`, `@mobile-ide/core`
  for the protocol, the timeline reducer and the reconnecting `MideClient`. No React Native, no Expo. Bundled by esbuild
  (`build.mjs`, ESM + code splitting) into `dist/` with hashed asset names; `dist/index.html` is generated from `src/index.html`.
- **Build:** `pnpm --filter @mobile-ide/studio build` (or the root `pnpm build`); `… dev` rebuilds on change (scripts/dev.sh runs
  it); `… typecheck`. The daemon reads `dist/` straight from disk, so a rebuild is live on reload.
- **Auth:** the launch URL carries a one-time pairing code in its fragment (`#pair=CODE&session=ID`); the page pairs itself once
  (device "Studio · <OS> <browser>") and keeps the token in `localStorage`. `mide studio --no-open` prints such a URL.
- **Layout:** `src/state/store.ts` (state) + `src/state/controller.ts` (every mutation: connection, follow logic, watches, file
  loads/saves, live reloads); `src/editor/*` (CodeMirror view registry, theme, live-change + ghost decorations);
  `src/components/*` (title bar, explorer, editor pane, session rail, command palette, toasts); `src/styles.css` (design tokens for
  both themes — components never hard-code colours).
- **QA without tokens:** `qa/` holds a CDP driver for a headless Chromium and a scripted scenario that pairs a window, starts a
  session against the stub agent (`apps/server/test/fixtures/stub-agent.ts`), approves an edit, and asserts the ghost → live-wash →
  new-file → save → conflict flow with screenshots. `qa/workflows.mjs` covers creation, questions, review, drafts, reconnect,
  keyboard focus, and responsive layouts. See `qa/README.md`.
