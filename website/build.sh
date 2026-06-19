#!/usr/bin/env bash
# Assemble website/dist with only the files the page serves.
# The page references shared icons (/assets) and screenshots (/store-assets)
# that live at the repo root, so they are copied in selectively here — this
# deliberately excludes questions.json, backups, the iOS screenshot tree, etc.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/assets dist/store-assets

# Page + SEO files
cp index.html styles.css site.webmanifest sitemap.xml robots.txt og-image.png dist/

# Icons referenced by the page and the web manifest
cp ../assets/favicon.png ../assets/icon.png ../assets/adaptive-icon.png dist/assets/

# App screenshots used in the hero and the gallery
cp ../store-assets/caa-quiz1.jpeg ../store-assets/caa-quiz2.jpeg \
   ../store-assets/caa-quiz3.jpeg ../store-assets/caa-quiz4.jpeg \
   ../store-assets/caa-quiz5.jpeg ../store-assets/caa-quiz6.jpeg dist/store-assets/

echo "Built dist/ ($(find dist -type f | wc -l | tr -d ' ') files)"
