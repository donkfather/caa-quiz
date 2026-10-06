#!/bin/bash
# Android release, built on EAS (Expo's cloud) instead of this machine.
#
#   scripts/release-android.sh            build on EAS, download the bundle to build/
#   scripts/release-android.sh --upload   ...and put it on Play's internal testing track
#
# EAS holds the upload key and the build counter (eas.json: appVersionSource
# "remote" + autoIncrement), so there is no key and no version number to pass.
# The Play upload stays here, with the service account read from 1Password.
set -euo pipefail
cd "$(dirname "$0")/.."

EAS=${EAS:-npx --yes eas-cli@latest}
PACKAGE=com.bhdit.caaquiz
PLAY_UPLOAD=${PLAY_UPLOAD:-$HOME/homelab/appstore/builder-expo/play-upload.mjs}
UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1

# EAS builds the working tree, committed or not. Say so rather than ship it silently.
if [ -n "$(git status --porcelain)" ]; then
  echo "warning: uncommitted changes will be part of this build" >&2
fi

mkdir -p build
META=build/eas-android-build.json
$EAS build --platform android --profile production --non-interactive --wait --json > "$META"

read -r STATUS VERSION CODE URL < <(node -e '
  const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0];
  console.log(b.status, b.appVersion, b.appBuildVersion, b.artifacts?.buildUrl ?? "-");
' "$META")
[ "$STATUS" = "FINISHED" ] && [ "$URL" != "-" ] || { echo "EAS build did not finish: $STATUS (see $META)" >&2; exit 1; }

AAB="build/caa-quiz-$VERSION-$CODE.aab"
curl -fL --retry 3 -o "$AAB" "$URL"

# R8 is on, so the bundle must carry its own map; Play reads it from there.
# (grep reads to the end on purpose: with pipefail, grep -q would end unzip
# with SIGPIPE on the first match and the check would fail on success)
unzip -Z1 "$AAB" | grep -Fx "BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map" >/dev/null \
  || { echo "$AAB has no R8 map inside: was minification turned off?" >&2; exit 1; }
echo "built $AAB"

if [ "$UPLOAD" = 1 ]; then
  op document get "Play SA claude-499612" --vault Claude \
    | node "$PLAY_UPLOAD" upload --package "$PACKAGE" --aab "$AAB" --track internal \
        --release-name "$VERSION ($CODE)" ${NOTES_RO:+--notes-ro "$NOTES_RO"}
fi
