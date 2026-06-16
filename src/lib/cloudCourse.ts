import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";

export interface CloudQuiz {
  question: string;
  options: string[];
  correct: number;
}

export interface CloudGlossaryEntry {
  term: string;
  definition?: string;
  image?: string | null;
}

export interface CloudSection {
  id: string;
  title: string;
  content: string;
  images?: string[];
  glossary?: CloudGlossaryEntry[];
  quiz?: CloudQuiz[];
}

export interface CloudModule {
  id: string;
  title: string;
  description: string;
  sections: CloudSection[];
  topic?: string;
}

export interface CloudModuleSummary {
  id: string;
  title: string;
  description: string;
  sort_order: number | null;
  sectionCount: number;
  quizCount: number;
  published_at: string;
}

const CACHE_KEY = "cloudCourse.v1";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 1 day

interface CachedPayload {
  fetchedAt: number;
  rows: Array<{
    id: string;
    title: string;
    description: string;
    sort_order: number | null;
    published_at: string;
    published_data: CloudModule;
  }>;
}

let _memCache: CachedPayload | null = null;
let _inflight: Promise<CachedPayload> | null = null;

async function readCache(): Promise<CachedPayload | null> {
  if (_memCache) return _memCache;
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    _memCache = JSON.parse(raw);
    return _memCache;
  } catch { return null; }
}

async function writeCache(payload: CachedPayload) {
  _memCache = payload;
  try { await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch {}
}

async function fetchFromSupabase(): Promise<CachedPayload> {
  const { data, error } = await supabase
    .from("course_modules")
    .select("id, title, description, sort_order, published_at, published_data")
    .not("published_data", "is", null)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });
  if (error) throw error;
  const payload: CachedPayload = {
    fetchedAt: Date.now(),
    rows: (data || []).map(r => ({
      id: r.id,
      title: r.title || "",
      description: r.description || "",
      sort_order: r.sort_order,
      published_at: r.published_at,
      published_data: r.published_data as CloudModule,
    })),
  };
  await writeCache(payload);
  return payload;
}

/** Returns cached payload if fresh; otherwise fetches. On fetch failure
 *  falls back to whatever cache exists (even if stale). */
export async function ensureCloudCourses(opts: { force?: boolean } = {}): Promise<CachedPayload> {
  if (!opts.force) {
    const cached = await readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  }
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try { return await fetchFromSupabase(); }
    catch (e) {
      const cached = await readCache();
      if (cached) return cached;
      throw e;
    }
    finally { _inflight = null; }
  })();
  return _inflight;
}

export async function listCloudModules(): Promise<CloudModuleSummary[]> {
  const { rows } = await ensureCloudCourses();
  return rows.map(r => {
    const m = r.published_data || ({} as CloudModule);
    const sections = m.sections || [];
    return {
      id: r.id,
      title: r.title || m.title || r.id,
      description: r.description || m.description || "",
      sort_order: r.sort_order,
      sectionCount: sections.length,
      quizCount: sections.reduce((sum, s) => sum + (s.quiz?.length || 0), 0),
      published_at: r.published_at,
    };
  });
}

export async function getCloudModule(id: string): Promise<CloudModule | null> {
  const { rows } = await ensureCloudCourses();
  const row = rows.find(r => r.id === id);
  return row?.published_data ?? null;
}

/** Direct public-bucket URL for an image referenced by filename. Mirrors
 *  the dashboard's courseImageUrl(). */
export function cloudImageUrl(filename: string): string | null {
  if (!filename) return null;
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/course-images/${encodeURIComponent(filename)}`;
}
