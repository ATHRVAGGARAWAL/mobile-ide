#!/usr/bin/env bash
# scripts/dev.sh — the whole dev loop in one command, stopped by one Ctrl-C.
#
#   1. builds @mobile-ide/core (the daemon and the app both import its dist/) — in watch mode via `tsc --watch`
#   2. starts the daemon from source            apps/server:  tsx watch src/cli.ts serve  (restarts on source changes)
#   3. starts the Expo web dev server           apps/mobile:  expo start --web
#      and rebuilds the Studio on change         apps/studio:  node build.mjs --watch  (served by the daemon at /studio/)
#   4. prints the URLs plus a ready-to-open pairing link once both answer
#   5. Ctrl-C stops everything in order (running agent turns get a few seconds); a second Ctrl-C a moment later force-kills
#
# Usage: scripts/dev.sh [options]        (or: pnpm dev -- [options])
#   --no-watch         run the daemon without auto-restart (default: tsx watch + tsc --watch restart it on server/core changes)
#   --port <n>         daemon port (default: "port" in the config file; 4820 on a fresh install)
#   --app-port <n>     Expo/Metro port (default 8081)
#   --home <dir>       MIDE_HOME for the daemon: config.json and mide.db live there (default ~/.mobile-ide)
#   --server-only      daemon only
#   --app-only         Expo only (pair it with a daemon running elsewhere)
#   --no-studio        do not build/watch the Studio bundle
#   --no-pair          do not mint a pairing code / print a pairing link
#   --raw-logs         pass the daemon's JSON log lines through unchanged instead of pretty-printing them
#   -h, --help         this text
#
# Environment
#   MIDE_HOME          same as --home
#   MIDE_LOG           daemon log level: debug | info | warn | error (default info)
#   MIDE_DRAIN_MS      how long Ctrl-C waits for a running agent turn (default 10000 here; the daemon alone defaults to 60000)
#   BROWSER=none       keep Expo from opening a browser tab (headless sessions)
#   NO_COLOR=1         plain output
#
# Needs node >= 22.5, pnpm and a completed `pnpm install`. Works from any cwd; the repo path may contain spaces.

set -uo pipefail
# No job control: background children then stay in our process group, so `setsid` below does not fork and the
# pid bash reports for a child is also the id of the new process group we later signal as a whole.
set +m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/apps/server"
APP_DIR="$ROOT/apps/mobile"
STUDIO_DIR="$ROOT/apps/studio"
CORE_DIR="$ROOT/packages/core"

# ------------------------------------------------------------------ options
WATCH=1
SERVER_PORT=''
APP_PORT=8081
RUN_SERVER=1
RUN_APP=1
RUN_STUDIO=1
PAIR=1
RAW_LOGS=0
HOME_DIR="${MIDE_HOME:-}"

usage() { sed -n '/^# Usage/,/^# Needs/p' "${BASH_SOURCE[0]}" | sed -E 's/^# ?//'; }
die() {
  printf 'dev.sh: %s\n' "$*" >&2
  exit 1
}
is_port() { [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }

while (($#)); do
  case "$1" in
    --watch) WATCH=1 ;;
    --no-watch) WATCH=0 ;;
    --port) SERVER_PORT="${2-}"; shift ;;
    --port=*) SERVER_PORT="${1#*=}" ;;
    --app-port) APP_PORT="${2-}"; shift ;;
    --app-port=*) APP_PORT="${1#*=}" ;;
    --home) HOME_DIR="${2-}"; shift ;;
    --home=*) HOME_DIR="${1#*=}" ;;
    --server-only) RUN_APP=0 ;;
    --app-only) RUN_SERVER=0; RUN_STUDIO=0 ;;
    --no-studio) RUN_STUDIO=0 ;;
    --no-pair) PAIR=0 ;;
    --raw-logs) RAW_LOGS=1 ;;
    -h | --help) usage; exit 0 ;;
    --) ;; # end-of-options marker, e.g. `pnpm dev -- --port 4821` (pnpm passes it through)
    *) die "unknown option '$1' (see --help)" ;;
  esac
  shift
done
[[ -z "$SERVER_PORT" ]] || is_port "$SERVER_PORT" || die "--port must be an integer in 1..65535"
is_port "$APP_PORT" || die "--app-port must be an integer in 1..65535"
((RUN_SERVER || RUN_APP)) || die "--server-only and --app-only exclude each other"
[[ -n "$HOME_DIR" ]] && export MIDE_HOME="$HOME_DIR"
export MIDE_LOG="${MIDE_LOG:-info}"
[[ "${MIDE_DRAIN_MS:-}" =~ ^[0-9]+$ ]] || MIDE_DRAIN_MS=10000
export MIDE_DRAIN_MS

# ------------------------------------------------------------------ output
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\e[0m' C_BOLD=$'\e[1m' C_DIM=$'\e[2m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m'
  C_BLUE=$'\e[34m' C_MAGENTA=$'\e[35m' C_CYAN=$'\e[36m'
  DEV_COLOR=1
else
  C_RESET='' C_BOLD='' C_DIM='' C_GREEN='' C_YELLOW='' C_BLUE='' C_MAGENTA='' C_CYAN=''
  DEV_COLOR=0
fi
TAG_DEV="${C_BOLD}[dev]${C_RESET}"
TAG_CORE="${C_CYAN}[core]${C_RESET}"
TAG_SERVER="${C_BLUE}[server]${C_RESET}"
TAG_APP="${C_MAGENTA}[app]${C_RESET}"
TAG_STUDIO="${C_GREEN}[studio]${C_RESET}"
say() { printf '%s %s\n' "$TAG_DEV" "$*"; }
warn() { printf '%s %s%s%s\n' "$TAG_DEV" "$C_YELLOW" "$*" "$C_RESET" >&2; }

# The daemon logs one JSON object per line (see apps/server/src/log.ts). This turns them into
# `[server] 12:34:56 info  mod message key=value …`; anything that is not JSON passes through.
read -r -d '' PRETTY_JS <<'__PRETTY_JS__' || true
const readline = require('node:readline');
// Node resets inherited signal dispositions at startup, so the shell's `trap ''` does not protect this process:
// ignore Ctrl-C & co. explicitly and keep draining until the daemon closes its end of the pipe.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {});
const color = process.env.DEV_COLOR === '1';
const tag = process.env.DEV_TAG || '[server]';
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const LEVELS = { debug: ['2', 'debug'], info: ['32', 'info '], warn: ['33', 'warn '], error: ['31', 'error'] };
const fmt = (v) => (typeof v === 'string' && v !== '' && !/[\s"=]/.test(v) ? v : JSON.stringify(v));
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let rec;
  if (line.startsWith('{')) {
    try { rec = JSON.parse(line); } catch { rec = undefined; }
  }
  if (!rec || typeof rec !== 'object' || typeof rec.msg !== 'string') {
    process.stdout.write(`${tag} ${line}\n`);
    return;
  }
  const { ts, level, msg, mod, ...rest } = rec;
  const time = typeof ts === 'string' && !Number.isNaN(Date.parse(ts)) ? new Date(ts).toTimeString().slice(0, 8) : '--:--:--';
  const [code, label] = LEVELS[level] ?? ['0', String(level ?? '').padEnd(5).slice(0, 5)];
  const fields = Object.entries(rest).map(([k, v]) => `${k}=${fmt(v)}`).join(' ');
  const scope = mod ? paint('36', String(mod)) + ' ' : '';
  process.stdout.write(`${tag} ${paint('2', time)} ${paint(code, label)} ${scope}${msg}${fields ? ' ' + paint('2', fields) : ''}\n`);
});
__PRETTY_JS__

# Small helpers that run through the server's own library API (apps/server/src/index.ts) so this script never
# parses CLI output. `--import tsx` runs the TypeScript sources directly.
read -r -d '' RESOLVE_JS <<'__RESOLVE_JS__' || true
import { loadConfig } from './src/index.ts';
const l = loadConfig();
console.log(JSON.stringify({ port: l.config.port, home: l.home, configPath: l.configPath, publicUrl: l.config.publicUrl }));
__RESOLVE_JS__
read -r -d '' MINT_JS <<'__MINT_JS__' || true
import { loadConfig, Db, generatePairingCode } from './src/index.ts';
const db = new Db(loadConfig().dbPath);
try {
  const code = generatePairingCode();
  db.createPairingCode(code);
  console.log(code);
} finally {
  db.close();
}
__MINT_JS__

# Output filters run in OUR process group and ignore Ctrl-C, so they still drain the last lines a child prints
# while it shuts down. They exit on their own when the child's stdout closes.
prefix_filter() {
  trap '' INT TERM HUP
  exec sed -u "s/^/$1 /"
}
pretty_filter() {
  trap '' INT TERM HUP
  exec env DEV_COLOR="$DEV_COLOR" DEV_TAG="$1" node -e "$PRETTY_JS"
}
# prefix_filter for `tsc --watch`, plus: create the marker file once the first compile has been emitted, so the
# daemon starts only after dist/ is complete (tsx would otherwise restart it immediately on the fresh files).
CORE_READY="${TMPDIR:-/tmp}/mide-dev-core-ready.$$"
core_filter() {
  trap '' INT TERM HUP
  exec awk -v tag="$1" -v ready="$CORE_READY" '{ print tag " " $0; fflush(); if (index($0, "Watching for file changes")) system("touch \"" ready "\"") }'
}

# ------------------------------------------------------------------ process management
declare -A PID=()      # name -> pid of the child (== its process group id, see `set +m` above)
declare -A SIGMODE=()  # name -> group | leader : whether Ctrl-C is forwarded to the whole group or only the leader

# start <name> <tag> <filter-fn> <how> <dir> <command...>
#   how=group  : the command is the real process (node, tsc, expo); signal its whole group
#   how=leader : the command is a supervisor that relays signals itself (tsx watch); signal only it — its child
#                would otherwise see two SIGINTs, and the daemon treats the second one as "force quit"
start() {
  local name="$1" tag="$2" filter="$3" how="$4" dir="$5"
  shift 5
  (cd "$dir" && exec setsid "$@") </dev/null > >("$filter" "$tag") 2>&1 &
  PID[$name]=$!
  SIGMODE[$name]=$how
  say "starting $name ${C_DIM}(pid $!: $*)${C_RESET}"
}

alive() { kill -0 "$1" 2>/dev/null; }
group_alive() { kill -0 -- "-$1" 2>/dev/null; }
any_alive() {
  local pid
  for pid in "${PID[@]}"; do group_alive "$pid" && return 0; done
  return 1
}
signal_child() { # signal_child <name> <SIG>
  local pid="${PID[$1]}"
  if [[ "${SIGMODE[$1]}" == leader ]] && alive "$pid"; then kill "-$2" "$pid" 2>/dev/null || true; else kill "-$2" -- "-$pid" 2>/dev/null || true; fi
}

# Give the output filters a moment to flush what the children printed while stopping. They exit on EOF, which
# arrives once every writer is gone — and a straggler in uninterruptible sleep (Metro's DevTools helpers at
# startup) can hold a pipe open for a while, so this is bounded: never `wait` for them.
drain_filters() {
  local i kids
  for ((i = 0; i < 20; i++)); do
    read -r -a kids < "/proc/$$/task/$$/children" 2>/dev/null || return 0
    ((${#kids[@]} == 0)) && return 0
    sleep 0.1
  done
}

STOPPING=0
STOP_AT_US=0
now_us() { local t="${EPOCHREALTIME:-}"; t="${t/./}"; printf '%s' "${t:-$((SECONDS * 1000000))}"; }
stop_all() { # stop_all <exit-code>
  local code="${1:-0}" name pid waited=0 grace
  if ((STOPPING)); then
    # `pnpm dev` / `npm run` relay the terminal's Ctrl-C to us as a second signal within milliseconds of the first;
    # only a second signal that arrives noticeably later means "force".
    (($(now_us) - STOP_AT_US < 1500000)) && return 0
    warn 'forcing'
    for pid in "${PID[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
    exit 130
  fi
  STOPPING=1
  STOP_AT_US=$(now_us)
  grace=$((MIDE_DRAIN_MS / 1000 + 20))
  say "stopping ${C_DIM}(a running agent turn gets up to $((MIDE_DRAIN_MS / 1000)) s; Ctrl-C again to force)${C_RESET}"
  for name in "${!PID[@]}"; do signal_child "$name" INT; done
  while ((waited < grace * 10)) && any_alive; do
    sleep 0.1
    waited=$((waited + 1))
  done
  if any_alive; then
    warn "still running after ${grace}s, killing"
    for pid in "${PID[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
    sleep 1
    for pid in "${PID[@]}"; do kill -KILL -- "-$pid" 2>/dev/null || true; done
  fi
  ((${#PID[@]})) && wait "${PID[@]}" 2>/dev/null
  drain_filters
  say 'stopped'
  exit "$code"
}
on_exit() { # last resort if the script dies some other way: never leave the daemon or Metro orphaned
  local pid
  for pid in "${PID[@]}"; do group_alive "$pid" && kill -TERM -- "-$pid" 2>/dev/null; done
  rm -f "$CORE_READY"
  return 0
}
trap 'stop_all 130' INT TERM HUP
trap on_exit EXIT

# ------------------------------------------------------------------ probes
port_in_use() {
  node -e "const s=require('node:net').connect({port:Number(process.argv[1]),host:'127.0.0.1'});s.once('connect',()=>{s.destroy();process.exit(0)});s.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)" "$1"
}
http_ok() { # prints the body of a 2xx response
  node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(2000)}).then(async(r)=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text());process.exit(0)}).catch(()=>process.exit(1))" "$1"
}
wait_for() { # wait_for <name> <url> <seconds>  → body on stdout; 1 = timeout, 2 = the child died
  local name="$1" url="$2" ticks=$(($3 * 2)) body
  while ((ticks-- > 0)); do
    alive "${PID[$name]}" || return 2
    if body="$(http_ok "$url")"; then
      printf '%s' "$body"
      return 0
    fi
    sleep 0.5
  done
  return 1
}
urlencode() { printf '%s' "$1" | sed 's#:#%3A#g; s#/#%2F#g'; }

# ------------------------------------------------------------------ prerequisites
command -v node >/dev/null 2>&1 || die 'node not found on PATH'
node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>22||(M===22&&m>=5)?0:1)' ||
  die "node >= 22.5 required (found $(node --version)); 24 recommended"
command -v pnpm >/dev/null 2>&1 || die 'pnpm not found (corepack enable, or npm i -g pnpm)'
[[ -d "$ROOT/node_modules" ]] || die "no node_modules — run \`pnpm install\` in $ROOT first"
TSX_BIN="$ROOT/node_modules/.bin/tsx"
TSC_BIN="$ROOT/node_modules/.bin/tsc"
if [[ -x "$APP_DIR/node_modules/.bin/expo" ]]; then EXPO_BIN="$APP_DIR/node_modules/.bin/expo"; else EXPO_BIN="$ROOT/node_modules/.bin/expo"; fi
[[ -x "$TSC_BIN" ]] || die "tsc not found at $TSC_BIN — run \`pnpm install\`"
((RUN_SERVER)) && [[ ! -x "$TSX_BIN" ]] && die "tsx not found at $TSX_BIN — run \`pnpm install\`"
((RUN_APP)) && [[ ! -x "$EXPO_BIN" ]] && die "expo CLI not found — run \`pnpm install\`"

# ------------------------------------------------------------------ core (server and app import packages/core/dist)
if ((WATCH)); then
  say 'compiling @mobile-ide/core (tsc --watch)'
  start core "$TAG_CORE" core_filter group "$CORE_DIR" "$TSC_BIN" -p tsconfig.json --watch --preserveWatchOutput
  ticks=240
  while [[ ! -e "$CORE_READY" ]] && ((ticks-- > 0)); do
    alive "${PID[core]}" || die 'tsc --watch exited (see the [core] lines above)'
    sleep 0.5
  done
  [[ -e "$CORE_READY" ]] || warn 'tsc --watch has not finished its first compile after 120 s; continuing anyway'
else
  say 'building @mobile-ide/core'
  if ! (cd "$ROOT" && pnpm --filter @mobile-ide/core build) 2>&1 | sed -u "s/^/$TAG_CORE /"; then
    die 'core build failed'
  fi
fi

# ------------------------------------------------------------------ daemon config + port checks
SERVER_URL=''
CONFIG_HOME=''
if ((RUN_SERVER)); then
  if ! CONFIG_JSON="$(cd "$SERVER_DIR" && MIDE_LOG=warn node --import tsx --input-type=module -e "$RESOLVE_JS")"; then
    die 'could not load the daemon config (see the error above)'
  fi
  CONFIG_HOME="$(node -p 'JSON.parse(process.argv[1]).home' "$CONFIG_JSON")"
  [[ -n "$SERVER_PORT" ]] || SERVER_PORT="$(node -p 'JSON.parse(process.argv[1]).port' "$CONFIG_JSON")"
  SERVER_URL="http://127.0.0.1:$SERVER_PORT"
  if port_in_use "$SERVER_PORT"; then
    die "port $SERVER_PORT is already in use. Another daemon (the systemd unit? \`systemctl --user stop mobile-ide\`) — or pass --port <n>."
  fi
fi
if ((RUN_APP)) && port_in_use "$APP_PORT"; then
  die "port $APP_PORT is already in use (another Metro?) — pass --app-port <n>."
fi

# ------------------------------------------------------------------ start
if ((RUN_SERVER)); then
  server_filter=pretty_filter
  ((RAW_LOGS)) && server_filter=prefix_filter
  if ((WATCH)); then
    start server "$TAG_SERVER" "$server_filter" leader "$SERVER_DIR" "$TSX_BIN" watch --clear-screen=false src/cli.ts serve --port "$SERVER_PORT"
  else
    start server "$TAG_SERVER" "$server_filter" group "$SERVER_DIR" node --import tsx src/cli.ts serve --port "$SERVER_PORT"
  fi
fi
if ((RUN_APP)); then
  # CI=1 keeps Expo's interactive keyboard UI off (its stdin is /dev/null); the web bundle still serves on demand.
  start app "$TAG_APP" prefix_filter group "$APP_DIR" env CI=1 "$EXPO_BIN" start --web --port "$APP_PORT"
fi
if ((RUN_STUDIO)); then
  # The daemon serves apps/studio/dist at /studio/ straight from disk, so a rebuild is live on the next reload.
  start studio "$TAG_STUDIO" prefix_filter group "$STUDIO_DIR" node build.mjs --watch
fi

# ------------------------------------------------------------------ readiness + pairing link
CODE=''
if ((RUN_SERVER)); then
  if health="$(wait_for server "$SERVER_URL/api/health" 90)"; then
    say "daemon ready at $SERVER_URL ${C_DIM}($(node -p 'const h=JSON.parse(process.argv[1]);`${h.serverName} v${h.version}`' "$health"))${C_RESET}"
  else
    rc=$?
    ((rc == 2)) && { warn 'the daemon exited while starting (see the [server] lines above)'; stop_all 1; }
    warn "no answer from $SERVER_URL/api/health after 90 s; continuing, check the [server] output"
  fi
  if ((PAIR)); then
    if CODE="$(cd "$SERVER_DIR" && MIDE_LOG=warn node --import tsx --input-type=module -e "$MINT_JS")"; then :; else
      warn 'could not mint a pairing code (run `mide pair` yourself)'
      CODE=''
    fi
  fi
fi
if ((RUN_APP)); then
  if wait_for app "http://localhost:$APP_PORT/" 180 >/dev/null; then
    say "web app ready at http://localhost:$APP_PORT"
  else
    rc=$?
    ((rc == 2)) && { warn 'Expo exited while starting (see the [app] lines above)'; stop_all 1; }
    warn "Metro is not answering on http://localhost:$APP_PORT yet; it may still be starting"
  fi
fi

say ''
say "${C_GREEN}ready${C_RESET}"
((RUN_SERVER)) && say "  daemon    $SERVER_URL   ${C_DIM}state: $CONFIG_HOME   logs: MIDE_LOG=$MIDE_LOG${C_RESET}"
((RUN_APP)) && say "  web app   http://localhost:$APP_PORT"
((RUN_SERVER && RUN_STUDIO)) && say "  studio    $SERVER_URL/studio/   ${C_DIM}pops up on session start; open now: MIDE_HOME=$CONFIG_HOME mide studio${C_RESET}"
if [[ -n "$CODE" ]]; then
  if ((RUN_APP)); then
    say "  pair      http://localhost:$APP_PORT/pair?server=$(urlencode "$SERVER_URL")#$CODE"
  else
    say "  pair      $SERVER_URL/pair#$CODE"
  fi
  say "            ${C_DIM}code ${CODE:0:4}-${CODE:4} · single use · 10 min · another: MIDE_HOME=$CONFIG_HOME mide pair${C_RESET}"
elif ((RUN_APP && !RUN_SERVER)); then
  say "  pair      enter your daemon's URL (e.g. http://127.0.0.1:4820) and a code from \`mide pair\`"
fi
((WATCH)) && say "  ${C_DIM}watch: the daemon restarts when apps/server/src or packages/core change${C_RESET}"
say 'Ctrl-C stops everything.'
say ''

# ------------------------------------------------------------------ supervise: the first child to exit takes the others down
while ((${#PID[@]})); do
  DEAD=''
  if wait -n -p DEAD "${PID[@]}"; then status=0; else status=$?; fi
  [[ -n "$DEAD" ]] || { ((status == 127)) && break; continue; } # interrupted by a signal → the trap handles it
  dead_name=''
  for name in "${!PID[@]}"; do [[ "${PID[$name]}" == "$DEAD" ]] && dead_name="$name"; done
  [[ -n "$dead_name" ]] && unset "PID[$dead_name]"
  ((STOPPING)) && continue
  warn "${dead_name:-a child} exited with status $status — stopping the rest"
  stop_all "$status"
done
stop_all 0
