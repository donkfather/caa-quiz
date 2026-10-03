-- Official (ANR) questions vs. extras.
--
-- The product rule: the official question list published by ANR is what the
-- app offers during the free trial; every other question ("extras") is part
-- of the one-time unlock. Which side a question is on is a property of the
-- question, so it lives here — the dashboard edits it, the publish step
-- copies it into the bundle, and the app only reads it.
--
-- DEFAULT false: a question added later is an extra unless someone marks it
-- official on purpose. The official list changes only when ANR publishes a
-- new one; a forgotten checkbox should cost a free user one question, not
-- give a paid one away.

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS official BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the official set is exactly the initial seed — the rows created by
-- the 2026-05-10 import of assets/questions.json (ids 1–575, transcribed from
-- the ANR class C/D lists). Everything added afterwards came in through the
-- dashboard from other sources (question_candidates.source_file records which).
UPDATE public.questions q
   SET official = true
 WHERE q.official = false
   AND EXISTS (SELECT 1 FROM public.question_versions v
                WHERE v.question_id = q.id AND v.kind = 'import');

-- The audit trigger just wrote one 'update' row per backfilled question. Label
-- them so the history says why (now() is constant within this transaction).
UPDATE public.question_versions
   SET note = 'marked official (ANR list) by migration 20261003000000'
 WHERE kind = 'update'
   AND created_at = now()
   AND note IS NULL;
