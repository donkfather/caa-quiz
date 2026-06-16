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
NODE_BIN_DIR="$(brew --prefix node@22)/bin"
export PATH="$NODE_BIN_DIR:$PATH"
node --version
npm --version

# node@22 is keg-only, so it is NOT on PATH during the separate `xcodebuild
# archive` process. The "Bundle React Native code and images" phase resolves
# Node from ios/.xcode.env via `command -v node` and would fail. Pin NODE_BINARY
# explicitly: .xcode.env sources .xcode.env.local last, so this wins. The file
# is gitignored (machine-specific), so we create it fresh here in CI.
echo "export NODE_BINARY=\"$NODE_BIN_DIR/node\"" > ios/.xcode.env.local
echo "▸ Pinned NODE_BINARY → $NODE_BIN_DIR/node"

# RevenueCat PUBLIC iOS SDK key (appl_…) — a publishable key, safe to embed
# (already committed in eas.json). iOS builds via Xcode Cloud, which does NOT read
# eas.json, so inject it here. The "Bundle React Native code and images" phase runs
# `expo export:embed` and sources .xcode.env.local, so app.config.js can read
# EXPO_PUBLIC_RC_IOS_KEY when it evaluates `extra`. Without this the Purchases SDK
# stays disabled in the build and the Remove-Ads IAP never appears.
echo "export EXPO_PUBLIC_RC_IOS_KEY=\"appl_kavuEwwxMyoJRMqTPNbStdRlbyw\"" >> ios/.xcode.env.local
echo "▸ Injected EXPO_PUBLIC_RC_IOS_KEY"

echo "▸ Installing JS dependencies…"
npm ci

echo "▸ Installing CocoaPods…"
cd ios
pod install

echo "▸ Post-clone complete."
