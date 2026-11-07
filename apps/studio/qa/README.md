# Studio QA (headless, token-free)

```
bash apps/studio/qa/daemon.sh          # scratch daemon on :4899 with the stub agent (MIDE_HOME=/tmp/mide-studio-test)
node apps/studio/qa/drive.mjs          # pairs a headless Chromium, runs the scenario, screenshots to /tmp/mide-studio-qa/shots
node apps/studio/qa/workflows.mjs      # creation, review forms, drafts, reconnect, keyboard focus, and narrow layouts
```

`drive.mjs` needs a Chromium binary (`CHROME=…`; defaults to Playwright's cache) and asserts: pairing from the launch URL, the
session appearing, the composer sending a prompt, the agent-opened tab, the ghost preview with struck-through text while the edit
waits for approval, Allow from the rail, the live wash on the written lines, the ghost disappearing, the new-file tab, the feed's
command and output, explorer pulses and git letters, the ⌘K palette finding the new file, a local edit + Ctrl-S landing on disk,
an external change applied live, the conflict banner, the light theme, and zero page exceptions. `cdp.mjs` is the ~80-line
DevTools-protocol driver (launch, navigate, evaluate, screenshot, keys). `MIDE_QA_AUTO_OPEN=true bash daemon.sh` turns the
launcher on so a real window pops up when `drive.mjs` creates its session.

`workflows.mjs` verifies task starters and custom-task preservation, inline creation failures and retry, a session's initial
prompt, required-answer validation, recorded answers, simultaneous questions and approvals, explicit always-allow confirmation,
literal permission input, session-specific message drafts, saved diffs, real WebSocket reconnect with draft retention, keyboard
focus trapping/restoration, and 390px panel navigation. It adds one comment to the scratch repo to make the diff check independent.
Both scenarios assert zero page exceptions; the workflow scenario also checks panels do not duplicate during live updates.

To isolate concurrent QA, set `MIDE_QA_HOME`, `MIDE_QA_REPO`, and `MIDE_QA_PORT` consistently for the daemon and driver. Set
`QA_CDP_PORT`, `QA_PROFILE`, and `OUT` separately for each browser run. Use scratch directories only: the daemon script replaces
its scratch config and stops any listener on the selected daemon port, and the browser driver replaces its profile directory.
