/**
 * Per-question accuracy stats. Used to build adaptive practice sessions
 * ("antrenament personalizat") that surface questions the user is weakest
 * on, mixed with ones they've never seen.
 *
 * Storage is a single AsyncStorage key holding a JSON object. ~575 questions
 * means ~30 KB worst case — fine to read/write whole-file each update.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Question } from "./questions";

const KEY = "question_stats_v1";

const SCORE_CORRECT = 1;
const SCORE_WRONG = -2;
/** A question with score >= this is treated as "mastered" and excluded
 * from the adaptive practice pool. Roughly: two correct answers with no
 * wrong attempts, or three correct after one wrong. */
const MASTERED_THRESHOLD = 2;

export interface QuestionStat {
  /** Net score. +1 per correct answer, -2 per wrong answer. Lower means
   * the user needs more practice on this question. New questions default
   * to 0, so they sort below ones the user has already mastered. */
  score: number;
  /** times the user has answered this question */
  t: number;
  /** times correct — kept for stats display + back-compat */
  c: number;
  /** last seen, epoch ms */
  ts: number;
}

type StatsMap = Record<string, QuestionStat>;

let _cache: StatsMap | null = null;

/** Internal — clear the in-memory cache so the next read pulls from
 * AsyncStorage. Used by the id-scheme migration. */
export function _resetStatsCache(): void {
  _cache = null;
}

/** Older builds stored {t, c, ts} without a `score`. Compute it on read so
 * the existing answer history isn't lost when this version installs. */
function ensureScore(s: any): QuestionStat {
  if (typeof s?.score === "number") return s as QuestionStat;
  const t = typeof s?.t === "number" ? s.t : 0;
  const c = typeof s?.c === "number" ? s.c : 0;
  const wrong = Math.max(t - c, 0);
  return {
    score: c * SCORE_CORRECT + wrong * SCORE_WRONG,
    t,
    c,
    ts: typeof s?.ts === "number" ? s.ts : 0,
  };
}

async function load(): Promise<StatsMap> {
  if (_cache) return _cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    const out: StatsMap = {};
    let migrated = false;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v?.score !== "number") migrated = true;
      out[k] = ensureScore(v);
    }
    _cache = out;
    if (migrated && Object.keys(out).length) {
      // Persist the upgraded shape so future reads skip the migration cost.
      AsyncStorage.setItem(KEY, JSON.stringify(out)).catch(() => {});
    }
  } catch {
    _cache = {};
  }
  return _cache!;
}

async function persist(map: StatsMap): Promise<void> {
  _cache = map;
  await AsyncStorage.setItem(KEY, JSON.stringify(map));
}

/** Append one answer to the stats for a question. Idempotent failures are
 * silent — practice tracking should never block the quiz UI. */
export async function recordAnswer(questionId: number, correct: boolean): Promise<void> {
  try {
    const map = await load();
    const cur = map[String(questionId)] ?? { score: 0, t: 0, c: 0, ts: 0 };
    map[String(questionId)] = {
      score: cur.score + (correct ? SCORE_CORRECT : SCORE_WRONG),
      t: cur.t + 1,
      c: cur.c + (correct ? 1 : 0),
      ts: Date.now(),
    };
    await persist(map);
  } catch {}
}

export async function getAllStats(): Promise<StatsMap> {
  return await load();
}

/** Build an adaptive practice list: 70% lowest-score (most need practice)
 * + 30% unseen. Fills any shortfall from the other pool. Returns at most
 * `count` questions, shuffled.
 *
 * To avoid showing the *same* weak questions every session, we sample from
 * a 3x-sized weak pool — the picker still favours low scores, but adjacent
 * scores rotate session to session. */
export async function pickAdaptive(all: Question[], count = 20): Promise<Question[]> {
  const stats = await load();
  const weakTarget = Math.floor(count * 0.7);
  const unseenTarget = count - weakTarget;

  // Split into three buckets:
  //   weak   — seen, score < MASTERED_THRESHOLD (still needs practice)
  //   unseen — never answered (score implicitly 0)
  //   mastered — seen, score >= MASTERED_THRESHOLD (excluded from the pool)
  const weak: { q: Question; score: number; ts: number }[] = [];
  const unseen: Question[] = [];
  for (const q of all) {
    const s = stats[String(q.id)];
    if (!s || s.t === 0) {
      unseen.push(q);
    } else if (s.score < MASTERED_THRESHOLD) {
      weak.push({ q, score: s.score, ts: s.ts });
    }
    // else: mastered — never surfaced through the adaptive picker
  }

  weak.sort((a, b) => (a.score - b.score) || (a.ts - b.ts));

  // Sample from the bottom 3 × weakTarget so two consecutive sessions don't
  // surface the exact same set when many questions share the same score.
  const weakPoolSize = Math.min(weak.length, Math.max(weakTarget * 3, weakTarget));
  const weakPicks = shuffle(weak.slice(0, weakPoolSize)).slice(0, weakTarget).map((x) => x.q);
  const unseenPicks = shuffle(unseen).slice(0, unseenTarget);
  let out = [...weakPicks, ...unseenPicks];

  // Top up from leftover weak + unseen only (never from mastered). Returns
  // a shorter session if the user really has run out of practice material.
  if (out.length < count) {
    const have = new Set(out.map((q) => q.id));
    const extras = [
      ...weak.slice(weakPoolSize).map((x) => x.q),
      ...unseen.slice(unseenTarget),
    ].filter((q) => !have.has(q.id));
    out = out.concat(shuffle(extras).slice(0, count - out.length));
  }

  return shuffle(out);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
