-- Add an explicit ordering column to course_modules so the dashboard and the
-- mobile app can display modules in a curated sequence (m_intro before
-- m_advanced, etc.) instead of insertion order.

ALTER TABLE public.course_modules
  ADD COLUMN IF NOT EXISTS sort_order INTEGER;

CREATE INDEX IF NOT EXISTS idx_course_modules_sort_order
  ON public.course_modules (sort_order NULLS LAST, id);

-- Seed sort_order for any existing rows so they keep a stable order until
-- the admin reorders them explicitly. Uses created_at as the seed key.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) * 10 AS new_order
    FROM public.course_modules
   WHERE sort_order IS NULL
)
UPDATE public.course_modules m
   SET sort_order = n.new_order
  FROM numbered n
 WHERE m.id = n.id;
