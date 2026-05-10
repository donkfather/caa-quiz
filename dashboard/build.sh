#!/usr/bin/env bash
# Build a `dist/` ready to deploy to Cloudflare Pages.
#
# Required env (or read from ../.env.local):
#   EXPO_PUBLIC_SUPABASE_URL  — your Supabase project URL
#   EXPO_PUBLIC_SUPABASE_KEY  — the anon key (safe to embed)
#
# Usage:
#   ./dashboard/build.sh
#   wrangler pages deploy dashboard/dist --project-name caahq

set -euo pipefail
cd "$(dirname "$0")"

# Pull env from .env.local if not already in environment
if [[ -f ../.env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  . ../.env.local
  set +a
fi

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
