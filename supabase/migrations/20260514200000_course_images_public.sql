-- Make the course-images bucket publicly readable so admin + mobile clients
-- can render images via `/storage/v1/object/public/course-images/<name>` —
-- no per-image signed URLs, no listing round-trips. Mirrors how
-- `question-images` works.

UPDATE storage.buckets SET public = TRUE WHERE id = 'course-images';

-- Read policy for the anon role (browser without auth). Admin write policy
-- from 20260101000002 stays unchanged.
DROP POLICY IF EXISTS "Anon can read course images" ON storage.objects;
CREATE POLICY "Anon can read course images"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'course-images');
