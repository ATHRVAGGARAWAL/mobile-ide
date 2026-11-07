#!/usr/bin/env bash
# (Re)start a scratch daemon for the Studio QA: its own MIDE_HOME, a throwaway git repo as the only project root, and the stub
# agent (apps/server/test/fixtures/stub-agent.ts) as the only agent — no tokens are ever spent. Then run `node drive.mjs`.
# Env: MIDE_QA_HOME (default /tmp/mide-studio-test), MIDE_QA_REPO (default /tmp/mide-studio-repo), MIDE_QA_PORT (default 4899),
#      MIDE_QA_AUTO_OPEN=true to exercise the launcher (a real browser window appears on this desktop).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOME_DIR="${MIDE_QA_HOME:-/tmp/mide-studio-test}"
REPO="${MIDE_QA_REPO:-/tmp/mide-studio-repo}"
PORT="${MIDE_QA_PORT:-4899}"
AUTO_OPEN="${MIDE_QA_AUTO_OPEN:-false}"
pid=$(ss -ltnp 2>/dev/null | grep -E ":$PORT\s" | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1)
[[ -n "$pid" ]] && kill "$pid" 2>/dev/null && sleep 1
mkdir -p "$HOME_DIR"
if [[ ! -d "$REPO/.git" ]]; then
  mkdir -p "$REPO/src" && cd "$REPO" && git init -q && printf 'export function hello(name: string) {\n  return `hello ${name}`;\n}\n\nexport const answer = 42;\n' > src/app.ts &&
    printf '# Demo\n\nA tiny repo for the Studio QA.\n' > README.md && git add -A && git -c user.email=qa@example.com -c user.name=qa commit -qm init
fi
cat > "$HOME_DIR/config.json" <<JSON
{ "port": $PORT, "projects": { "roots": ["$REPO"] },
  "agents": { "stub": { "name": "Stub Agent", "command": "$ROOT/node_modules/.bin/tsx", "args": ["$ROOT/apps/server/test/fixtures/stub-agent.ts"], "enabled": true } },
  "studio": { "autoOpen": $AUTO_OPEN } }
JSON
cd "$ROOT/apps/server" || exit 1
MIDE_HOME="$HOME_DIR" MIDE_LOG=debug setsid node --import tsx src/cli.ts serve > "$HOME_DIR/daemon.log" 2>&1 &
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.5; done
curl -s "http://127.0.0.1:$PORT/api/health"; echo
