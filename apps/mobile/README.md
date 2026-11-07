# @mobile-ide/app

Expo SDK 57 client for the mobile-ide daemon (`apps/server`): sessions, chat timeline with
permission prompts, files, git changes, terminal, settings. Targets iOS (primary) and web
(installable PWA / laptop browser). All wire types come from `@mobile-ide/core`.

The interface uses graphite and paper themes with an amber accent. Sessions offers editable workflow starters, search and
status filters; approvals and questions share an attention inbox. Files, Changes and Terminal share the selected project.
On wider screens the phone dock becomes a sidebar. See [UI workflows](../../docs/UI_WORKFLOWS.md) for the interaction design.

## Attach photos

In chat, tap **+ → Gallery** or **Files**, check the thumbnails, then send. In Terminal, choose **Add photos**, select a source,
then **Upload & paste**. This saves photos in the selected project's `.mobile-ide-uploads` directory and pastes their quoted
absolute paths into the current prompt; it does not press Enter. Add your request and submit when ready.

Up to four photos can be selected. Photos are resized to 1600 pixels on the longest edge; source files must be below 20 MB,
and each prepared image below 5 MB. Files is for image attachments, not arbitrary documents. The web browser controls the
system picker choices. Native builds need the added `expo-document-picker` module; rebuild a custom development client.

## Develop

```bash
pnpm --filter @mobile-ide/core build        # once, and after changing packages/core
cd apps/mobile
npx expo start --web                        # http://localhost:8081 — pair it with a running `mide serve`
npx expo start                              # Metro for a dev build on a device
pnpm typecheck                              # tsc --noEmit
npx expo-doctor
```

The web dev server never counts as the daemon: on the pairing screen enter the daemon URL
(`http://127.0.0.1:4820` locally, or your `tailscale serve` URL) and the code from `mide pair`.

## Pairing

`mide pair --name "iPhone"` prints an 8-character code, an `https://<host>/pair#CODE` link, a
`mobileide://pair?server=…&code=…` deep link and a QR of the link. The pairing screen accepts all of them:

| How | Where it works |
| --- | --- |
| Open the link / scan the QR with the phone's camera app | web + PWA — the screen prefills server and code |
| **Scan QR code** button (in-app camera, `expo-camera`) | native builds; auto-pairs when the QR carries server + code |
| **Paste link or code** button (clipboard) | everywhere; a bare `ABCD-1234` or the full link both work |
| **Recent servers** chips | everywhere; every daemon you paired with, tap to refill, hold to remove |
| Type the URL and code | everywhere |

Pasting a link into the code field also fills both fields. Codes are single-use and expire after 10 minutes.

## Settings

Settings has three categories and preserves unfinished fields when you switch between them:

- **Appearance** — system/light/dark previews, terminal font size and optional display adjustments.
- **Notifications** — the device's push channel and optional ntfy setup, channel status, trigger rules and a test send.
- **Connection** — server, device and agent details, with diagnostics and app information behind a disclosure.
  **Test connection** probes `/api/health` (latency), checks the device token, and reports the WebSocket
  state with a reconnect shortcut. **Check version** compares the daemon version with this build and
  shows the exact command to run on the laptop (`git pull && pnpm install && pnpm build && systemctl --user restart mobile-ide`)
  or tells you to reload/reinstall the app when the app is the older side. A version mismatch is also flagged
  inline in the Server card as soon as health loads.
  **Copy diagnostics** puts a JSON report on the clipboard for bug reports. **Forget this server** drops this device's token
  and local registrations; the server stays in the recent list.

## Workflow verification

[qa/README.md](qa/README.md) describes the repeatable browser scenario for the production web export. It uses temporary
projects, a local stub agent and its own daemon state, including real tmux keyboard input. Native device checks are separate.

## Notifications matrix

| Channel | Build | Needs | Status shown in Settings |
| --- | --- | --- | --- |
| Push notifications (Expo → APNs/FCM) | native | `extra.eas.projectId` (run `eas init`), APNs key via `eas credentials`, physical device, dev build (not Expo Go) | Registered / Not enabled / Blocked / Needs EAS project id / Simulator / Needs a dev build |
| Web Push (VAPID) | installed web app (Add to Home Screen), HTTPS | daemon VAPID keys (`mide vapid`, or auto-generated on first run) | Subscribed / Not enabled / Add to Home Screen first / Needs HTTPS / Blocked |
| ntfy | every build | the ntfy app subscribed to a private topic | Registered / Not set |

## Web build

```bash
npx expo export -p web                      # -> dist/
```

`dist/` is a single-page app. Whatever hosts it (the daemon does, see `apps/server/src/routes/static.ts`) must:

- serve `/sw.js` and `/manifest.webmanifest` as static files (Web Push + install banner),
- fall back to `index.html` for `/pair` and `/session/*` so QR links and notification clicks open the app,
- be reachable from the same tailnet as the daemon; the daemon allows loopback, tailnet and
  private-network origins for CORS and WebSocket upgrades.

`app/+html.tsx` and `public/index.html` carry the same PWA tags; with `web.output: "single"` Expo uses
`public/index.html`, keep the two in sync.

## Icons and splash

Everything under `assets/` is generated from one vector glyph (a `>_` prompt in the accent colour on the
theme background) by `assets/icon-source/build-icons.mjs`:

```bash
cd apps/mobile
node assets/icon-source/build-icons.mjs                      # uses `sharp` if installed, else headless Chromium
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
CHROME_PATH=/path/to/chrome-headless-shell node assets/icon-source/build-icons.mjs
```

Outputs: `icon.png` (iOS light, opaque 1024²), `icon-dark.png` / `icon-tinted.png` (iOS 18 variants,
transparent), `adaptive-icon.png` + `adaptive-icon-mono.png` (Android, 66 % safe zone), `splash-icon.png` /
`splash-icon-dark.png` (light and dark splash, wired in `app.json`), `notification-icon.png` (96², white on
transparent), `favicon.png`, and the PWA icons in `assets/web/`. Copy those last ones over `public/`
whenever the glyph changes:

```bash
cp assets/web/apple-touch-icon.png assets/web/icon-192.png assets/web/icon-512.png public/
```

## iOS build (needs the Apple Developer Program)

```bash
cd apps/mobile
npx eas login
npx eas init                                # creates the EAS project and writes extra.eas.projectId into app.json
npx eas device:create                       # register the iPhone's UDID for internal distribution
npx eas build -p ios --profile development  # profiles: development | preview | production (eas.json)
npx eas credentials -p ios                  # upload the APNs .p8 key so Expo push can deliver
```

### `extra.eas.projectId`

`app.json` ships with `"extra": { "eas": { "projectId": "" } }` on purpose: the id is per Expo account.
`eas init` fills it (accept the prompt to link the existing slug `mobile-ide`, or create a new project).
Without it `getExpoPushTokenAsync` cannot mint a token, and Settings → Push notifications shows
**Needs EAS project id**. If you would rather not commit the id, set `EAS_PROJECT_ID` in the build
environment and read it in `app.config.ts` — the app only needs it at runtime through `Constants`.

Other things `eas build` wants from you once: an Apple Team, a bundle id (`dev.mobileide.app`, already set),
and the push key. `eas.json` pins pnpm 11.24.0 for the cloud builder and uses remote `appVersionSource`
so `production` auto-increments the build number.

### Native modules in this app

expo-camera (QR pairing), expo-notifications (push), expo-secure-store (token), expo-clipboard,
expo-image-picker (screenshots into prompts), expo-haptics, react-native-keyboard-controller. All of them
are guarded so the web build never evaluates native-only code (`.native.tsx` files or lazy `require`).

## Layout

- `app/` — Expo Router routes: `(auth)/pair`, `(tabs)/{index,files,changes,terminal,settings}`,
  `session/[id]`, `new-session` (modal), `file`, `+not-found`.
- `src/state/` — zustand stores: settings (persisted, secure on native), connection (`MideClient`),
  sessions/timelines (core reducer + outbox), projects, read markers, toasts.
- `src/components/` — `ui` kit plus feature folders (`chat`, `permissions`, `sessions`, `files`, `changes`,
  `terminal`, `pair` for the QR scanner).
- `src/dom/` — `'use dom'` components: markdown, unified diff, Shiki code viewer, xterm terminal.
- `src/lib/` — deep links, notifications (native) + web push with per-channel status, server history,
  version comparison, formatting helpers.

Deep links: `mobileide://pair?server=&code=`, `mobileide://session/<id>`; on the web `/pair#<code>` and `/session/<id>`.
