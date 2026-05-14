import data from "../../assets/questions.json";
import { initQuestions, getQuestions, onQuestionsUpdated } from "./questionsRemote";

export type Topic = "colreg" | "navigation" | "seamanship" | "maneuvering" | "first_aid" | "rnd" | "weather" | "signs";
export type License = "C" | "D";
export type ExamType = "cat-c" | "cat-d" | "dif-c" | "dif-d";

export interface Question {
  id: number;
  question: string;
  options: string[];
  correct: number;
  topic: Topic;
  topics?: Topic[];
  license: License[];
  image_path?: string | null;
}

/** Topics list, falling back to the legacy single-topic field. */
export function topicsOf(q: Question): Topic[] {
  if (Array.isArray(q.topics) && q.topics.length > 0) return q.topics;
  return q.topic ? [q.topic] : [];
}

// Mutable so we can swap in the cached/remote version after init.
// ES module `let` exports are live bindings — importers see updates.
export let allQuestions: Question[] = data as Question[];

/** Fire-and-forget: pulls cached questions from AsyncStorage, kicks off a
 * remote refresh in the background, swaps `allQuestions` once a newer set
 * is available. Safe to call multiple times. */
export async function refreshAllQuestions(): Promise<void> {
  await initQuestions();
  const fresh = getQuestions() as Question[];
  if (Array.isArray(fresh) && fresh.length > 0) {
    allQuestions = fresh;
  }
}

// Subscribe once at module-load so any background refresh that arrives
// *after* the initial refreshAllQuestions() call (e.g. when the cached
// copy was older than the new remote version) also updates `allQuestions`.
// Without this, totalQuestions()/getQuestionCount() would return the
// stale boot-time count until the user manually triggered another refresh.
onQuestionsUpdated(() => {
  const fresh = getQuestions() as Question[];
  if (Array.isArray(fresh) && fresh.length > 0) {
    allQuestions = fresh;
  }
});

/** Shuffle array using Fisher-Yates */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Get all questions in order, optionally filtered */
export function getAllQuestions(filters?: { topic?: Topic; license?: License }): Question[] {
  let qs = [...allQuestions];
  if (filters?.topic) qs = qs.filter((q) => topicsOf(q).includes(filters.topic!));
  if (filters?.license) qs = qs.filter((q) => q.license.includes(filters.license!));
  return qs;
}

/** Same as getAllQuestions but shuffled. Practice mode uses this so the
 * user doesn't see the same first questions every time they start a
 * session — order in the bundle is by DB id, which is far from useful. */
export function getPracticeQuestions(filters?: { topic?: Topic; license?: License }): Question[] {
  return shuffle(getAllQuestions(filters));
}

/** Generate a Fisher-Yates permutation `[0..n-1]`. Stored alongside a
 * session so a resumed quiz can re-apply the same option order it had
 * when the user closed the app. */
export function genShuffleOrder(n: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/** Apply a permutation to a question's options and update the `correct`
 * index so the answer stays consistent. Returns a fresh object — never
 * mutates the shared `allQuestions` entry. */
export function applyOptionOrder(q: Question, order: number[]): Question {
  if (!order || order.length !== q.options.length) return q;
  return {
    ...q,
    options: order.map((i) => q.options[i]),
    correct: order.indexOf(q.correct),
  };
}

/** Convenience: generate a fresh permutation and apply it. Used in
 * practice modes so the user can't memorise "the answer is always B". */
export function shuffleQuestionOptions(q: Question): Question {
  return applyOptionOrder(q, genShuffleOrder(q.options.length));
}

export const TOPIC_LABELS: Record<Topic, string> = {
  colreg: "COLREG",
  navigation: "Navigație maritimă",
  seamanship: "Marinărie",
  maneuvering: "Conducerea și manevra",
  first_aid: "Prim ajutor",
  rnd: "Reg. Navigației pe Dunăre",
  weather: "Meteo",
  signs: "Semnalizare",
};

export const LICENSE_LABELS: Record<License, string> = {
  C: "Clasa C",
  D: "Clasa D",
};

export function getQuestionCount(filters?: { topic?: Topic; license?: License }): number {
  return getAllQuestions(filters).length;
}

// --- Exam structure ---

export interface ExamConfig {
  type: ExamType;
  label: string;
  shortLabel: string;
  description: string;
  /** Topic -> number of questions to draw */
  composition: { topic: Topic; count: number }[];
  total: number;
  /** Minimum correct answers to pass (absolute, not percent) */
  passThreshold: number;
  /** Time limit in seconds */
  durationSec: number;
}

export const EXAM_CONFIGS: Record<ExamType, ExamConfig> = {
  "cat-c": {
    type: "cat-c",
    label: "Examen Categoria C",
    shortLabel: "Categoria C",
    description: "Maritim — 26 întrebări, 30 min, minim 22 corecte",
    composition: [
      { topic: "colreg", count: 8 },
      { topic: "seamanship", count: 6 },
      { topic: "navigation", count: 6 },
      { topic: "maneuvering", count: 6 },
    ],
    total: 26,
    passThreshold: 22,
    durationSec: 30 * 60,
  },
  "cat-d": {
    type: "cat-d",
    label: "Examen Categoria D",
    shortLabel: "Categoria D",
    description: "Dunăre — 26 întrebări, 30 min, minim 22 corecte",
    composition: [
      { topic: "rnd", count: 10 },
      { topic: "seamanship", count: 8 },
      { topic: "maneuvering", count: 8 },
    ],
    total: 26,
    passThreshold: 22,
    durationSec: 30 * 60,
  },
  "dif-c": {
    type: "dif-c",
    label: "Examen diferență Categoria C",
    shortLabel: "Diferență C",
    description: "Doar COLREG — 10 întrebări, 10 min, minim 8 corecte",
    composition: [{ topic: "colreg", count: 10 }],
    total: 10,
    passThreshold: 8,
    durationSec: 10 * 60,
  },
  "dif-d": {
    type: "dif-d",
    label: "Examen diferență Categoria D",
    shortLabel: "Diferență D",
    description: "Doar Reg. Dunăre — 10 întrebări, 10 min, minim 8 corecte",
    composition: [{ topic: "rnd", count: 10 }],
    total: 10,
    passThreshold: 8,
    durationSec: 10 * 60,
  },
};

/**
 * Build an exam by drawing the configured per-topic counts at random.
 *
 * If `recentIds` is provided, the picker prefers questions NOT in that set
 * to minimise overlap with the user's previous sessions. Per-topic, "fresh"
 * (unseen) questions are used first; if a topic's fresh pool is too small
 * to fill its slot, it falls back to the recent pool for the remainder.
 * This keeps the exam well-formed even on very small topic pools.
 */
export function getExamQuestions(examType: ExamType, recentIds?: Iterable<number>): Question[] {
  const cfg = EXAM_CONFIGS[examType];
  const recent = new Set<number>(recentIds ?? []);
  const out: Question[] = [];
  for (const slot of cfg.composition) {
    const pool = allQuestions.filter((q) => topicsOf(q).includes(slot.topic));
    const fresh = pool.filter((q) => !recent.has(q.id));
    const stale = pool.filter((q) => recent.has(q.id));
    const picked = shuffle(fresh).slice(0, slot.count);
    if (picked.length < slot.count) {
      picked.push(...shuffle(stale).slice(0, slot.count - picked.length));
    }
    out.push(...picked);
  }
  // Shuffle final order so topics aren't grouped
  return shuffle(out);
}

/** Live total count. Re-evaluated on every read so it picks up remote
 * refreshes that happened after the importing module loaded. */
export function totalQuestions(): number {
  return allQuestions.length;
}

/** @deprecated use totalQuestions() — keeps the value at module-load time
 * for backwards compatibility with one-shot reads. */
export const TOTAL_QUESTIONS = allQuestions.length;
