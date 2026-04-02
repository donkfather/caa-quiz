# Chestionare Barca (caa-quiz)

Romanian boating license quiz app built with Expo (React Native).

## Setup

```bash
npm install
```

## Development

```bash
npm run start              # Expo dev server
npm run android            # Run on Android
npm run ios                # Run on iOS
npm run web                # Run on web
```

**Note:** The `EXPO_ROUTER_APP_ROOT` env var is set automatically in npm scripts.

## Building

### Preview (APK with test ads)

```bash
npm run build:preview
```

### Production (AAB with real ads)

```bash
npm run build:production
```

Both commands build locally via EAS and save the artifact to `~/SynologyDrive/Projects/caa-quiz/builds/{profile}/`.

### Remote builds (via EAS)

```bash
eas build --platform android --profile preview
eas build --platform android --profile production
```

## Project Structure

```
app/              — Expo Router screens (file-based routing)
src/
  components/     — Reusable components (AdBanner, etc.)
  lib/            — Utilities (ads, settings, themes, vouchers)
scripts/          — Build automation
```
