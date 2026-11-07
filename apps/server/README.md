# @mobile-ide/server — the `mide` daemon

Runs on your dev machine (or a VPS on your tailnet). Owns every agent session, persists every event with a per-session `seq` so the phone can resume after bad signal, serves files/git/terminal, and pushes notifications. Agents speak ACP over stdio: OpenCode natively, Claude Code and Codex through the `@agentclientprotocol/*-acp` adapters, so your existing `claude`/`codex`/`opencode` binaries, config and billing are untouched.

Requires Node 22.13+ (24 recommended — `node:sqlite` without flags), `tmux`, `git`, and preferably `rg`.

## Commands

```
mide serve     [--port 4820] [--host 127.0.0.1] [--config <path>]   run the daemon (foreground, JSON logs)
mide pair      [--name iPhone] [--ttl 10] [--no-qr]                  one-time pairing code + URL + QR
mide devices   [--revoke <id>] [--json]                              paired devices; revoke by id or unique prefix
mide vapid     [--rotate] [--json]                                   Web Push (VAPID) key pair in config.json; print the public key
mide terminals [--kill <id> | --kill-all] [--json]                   tmux sessions behind the Terminal tab; kill one or all
mide doctor    [--json] [--agent-timeout 20]                         readiness checks; exit 1 on FAIL rows
```

Every command accepts `-c/--config <path>`. State lives in `~/.mobile-ide/` (`MIDE_HOME` overrides): `config.json` (created with defaults on first run), `mide.db` (SQLite, WAL), and the optional `env` file read by the systemd unit. The state directory is always denylisted for `/api/fs`, whatever `MIDE_HOME` points at, and auto-generated VAPID keys are written to the config file that was actually loaded (`-c <path>` included).

### `mide serve`

Boots in this order: config → SQLite → session recovery (turns interrupted by the last shutdown are closed out, pending permissions and agent questions cancelled) → HTTP on `host:port` → WebSockets → agents pre-warmed and closed-session space reclaimed in the background. Bind stays on `127.0.0.1`; `tailscale serve` provides HTTPS for the phone.

Stopping (`SIGINT`/`SIGTERM`/`SIGHUP`): new connections are refused, WebSocket clients are dropped (they replay from their last `seq` on reconnect), running turns get up to 60 s to finish, agent adapters get `SIGINT`, tmux terminals stay alive, the DB closes last. A second signal exits immediately.

| Variable | Effect |
|---|---|
| `MIDE_HOME` | state directory (default `~/.mobile-ide`) |
| `MIDE_LOG` | `debug` \| `info` \| `warn` \| `error` (default `info` for `serve`, `warn` for the other commands) |
| `MIDE_DRAIN` | `cancel` → cancel running turns on shutdown instead of waiting for them |
| `MIDE_DRAIN_MS` | how long to wait for turns (default `60000`) |

### `mide pair`

Mints an 8-character code (10-minute TTL, single use) directly in the database — the daemon may or may not be running — and prints `<publicUrl>/pair#<code>`, the native deep link `mobileide://pair?server=…&code=…`, and a QR of the web URL. `publicUrl` comes from config; until it is set the link uses the loopback address, which the phone cannot open (`mide doctor` shows the `tailscale serve` URL to paste in).

### `mide devices`

Lists devices with pairing time, last-seen time and status. `--revoke <id>` deletes the device's token and push subscriptions immediately; HTTP calls fail from the next request, open WebSockets drop at their next reconnect.

### `mide vapid`

Web Push needs a VAPID key pair. The daemon generates and stores one in the loaded config on first start when none is configured; `mide vapid` does the same without starting anything and prints the public key, `--rotate` replaces the pair (browsers must re-enable Web Push afterwards; the installed app re-subscribes on its next launch).

### `mide terminals`

The Terminal tab runs each shell in a tmux session named `<tmuxPrefix>-<id>`; they outlive the daemon on purpose. This lists them (id, tmux session, directory), `--kill <id>` / `--kill-all` end them. The app offers the same through Terminal → menu → "Close shell", and the REST API through `GET /api/terminals` and `DELETE /api/terminals/:id`.

### `mide doctor`

Rows stream as they complete; agents come last because each may take up to 20 s. With the three default agents that is 20 rows (17 fixed + one per enabled agent).

| Row | FAIL when | WARN when |
|---|---|---|
| Node.js | < 22.5 | 22.5–22.12 / 23.0–23.3 (`node:sqlite` behind a flag) |
| Config | invalid JSON / schema | |
| Database | `~/.mobile-ide` or `mide.db` not writable | (shows the on-disk size incl. WAL and the closed-session retention) |
| tmux, git | missing | |
| ripgrep | | missing (slower built-in search) |
| node-pty | fails **and** `script` missing | fails but `script` present (fallback path) |
| Tailscale / tailscale serve | | not installed, not running, not forwarding to the daemon's port |
| publicUrl | not a URL | unset, differs from the serve URL, not HTTPS |
| Web app | | no exported build found (`pnpm build` / `webApp.dir`), or `index.html` is older than the sources |
| Studio | | bundle not built (`pnpm build` / `studio.dir`), no browser found (`studio.browser`), no display reachable from the daemon |
| Linger | | `loginctl enable-linger` not done (daemon dies at logout) |
| systemd PATH | | `node`/agent binaries would not resolve on the service PATH |
| systemd unit | unit in `failed` state | not installed / not enabled |
| Daemon | unit active but `/api/health` silent; foreign program on the port | |
| Project roots | none configured | a root does not exist |
| Notifications | | nothing can reach the phone yet |
| Agent: … | binary missing, or no ACP `initialize` reply within the budget | |

The agent check spawns the adapter exactly as the daemon does and only calls `initialize`, so it costs no tokens. First runs of the `npx`-based adapters download packages and can exceed the budget: run it again.

## Configuration (`~/.mobile-ide/config.json`)

```jsonc
{
  "serverName": "fedora",
  "port": 4820, "host": "127.0.0.1",
  "publicUrl": null,                       // e.g. "https://laptop.tailnet.ts.net" — QR codes and notification links use it
  "trustProxy": false,                     // true behind `tailscale serve`/a loopback reverse proxy: honour X-Forwarded-For for the pairing rate limit
  "webApp": { "dir": null },               // exported web build to serve at "/"; null = <repo>/apps/mobile/dist when run from the checkout, else <MIDE_HOME>/www
  "studio": { "autoOpen": true, "browser": null, "dir": null, "windowSize": "1480x920" }, // the laptop's live editor at /studio/: pop up on session start, which browser (null = detect), bundle dir, window size
  "projects": { "roots": ["~/"], "denylist": ["~/.ssh", "~/.gnupg", "~/.mobile-ide"] },   // MIDE_HOME is always denied as well
  "agents": {
    "opencode": { "name": "OpenCode",    "command": "opencode", "args": ["acp"], "env": {} },
    "claude":   { "name": "Claude Code", "command": "npx", "args": ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"], "env": {} },
    "codex":    { "name": "Codex",       "command": "npx", "args": ["-y", "@agentclientprotocol/codex-acp@1.8.0"], "env": { "CODEX_PATH": "" } }
  },
  "notifications": {
    "ntfy":    { "server": "https://ntfy.sh", "topic": null },   // devices also register their own topics from the app
    "expo":    { "enabled": true },
    "webpush": { "vapidPublicKey": null, "vapidPrivateKey": null, "subject": "mailto:me@example.com" }
  },
  "terminal": { "shell": "$SHELL", "tmuxPrefix": "mide", "autoOpen": false },
  "limits": { "maxFileBytes": 1048576, "maxDiffBytes": 2097152, "eventReplayBatch": 500, "closedSessionRetentionDays": 30 }
}
```

`limits.closedSessionRetentionDays`: closed sessions and their event logs are deleted this many days after closing, at daemon start (0 = keep forever); open sessions are never pruned. The doctor's Database row shows the file size.

Per agent: `enabled: false` hides it without deleting it; `customModels: [...]` adds model ids to the new-session picker; `env` is layered over the daemon's environment (empty strings remove a variable). Agents inherit everything else from the daemon, so `ANTHROPIC_BASE_URL`-style variables must reach the daemon — see the systemd note below.

## Running as a service

```bash
pnpm install && pnpm build                                      # from the repo root
ln -sf "$PWD/apps/server/bin/mide.js" ~/.local/bin/mide
mide doctor
cp deploy/systemd/mobile-ide.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now mobile-ide
loginctl enable-linger "$USER"                                  # or the unit dies with your login session
journalctl --user -u mobile-ide -f
```

The unit runs `%h/.local/bin/mide serve` with `Restart=always`, `RestartSec=3`, `TimeoutStopSec=90`, `KillMode=mixed`, and a fixed `PATH` of `~/.local/bin:~/bin:/usr/local/bin:/usr/bin:/bin`. systemd does not read your shell profile, so if `node` comes from nvm, or the agents need proxy variables, put them in `~/.mobile-ide/env` (loaded via `EnvironmentFile=`):

```bash
echo "PATH=$PATH" >> ~/.mobile-ide/env        # makes nvm's node/npx and ~/.local/bin visible
# ANTHROPIC_BASE_URL=http://127.0.0.1:8787   # whatever your shell exports for the agents
systemctl --user restart mobile-ide
```

`mide doctor` → *systemd PATH* tells you what would be missing before you find out from the journal.

Expose it to the phone with `sudo tailscale serve --bg 4820`, put the printed `https://…ts.net` URL into `publicUrl`, restart, then `mide pair`. Full walkthrough: `docs/RUNBOOK.md`.

## Development

```bash
pnpm --filter @mobile-ide/server dev          # tsx src/cli.ts serve
pnpm --filter @mobile-ide/server typecheck
pnpm --filter @mobile-ide/server test         # node:test; agent tests skip without opencode or with MIDE_SKIP_AGENT_TESTS=1
MIDE_HOME=/tmp/mide tsx src/cli.ts doctor     # everything can run against a scratch state dir
```

Test files: `unit`, `unit-adapters` (recorded Claude/Codex traffic), `unit-sessions` (title policy, boot/shutdown, notifier dedupe, ntfy
server validation, static HEAD/compression, previews, space reclaim), `terminal` (real tmux), and the agent-backed proofs `e2e`,
`e2e-permissions`, `e2e-restart`, `e2e-crash` (OpenCode by default, `MIDE_TEST_AGENT=claude|codex`) and `e2e-elicitation` (always Claude
Code: one `AskUserQuestion` turn answered from the client; skips when `claude` is not on PATH). Every agent-backed file costs one or two
tiny prompts.

Programmatic use: `import { startServer, runDoctor } from '@mobile-ide/server'` — `startServer({ home, overrides: { port: 0 } })` returns `{ ctx, server, port, url, close() }`, which is how the e2e tests boot a daemon on a random port.

Layout: `app.ts` bootstrap · `cli.ts` commands · `doctor.ts` checks · `http.ts`+`routes/` REST (incl. `routes/static.ts` web app hosting and `routes/terminals.ts`) · `ws.ts` event and terminal sockets · `sessions.ts` + `agents/` ACP session manager (turns, permissions, elicitations = agent questions / URL hand-offs) · `db.ts` SQLite · `notify.ts` ntfy/Expo/Web Push · `terminal.ts` tmux-backed ptys · `paths.ts` root/denylist policy.
