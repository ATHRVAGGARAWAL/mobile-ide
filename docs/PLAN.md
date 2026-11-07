# Mobile IDE — plan

## Context

You want to drive coding agents (Claude Code, Codex, OpenCode, and any future agent) from your iPhone: send prompts, watch streaming output, answer permission prompts, browse files and diffs, use a terminal, and keep working from anywhere. Today you do this with T3 Code desktop plus the T3 Connect relay, propped up by two hand-written systemd units (`t3-connect-watchdog`, `t3-relay-portfix`) because the relay pins an origin port the T3 server does not honor and because the GUI must stay running. Your stated priorities: **reliable, highly functional, great UI/UX**.

Two facts found during research shape everything:

1. **The vendors' own phone paths are closed to you.** Claude Code Remote Control refuses any custom `ANTHROPIC_BASE_URL` (since v2.1.196) and needs a claude.ai subscription; your Claude runs through the Azure router proxy. Codex's `remote_control` feature is marked *removed* in your 0.147.0 build, and ChatGPT mobile does not support Linux hosts. OpenCode has no first-party mobile app. So a self-hosted system is not a nice-to-have; it is the only way to get all three agents on your phone.
2. **On iOS neither a web app nor a native app can hold a socket in the background.** Therefore the server must own every session, persist every event, and let the phone resume from a sequence number. Push notifications wake you; the client catches up. This design is identical for PWA and native, which is why the client choice is about UX, not reliability.

## Decisions

| Area | Decision | Why |
|---|---|---|
| Agent layer | **ACP** (Agent Client Protocol v1, `@agentclientprotocol/sdk` 1.4) over stdio. OpenCode natively (`opencode acp`), Claude via `@agentclientprotocol/claude-agent-acp`, Codex via `@agentclientprotocol/codex-acp`. | One schema for prompts, streaming, structured tool calls with diffs, four-option permissions, modes, slash commands. ~40 agents in the registry. Adapters are Zed/JetBrains-maintained (not vendor), Apache-2.0, released weekly. Each agent gets an escape hatch to its native SDK if ACP flattens something. |
| Billing | Unchanged. The daemon shells out to the same `claude`/`codex`/`opencode` binaries with the same env, so requests still go through your Azure proxies. | Marginal LLM spend of the custom path is zero. |
| Durability | Node daemon owns sessions; **SQLite (`node:sqlite`) append-only event log with a monotonic `seq` per session**, written before broadcast; pending permissions persisted; client reconnects with `afterSeq`. Agents never time out on permission prompts, so an approval hours later works as long as the process lives. | Reconnects on cellular, iOS backgrounding, and daemon restarts become non-events. Same pattern OpenCode uses internally. |
| Process lifetime | Daemon under `systemd --user` with `Restart=always`, `loginctl enable-linger`, graceful stop that SIGINTs agents (SIGTERM leaves turns unfinished). Terminals live in `tmux` so they outlive the daemon. | Your laptop currently has `Linger=no`, so every user unit dies at logout. Fixing that is step zero. |
| Network | **Tailscale** on laptop and phone; daemon binds `127.0.0.1`; `tailscale serve` terminates HTTPS with a Let's Encrypt cert on `<laptop>.<tailnet>.ts.net`. Bearer token auth on every request and WebSocket upgrade anyway. | $0, no inbound ports, no relay to operate, no vendor account. The iPhone SSL reports against Serve were a DNS-over-HTTPS app conflict, not a trust problem. Funnel, ngrok, and a public relay are explicitly out for v1. |
| Client | **Expo SDK 57** app (Expo Router), targeting **iOS native** as the primary UX and **web** as a second target for the laptop browser and as a $0 installable PWA on the phone until the Apple Developer account is in place. DOM components host web-only pieces (xterm.js, Shiki, diff view) so they render on both. | You already ship Expo apps via EAS from Linux. Native gives keyboard-aware composer, haptics, Live Activities and silent push later. EAS builds run on Expo's Mac cloud; on-device builds need the $99/yr Apple Developer Program (Expo Go on the App Store is stuck at SDK 54, so do not plan around it). |
| Notifications | `Notifier` interface with three backends: **ntfy** (works today, install the ntfy iOS app), **Expo Push** (once the Apple account exists), **Web Push** (VAPID, for the installed PWA; every push must show a visible notification or Safari revokes the subscription). | Permission-prompt and turn-finished alerts are the highest-value interaction; shipping them should not wait on Apple. |
| Terminal | `@lydell/node-pty` inside `tmux` sessions, streamed over a dedicated WebSocket; xterm.js 6 + WebGL addon in a DOM component with an accessory key row (Esc, Tab, Ctrl, arrows, Ctrl-C). Secondary tab, lazy-loaded. Agent command output in chat is ANSI-to-HTML, not xterm. | Every well-reviewed mobile client makes chat primary and terminal secondary; iOS touch/keyboard bugs in xterm are real but manageable behind a tab. |
| Files | Own REST endpoints (tree, read with size cap, ripgrep search, git status/diff/log via the system `git`). Read-only viewer with Shiki in v1. | ACP's `fs/*` methods are the wrong direction (editor lends files to a local agent) and are removed in ACP v2. |
| Hosting later | Same daemon on a Hetzner-class VPS joined to the tailnet when you want laptop-off operation. Repos are cloned there; the laptop becomes another client. Railway is the wrong shape (RAM billed at $10/GB/mo for always-on stateful processes; sandboxes are short-lived). | No code sync problem exists if the canonical checkout moves with the agent. |

## Architecture

```
iPhone (Expo app / PWA)  ──WSS+HTTPS──▶  tailscale serve  ──▶  daemon 127.0.0.1:4820
                                                                 ├─ Hono REST: pair, sessions, fs, git, push
                                                                 ├─ ws: /ws (events, prompts, permissions)  /ws/terminal (pty)
                                                                 ├─ SQLite: devices, sessions, events(seq), permissions, push_subs
                                                                 ├─ AgentHost per agent kind (ACP over stdio, N sessions each)
                                                                 │    ├─ opencode acp
                                                                 │    ├─ claude-agent-acp  → claude CLI (Azure router proxy env)
                                                                 │    └─ codex-acp        → codex (azure_foundry)
                                                                 ├─ Notifier: ntfy | expo | webpush
                                                                 └─ tmux-backed PTYs
```

Event flow: ACP `session/update` → normalize to `TimelineEvent` → append `(sessionId, seq, ts, event)` → broadcast to subscribed sockets → client reducer builds the visible timeline. Reconnect: `subscribe {sessionId, afterSeq}` replays from SQLite then goes live. Permission: `permission.requested` event + push; the ACP request stays pending until the phone answers; `cancelled` is only sent on explicit user cancel (it aborts the whole turn).

## Repository layout

```
packages/core     protocol (zod), timeline reducer, reconnecting WS client, REST paths — no React/RN imports
apps/server       daemon: bin `mide` (serve | pair | doctor)
apps/mobile       Expo Router app: (tabs) Sessions · Files · Changes · Terminal · Settings; chat screen per session
deploy/systemd    mobile-ide.service (user unit), tailscale notes
docs              PLAN.md, RUNBOOK.md
```

## Phases

1. **Foundation (done 2026-09-03; see docs/STATUS.md):** monorepo, `@mobile-ide/core` contract, server with ACP session manager + event log + WS protocol + pairing auth + fs/git API + ntfy notifier + pty, Expo app with sessions list, new-session sheet, chat timeline (streaming markdown, tool cards, unified diff cards, permission bottom sheet), files browser, changes view, terminal tab, settings/pairing. Verified end-to-end against OpenCode ACP on this machine and by typecheck + web export of the app.
2. **On the phone (you, ~1 hour):** install Tailscale on Fedora and iPhone, `tailscale serve`, `loginctl enable-linger`, enable the systemd unit, pair from Safari, Add to Home Screen. Install ntfy and subscribe to your topic.
3. **Native build (when you enroll in the Apple Developer Program, $99/yr):** `eas build -p ios --profile development`, `eas device:create`, APNs key, Expo push; add haptics, `react-native-keyboard-controller`, Live Activity for "agent running / needs you".
4. **Hardening:** passkey (WebAuthn) login for the web client, fresh biometric before approving destructive tool calls, audit log of executed commands, per-agent health in `/api/health`, log shipping.
5. **Later:** always-on VPS, image attachments from camera roll, voice input (native only), session forking, Codex `turn/steer`-style mid-turn steering where the adapter exposes it, ACP v2 when it stabilizes (gate behind version negotiation).

## What you need to obtain or enable

- **Tailscale** (free Personal plan): `sudo dnf config-manager --add-repo https://pkgs.tailscale.com/stable/fedora/tailscale.repo && sudo dnf install tailscale && sudo systemctl enable --now tailscaled && sudo tailscale up --ssh`; enable MagicDNS + HTTPS certificates in the admin console; iOS app from the App Store. Do not install a DNS-over-HTTPS profile app on the phone (it shadows MagicDNS).
- **Keep the laptop awake:** `loginctl enable-linger athrv`; `HandleLidSwitch=ignore` drop-in in `/etc/systemd/logind.conf.d/`.
- **ntfy** iOS app (free) for notifications today.
- **Apple Developer Program** ($99/yr, enroll from the Apple Developer iOS app) when you want the native build, TestFlight, and APNs. EAS free tier: 15 iOS builds/month.
- Nothing else. No Railway, no domain, no relay for v1.

## Verification

- Server: `pnpm --filter @mobile-ide/server test` runs an end-to-end test that pairs a device, creates an OpenCode session in a temp git repo, sends a one-line prompt, asserts streamed `message.delta` and `turn.ended` events with increasing `seq`, reconnects with `afterSeq` and asserts exact replay, and exercises fs/git endpoints.
- App: `pnpm --filter @mobile-ide/app typecheck` and `npx expo export -p web` succeed; open the web build against the local daemon in a mobile viewport.
- On device: pair, run a prompt, background the app for 10 minutes mid-turn, return and confirm no gap in the transcript; trigger a permission prompt with Claude in default permission mode and approve from the ntfy notification.

## Risks and mitigations

- **Adapter churn:** `claude-agent-acp` ships several releases a day and has open regressions (e.g. permission prompt shows the model's description instead of the command, issue #1068). Pin versions in `apps/server/package.json`; the permission sheet always shows `rawInput` so you approve the real command.
- **`codex-acp` bundles its own Codex** (0.152.x) rather than your 0.147.0. Set `CODEX_PATH` to your binary if behavior diverges; confirm it reads `~/.codex/config.toml` (azure_foundry).
- **Cold start:** Claude sessions can take ~10 s to create. The UI shows a "starting" state; the server pre-warms one adapter per agent at boot.
- **RAM:** each active Claude/Codex session costs 250–450 MB. Realistic phone concurrency is 1–3 sessions; the app closes idle sessions (`session/close`) and rehydrates from the log.
- **iOS 26 PWA keyboard bug** (fixed-bottom composer floats after keyboard dismiss): drive layout from `visualViewport` events on web; irrelevant in the native build.
