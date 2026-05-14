-- Course modules persistence + publish flow.
--
-- Tables:
--   course_modules         — one row per learning module, with edited draft + last published snapshot
--   course_module_versions — audit log (insert / update / publish / revert / delete)
--
-- Storage:
--   bucket "course-images" — per-module image assets, addressed as <module_id>/<filename>

-- ───────────────────────── course_modules ─────────────────────────

CREATE TABLE IF NOT EXISTS public.course_modules (
  id              TEXT PRIMARY KEY,           -- e.g. "m9"
  title           TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  data            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- live editable module
  published_data  JSONB,                      -- snapshot served to the mobile app
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_course_modules_updated_at ON public.course_modules (updated_at DESC);

CREATE OR REPLACE FUNCTION public.fn_course_modules_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_course_modules_updated_at ON public.course_modules;
CREATE TRIGGER trg_course_modules_updated_at
BEFORE UPDATE ON public.course_modules
FOR EACH ROW EXECUTE FUNCTION public.fn_course_modules_updated_at();

-- ───────────────────────── audit table + trigger ─────────────────────────

CREATE TABLE IF NOT EXISTS public.course_module_versions (
  id          BIGSERIAL PRIMARY KEY,
  module_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('insert','update','publish','revert','delete')),
  data        JSONB NOT NULL,
  actor       UUID,
  actor_email TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_course_module_versions_module ON public.course_module_versions (module_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_course_modules_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_actor       UUID := auth.uid();
  v_actor_email TEXT := NULLIF(auth.jwt()->>'email','');
BEGIN
  IF (TG_OP = 'INSERT') THEN
    INSERT INTO public.course_module_versions(module_id, kind, data, actor, actor_email)
      VALUES (NEW.id, 'insert', to_jsonb(NEW), v_actor, v_actor_email);
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    -- Tag this as 'publish' when only the published_* columns moved; else 'update'.
    IF NEW.published_at IS DISTINCT FROM OLD.published_at
       AND NEW.data IS NOT DISTINCT FROM OLD.data
       AND NEW.title IS NOT DISTINCT FROM OLD.title
       AND NEW.description IS NOT DISTINCT FROM OLD.description THEN
      INSERT INTO public.course_module_versions(module_id, kind, data, actor, actor_email, note)
        VALUES (NEW.id, 'publish', to_jsonb(NEW), v_actor, v_actor_email, 'published preview to prod');
    ELSIF NEW.data IS DISTINCT FROM OLD.data
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.description IS DISTINCT FROM OLD.description THEN
      INSERT INTO public.course_module_versions(module_id, kind, data, actor, actor_email)
        VALUES (NEW.id, 'update', to_jsonb(NEW), v_actor, v_actor_email);
    END IF;
    RETURN NEW;
  ELSIF (TG_OP = 'DELETE') THEN
    INSERT INTO public.course_module_versions(module_id, kind, data, actor, actor_email)
      VALUES (OLD.id, 'delete', to_jsonb(OLD), v_actor, v_actor_email);
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_course_modules_audit ON public.course_modules;
CREATE TRIGGER trg_course_modules_audit
AFTER INSERT OR UPDATE OR DELETE ON public.course_modules
FOR EACH ROW EXECUTE FUNCTION public.fn_course_modules_audit();

-- ───────────────────────── publish RPC ─────────────────────────

CREATE OR REPLACE FUNCTION public.publish_course_module(p_module_id TEXT)
RETURNS public.course_modules LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_row public.course_modules;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin only'; END IF;
  UPDATE public.course_modules
     SET published_data = data, published_at = NOW()
   WHERE id = p_module_id
   RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'module not found'; END IF;
  RETURN v_row;
END $$;

GRANT EXECUTE ON FUNCTION public.publish_course_module(TEXT) TO authenticated;

-- ───────────────────────── RLS ─────────────────────────

ALTER TABLE public.course_modules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_module_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS course_modules_admin     ON public.course_modules;
DROP POLICY IF EXISTS course_modules_anon_read ON public.course_modules;
DROP POLICY IF EXISTS course_modules_versions_admin ON public.course_module_versions;

-- Admins: full access to drafts + history
CREATE POLICY course_modules_admin ON public.course_modules
  FOR ALL TO authenticated
  USING      ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

-- Anon (mobile app): can read published modules only.
-- A NULL published_data row is hidden until the admin publishes it.
CREATE POLICY course_modules_anon_read ON public.course_modules
  FOR SELECT TO anon
  USING (published_data IS NOT NULL);

CREATE POLICY course_modules_versions_admin ON public.course_module_versions
  FOR ALL TO authenticated
  USING      ((SELECT public.is_admin()))
  WITH CHECK ((SELECT public.is_admin()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.course_modules         TO authenticated;
GRANT SELECT                          ON public.course_modules         TO anon;
GRANT SELECT, INSERT                  ON public.course_module_versions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.course_module_versions_id_seq   TO authenticated;

-- ───────────────────────── course-images bucket ─────────────────────────

INSERT INTO storage.buckets (id, name, public)
  VALUES ('course-images', 'course-images', FALSE)
  ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Anon can read course images"      ON storage.objects;
DROP POLICY IF EXISTS "Admin can write course images"    ON storage.objects;

CREATE POLICY "Anon can read course images"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'course-images');

CREATE POLICY "Admin can write course images"
  ON storage.objects FOR ALL TO authenticated
  USING      (bucket_id = 'course-images' AND (SELECT public.is_admin()))
  WITH CHECK (bucket_id = 'course-images' AND (SELECT public.is_admin()));
