-- Local-dev parity for the admin dashboard.
-- Adds the pieces that were built directly in the Supabase Studio UI on prod
-- and weren't captured in 001_questions_with_history.sql.
--
-- Scope:
--   • admins allowlist table + is_admin / is_owner / list_admins / add_admin /
--     remove_admin RPCs
--   • Storage buckets: questions, question-images, question-bundles
--   • question_candidates and question_reports stub tables (empty by default,
--     so the Import / Reports pages render without errors)
--   • Stub RPCs: find_similar_questions, recompute_pending_similars
--
-- This file is intended for the local Supabase stack. Prod already has these
-- objects; running this against prod would mostly no-op (ON CONFLICT / IF NOT
-- EXISTS) but it's not necessary to.

-- ───────────────────── questions: missing columns ─────────────────────
-- The prod table has a `topics text[]` for multi-topic questions and an
-- `image_path text` column; both are referenced by the dashboard.
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS topics     TEXT[] DEFAULT '{}';
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS image_path TEXT;

-- ───────────────────── admins allowlist ─────────────────────

CREATE TABLE IF NOT EXISTS public.admins (
  email     TEXT  PRIMARY KEY,
  is_owner  BOOL  NOT NULL DEFAULT FALSE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admins_self_read ON public.admins;
CREATE POLICY admins_self_read ON public.admins
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.email = (auth.jwt()->>'email')));

DROP POLICY IF EXISTS admins_owner_write ON public.admins;
CREATE POLICY admins_owner_write ON public.admins
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.admins a WHERE a.email = (auth.jwt()->>'email') AND a.is_owner))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.email = (auth.jwt()->>'email') AND a.is_owner));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.admins TO authenticated;

-- ───────────────────── admin RPCs ─────────────────────

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE email = (auth.jwt()->>'email'));
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE email = (auth.jwt()->>'email') AND is_owner);
$$;

CREATE OR REPLACE FUNCTION public.list_admins()
RETURNS TABLE(email TEXT, is_owner BOOL) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT a.email, a.is_owner FROM public.admins a
   WHERE EXISTS (SELECT 1 FROM public.admins WHERE email = (auth.jwt()->>'email'))
   ORDER BY a.is_owner DESC, a.email;
$$;

CREATE OR REPLACE FUNCTION public.add_admin(p_email TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'owner only'; END IF;
  INSERT INTO public.admins (email) VALUES (LOWER(TRIM(p_email)))
    ON CONFLICT (email) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_admin(p_email TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT public.is_owner() THEN RAISE EXCEPTION 'owner only'; END IF;
  DELETE FROM public.admins
   WHERE email = LOWER(TRIM(p_email)) AND NOT is_owner;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin()        TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner()        TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_admins()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_admin(TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_admin(TEXT) TO authenticated;

-- ───────────────────── question_candidates (stub) ─────────────────────

CREATE TABLE IF NOT EXISTS public.question_candidates (
  id                   BIGSERIAL PRIMARY KEY,
  source_file          TEXT,
  source_nr            INTEGER,
  topic                TEXT,
  topics               TEXT[],
  question             TEXT NOT NULL,
  options              TEXT[] NOT NULL,
  correct              INTEGER NOT NULL,
  license              TEXT[],
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','accepted','rejected')),
  duplicate_of         BIGINT,
  imported_question_id BIGINT,
  similar_ids          BIGINT[] DEFAULT '{}',
  similar_scores       NUMERIC[] DEFAULT '{}',
  image_path           TEXT,
  decided_at           TIMESTAMPTZ,
  decided_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.question_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_question_candidates ON public.question_candidates;
CREATE POLICY admin_question_candidates ON public.question_candidates
  FOR ALL TO authenticated
  USING      ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.question_candidates TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.question_candidates_id_seq TO authenticated;

-- ───────────────────── question_reports (stub) ─────────────────────

CREATE TABLE IF NOT EXISTS public.question_reports (
  id                 BIGSERIAL PRIMARY KEY,
  kind               TEXT NOT NULL DEFAULT 'main',  -- 'main' | 'learn'
  question_id        BIGINT,
  external_ref       TEXT,
  question_text      TEXT,
  message            TEXT,
  app_version        TEXT,
  questions_version  TEXT,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.question_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_question_reports ON public.question_reports;
CREATE POLICY admin_question_reports ON public.question_reports
  FOR ALL TO authenticated
  USING      ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.question_reports TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.question_reports_id_seq TO authenticated;

-- ───────────────────── similarity RPC stubs ─────────────────────
-- Local dev doesn't have a real trigram similarity index; these return
-- empty/no-op so the dashboard pages don't error.

CREATE OR REPLACE FUNCTION public.find_similar_questions(p_text TEXT, p_threshold NUMERIC DEFAULT 0.3, p_limit INT DEFAULT 5)
RETURNS TABLE(id BIGINT, question TEXT, score NUMERIC)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT id, question, 0::numeric AS score FROM public.questions WHERE FALSE;
$$;

CREATE OR REPLACE FUNCTION public.recompute_pending_similars(p_threshold NUMERIC DEFAULT 0.3, p_limit INT DEFAULT 5)
RETURNS TABLE(changed INT, gained INT, lost INT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT 0, 0, 0;
$$;

GRANT EXECUTE ON FUNCTION public.find_similar_questions(TEXT, NUMERIC, INT)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_pending_similars(NUMERIC, INT)            TO authenticated;

-- ───────────────────── Storage buckets ─────────────────────

INSERT INTO storage.buckets (id, name, public)
  VALUES ('questions',       'questions',       FALSE),
         ('question-images', 'question-images', FALSE),
         ('question-bundles','question-bundles',FALSE)
  ON CONFLICT (id) DO NOTHING;

-- Read: anon + authenticated can read all three (dashboard previews + mobile app)
DROP POLICY IF EXISTS "Anon can read questions"        ON storage.objects;
DROP POLICY IF EXISTS "Anon can read question images"  ON storage.objects;
DROP POLICY IF EXISTS "Anon can read question bundles" ON storage.objects;
CREATE POLICY "Anon can read questions"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'questions');
CREATE POLICY "Anon can read question images"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'question-images');
CREATE POLICY "Anon can read question bundles"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'question-bundles');

-- Write: admins can write
DROP POLICY IF EXISTS "Admin can write questions blobs"          ON storage.objects;
DROP POLICY IF EXISTS "Admin can write question images"          ON storage.objects;
DROP POLICY IF EXISTS "Admin can write question bundles"         ON storage.objects;
CREATE POLICY "Admin can write questions blobs"
  ON storage.objects FOR ALL TO authenticated
  USING      (bucket_id = 'questions'        AND (SELECT public.is_admin()))
  WITH CHECK (bucket_id = 'questions'        AND (SELECT public.is_admin()));
CREATE POLICY "Admin can write question images"
  ON storage.objects FOR ALL TO authenticated
  USING      (bucket_id = 'question-images'  AND (SELECT public.is_admin()))
  WITH CHECK (bucket_id = 'question-images'  AND (SELECT public.is_admin()));
CREATE POLICY "Admin can write question bundles"
  ON storage.objects FOR ALL TO authenticated
  USING      (bucket_id = 'question-bundles' AND (SELECT public.is_admin()))
  WITH CHECK (bucket_id = 'question-bundles' AND (SELECT public.is_admin()));
