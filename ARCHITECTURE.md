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
│  │   Phone (Android app)  │                  │  Browser (admin)         ││
│  │   Chestionare Barca    │                  │  caahq.bhdevelopment.ro  ││
│  └─────────────┬──────────┘                  └─────────────┬────────────┘│
│                │                                            │             │
│                │  reads questions/v{N}.json on launch       │  full CRUD  │
│                │  (with anon key, private bucket)           │  + history  │
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
| Mobile app | User's phone | Quiz UX, offline-cache fallback | `app/`, `src/` |
| Admin dashboard | Cloudflare Pages | Question editing, history, publish | `dashboard/` |
| Database + storage | Supabase | Source of truth + audit trail | `scripts/supabase/migrations/` |

The mobile app **never writes** to Supabase. It only fetches the public
versioned blob on launch. The dashboard is the only thing that writes.

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
SUPABASE_SERVICE_KEY=sbp_…                      # service-role — local CLI only
```

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
- `build/preview.apk` (~90 MB, with test ads, for sideloading)
- `build/production.aab` (~63 MB, for Play Console)
- Both are also copied to `~/SynologyDrive/Projects/caa-quiz/builds/...`

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
| Schema changes | `scripts/supabase/migrations/*.sql` |
| Dashboard UI | `dashboard/` (deployed to Cloudflare Pages) |
| Mobile app code | `app/`, `src/` |
| Build artifacts | `build/` locally; `~/SynologyDrive/Projects/caa-quiz/builds/` permanent |

When in doubt: the database is the truth. The bundled JSON is a fallback
for first-launch / offline. The Storage blobs are how that truth reaches
already-installed apps without a rebuild.
