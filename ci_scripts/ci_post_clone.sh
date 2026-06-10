#!/bin/zsh

# Xcode Cloud post-clone step.
#
# This is an Expo project: the native `ios/` folder is committed, but `Pods/`
# and `node_modules/` are not. Xcode Cloud images ship Homebrew + CocoaPods but
# NOT Node, so we install Node, restore JS deps (needed by the "Bundle React
# Native code and images" phase, which runs `expo export:embed` during archive),
# then install Pods.
#
# Required workflow environment variables (set in App Store Connect → Xcode
# Cloud → Workflow → Environment):
#   EXPO_PUBLIC_SUPABASE_URL
#   EXPO_PUBLIC_SUPABASE_KEY
#   EXPO_ROUTER_APP_ROOT=./app
# Do NOT set EXPO_PUBLIC_USE_TEST_ADS (its absence selects real AdMob units).

set -euo pipefail

cd "$CI_PRIMARY_REPOSITORY_PATH"

echo "▸ Installing Node…"
export HOMEBREW_NO_INSTALL_CLEANUP=1
export HOMEBREW_NO_AUTO_UPDATE=1
brew install node@22
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
npm --version

echo "▸ Installing JS dependencies…"
npm ci

echo "▸ Installing CocoaPods…"
cd ios
pod install

echo "▸ Post-clone complete."
