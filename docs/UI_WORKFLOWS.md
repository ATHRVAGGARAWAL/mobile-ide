# UI rewrite — September 2026

## Read and understand

Before implementation, four agents read the authored code, tests, configuration and documentation across the phone app,
Studio, daemon and core package. Generated builds, dependencies and binary assets were excluded from source review.
The initial workspace typecheck passed. A copy of the original project was saved in `/tmp/mobile-ide-ui-before-20260905.tar.gz`.

The daemon remains the source of truth. The UI must retain ordered replay, offline answers, exact permission inputs,
question validation, live filesystem updates, concurrent-save conflict handling and native keyboard/safe-area behavior.

## User workflows

| Workflow | Entry | Desired next action |
| --- | --- | --- |
| Connect a device | Pairing | Enter or paste the server and code, connect; setup help and device options are secondary. |
| Start work | Sessions / Studio | Describe the task, choose a project and agent, then start. Advanced configuration is optional. |
| Continue work | Sessions | Search by task or project, filter by status and reopen the conversation. |
| Answer an agent | Attention inbox / chat / Studio review | Distinguish approvals from questions, inspect the full input, submit an answer and follow its delivery state. |
| Inspect the workspace | Chat shortcuts / Files | Keep the project context while browsing, searching and viewing live files. |
| Review changes | Changes / Studio | Separate current changes from history; open staged or unstaged diffs with readable controls. |
| Use a shell | Terminal | See the selected project and connection, type with accessible accessory keys and recover a dropped connection. |
| Personalize and diagnose | Settings | Choose appearance, notifications or connection/device details without traversing one long page. |

## Shared design

Warm graphite in dark mode, paper in light mode, a single amber accent, quiet borders and clear typography. Color comes from
tokens. Primary actions and pending attention use amber; routine controls remain neutral. Destructive actions retain their
semantic color. Interactive controls have generous touch targets, visible keyboard focus and explicit labels.

Headers separate screen identity from project selection. Empty/loading/error states explain what to do next. Large text and
paths can wrap or truncate without forcing the page wider. Phone controls remain reachable above the keyboard and safe areas;
desktop panels adapt to narrower windows.

## Ownership and verification

- Main agent: shared mobile UI/theme, app shell, pairing, settings, branding and integration.
- Conversation agent: sessions, task creation, chat, approvals and questions.
- Workspace agent: files, changes, terminal, project selection and DOM rendering.
- Studio agent: desktop workspace, task creation, review queue and Studio QA.

Integration is verified: all four packages typecheck; core/daemon and Studio builds and the Expo web export pass. Core tests
pass 10/10; daemon tests pass 141 with 8 real-agent tests skipped. Studio passes 51 browser assertions and mobile passes 35,
using isolated daemon state and scripted agents. The browser scenarios exercise both themes, phone and desktop widths,
questions and approvals, draft retention, live files, project changes and terminal input. Studio also verifies reconnect,
local saves and external edit conflicts.

Integration review corrected Settings draft loss, custom Android dock keyboard handling, web ARIA states and text contrast.
Native iOS/Android keyboard, camera, clipboard and notification behavior still requires device verification. See
[mobile QA](../apps/mobile/qa/README.md), [Studio QA](../apps/studio/qa/README.md) and [STATUS.md](STATUS.md) for reproduction
and the distinction between current checks and earlier real-agent runs.
