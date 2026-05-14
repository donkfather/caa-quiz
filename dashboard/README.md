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

Once-off build:

```sh
cd dashboard
./build.sh
npx serve dist                # any static server works
```

Live-reload dev loop (recommended while editing the dashboard):

```sh
# 1. Spin up the local Supabase stack (Postgres + Auth + Storage + Studio).
#    First run pulls ~2 GB of Docker images and takes 1-2 min.
cd ~/projects/caa-quiz
./scripts/local-supabase.sh start

# 2. Start the dashboard dev server pointed at it.
cd dashboard
./dev.sh                      # http://localhost:3000 · auto-rebuild on save, auto-reload browser
```

`./dev.sh` defaults to `--env dev` and reads `../.env.local.dev` (auto-generated when you ran `local-supabase.sh start`). Sign in with **popescut94@gmail.com / localdev** — that's the seeded admin owner.

To browse the local DB directly, open the Studio URL printed by `local-supabase.sh start` (usually http://127.0.0.1:54323).

`./scripts/local-supabase.sh` commands:

| Command | What it does |
|---|---|
| `start` | Boots the stack, runs migrations + `supabase/seed.sql`, writes `.env.local.dev` |
| `stop` | Shuts down Docker containers |
| `reset` | Wipes the local DB and replays migrations + seed |
| `env` | Re-writes `.env.local.dev` from a running stack |
| `status` | Prints URLs/keys |

To point the dashboard at **production** (writes hit live data — be careful):

```sh
cd dashboard
./dev.sh --env prod
```

The first run will fetch `chokidar-cli` and `live-server` via `npx`. If you have `fswatch` from Homebrew installed (`brew install fswatch`), the watcher uses that instead — it's snappier.

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
