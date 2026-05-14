/**
 * One-time migration from the legacy 0-based question id scheme (where
 * bundled JSON / storage blob renumbered questions from 0) to the DB's
 * 1-based primary keys. All locally-stored question ids — seen set,
 * recent-exam buffer, per-question stats — get shifted by +1.
 *
 * Idempotent via the `id_scheme_v2` AsyncStorage flag. Call only AFTER
 * the loaded question set is known to use the new scheme (min id >= 1),
 * so we don't migrate prematurely against a cached old payload.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { _resetStatsCache } from "./questionStats";

const SCHEME_KEY = "id_scheme_v2";

export async function migrateIdScheme(): Promise<void> {
  const done = await AsyncStorage.getItem(SCHEME_KEY);
  if (done) return;

  await shiftArrayKey("quiz_seen_questions");
  await shiftArrayKey("recent_exam_question_ids");
  await shiftStatsKeys();

  await AsyncStorage.setItem(SCHEME_KEY, "1");
}

async function shiftArrayKey(key: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const shifted = arr
      .map((x) => (typeof x === "number" ? x + 1 : null))
      .filter((x): x is number => x !== null);
    await AsyncStorage.setItem(key, JSON.stringify(shifted));
  } catch {}
}

async function shiftStatsKeys(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem("question_stats_v1");
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    const shifted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const n = Number(k);
      if (Number.isFinite(n)) shifted[String(n + 1)] = v;
    }
    await AsyncStorage.setItem("question_stats_v1", JSON.stringify(shifted));
    _resetStatsCache();
  } catch {}
}
