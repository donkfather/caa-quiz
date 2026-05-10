-- Question manager schema with auto-versioning and admin-only RLS.
--
-- Run once in the Supabase SQL editor. Idempotent on re-run.
--
-- Tables:
--   public.questions          — current state, exactly one row per question
--   public.question_versions  — append-only audit log; one row per change
--
-- Auto-versioning is done by a trigger so app code can never forget. Every
-- INSERT/UPDATE/DELETE on `questions` lands one row in `question_versions`
-- with the full row snapshot, the change kind, and the user who did it.
--
-- RLS: locked to a single admin email (popescut94@gmail.com).

-- ─────────────────────────── tables ───────────────────────────

CREATE TABLE IF NOT EXISTS public.questions (
  id            BIGSERIAL PRIMARY KEY,
  question      TEXT      NOT NULL,
  options       TEXT[]    NOT NULL,
  correct       INTEGER   NOT NULL,
  topic         TEXT      NOT NULL CHECK (topic IN ('colreg','navigation','seamanship','maneuvering','first_aid','law')),
  license       TEXT[]    NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (array_length(options, 1) >= 2),
  CHECK (correct >= 0 AND correct < array_length(options, 1)),
  CHECK (license <@ ARRAY['C','D']::TEXT[])
);

CREATE INDEX IF NOT EXISTS idx_questions_topic ON public.questions (topic);
CREATE INDEX IF NOT EXISTS idx_questions_updated_at ON public.questions (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.question_versions (
  id            BIGSERIAL PRIMARY KEY,
  question_id   BIGINT    NOT NULL,
  kind          TEXT      NOT NULL CHECK (kind IN ('insert','update','delete','revert','import')),
  snapshot      JSONB     NOT NULL,
  actor         UUID      REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email   TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_question_versions_question_id ON public.question_versions (question_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_question_versions_created_at ON public.question_versions (created_at DESC);

-- ───────────────────── auto-version trigger ─────────────────────

-- Keep `updated_at` fresh on every UPDATE.
CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_questions_updated_at ON public.questions;
CREATE TRIGGER trg_questions_updated_at
  BEFORE UPDATE ON public.questions
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

-- Append a snapshot to question_versions on every change.
-- SECURITY DEFINER so the trigger can write the version regardless of the
-- caller's RLS — the policies already gated whether the underlying mutation
-- was allowed in the first place.
CREATE OR REPLACE FUNCTION public.fn_questions_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor       UUID := auth.uid();
  v_actor_email TEXT := COALESCE(auth.jwt()->>'email', NULL);
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.question_versions(question_id, kind, snapshot, actor, actor_email)
    VALUES (OLD.id, 'delete', to_jsonb(OLD), v_actor, v_actor_email);
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.question_versions(question_id, kind, snapshot, actor, actor_email)
    VALUES (NEW.id, 'insert', to_jsonb(NEW), v_actor, v_actor_email);
    RETURN NEW;
  END IF;

  -- UPDATE: only log if something actually changed
  IF NEW IS DISTINCT FROM OLD THEN
    INSERT INTO public.question_versions(question_id, kind, snapshot, actor, actor_email)
    VALUES (NEW.id, 'update', to_jsonb(NEW), v_actor, v_actor_email);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_questions_audit ON public.questions;
CREATE TRIGGER trg_questions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.questions
  FOR EACH ROW EXECUTE FUNCTION public.fn_questions_audit();

-- ───────────────────── revert RPC ─────────────────────
-- Updates a question to a prior version's content and tags the resulting
-- audit row with kind = 'revert'. Implemented as an RPC so the special
-- "this is a revert" kind is set atomically with the update.

CREATE OR REPLACE FUNCTION public.revert_question(p_version_id BIGINT, p_note TEXT DEFAULT NULL)
RETURNS public.questions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_version  public.question_versions%ROWTYPE;
  v_snap     JSONB;
  v_q        public.questions%ROWTYPE;
  v_actor      UUID := auth.uid();
  v_actor_email TEXT := COALESCE(auth.jwt()->>'email', NULL);
BEGIN
  -- Permission: same admin guard as the RLS policy.
  IF v_actor_email IS DISTINCT FROM 'popescut94@gmail.com' THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_version FROM public.question_versions WHERE id = p_version_id;
  IF v_version IS NULL THEN RAISE EXCEPTION 'version not found'; END IF;

  v_snap := v_version.snapshot;

  UPDATE public.questions
     SET question = v_snap->>'question',
         options  = ARRAY(SELECT jsonb_array_elements_text(v_snap->'options')),
         correct  = (v_snap->>'correct')::INT,
         topic    = v_snap->>'topic',
         license  = ARRAY(SELECT jsonb_array_elements_text(v_snap->'license'))
   WHERE id = v_version.question_id
   RETURNING * INTO v_q;

  -- The standard audit trigger just wrote an 'update' row for this change;
  -- relabel it as 'revert' and attach the note + source pointer.
  UPDATE public.question_versions
     SET kind = 'revert',
         note = COALESCE(p_note, 'reverted to version #' || p_version_id)
   WHERE id = (SELECT MAX(id) FROM public.question_versions WHERE question_id = v_q.id);

  RETURN v_q;
END;
$$;

-- ───────────────────── RLS ─────────────────────

ALTER TABLE public.questions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_versions  ENABLE ROW LEVEL SECURITY;

-- Single-admin allowlist. Easy to extend later by switching to a table.
DROP POLICY IF EXISTS admin_questions          ON public.questions;
DROP POLICY IF EXISTS admin_question_versions  ON public.question_versions;

CREATE POLICY admin_questions ON public.questions
  FOR ALL TO authenticated
  USING      ((auth.jwt()->>'email') = 'popescut94@gmail.com')
  WITH CHECK ((auth.jwt()->>'email') = 'popescut94@gmail.com');

CREATE POLICY admin_question_versions ON public.question_versions
  FOR ALL TO authenticated
  USING      ((auth.jwt()->>'email') = 'popescut94@gmail.com')
  WITH CHECK ((auth.jwt()->>'email') = 'popescut94@gmail.com');

-- Grants — Supabase exposes tables to PostgREST through the `authenticated`
-- and `anon` roles; without GRANTs the API returns "permission denied".
GRANT USAGE  ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.questions          TO authenticated;
GRANT SELECT, INSERT                  ON public.question_versions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.questions_id_seq          TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.question_versions_id_seq  TO authenticated;

-- ───────────────────── Storage RLS ─────────────────────
-- The mobile app reads `questions/v{N}.json` via the existing read-only
-- policy (set up in scripts/supabase/setup.sql). The dashboard's "Publish"
-- button uploads NEW versions from the browser using the admin's session,
-- so we need an INSERT/UPDATE policy for the same admin email.

DROP POLICY IF EXISTS "Admin can write questions blobs" ON storage.objects;
CREATE POLICY "Admin can write questions blobs"
ON storage.objects FOR ALL
TO authenticated
USING      (bucket_id = 'questions' AND (auth.jwt()->>'email') = 'popescut94@gmail.com')
WITH CHECK (bucket_id = 'questions' AND (auth.jwt()->>'email') = 'popescut94@gmail.com');
