import AsyncStorage from "@react-native-async-storage/async-storage";
import { getHistory } from "./storage";

const STREAK_KEY = "quiz_streak";
const BADGES_KEY = "quiz_badges";
const SEEN_QUESTIONS_KEY = "quiz_seen_questions";

// --- Streak ---

export interface StreakData {
  current: number;
  best: number;
  lastQuizDate: string | null; // YYYY-MM-DD
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function getStreak(): Promise<StreakData> {
  const raw = await AsyncStorage.getItem(STREAK_KEY);
  if (!raw) return { current: 0, best: 0, lastQuizDate: null };
  const data: StreakData = JSON.parse(raw);
  // Check if streak is still valid
  const today = todayStr();
  const yesterday = yesterdayStr();
  if (data.lastQuizDate !== today && data.lastQuizDate !== yesterday) {
    // Streak broken
    data.current = 0;
  }
  return data;
}

export async function recordQuizForStreak(): Promise<StreakData> {
  const streak = await getStreak();
  const today = todayStr();

  if (streak.lastQuizDate === today) {
    // Already counted today
    return streak;
  }

  if (streak.lastQuizDate === yesterdayStr()) {
    streak.current += 1;
  } else {
    streak.current = 1;
  }

  streak.best = Math.max(streak.best, streak.current);
  streak.lastQuizDate = today;
  await AsyncStorage.setItem(STREAK_KEY, JSON.stringify(streak));
  return streak;
}

// --- Seen questions tracking ---

export async function getSeenQuestions(): Promise<Set<number>> {
  const raw = await AsyncStorage.getItem(SEEN_QUESTIONS_KEY);
  if (!raw) return new Set();
  return new Set(JSON.parse(raw));
}

export async function addSeenQuestions(ids: number[]): Promise<number> {
  const seen = await getSeenQuestions();
  for (const id of ids) seen.add(id);
  await AsyncStorage.setItem(SEEN_QUESTIONS_KEY, JSON.stringify([...seen]));
  return seen.size;
}

// --- Badges ---

export interface BadgeDef {
  key: string;
  name: string;
  description: string;
}

export const BADGE_DEFS: BadgeDef[] = [
  { key: "prima_cursa", name: "Prima cursă", description: "Completează primul test" },
  { key: "marinar", name: "Marinar", description: "Completează 10 teste" },
  { key: "capitan", name: "Căpitan", description: "Completează 50 de teste" },
  { key: "perfect", name: "Perfect", description: "Obține 100% la un examen" },
  { key: "persistent", name: "Persistent", description: "Streak de 7 zile" },
  { key: "dedicat", name: "Dedicat", description: "Streak de 30 de zile" },
  { key: "explorer", name: "Explorer", description: "Răspunde la toate cele 511 întrebări" },
  { key: "admis", name: "Admis", description: "Promovează 5 examene consecutiv" },
];

export async function getUnlockedBadges(): Promise<Set<string>> {
  const raw = await AsyncStorage.getItem(BADGES_KEY);
  if (!raw) return new Set();
  return new Set(JSON.parse(raw));
}

async function unlockBadge(key: string): Promise<boolean> {
  const badges = await getUnlockedBadges();
  if (badges.has(key)) return false;
  badges.add(key);
  await AsyncStorage.setItem(BADGES_KEY, JSON.stringify([...badges]));
  return true;
}

/** Check and unlock all eligible badges. Returns newly unlocked badge keys. */
export async function checkAndUnlockBadges(): Promise<string[]> {
  const history = await getHistory();
  const streak = await getStreak();
  const seen = await getSeenQuestions();
  const unlocked = await getUnlockedBadges();
  const newBadges: string[] = [];

  async function tryUnlock(key: string, condition: boolean) {
    if (!unlocked.has(key) && condition) {
      const isNew = await unlockBadge(key);
      if (isNew) newBadges.push(key);
    }
  }

  // Prima cursă — 1 quiz completed
  await tryUnlock("prima_cursa", history.length >= 1);

  // Marinar — 10 quizzes
  await tryUnlock("marinar", history.length >= 10);

  // Căpitan — 50 quizzes
  await tryUnlock("capitan", history.length >= 50);

  // Perfect — 100% on an exam (26 questions)
  const hasPerfect = history.some((h) => h.score === 100 && h.mode === "exam");
  await tryUnlock("perfect", hasPerfect);

  // Persistent — 7-day streak
  await tryUnlock("persistent", streak.best >= 7);

  // Dedicat — 30-day streak
  await tryUnlock("dedicat", streak.best >= 30);

  // Explorer — seen all questions
  await tryUnlock("explorer", seen.size >= 511);

  // Admis — 5 consecutive passed exams (score >= 70)
  let consecutive = 0;
  let maxConsecutive = 0;
  for (const h of [...history].reverse()) {
    if (h.mode === "exam" && h.score >= 70) {
      consecutive++;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
    } else if (h.mode === "exam") {
      consecutive = 0;
    }
  }
  await tryUnlock("admis", maxConsecutive >= 5);

  return newBadges;
}
