#!/usr/bin/env bash
# scripts/cloudflare-tunnel.sh — put the daemon behind a *stable* Cloudflare Tunnel on a hostname you own.
#
# Why: some networks (hostel / campus / corporate firewalls such as Fortinet) block Tailscale's coordination server and
# relays, so the laptop shows as offline on the tailnet and the phone cannot reach https://<laptop>.<tailnet>.ts.net.
# Cloudflare's edge is almost always reachable. A quick tunnel (`cloudflared tunnel --url ...`) works but its URL changes
# on every restart; a *named* tunnel on your own domain gives the phone one URL forever, from any network — the phone does
# not need to share a Wi-Fi with the laptop, only the laptop needs to be online.
#
# The daemon stays bound to 127.0.0.1. Only the tunnel process talks to Cloudflare (outbound only, no open ports), and every
# request still needs a paired device's bearer token. Optionally add a Cloudflare Access policy in front of the hostname.
#
# Usage: scripts/cloudflare-tunnel.sh <hostname> [options]
#   <hostname>         e.g. ide.example.com — a DNS name in a zone that lives on your Cloudflare account
#   --name <tunnel>    tunnel name in Cloudflare (default: mobile-ide)
#   --port <n>         daemon port (default: "port" in ~/.mobile-ide/config.json, else 4820)
#   --no-service       do not install / start the systemd user unit, just print the `cloudflared tunnel run` command
#   --no-restart       do not restart the daemon after setting publicUrl
#   -h, --help         this text
#
# One-time prerequisite (interactive, opens a browser, cannot be scripted):
#   cloudflared tunnel login          # pick the zone that holds <hostname>; writes ~/.cloudflared/cert.pem
#
# Idempotent: rerun it to change the hostname or port. Works from any cwd; the repo path may contain spaces.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIDE_HOME="${MIDE_HOME:-$HOME/.mobile-ide}"
CF_DIR="$HOME/.cloudflared"
UNIT_SRC="$ROOT/deploy/systemd/cloudflared-mide.service"
UNIT_DIR="$HOME/.config/systemd/user"

TUNNEL_NAME="mobile-ide"
PORT=""
HOSTNAME_ARG=""
INSTALL_SERVICE=1
RESTART_DAEMON=1

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) TUNNEL_NAME="${2:?--name needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --no-restart) RESTART_DAEMON=0; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) if [ -z "$HOSTNAME_ARG" ]; then HOSTNAME_ARG="$1"; else echo "unexpected argument: $1" >&2; exit 2; fi; shift ;;
  esac
done

if [ -z "$HOSTNAME_ARG" ]; then echo "error: <hostname> is required (e.g. ide.example.com)" >&2; usage >&2; exit 2; fi
HOSTNAME_ARG="${HOSTNAME_ARG#https://}"; HOSTNAME_ARG="${HOSTNAME_ARG%%/*}"
if ! [[ "$HOSTNAME_ARG" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "error: '$HOSTNAME_ARG' does not look like a DNS hostname" >&2; exit 2
fi
PUBLIC_URL="https://$HOSTNAME_ARG"

say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ cloudflared binary
find_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then command -v cloudflared; return; fi
  # T3 Code ships one under ~/.t3; reuse the newest rather than downloading again.
  local cand
  cand="$(ls -d "$HOME"/.t3/tools/cloudflared/*/linux-x64/cloudflared 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$cand" ] && [ -x "$cand" ]; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$cand" "$HOME/.local/bin/cloudflared"
    echo "$HOME/.local/bin/cloudflared"; return
  fi
  return 1
}
CLOUDFLARED="$(find_cloudflared)" || die "cloudflared not found. Install it: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ (Fedora: sudo dnf install cloudflared, or drop the binary into ~/.local/bin)"
ok "cloudflared: $CLOUDFLARED ($("$CLOUDFLARED" --version 2>/dev/null | head -1))"
# The systemd unit execs %h/.local/bin/cloudflared — make sure that path resolves even when the binary came from PATH.
if [ ! -e "$HOME/.local/bin/cloudflared" ]; then mkdir -p "$HOME/.local/bin"; ln -sf "$CLOUDFLARED" "$HOME/.local/bin/cloudflared"; fi

# ------------------------------------------------------------------ login (interactive, once)
if [ ! -s "$CF_DIR/cert.pem" ]; then
  cat >&2 <<MSG

This account is not logged in to Cloudflare yet (no $CF_DIR/cert.pem). Run, once, in a terminal with a browser:

    cloudflared tunnel login

pick the zone that contains '$HOSTNAME_ARG', then rerun:

    "$ROOT/scripts/cloudflare-tunnel.sh" $HOSTNAME_ARG${TUNNEL_NAME:+ --name $TUNNEL_NAME}

MSG
  exit 1
fi
ok "logged in ($CF_DIR/cert.pem)"

# ------------------------------------------------------------------ port
if [ -z "$PORT" ]; then
  PORT="$(node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.port??4820)}catch{console.log(4820)}' "$MIDE_HOME/config.json")"
fi
[[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be a number, got '$PORT'"

# ------------------------------------------------------------------ tunnel (create once)
TUNNEL_ID="$("$CLOUDFLARED" tunnel list --name "$TUNNEL_NAME" -o json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const t=Array.isArray(a)?a.find((x)=>x&&x.name===process.argv[1]):null;if(t&&t.id)console.log(t.id)}catch{}})' "$TUNNEL_NAME")"
if [ -z "$TUNNEL_ID" ]; then
  say "creating tunnel '$TUNNEL_NAME'"
  "$CLOUDFLARED" tunnel create "$TUNNEL_NAME" >/dev/null
  TUNNEL_ID="$("$CLOUDFLARED" tunnel list --name "$TUNNEL_NAME" -o json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const a=JSON.parse(s);const t=a.find((x)=>x.name===process.argv[1]);if(t)console.log(t.id)})' "$TUNNEL_NAME")"
  [ -n "$TUNNEL_ID" ] || die "tunnel '$TUNNEL_NAME' was created but cannot be listed"
fi
CREDS="$CF_DIR/$TUNNEL_ID.json"
[ -s "$CREDS" ] || die "credentials file $CREDS is missing. The tunnel exists in Cloudflare but this machine has no key for it: run 'cloudflared tunnel delete $TUNNEL_NAME' (or pick another --name) and rerun."
ok "tunnel '$TUNNEL_NAME' = $TUNNEL_ID"

# ------------------------------------------------------------------ DNS record  <hostname> CNAME <id>.cfargotunnel.com
say "routing $HOSTNAME_ARG → tunnel"
"$CLOUDFLARED" tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$HOSTNAME_ARG" >/dev/null 2>&1 \
  || "$CLOUDFLARED" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" >/dev/null 2>&1 \
  || die "could not create the DNS record for $HOSTNAME_ARG. Is its zone on the Cloudflare account you logged in with? (An existing non-tunnel record with that name must be removed in the dashboard.)"
ok "DNS: $HOSTNAME_ARG → $TUNNEL_ID.cfargotunnel.com"

# ------------------------------------------------------------------ config.yml
mkdir -p "$CF_DIR"
cat > "$CF_DIR/config.yml" <<YML
# Written by mobile-ide scripts/cloudflare-tunnel.sh — rerun it to change hostname or port.
tunnel: $TUNNEL_ID
credentials-file: $CREDS
no-autoupdate: true
ingress:
  - hostname: $HOSTNAME_ARG
    service: http://127.0.0.1:$PORT
    originRequest:
      # WebSockets (/ws, /ws/terminal) are long-lived; never let the connector time them out on its own.
      connectTimeout: 30s
      keepAliveTimeout: 90s
  - service: http_status:404
YML
"$CLOUDFLARED" tunnel --config "$CF_DIR/config.yml" ingress validate >/dev/null || die "ingress rules in $CF_DIR/config.yml did not validate"
ok "wrote $CF_DIR/config.yml (→ http://127.0.0.1:$PORT)"

# ------------------------------------------------------------------ daemon config: publicUrl + trustProxy
node - "$MIDE_HOME/config.json" "$PUBLIC_URL" <<'JS'
const fs = require('fs');
const [p, url] = process.argv.slice(2);
const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
const before = c.publicUrl ?? null;
c.publicUrl = url;
c.trustProxy = true; // every request reaches the daemon from the local connector; trust its X-Forwarded-For for rate limits
fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
console.log(`  publicUrl: ${before ?? '(unset)'} → ${url}`);
JS
ok "daemon config updated ($MIDE_HOME/config.json)"

# ------------------------------------------------------------------ stop a quick tunnel if one is running
if pgrep -f 'cloudflared tunnel --url' >/dev/null 2>&1; then
  say "stopping the quick tunnel (its trycloudflare.com URL is superseded)"
  pkill -f 'cloudflared tunnel --url' || true
fi

# ------------------------------------------------------------------ systemd user unit
if [ "$INSTALL_SERVICE" -eq 1 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$UNIT_DIR"
  cp "$UNIT_SRC" "$UNIT_DIR/cloudflared-mide.service"
  systemctl --user daemon-reload
  systemctl --user enable --now cloudflared-mide.service >/dev/null 2>&1 || systemctl --user restart cloudflared-mide.service
  systemctl --user restart cloudflared-mide.service
  ok "systemd user unit cloudflared-mide.service is running (journalctl --user -u cloudflared-mide -f)"
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    echo "  note: run 'loginctl enable-linger $USER' once so the tunnel (and the daemon) survive logout."
  fi
else
  say "run the tunnel yourself (foreground):  cloudflared tunnel --config $CF_DIR/config.yml run"
fi

# ------------------------------------------------------------------ restart the daemon so the origin allowlist and pairing links follow publicUrl
restart_daemon() {
  if systemctl --user is-active --quiet mobile-ide.service 2>/dev/null; then
    systemctl --user restart mobile-ide.service; ok "restarted mobile-ide.service"; return
  fi
  local pid
  pid="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
  if [ -n "$pid" ]; then
    say "restarting the daemon (pid $pid, not under systemd — SIGINT, then relaunch with nohup)"
    kill -INT "$pid" 2>/dev/null || true
    for _ in $(seq 1 90); do ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q . || break; sleep 1; done
    (cd "$HOME" && MIDE_HOME="$MIDE_HOME" nohup mide serve >> "$MIDE_HOME/serve.log" 2>&1 &)
    for _ in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 1; done
    ok "daemon relaunched (log: $MIDE_HOME/serve.log)"
  else
    echo "  daemon is not running; start it with 'mide serve' or 'systemctl --user start mobile-ide'."
  fi
}
[ "$RESTART_DAEMON" -eq 1 ] && restart_daemon

# ------------------------------------------------------------------ verify through Cloudflare
say "checking $PUBLIC_URL/api/health through Cloudflare (DNS + connector registration can take ~30 s)"
code=""
for _ in $(seq 1 30); do
  code="$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$PUBLIC_URL/api/health" || true)"
  [ "$code" = "200" ] && break
  sleep 2
done
if [ "$code" = "200" ]; then
  ok "$PUBLIC_URL answers: $(curl -s -m 8 "$PUBLIC_URL/api/health")"
else
  echo "  not reachable yet (last HTTP status: ${code:-none}). Check: journalctl --user -u cloudflared-mide -n 30, and that the zone is active on Cloudflare."
fi

cat <<MSG

Done. Phone: open $PUBLIC_URL/ (Safari → Share → Add to Home Screen), then pair with:   mide pair --name iPhone
Already-paired devices keep their token — they only need the new server URL (Settings → server → $PUBLIC_URL).
Optional second login wall: Cloudflare Zero Trust → Access → Applications → self-hosted → $HOSTNAME_ARG (free ≤ 50 users).
MSG
