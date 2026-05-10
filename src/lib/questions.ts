import data from "../../assets/questions.json";

export type Topic = "colreg" | "navigation" | "seamanship" | "maneuvering" | "first_aid" | "law";
export type License = "C" | "D";
export type ExamType = "cat-c" | "cat-d" | "dif-c" | "dif-d";

export interface Question {
  id: number;
  question: string;
  options: string[];
  correct: number;
  topic: Topic;
  license: License[];
}

export const allQuestions: Question[] = data as Question[];

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
  if (filters?.topic) qs = qs.filter((q) => q.topic === filters.topic);
  if (filters?.license) qs = qs.filter((q) => q.license.includes(filters.license!));
  return qs;
}

export const TOPIC_LABELS: Record<Topic, string> = {
  colreg: "COLREG",
  navigation: "Navigație maritimă",
  seamanship: "Marinărie",
  maneuvering: "Conducerea și manevra",
  first_aid: "Prim ajutor",
  law: "Reg. Navigației pe Dunăre",
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
      { topic: "law", count: 10 },
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
    composition: [{ topic: "law", count: 10 }],
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
    const pool = allQuestions.filter((q) => q.topic === slot.topic);
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

export const TOTAL_QUESTIONS = allQuestions.length;
