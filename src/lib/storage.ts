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
