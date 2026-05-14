#!/usr/bin/env bash
# Live-reload dev server for the CAA HQ dashboard.
#   • Builds dist/ once.
#   • Watches index.html / app.js / styles.css / config.js for edits and rebuilds.
#   • Serves dist/ on http://localhost:3000 with browser auto-reload on dist changes.
#
# Defaults to the LOCAL Supabase stack (`--env dev`, reads ../.env.local.dev).
# Pass `--env prod` to point at production. ⚠ that means live writes.
#
# Usage:
#   ./dashboard/dev.sh                  # local Supabase
#   ./dashboard/dev.sh --env prod       # production (be careful)
set -euo pipefail
cd "$(dirname "$0")"

ENV_NAME="dev"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

./build.sh --env "$ENV_NAME"
echo
if [[ "$ENV_NAME" == "prod" ]]; then
  printf "\033[31;1m⚠ POINTING AT PROD — writes hit live data.\033[0m\n"
fi
echo "▶ watching source files · live-server on http://localhost:3000  (env=$ENV_NAME)"
echo

# Pick watcher: fswatch (brew) when available, else chokidar-cli via npx.
start_watcher() {
  if command -v fswatch >/dev/null 2>&1; then
    fswatch -o index.html app.js styles.css config.js | while read -r _; do
      printf "\033[2m[rebuild %s]\033[0m\n" "$(date +%H:%M:%S)"
      ./build.sh --env "$ENV_NAME" >/dev/null
    done
  else
    npx --yes chokidar-cli \
      "index.html" "app.js" "styles.css" "config.js" \
      -c "./build.sh --env $ENV_NAME >/dev/null && echo \"[rebuilt \$(date +%H:%M:%S)]\""
  fi
}

start_watcher &
WATCH_PID=$!
trap 'kill $WATCH_PID 2>/dev/null || true' EXIT INT TERM

# live-server serves dist/ and pushes a reload event whenever a file in
# dist/ changes. The injected snippet handles the browser side; no plugin.
npx --yes live-server --port=3000 --no-browser --quiet dist
