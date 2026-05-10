-- Run once in the Supabase SQL editor (or `supabase db push`).
-- Creates a private bucket for question payloads and an RLS policy that
-- allows any client carrying the anon key to read but not write.

-- 1. Bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('questions', 'questions', false)
ON CONFLICT (id) DO NOTHING;

-- 2. Read policy: any authenticated request (incl. anon) can SELECT objects
--    in this bucket. Combined with the bucket being non-public, this means
--    a `curl https://…/object/public/questions/v3.json` returns 403; only
--    requests carrying the anon-key Authorization header succeed.
DROP POLICY IF EXISTS "Anon can read questions" ON storage.objects;
CREATE POLICY "Anon can read questions"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'questions');

-- 3. Writes are NOT exposed to anon. Uploads happen via the service-role
--    key from the upload CLI (scripts/supabase/upload_questions.py).
