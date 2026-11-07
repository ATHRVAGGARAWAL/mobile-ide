# Runbook — from zero to driving agents from your iPhone

All steps run on the Fedora laptop unless marked (phone).

## 0. Make services survive logout (one time)
```bash
loginctl enable-linger "$USER"          # your user units currently die at logout (Linger=no)
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' | sudo tee /etc/systemd/logind.conf.d/mobile-ide.conf
sudo systemctl restart systemd-logind   # note: this can end your graphical session; do it from a fresh login
```

## 1. Tailscale (one time)
```bash
sudo dnf config-manager --add-repo https://pkgs.tailscale.com/stable/fedora/tailscale.repo
sudo dnf install -y tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up --ssh               # --ssh gives you an emergency shell path that shares nothing with the daemon
```
Admin console (login.tailscale.com): DNS → enable **MagicDNS** and **HTTPS Certificates**.
(phone) Install Tailscale from the App Store, sign in with the same account, leave it connected. Do not install DNS-over-HTTPS profile apps on the phone; they shadow MagicDNS.

## 2. Build and install the daemon
```bash
cd "/home/athrv/mobile ide"
pnpm install && pnpm build             # core + daemon, then `expo export -p web` into apps/mobile/dist
ln -sf "$PWD/apps/server/bin/mide.js" ~/.local/bin/mide
sudo dnf install -y ripgrep            # optional: /api/fs/search falls back to git grep without it
mide doctor                            # every row should be OK before continuing (tailscale/linger rows go green after steps 0-1)
```
The daemon serves the exported web app at `/`, so `https://<laptop>.<tailnet>.ts.net/` opens the app itself (installable
from Safari, step 5). It looks for the build in this order: `"webApp": { "dir": "…" }` in `~/.mobile-ide/config.json`
→ `apps/mobile/dist` of the checkout it runs from → `~/.mobile-ide/www` (copy an export there when the daemon runs from
somewhere else). `mide doctor`'s **Web app** row shows which folder is used and how old the export is; without any build
the daemon answers `/` with a plain landing page. Rebuild the web app alone with `pnpm build:web` — the daemon picks a
new export up on the next request, no restart needed.

## 2b. The Studio — see the agent edit your code on the laptop
`pnpm build` also bundles the Studio (`apps/studio/dist`), which the daemon serves at `http://127.0.0.1:4820/studio/`. It pops
up on its own the moment a session starts (from the phone or anywhere) as a dedicated browser app-window — no tabs, no URL bar —
pairs itself and follows the agent: files open as the agent touches them, an announced edit is drawn in place before it lands,
and the written lines light up when it does. You can approve tool calls, answer questions, send prompts and edit/save files from
there too (⌘S; a stale file is a conflict banner, never a silent overwrite).
- Open it by hand: `mide studio` (or `mide studio --session <id>`; `--no-open` prints the launch URL). From the phone: session
  menu → *Open in Studio*.
- Browser: Chrome, Chromium, Brave or Edge give the app-window (native installs and Flatpaks are found automatically; Firefox
  opens a normal window). Force one with `"studio": { "browser": "flatpak run com.brave.Browser" }` in `config.json`.
- Under systemd the daemon has no display of its own. GNOME and KDE import `DISPLAY`/`WAYLAND_DISPLAY` into the user manager at
  login, and the launcher reads them from `systemctl --user show-environment`; if `mide doctor` shows *Studio … no display*, add
  `DISPLAY=:0` / `WAYLAND_DISPLAY=wayland-0` to `~/.mobile-ide/env` or run `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY`.
- Turn the pop-up off with `"studio": { "autoOpen": false }`; `mide studio` still works. One window follows every session — a
  connected Studio is never duplicated.
- `mide doctor` → *Studio* row: where the bundle is, which browser will be used, whether a display is reachable, auto-open state.

## 3. Run it as a service
```bash
cp deploy/systemd/mobile-ide.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mobile-ide.service
journalctl --user -u mobile-ide -f     # watch it come up; agents pre-warm at boot
```

## 4. Expose it on your tailnet over HTTPS
```bash
sudo tailscale serve --bg 4820         # https://<laptop>.<tailnet>.ts.net -> 127.0.0.1:4820
tailscale serve status
```
Put that URL into `~/.mobile-ide/config.json` as `"publicUrl"`, and set `"trustProxy": true` (behind `tailscale serve` every request arrives from loopback; this keys the pairing rate limit on the proxy-appended client address instead of one shared bucket). Then `systemctl --user restart mobile-ide` so QR codes and notification links use the public URL.

### Show phone work on the laptop

Set `studio.autoOpen: true` and `terminal.autoOpen: true` in `~/.mobile-ide/config.json`, then restart the daemon.
Agent tasks open Studio; its **Jump to new sessions** control also follows resumed tasks. Terminal sessions open a native
desktop terminal attached to the exact same tmux shell. Closing that window detaches the laptop; using `exit` inside the
shell ends it for both devices. The shared terminal uses the largest attached window; the phone shows a smaller viewport
while the laptop is attached, and regains its own layout when the laptop window closes.
Reopening the phone terminal can reopen a closed laptop window after a 20-second cooldown.
The desktop must be logged in. The systemd unit's `KillMode=process` preserves terminal work and desktop windows on daemon restarts;
install the updated unit and run `systemctl --user daemon-reload` before restarting an older installation.

### When the site stops responding

Check both processes: a healthy tunnel cannot serve the app when the daemon is stopped.

```bash
systemctl --user status mobile-ide cloudflared-mide --no-pager
systemctl --user enable --now mobile-ide
curl --fail http://127.0.0.1:4820/api/health
mide doctor
```

For a Cloudflare installation, also check `https://<your-hostname>/api/health`. The tunnel unit now requests
`mobile-ide.service` at startup. Keep the daemon enabled as well so it starts independently of the tunnel.
`mide doctor` warns if the daemon is stopped, including when its unit is enabled but inactive.

The clients retry stalled connections automatically: opening a socket has a 10-second budget, and heartbeats
sent every 20 seconds must receive a reply within 10 seconds. Mobile's connection banner also provides **Retry now**
during reconnection. Reload an existing web app tab after rebuilding to receive updated client code.

## 4b. Alternative: Cloudflare tunnel when the network blocks Tailscale

Some networks (campus / corporate firewalls such as Fortinet) block Tailscale's coordination server and relays, so the
laptop shows as offline on the tailnet and the phone cannot reach `https://<host>.<tailnet>.ts.net`. Cloudflare's edge is
almost always allowed, so a tunnel from the laptop to Cloudflare gives the phone a working URL on those networks. The daemon
stays bound to `127.0.0.1`; only the tunnel process is exposed, and every request still needs a paired device's bearer token.

Quick tunnel (no account, random URL, changes on every restart):

```sh
cloudflared tunnel --url http://127.0.0.1:4820 --no-autoupdate      # prints https://<words>.trycloudflare.com
# set "publicUrl" in ~/.mobile-ide/config.json to that URL and restart the daemon (the origin allowlist follows publicUrl)
mide pair --name iPhone                                              # the printed link now uses the tunnel URL
```

Stop it with Ctrl-C (or `pkill -x cloudflared`); the URL is dead the moment the process exits. A device that paired through a
quick tunnel keeps its token; after a restart it only needs the new server URL (Settings → server) — no re-pairing.

Stable tunnel (needs a free Cloudflare account and a domain you own on Cloudflare, roughly USD 10/year). One script does
everything except the browser login:

```sh
cloudflared tunnel login                                             # once, interactive: pick the zone that holds the hostname
scripts/cloudflare-tunnel.sh ide.example.com                         # create tunnel "mobile-ide", CNAME the hostname to it,
                                                                     # write ~/.cloudflared/config.yml, set publicUrl + trustProxy,
                                                                     # install + start the cloudflared-mide user unit, restart the
                                                                     # daemon, curl https://ide.example.com/api/health
```

`scripts/cloudflare-tunnel.sh --help` lists the options (`--name`, `--port`, `--no-service`, `--no-restart`); rerun it to move to another
hostname or port. The unit is `deploy/systemd/cloudflared-mide.service` (`journalctl --user -u cloudflared-mide -f`); with
`loginctl enable-linger $USER` it starts at boot together with the daemon. The same by hand:

```sh
cloudflared tunnel create mobile-ide
cloudflared tunnel route dns mobile-ide ide.example.com
cloudflared tunnel run --url http://127.0.0.1:4820 mobile-ide        # or `cloudflared service install` for systemd
```

Set `publicUrl` to `https://ide.example.com` once. Put a Cloudflare Access policy (Zero Trust → Access → Applications, free
for up to 50 users) in front of the hostname for a second login wall before the daemon's own token check. Web Push works
through either tunnel because the origin is HTTPS. The phone never needs to share a network with the laptop — the connector
dials Cloudflare outbound, the phone reaches Cloudflare from Wi-Fi or cellular; `tailscale status` may keep saying `offline`,
that is fine. `mide doctor` reports a non-tailscale https `publicUrl` as OK ("tunnel / reverse proxy").

Watching from the laptop: the daemon hosts the same web app on `http://127.0.0.1:4820/` — open it in a browser tab (pair it as one
more device with `mide pair --name laptop`; loopback origins are always allowed) and you see every session live, the same timeline
the phone sees. There is no separate desktop UI to run; the agents edit files on disk, so your normal editor shows the changes as
they land.

## 5. Pair the phone
```bash
mide pair --name "iPhone"              # prints an 8-char code, a URL and a QR
```
(phone, web/PWA path) Open `https://<laptop>.<tailnet>.ts.net/` in Safari → Share → **Add to Home Screen** → open the new
icon → enter the code from `mide pair`. Pairing inside the installed app matters: the Home Screen app has its own storage,
so a code entered in the Safari tab does not carry over. (Scanning the QR opens `/pair#CODE` with the code prefilled —
fine for a quick look in Safari; for the installed app type the code.)
(phone, native path) Open the app → Pair → scan or type.

## 6. Notifications today (no Apple account needed)
(phone) Install **ntfy** from the App Store, subscribe to a long random topic name.
In the app: Settings → Notifications → ntfy topic → Save → Send test. The daemon posts permission prompts and finished turns to that topic with a link back into the session.

## 7. Native iOS build (when you have the Apple Developer Program)
```bash
cd apps/mobile
npx eas login && npx eas init
npx eas device:create                  # register the iPhone's UDID
npx eas build -p ios --profile development   # ~15 min on Expo's Mac cloud; install from the link
npx eas credentials -p ios             # upload the APNs .p8 key for push
```
Then in the app: Settings → Notifications → enable push (registers the Expo token with the daemon).

## Daily operation
- New session from the phone: Sessions → + → agent, project, first prompt.
- Approve a tool call: tap the notification → the permission sheet shows the exact command → Allow once / Always / Reject.
- If the phone shows "reconnecting": check `tailscale status` on both ends; the daemon replays anything you missed.
- Update the daemon: `git pull && pnpm install && pnpm build && systemctl --user restart mobile-ide` (turns in flight get up to 60 s to finish; long ones resume via session load). `pnpm build` also re-exports the web app; the phone loads the new version on its next launch (`index.html` is never cached, bundles are content-hashed).
- Develop: `pnpm dev` (scripts/dev.sh) runs the daemon under tsx, `expo start --web` and the Studio bundler in watch mode together with one Ctrl-C; the daemon keeps serving the last export at `/` (and the freshly rebuilt Studio at `/studio/`) while the Expo dev server hot-reloads on :8081.
- The Studio did not pop up: `mide doctor` (Studio row), then `journalctl --user -u mobile-ide | grep studio` — `studio.auto_open.not_opened` carries the reason (no bundle, no browser, no display, cooldown, a Studio already connected).
- Debug from anywhere: `tailscale ssh <laptop>` then `journalctl --user -u mobile-ide -n 200`.

## Moving to an always-on box later
Install Node, tmux, git, rg, the three agents and their credentials on the VPS, join it to the tailnet, clone your repos there, copy `~/.mobile-ide/config.json`, run the same steps 2–5. Your Azure proxies (`~/.claude/proxy`, `~/.codex/proxy`) must run on the box too; point `ANTHROPIC_BASE_URL` at the box's own loopback.
