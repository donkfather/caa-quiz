# Remote questions via Supabase Storage

The app loads its question set from a private Supabase Storage bucket so
typo / wrong-answer fixes don't require a new Play Store build.

## Architecture

```
Edit JSON locally
   │
   ▼
scripts/supabase/upload_questions.py   ← writes v{N}.json + current.json
   │
   ▼
Supabase Storage (private bucket: questions)
   │   anon-key auth required (RLS allows SELECT only)
   ▼
Mobile app on launch:
  1. Cached AsyncStorage version is mounted instantly (or bundled fallback)
  2. Background fetch of current.json
  3. If version > cached: download v{N}.json, validate, persist, swap in
  4. Next launch: same loop with the new version as baseline
```

The bundled `assets/questions.json` is the **first-run fallback** for
brand-new installs that have never reached the network. It also acts as
the absolute fallback if anything ever goes wrong with the remote.

## One-time setup (Supabase project)

1. Open your Supabase project → SQL editor
2. Paste the contents of `setup.sql` and run
3. Confirm in Storage that the `questions` bucket exists and is **private**

## Push an update

```sh
# Required env in .env.local:
#   EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
#   EXPO_PUBLIC_SUPABASE_KEY=<anon key>      # used by the mobile client
#   SUPABASE_SERVICE_KEY=<service_role key>   # used ONLY by this CLI

python3 scripts/supabase/upload_questions.py scripts/review/data/final_questions.json
```

Output:

```
uploading 575 questions (320,124 bytes) → questions/v3.json
published v3  sha256=8c1a9b2d…  count=575
```

The next time anyone opens the app, the background fetch picks up `v3`
and replaces the local cache. Users on `v2` will see the old data until
their next launch — that's intentional (no live mid-session swaps).

## Override a specific version

```sh
python3 scripts/supabase/upload_questions.py final.json --version 7
```

Useful for rolling back: re-publish the prior version's content under a
*higher* version number so older clients pick it up. Don't reuse a version
number — clients trust the pointer's monotonically increasing number to
decide whether a refresh is needed.

## Why service_role key for upload?

Because the bucket is private and the RLS policy only grants `SELECT` to
`anon` / `authenticated`. Inserts/updates need the service role.
**Never** ship the service-role key in the app bundle — keep it local.
