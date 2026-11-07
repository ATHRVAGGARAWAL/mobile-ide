# mobile-ide

Drive your coding agents — Claude Code, Codex, OpenCode, anything that speaks the [Agent Client Protocol](https://agentclientprotocol.com) —
from your iPhone: send prompts, watch them stream, approve tool calls with the exact command in front of you, browse files and
diffs, open a terminal, and pick up where you left off after bad signal or a daemon restart.

The mobile app and desktop Studio share graphite/paper themes and an amber accent. Start with an editable task workflow,
handle approvals and questions in the review queue, then move between live files, changes and the terminal in the same project.
See [UI workflows](docs/UI_WORKFLOWS.md) for the design and [Status](docs/STATUS.md) for verification.

```
  iPhone  ──── Tailscale (WireGuard, HTTPS via tailscale serve) ────▶  your dev machine
  Expo app / installed PWA                                            mide serve  ── ACP over stdio ──▶  opencode · claude · codex
  ntfy for notifications                                              SQLite event log · files · git · tmux terminals
```

Why it is built this way (details in [docs/PLAN.md](docs/PLAN.md)):

- **Your agents, your billing.** The daemon runs the same `claude` / `codex` / `opencode` binaries with the same environment, so
  custom endpoints and proxies keep working. The vendors' own phone paths refuse that setup; this one does not care.
- **iOS cannot hold a socket in the background**, so the daemon owns every session and persists every event with a per-session
  sequence number. The phone resumes from the last sequence it saw; notifications wake you when an agent needs an answer.
- **$0 and no inbound ports.** The daemon binds to loopback; Tailscale provides the network and the certificate.

## Quick start (dev machine)

Requirements: Node 22.13+ (24 recommended), pnpm 11 (`corepack enable`), `git`, `tmux`, optionally `rg`, and whichever agents
you use (`opencode`, `claude`, `codex`) already installed and authenticated.

```bash
cd "/home/athrv/mobile ide"                # the path has a space — keep the quotes
pnpm install && pnpm build                 # core + daemon, then the web app export (apps/mobile/dist)
ln -sf "$PWD/apps/server/bin/mide.js" ~/.local/bin/mide
mide doctor                                # readiness table; agents answer ACP initialize (no tokens spent)
mide serve                                 # http://127.0.0.1:4820 — serves the web app at / and the API under /api
mide pair --name iPhone                    # one-time code + link + QR, in another terminal
```

Then follow [docs/RUNBOOK.md](docs/RUNBOOK.md): systemd user unit, `tailscale serve`, pair the phone, notifications, and the
native iOS build once you have an Apple Developer account.

## Development

```bash
pnpm dev                                   # = scripts/dev.sh: builds core, runs the daemon under tsx watch and
                                           #   `expo start --web`, prints the URLs and a ready pairing link; one Ctrl-C stops both
scripts/dev.sh --help                      # --no-watch --port N --app-port N --home DIR --server-only --app-only --no-pair
pnpm dev -- --port 4821 --home /tmp/mide   # flags go after `--` through pnpm (it prints a red ELIFECYCLE line on Ctrl-C; harmless)
pnpm typecheck && pnpm test                # every package; the server e2e runs ONE tiny real agent turn (costs tokens)
MIDE_SKIP_AGENT_TESTS=1 pnpm test          # everything that is free
pnpm --filter @mobile-ide/core build       # after changing packages/core — the other packages import its dist/
```

`scripts/dev.sh` uses your real `~/.mobile-ide` state by default; `--home /tmp/mide-dev` (or `MIDE_HOME`) keeps experiments apart.
`CLAUDE.md` lists the conventions, the per-package commands and how to add an agent; `docs/ARCHITECTURE.md` maps every module.

## Repository layout

| Path | What |
|---|---|
| `packages/core` | `@mobile-ide/core` — zod wire protocol, REST path table, timeline reducer, reconnecting WebSocket client. No React. |
| `apps/server` | `@mobile-ide/server` — the `mide` daemon: Hono REST, `ws` protocol with SQLite-backed replay, ACP agent hosts, permissions, tmux terminals, notifications, static web app hosting, `mide doctor`. |
| `apps/mobile` | `@mobile-ide/app` — Expo SDK 57 + Expo Router: Sessions, Chat, Files, Changes, Terminal, Settings, pairing. iOS native and web/PWA. |
| `apps/studio` | `@mobile-ide/studio` — desktop editor with live agent edits, a review queue, file diffs and responsive panels. |
| `deploy/systemd` | `mobile-ide.service` user unit. |
| `scripts` | `dev.sh` development loop. |
| `docs` | [PLAN](docs/PLAN.md) (why) · [ARCHITECTURE](docs/ARCHITECTURE.md) (how) · [STATUS](docs/STATUS.md) (what is verified) · [RUNBOOK](docs/RUNBOOK.md) (operate) · [SERVER_SPEC](docs/SERVER_SPEC.md) / [APP_SPEC](docs/APP_SPEC.md) (intended behaviour). |

Package READMEs: [apps/server/README.md](apps/server/README.md) (CLI, config, systemd, doctor rows) and
[apps/mobile/README.md](apps/mobile/README.md) (Expo dev, web export, EAS), and [apps/studio/README.md](apps/studio/README.md) (desktop workflows and browser QA).

## Status

See [docs/STATUS.md](docs/STATUS.md). In short: the daemon, the shared protocol and the app are built and verified end to end
against a real OpenCode session (pair → prompt → streamed events → reconnect replay → files/git → terminal → graceful stop);
the installed PWA path works today; the native iOS build waits for an Apple Developer account.
