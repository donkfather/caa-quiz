# CAA HQ — question manager dashboard

Static SPA hosted at `caahq.bhdevelopment.ro`. Reads/writes the Supabase
`questions` and `question_versions` tables directly. No backend server.

## One-time setup

### 1. Apply the Postgres schema

In the Supabase SQL editor, paste & run:

```
scripts/supabase/migrations/001_questions_with_history.sql
```

That creates the `questions` table, the `question_versions` audit table,
the auto-version trigger, the `revert_question(p_version_id, p_note)` RPC,
and the RLS policies that allow only `popescut94@gmail.com` to read/write.

### 2. Lock signups + create the admin user

In Supabase Dashboard → Authentication → Providers → Email:
- **Disable** "Enable Sign Ups" (so nobody else can register).

In Authentication → Users → "Add user":
- Email: `popescut94@gmail.com`
- Set a password (or send a magic-link invite, then set a password from the
  reset flow).

Optional: Authentication → URL Configuration → Site URL =
`https://caahq.bhdevelopment.ro` so password-reset links land back here.

### 3. Import the existing 575 questions

```sh
python3 scripts/supabase/migrate_local_to_db.py
```

Reads `assets/questions.json` and inserts into the `questions` table.
Refuses if the table is non-empty (pass `--force` to truncate first).

## Build & deploy

The dashboard is plain HTML/CSS/JS — no bundler. Build just substitutes the
Supabase URL + anon key from `.env.local` into `config.js`.

```sh
cd dashboard
./build.sh                                                  # → dist/
wrangler pages deploy dist --project-name caahq             # → caahq.pages.dev
```

Then in Cloudflare Pages → caahq → Custom domains, add
`caahq.bhdevelopment.ro` and update the DNS CNAME at your registrar:

```
caahq    CNAME    caahq.pages.dev    (proxied through Cloudflare)
```

## Local development

```sh
cd dashboard
./build.sh
npx serve dist                # any static server works
```

Sign in with the admin email + password.

## How history works

Every INSERT/UPDATE/DELETE on `questions` lands a row in
`question_versions` via a Postgres trigger. The dashboard's "History" tab
loads those rows in reverse chronological order and renders a per-version
side-by-side diff (previous vs this).

"Revert to this" calls the `revert_question` RPC which atomically writes
the old snapshot back AND tags the resulting audit row as `kind='revert'`,
so reverts are themselves reversible.

## Sync to mobile bundle

Before a mobile build, pull the current table state into
`assets/questions.json` so new installs ship with the latest data:

```sh
python3 scripts/supabase/sync_db_to_local.py
```

The "Publish" button in the dashboard takes a separate path — it uploads
the table snapshot to Supabase Storage as `v{N}.json`, which the running
app picks up on next launch (no rebuild needed).
