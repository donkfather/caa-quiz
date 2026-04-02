import data from "../../assets/questions.json";

export type Topic = "colreg" | "lights_signals" | "navigation" | "seamanship" | "maneuvering" | "first_aid" | "law";
export type License = "C" | "D";

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

/** Get a random subset of questions */
export function getQuizQuestions(count: number = 26): Question[] {
  return shuffle(allQuestions).slice(0, count);
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
  lights_signals: "Lumini și semnale",
  navigation: "Navigație",
  seamanship: "Marinărie",
  maneuvering: "Manevră",
  first_aid: "Prim ajutor",
  law: "Legislație",
};

export const LICENSE_LABELS: Record<License, string> = {
  C: "Clasa C",
  D: "Clasa D",
};

export function getQuestionCount(filters?: { topic?: Topic; license?: License }): number {
  return getAllQuestions(filters).length;
}

export const EXAM_QUESTION_COUNT = 26;
export const TOTAL_QUESTIONS = allQuestions.length;
