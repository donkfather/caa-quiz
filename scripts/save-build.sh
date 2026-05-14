#!/bin/bash
set -e

PROFILE="${1:-preview}"
DATE=$(date +%Y-%m-%d)
VERSION=$(node -p "require('./app.json').expo.version")
VCODE=$(node -p "require('./app.json').expo.android.versionCode")

NAS_DIR="$HOME/SynologyDrive/Projects/caa-quiz/builds/$PROFILE"
mkdir -p "$NAS_DIR"

if [ "$PROFILE" = "preview" ]; then
  SRC="build/preview.apk"
  DEST="$NAS_DIR/caa-quiz-${PROFILE}-v${VERSION}-${VCODE}-${DATE}.apk"
else
  SRC="build/production.aab"
  DEST="$NAS_DIR/caa-quiz-${PROFILE}-v${VERSION}-${VCODE}-${DATE}.aab"
fi

if [ ! -f "$SRC" ]; then
  echo "Build file not found: $SRC"
  exit 1
fi

cp "$SRC" "$DEST"
echo "Saved: $DEST"

# Send push notification via ntfy.sh
PROFILE_CAP=$(echo "${PROFILE:0:1}" | tr '[:lower:]' '[:upper:]')${PROFILE:1}
curl -s \
  -H "Title: CAA Quiz - ${PROFILE_CAP} Build" \
  -d "${PROFILE_CAP} build v${VERSION} (${VCODE}) saved to NAS" \
  ntfy.sh/bhdit-caa-quiz-builds > /dev/null 2>&1 || true
