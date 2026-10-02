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
npm test                   # Access rules + scenario tests (node --test, Node >= 23.6)
```

**Note:** The `EXPO_ROUTER_APP_ROOT` env var is set automatically in npm scripts.

## Access model

No ads. Every device gets a **5-day free trial** with full access, started
from a one-time intro screen; after it ends a full-screen lock screen blocks
the app until the user buys the **one-time unlock** (no subscription) or
restores it. People who bought the old "remove ads" purchase are unlocked
automatically — it is the same store product.

| Rule | Where it lives |
|---|---|
| Who has paid | App Store / Google Play, read through RevenueCat entitlement **`no_ads`** (`src/lib/purchases.ts`). The id predates this model; renaming it would lock out past buyers. |
| When a trial started | Supabase `public.trials` (hashed device key), via the `start_trial` / `get_trial` RPCs (`supabase/migrations/20261002000000_trials.sql`). Trial length is `public.trial_length()`. |
| How the inputs combine | `src/lib/accessCore.ts` — pure, tested by `npm test` |
| Gathering inputs, caching, offline | `src/lib/access.ts`, device key in `src/lib/deviceKey.ts` |
| What the app shows | `AccessProvider` (`src/lib/AccessContext.tsx`) in `app/_layout.tsx`: `TrialIntro` → app → `Paywall` |

Details, offline behaviour and the release checklist:
[`docs/MONETIZATION.md`](./docs/MONETIZATION.md).

## Building

### Preview (sideloadable APK)

```bash
npm run build:preview
```

Preview builds have a separate package id (`….preview`), an orange icon and a
**"Expiră perioada de probă (preview)"** button in Settings for testing the lock
screen. They carry no RevenueCat key, so buying and restoring are unavailable in
them.

### Production (AAB for Play Console)

```bash
npm run build:production
```

Both commands build locally via EAS and save the artifact to `~/SynologyDrive/Projects/caa-quiz/builds/{profile}/`.

iOS builds run on Xcode Cloud (`ci_scripts/ci_post_clone.sh`).

### Remote builds (via EAS)

```bash
eas build --platform android --profile preview
eas build --platform android --profile production
```

## Project Structure

```
app/              — Expo Router screens (file-based routing)
src/
  components/     — Reusable components (TrialIntro, Paywall, etc.)
  lib/            — Utilities (access, purchases, settings, themes, questions)
supabase/         — Database migrations
scripts/          — Build automation, question tooling
docs/             — Privacy policy, terms, store listings, monetization
website/          — Landing page (chestionarebarca.bhdit.ro)
```
