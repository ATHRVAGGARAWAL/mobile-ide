# Mobile workflow QA

The exported Expo app is exercised in headless Chromium against an isolated daemon, two temporary Git projects and the
scripted ACP agent. No real agent accounts or existing daemon state are used. The harness starts its own random port and
closes its browser, daemon and tmux sessions afterward; the scratch projects and screenshots remain for inspection.

From the repository root, after building core and exporting the mobile app:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core node --import tsx apps/mobile/qa/drive.mjs
```

`PLAYWRIGHT_MODULE` points to an existing Playwright Core installation (or omit it when the package is resolvable locally).
`CHROME` selects an installed Chromium executable; by default the script finds a Linux headless-shell build in Playwright's
cache. `MIDE_QA_OUT` optionally sets the screenshot/results directory. Git, tmux and ripgrep must be available.

The scenario covers pairing error/retry, Settings drafts and theme persistence, responsive navigation, task creation,
simultaneous approvals and questions, required answers, literal permission input and always-allow confirmation, draft
preservation, stopping a turn, session search and workflow starters. Workspace coverage includes live files, staged and
unstaged diffs, history, project isolation, content search, hidden files and real terminal input. It captures both themes,
320px/390px phone layouts and desktop layouts, and fails on browser page exceptions.

The stub fixture accepts `ask` for edit permission, `question` for a single-select form, `ask question` for both requests,
`slow` for longer pauses and `fail` for a refused turn. Cancellation is supported so stopping a task can be verified.

These browser checks do not exercise native iOS/Android keyboard, camera, clipboard or push-notification integrations.
