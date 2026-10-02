# Architecture & operations

How the **chestionare barca** system is wired together — apps, services,
domains, and the day-to-day playbook for changing things.

The code-level README is in [`README.md`](./README.md). This document is
about the *setup and operations* side.

---

## 1. The big picture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                  USERS                                    │
│  ┌────────────────────────┐                  ┌──────────────────────────┐│
│  │   Phone (iOS/Android)  │                  │  Browser (admin)         ││
│  │   Chestionare Barca    │                  │  caahq.bhdevelopment.ro  ││
│  └─────────────┬──────────┘                  └─────────────┬────────────┘│
│                │                                            │             │
│                │  reads questions/v{N}.json on launch       │  full CRUD  │
│                │  (with anon key, private bucket)           │  + history  │
│                │  + trial / report RPCs (anon key)          │             │
└────────────────┼────────────────────────────────────────────┼────────────┘
                 │                                            │
                 ▼                                            ▼
        ┌─────────────────────────────────────────────────────────────┐
        │                      SUPABASE                                │
        │  ┌─────────────────────┐    ┌────────────────────────────┐  │
        │  │  Storage bucket     │    │  Postgres                  │  │
        │  │  `questions/`       │◄───│   public.questions         │  │
        │  │  v1.json, v2.json…  │    │   public.question_versions │  │
        │  │  current.json       │    │   trigger → audit          │  │
        │  │                     │    │   public.trials (hashed)   │  │
        │  └─────────────────────┘    │   RLS = popescut94@gmail   │  │
        │                              └────────────────────────────┘  │
        │  Auth: email+password, sign-ups disabled, single admin user  │
        └──────────────────────────────────────────────────────────────┘
                                       ▲
                                       │ "Publish" button writes new
                                       │ versioned blob to Storage
                                       │
        ┌──────────────────────────────┴───────────────────────────────┐
        │                  CLOUDFLARE PAGES                              │
        │  Project: caahq                                                │
        │  Domain : caahq.bhdevelopment.ro (CNAME → caahq.pages.dev)     │
        │  Source : dashboard/ (static HTML+CSS+JS)                      │
        │  Talks to Supabase via the JS client + anon key                │
        └────────────────────────────────────────────────────────────────┘
```

**Three discrete systems, one shared data layer:**

| | Where it runs | What it owns | Source code |
|---|---|---|---|
| Mobile app | User's phone | Quiz UX, offline-cache fallback, access gating (trial / lock screen) | `app/`, `src/` |
| Admin dashboard | Cloudflare Pages | Question editing, history, publish | `dashboard/` |
| Database + storage | Supabase | Source of truth + audit trail, free-trial records | `supabase/migrations/` |

Payments sit outside these three: **App Store / Google Play** hold the
purchases and **RevenueCat** reports them to the app as the entitlement
`no_ads` (configured in the RevenueCat dashboard, nothing in this repo).

The mobile app **never writes question content**. It reads the published
blob on launch and, with the anon key, calls exactly four RPCs:
`get_trial` (read-only), `start_trial` (insert-if-absent — an existing trial
start is never moved), `submit_question_report`, and `forget_device` (deletes
this device's question reports; called by *Șterge toate datele* in
`src/lib/dataReset.ts`, and kept with its anon grant by
`20261002000001_retire_vouchers.sql`). Revoking any of the four from `anon`
breaks the app silently. The dashboard is the only thing that edits content.

### Access: trial → lock screen → unlock

No ads. Each device gets a 5-day trial, started from a one-time intro screen;
afterwards a full-screen lock screen blocks the app until the one-time unlock is
bought or restored. Where each rule lives:

| Rule | Lives in | Why there |
|---|---|---|
| Who has paid | The store account, read via RevenueCat entitlement `no_ads` | The store is the only party that knows; past "remove ads" buyers are unlocked because it is the same product and entitlement |
| When this device's trial started | `public.trials` (sha256 of the device key), written only by `start_trial` | A row the client cannot move survives reinstall, data wipe and clock changes |
| How long a trial lasts | `public.trial_length()` | Defined once; client `TRIAL_DAYS` is only the offline fallback |
| How the inputs combine | `src/lib/accessCore.ts` (pure, `npm test`) | Testable without a phone |
| What the app shows | `AccessProvider` in `app/_layout.tsx` | One gate for every screen |

Full explanation, offline behaviour and the release checklist:
[`docs/MONETIZATION.md`](./docs/MONETIZATION.md).

---

## 2. How a typical edit reaches a user

```
Tudor edits a question in the dashboard
  │
  │ autosave (1.5s after typing stops)
  ▼
PostgREST UPDATE → Postgres → audit trigger
  │
  │ writes a new row to public.question_versions
  ▼
Tudor clicks "Publish"
  │
  │ dashboard reads the whole questions table
  │ → uploads questions/v{N+1}.json + current.json
  ▼
Supabase Storage now has a new pointer
  │
  │ user opens the app at any later time
  ▼
Mobile app fetches current.json (compares versions)
  │
  │ if newer: downloads v{N+1}.json, validates, writes to AsyncStorage
  ▼
User now sees the updated question
```

**Two important properties:**

- **No mobile rebuild needed.** Question fixes are live within the time it
  takes the user to relaunch the app.
- **Bundled fallback never goes stale by accident.** Before each native
  build, run `python3 scripts/supabase/sync_db_to_local.py` to refresh
  `assets/questions.json` from the table. New installs that have never
  reached the network still see current data.

---

## 3. Domains & accounts (one-time setup)

### Cloudflare account

| | Value |
|---|---|
| Account | BHDIT (`6a11e102b4cfaf93c4345ec77e10c170`) |
| Zone | `bhdevelopment.ro` (`7b63adbec3e8e8065df969e058275397`) |
| Pages project | `caahq` (https://caahq.pages.dev) |
| Custom domain | `caahq.bhdevelopment.ro`, CNAME → `caahq.pages.dev`, proxied |

### Supabase project

| | Value |
|---|---|
| Org slug | `xiixponyhacfjqghfgne` |
| Project ref | `heuooollkwoksqfncvoc` |
| Region | eu-west-1 |
| URL | `https://heuooollkwoksqfncvoc.supabase.co` |
| Admin user | `popescut94@gmail.com` (the only signed-up user) |

### Local secrets

`.env.local` at the repo root holds all keys. **Never commit this file.**

```sh
EXPO_PUBLIC_SUPABASE_URL=https://heuooollkwoksqfncvoc.supabase.co
EXPO_PUBLIC_SUPABASE_KEY=sb_publishable_…       # anon — safe to ship
EXPO_PUBLIC_RC_IOS_KEY=appl_…                   # RevenueCat public SDK key
EXPO_PUBLIC_RC_ANDROID_KEY=goog_…               # RevenueCat public SDK key
SUPABASE_SERVICE_KEY=sbp_…                      # service-role — local CLI only
```

The RevenueCat keys are public SDK keys (also in `eas.json` for production;
Xcode Cloud injects the iOS one in `ci_scripts/ci_post_clone.sh`). A store
build **without** them cannot sell or restore the unlock, so anyone whose
trial ends is stuck on the lock screen.

The `EXPO_PUBLIC_*` pair is read by:
- the Expo build (`app.config.js` → app bundle)
- `dashboard/build.sh` (substituted into `dashboard/dist/config.js`)
- `scripts/supabase/migrate_local_to_db.py` (one-shot import)
- `scripts/supabase/sync_db_to_local.py` (pre-build sync)

The service-role key is **only** used by local CLI scripts that need to
bypass RLS (initial import, sync-down). It's never embedded anywhere.

---

## 4. Initial setup from scratch

If you ever lose the project and have to rebuild from the repo:

### Database

1. Create the Supabase project, copy URL + anon key + service-role key into
   `.env.local`.
2. Run the schema migration in the SQL editor:
   ```
   scripts/supabase/migrations/001_questions_with_history.sql
   ```
   Creates `public.questions`, `public.question_versions`, the audit
   trigger, the `revert_question` RPC, RLS policies (locked to
   `popescut94@gmail.com`), and the Storage bucket-write policy.
3. Authentication → Providers → Email → **disable Sign Ups**.
4. Authentication → Users → Add user → `popescut94@gmail.com` with a
   password. Set Site URL to `https://caahq.bhdevelopment.ro`.
5. Create the Storage bucket *(if it isn't there yet)*:
   ```sh
   # via the Supabase dashboard → Storage → New bucket "questions" (private)
   # or run scripts/supabase/setup.sql which has the CREATE + read policy
   ```
6. Import the question bank from the repo's bundled JSON:
   ```sh
   python3 scripts/supabase/migrate_local_to_db.py
   ```
7. On a **new, empty** project only: apply the files in
   `supabase/migrations/` in filename order. (The production project
   `heuooollkwoksqfncvoc` was built by hand and its recorded migration history
   uses different version ids — never `supabase db push` or
   `supabase migration repair` against it; see `docs/MONETIZATION.md` →
   *Release checklist* for how to apply new files there.) Two of them
   carry the access model: `20261002000000_trials.sql` (the `trials` table,
   `get_trial` / `start_trial`) and `20261002000001_retire_vouchers.sql`.
   Without the first, the app still runs but every trial lives only on the
   device, so a reinstall starts a new one — and nothing reports it.

### Dashboard (Cloudflare Pages)

1. Authenticate wrangler (one-time):
   ```sh
   npx wrangler login
   ```
2. Build & deploy:
   ```sh
   cd dashboard
   ./build.sh
   npx wrangler pages project create caahq --production-branch main
   npx wrangler pages deploy dist --project-name caahq --branch main
   ```
3. Add custom domain (if `bhdevelopment.ro` is in the Cloudflare account):
   - Pages → caahq → Custom domains → add `caahq.bhdevelopment.ro`
   - DNS → bhdevelopment.ro → add CNAME `caahq` → `caahq.pages.dev` (proxied)
   - Wait ~1 min for cert issuance.

### Mobile app

The app reads `EXPO_PUBLIC_SUPABASE_URL` + `EXPO_PUBLIC_SUPABASE_KEY` from
`.env.local` at build time. As long as those are set, `npm run build:preview`
or `npm run build:production` produces an artifact that knows where to look.
Store builds also need the two `EXPO_PUBLIC_RC_*` keys (see above); preview
builds deliberately have none, so buying is unavailable in them.

---

## 5. Day-to-day workflows

### Edit a question, deploy to existing users

1. Open <https://caahq.bhdevelopment.ro>, sign in.
2. Edit. Changes autosave to Supabase ~1.5s after you stop typing.
   - Every save lands a row in `question_versions` with your email and
     timestamp.
3. Click **Publish**. The dashboard snapshots the full table, uploads
   `questions/v{N+1}.json` and updates `questions/current.json`.
4. Done. The next time any user opens the app with internet, they get the
   new content.

### Roll back a question

1. Open the question → **History** tab.
2. Find the version you want → click **Revert to this**.
3. The change is itself audited as `kind = 'revert'`, so a revert is also
   reversible.
4. Click **Publish** to push the rolled-back state to live users.

### Cut a new app release

```sh
# 1. pull current Supabase state into the bundled fallback
python3 scripts/supabase/sync_db_to_local.py

# 2. build (sequential preview → production)
npm run build:preview && npm run build:production
```

Artifacts:
- `build/preview.apk` (for sideloading; has the "Expiră perioada de probă"
  test button, no RevenueCat key)
- `build/production.aab` (for Play Console)
- Both are also copied to `~/SynologyDrive/Projects/caa-quiz/builds/...`

The first release of the trial model has manual store and database steps —
work through the checklist in [`docs/MONETIZATION.md`](./docs/MONETIZATION.md)
before submitting.

### Redeploy the dashboard

```sh
cd dashboard && ./build.sh && npx wrangler pages deploy dist --project-name caahq --branch main
```

The `build.sh` re-injects the env vars from `.env.local` into the static
files; deploys are zero-downtime via Cloudflare.

---

## 6. Where to look when something breaks

| Symptom | Likely cause | Where to check |
|---|---|---|
| Dashboard shows "load failed" | Anon key wrong / RLS blocking / browser cached an old build | Browser devtools → Network. Re-run `dashboard/build.sh` if env keys changed. |
| Sign-in says "Invalid credentials" | User doesn't exist OR sign-ups still disabled and you tried a new email | Supabase Auth → Users |
| Publish button errors with 403 | Storage RLS rejected the upload | Supabase Storage → Policies. The admin policy is in `001_questions_with_history.sql` |
| Mobile app stuck on old questions | Version pointer not updated, or app hasn't relaunched | Pull `current.json` directly: `curl -H "apikey: $ANON" https://…/storage/v1/object/questions/current.json` |
| `caahq.bhdevelopment.ro` 404 | Domain not yet attached or CNAME missing | Cloudflare Pages → caahq → Custom domains. Should show "Active" |
| Sign-up disabled but I want to add another admin | Add user via Supabase dashboard → Users → Invite, then update the RLS policy email check (or migrate to a `admins` table) | `001_questions_with_history.sql`, lines with `popescut94@gmail.com` |
| Someone who paid sees the lock screen | Different store account, or RevenueCat couldn't be reached and the device has no cached unlock | Ask them to tap **Restaurează achizițiile**. RevenueCat dashboard → Customers. Check the product is still attached to entitlement `no_ads`. |
| Nobody can buy ("Produsul nu este disponibil momentan") | No RevenueCat key in that build, or no *current* offering with a package | `app.config.js` extra / build env; RevenueCat → Offerings |
| A reinstall got a fresh trial | `get_trial` / `start_trial` failing (migration not applied?) or the device was offline at the time | Supabase → Logs → API; `select count(*), max(started_at) from public.trials;` |

### Logs

- **Mobile** — `adb logcat | grep -i questions` while the app launches; the
  loader in `src/lib/questionsRemote.ts` is silent on success but logs to
  the JS console on failure.
- **Dashboard** — browser devtools, plus Cloudflare Pages → Deployments
  → click the deploy → "Build log" / "Functions log" (we don't use
  functions, so the latter is empty).
- **Database** — Supabase → Logs → Postgres / API. The `get_advisors`
  output is also worth re-running after any schema change.

---

## 7. Source-of-truth map

If you're confused about where something lives:

| Thing | Source of truth |
|---|---|
| Live question content | `public.questions` in Supabase |
| Question history / who-edited-what | `public.question_versions` |
| Mobile bundled fallback | `assets/questions.json` (regenerated from the table) |
| Currently-published version pointer | `questions/current.json` in Supabase Storage |
| Past published blobs | `questions/v1.json`, `questions/v2.json`, … |
| Admin allowlist | RLS policies in the schema (single email, hard-coded) |
| Who has paid | App Store / Google Play, read via RevenueCat entitlement `no_ads` |
| When a device's trial started | `public.trials` (sha256 of the device key), written only by `start_trial` |
| Trial length | `public.trial_length()` (client `TRIAL_DAYS` is the offline fallback) |
| Access rules (trial / expired / unlocked) | `src/lib/accessCore.ts` |
| Which screen shows (intro / app / lock screen) | `AccessProvider` in `app/_layout.tsx` |
| Privacy policy + terms users actually see | Google Sites pages, hand-edited copies of `docs/privacy-policy.html` and `docs/terms-of-service.html` |
| Schema changes | `supabase/migrations/*.sql` (the older `scripts/supabase/migrations/` holds the original schema) |
| Dashboard UI | `dashboard/` (deployed to Cloudflare Pages) |
| Mobile app code | `app/`, `src/` |
| Build artifacts | `build/` locally; `~/SynologyDrive/Projects/caa-quiz/builds/` permanent |

When in doubt: the database is the truth. The bundled JSON is a fallback
for first-launch / offline. The Storage blobs are how that truth reaches
already-installed apps without a rebuild.
