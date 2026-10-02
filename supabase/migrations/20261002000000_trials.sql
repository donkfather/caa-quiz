-- Free-trial bookkeeping for the "5-day trial, then one-time unlock" model.
--
-- Every install gets 5 days of full access; after that the app locks until
-- the one-time RevenueCat unlock is bought or restored. The SERVER owns the
-- start date, so changing the device clock, reinstalling, or tapping
-- "Șterge toate datele" (which clears local storage only and deliberately
-- leaves this row alone — the privacy policy discloses that) cannot restart
-- a trial.
--
-- Only a SHA-256 hash of the device key is stored, never the key itself. The
-- key is the Android ID on Android (survives reinstall) and a random value
-- kept in the iOS Keychain (survives app deletion) — see src/lib/deviceKey.ts.
--
-- Client contract (src/lib/access.ts), both RPCs callable with the anon key:
--   get_trial(p_device_key)               read-only, never creates a row
--   start_trial(p_device_key, p_platform [, p_started_at])
--                                         insert-if-absent; an existing start
--                                         is NEVER moved; returns the stored row.
--                                         p_started_at registers a trial the
--                                         device started offline, clamped to
--                                         [now - trial length, now].
-- Both return jsonb { exists, started_at, ends_at, server_now }, timestamps as
-- UTC ISO-8601 with milliseconds ("2026-10-02T09:15:00.000Z"). server_now
-- lets the client notice a device clock that was set back.
--
-- The trial length is defined ONCE, in public.trial_length(). The client's
-- TRIAL_DAYS (src/lib/accessCore.ts) is only the offline fallback and must
-- match it.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ─────────────────────────── table ───────────────────────────

CREATE TABLE IF NOT EXISTS public.trials (
  key_hash    TEXT        PRIMARY KEY,
  platform    TEXT        NOT NULL CHECK (platform IN ('ios','android','web')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A raw device key can never land here, whatever path writes the row.
  CHECK (key_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE public.trials IS
  'One row per device that started the free trial. key_hash = sha256(device key); the raw key is never stored. Written only by start_trial().';

-- RLS on with NO policies, and no table grants: the only way in is through
-- the two SECURITY DEFINER functions below. The REVOKE matters — Supabase's
-- default privileges grant anon/authenticated full access to new tables.
ALTER TABLE public.trials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trials FROM anon, authenticated;

-- ─────────────────────────── helpers ───────────────────────────
-- Shared by get_trial and start_trial so the two can never disagree on the
-- length, the hash, or the response shape (a get_trial that hashed the key
-- differently from start_trial would never find the row it created).

CREATE OR REPLACE FUNCTION public.trial_length()
RETURNS INTERVAL
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT INTERVAL '5 days';
$$;

CREATE OR REPLACE FUNCTION public.trial_key_hash(p_device_key TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF p_device_key IS NULL OR length(p_device_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid device key' USING ERRCODE = '22023';
  END IF;
  RETURN encode(extensions.digest(p_device_key, 'sha256'), 'hex');
END;
$$;

-- The arithmetic runs on UTC wall time, where a day is always 24h, so
-- ends_at - started_at is exactly TRIAL_DAYS * 86 400 000 ms whatever the
-- session TimeZone is (a "day" across a local DST change would be 23h/25h).
-- Milliseconds, not microseconds: that is the ISO form every JS engine parses.
CREATE OR REPLACE FUNCTION public.trial_state(p_started_at TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'exists',     p_started_at IS NOT NULL,
    'started_at', to_char(p_started_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ends_at',    to_char((p_started_at AT TIME ZONE 'UTC') + public.trial_length(),
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'server_now', to_char(NOW() AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
$$;

-- ─────────────────────────── RPCs ───────────────────────────

-- Read-only: reports whether this device has a trial on record. Never creates
-- one — the trial starts only when the user taps "Începe perioada gratuită".
CREATE OR REPLACE FUNCTION public.get_trial(p_device_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_started TIMESTAMPTZ;
BEGIN
  SELECT t.started_at INTO v_started
    FROM public.trials t
   WHERE t.key_hash = public.trial_key_hash(p_device_key);

  RETURN public.trial_state(v_started);
END;
$$;

-- Insert-if-absent, then read the stored row back. ON CONFLICT DO NOTHING
-- means an existing start is never moved, and a concurrent double-tap is
-- safe: the second insert waits for the first to commit, does nothing, and
-- its SELECT (a fresh snapshot per statement, because the function is
-- VOLATILE) sees the winner's row.
--
-- p_started_at (optional) is how the app registers a trial it had to start
-- offline: with its real start, so registering a trial that already ran does
-- not open a fresh 5-day window for the next reinstall. The claim can only
-- make the record EARLIER than "now": a future value is clamped to now (a
-- clock set forward cannot extend anything), and anything older than the
-- trial length to now - trial length (already over; how much older is
-- irrelevant). NULL = starts now, the normal online tap.
CREATE OR REPLACE FUNCTION public.start_trial(
  p_device_key TEXT,
  p_platform   TEXT,
  p_started_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hash    TEXT := public.trial_key_hash(p_device_key);
  v_started TIMESTAMPTZ;
BEGIN
  -- The table's CHECK is the real guard; this only turns a bad value into a
  -- clean error instead of a constraint-violation message.
  IF p_platform IS NULL OR p_platform NOT IN ('ios','android','web') THEN
    RAISE EXCEPTION 'invalid platform' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.trials (key_hash, platform, started_at)
  VALUES (
    v_hash,
    p_platform,
    GREATEST(LEAST(COALESCE(p_started_at, NOW()), NOW()), NOW() - public.trial_length())
  )
  ON CONFLICT (key_hash) DO NOTHING;

  SELECT t.started_at INTO v_started
    FROM public.trials t
   WHERE t.key_hash = v_hash;

  RETURN public.trial_state(v_started);
END;
$$;

-- ─────────────────────────── grants ───────────────────────────
-- Supabase's default privileges grant EXECUTE on new public functions to
-- anon/authenticated directly, so revoking from PUBLIC alone is not enough.
-- The helpers stay internal: the SECURITY DEFINER RPCs run as their owner
-- and do not need the caller to hold EXECUTE on them.

REVOKE ALL ON FUNCTION public.trial_length()              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_key_hash(TEXT)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_state(TIMESTAMPTZ)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_trial(TEXT)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_trial(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_trial(TEXT)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_trial(TEXT, TEXT, TIMESTAMPTZ) TO anon, authenticated;
