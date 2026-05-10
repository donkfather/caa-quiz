import AsyncStorage from "@react-native-async-storage/async-storage";

const HISTORY_KEY = "quiz_history";
const SESSIONS_KEY = "quiz_sessions";
const MAX_HISTORY = 50;

// --- Aggregate stats (derived from history) ---

export interface QuizStats {
  totalQuizzes: number;
  totalCorrect: number;
  totalAnswered: number;
  bestScore: number;
}

export async function getStats(): Promise<QuizStats> {
  const history = await getHistory();
  const stats: QuizStats = { totalQuizzes: 0, totalCorrect: 0, totalAnswered: 0, bestScore: 0 };
  for (const h of history) {
    stats.totalQuizzes += 1;
    stats.totalCorrect += h.correct;
    stats.totalAnswered += h.total;
    stats.bestScore = Math.max(stats.bestScore, h.score);
  }
  return stats;
}

// --- Completed quiz history ---

export interface SessionRecord {
  id: string;
  mode: string;
  correct: number;
  total: number;
  score: number;
  date: string;
  topic?: string;
  license?: string;
  examType?: string;
  passed?: boolean;
}

export async function getHistory(): Promise<SessionRecord[]> {
  const raw = await AsyncStorage.getItem(HISTORY_KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

export async function saveQuizResult(
  mode: string,
  correct: number,
  total: number,
  extra?: { topic?: string; license?: string; examType?: string; passed?: boolean },
): Promise<void> {
  const score = Math.round((correct / total) * 100);
  const history = await getHistory();
  history.unshift({
    id: `${Date.now()}`,
    mode,
    correct,
    total,
    score,
    date: new Date().toISOString(),
    topic: extra?.topic,
    license: extra?.license,
    examType: extra?.examType,
    passed: extra?.passed,
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(HISTORY_KEY);
}

// --- In-progress sessions (resumable) ---

export interface ActiveSession {
  id: string;
  mode: string;
  questionIds: number[]; // indices into allQuestions
  answers: (number | null)[]; // user's selected option per question, null = unanswered
  currentIndex: number;
  startedAt: string;
  updatedAt: string;
  topic?: string;
  license?: string;
  examType?: string;
}

export async function getActiveSessions(): Promise<ActiveSession[]> {
  const raw = await AsyncStorage.getItem(SESSIONS_KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

export async function saveActiveSession(session: ActiveSession): Promise<void> {
  const sessions = await getActiveSessions();
  const idx = sessions.findIndex((s) => s.id === session.id);
  session.updatedAt = new Date().toISOString();
  if (idx >= 0) {
    sessions[idx] = session;
  } else {
    sessions.unshift(session);
  }
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

export async function deleteActiveSession(id: string): Promise<void> {
  const sessions = await getActiveSessions();
  const filtered = sessions.filter((s) => s.id !== id);
  await AsyncStorage.setItem(SESSIONS_KEY, JSON.stringify(filtered));
}

// --- Recent exam questions (anti-overlap memory) ---
//
// Sliding window of question IDs served by recent EXAM sessions. New IDs are
// pushed to the front; the buffer is trimmed to RECENT_CAPACITY. The exam
// builder reads this list and prefers questions NOT in it, falling back only
// when a topic's fresh pool runs out. Practice/learn modes don't use it.

const RECENT_EXAM_KEY = "recent_exam_question_ids";
const RECENT_CAPACITY = 80; // ~3 cat-c exams or ~8 dif-c exams of memory

export async function getRecentExamQuestionIds(): Promise<number[]> {
  const raw = await AsyncStorage.getItem(RECENT_EXAM_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export async function pushRecentExamQuestionIds(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const current = await getRecentExamQuestionIds();
  // New IDs go to the front; de-dup keeps the most recent occurrence first.
  const merged = [...ids, ...current];
  const seen = new Set<number>();
  const dedup: number[] = [];
  for (const id of merged) {
    if (!seen.has(id)) {
      seen.add(id);
      dedup.push(id);
      if (dedup.length >= RECENT_CAPACITY) break;
    }
  }
  await AsyncStorage.setItem(RECENT_EXAM_KEY, JSON.stringify(dedup));
}

export async function clearRecentExamQuestionIds(): Promise<void> {
  await AsyncStorage.removeItem(RECENT_EXAM_KEY);
}
