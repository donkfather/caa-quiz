#!/usr/bin/env bash
# Build a `dist/` ready to deploy to Cloudflare Pages.
#
# Required env (or read from ../.env.local):
#   EXPO_PUBLIC_SUPABASE_URL  — Supabase project URL
#   EXPO_PUBLIC_SUPABASE_KEY  — anon key (safe to embed)
#
# Usage:
#   ./dashboard/build.sh                # prod build — sources ../.env.local
#   ./dashboard/build.sh --env dev      # local build — sources ../.env.local.dev
#                                       # (created automatically from `supabase start` output)

set -euo pipefail
cd "$(dirname "$0")"

ENV_NAME="prod"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ "$ENV_NAME" == "prod" ]]; then
  ENV_FILE="../.env.local"
else
  ENV_FILE="../.env.local.$ENV_NAME"
fi

# Pull env from the chosen file if not already in environment
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  set +a
elif [[ "$ENV_NAME" != "prod" ]]; then
  echo "ERROR: $ENV_FILE not found. Run 'supabase start' and copy its URL/key into $ENV_FILE." >&2
  exit 1
fi

echo "[build] env=$ENV_NAME (from $ENV_FILE)"

if [[ -z "${EXPO_PUBLIC_SUPABASE_URL:-}" || -z "${EXPO_PUBLIC_SUPABASE_KEY:-}" ]]; then
  echo "ERROR: set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY" >&2
  exit 1
fi

rm -rf dist && mkdir -p dist
cp index.html styles.css app.js dist/

# Inject runtime config. We replace placeholders rather than building a
# bundle — the dashboard intentionally has no build step.
sed -e "s|__SUPABASE_URL__|${EXPO_PUBLIC_SUPABASE_URL}|g" \
    -e "s|__SUPABASE_ANON_KEY__|${EXPO_PUBLIC_SUPABASE_KEY}|g" \
    config.js > dist/config.js

# Cache-bust app.js / styles.css references so a deploy is guaranteed to
# replace stale copies in the browser, regardless of CDN/edge cache TTL.
DEPLOY_TS=$(date +%s)
sed -i.bak \
    -e "s|app\.js|app.js?v=${DEPLOY_TS}|g" \
    -e "s|styles\.css|styles.css?v=${DEPLOY_TS}|g" \
    dist/index.html && rm dist/index.html.bak

# A minimal _headers file so the dashboard isn't iframed and asset caching
# is sensible. Cloudflare Pages reads this automatically.
cat > dist/_headers <<'EOF'
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/index.html
  Cache-Control: no-cache

/*.js
  Cache-Control: public, max-age=300

/*.css
  Cache-Control: public, max-age=300
EOF

# SPA-style fallback: every unknown path returns index.html. We don't have
# routes today, but this keeps deep links from 404'ing.
cat > dist/_redirects <<'EOF'
/*    /index.html    200
EOF

echo "built dashboard/dist  ($(du -sh dist | cut -f1))"
echo
echo "deploy with:"
echo "  cd dashboard && wrangler pages deploy dist --project-name caahq"
