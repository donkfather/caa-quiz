// Which questions a user may be given: the official ANR list for everyone,
// the extras only with the one-time unlock.
//
// Pure (no react-native / expo imports, erasable TypeScript only) so it runs
// under `node --test` like accessCore.ts. questions.ts is the only caller; it
// feeds in the loaded questions and the current access verdict.

export interface Gatable {
  id: number;
  /** Set by the dashboard's publish step from public.questions.official. */
  official?: boolean;
}

/** Whether a question belongs to the official list.
 *
 * The published bundle carries `official` explicitly. A bundle without it —
 * the copy shipped inside the app, or a bundle cached before the field
 * existed — falls back to "is it one of the questions shipped in the app",
 * because the shipped file is exactly the original ANR seed. A question the
 * fallback can't place is an extra, matching the database default. */
export function isOfficial(q: Gatable, bundledIds: ReadonlySet<number>): boolean {
  if (typeof q.official === "boolean") return q.official;
  return bundledIds.has(q.id);
}

/** The questions this user can be served. Returns the same array when the
 * extras are unlocked, so callers never pay for a copy they don't need. */
export function availableQuestions<T extends Gatable>(
  all: readonly T[],
  extrasUnlocked: boolean,
  bundledIds: ReadonlySet<number>,
): readonly T[] {
  if (extrasUnlocked) return all;
  return all.filter((q) => isOfficial(q, bundledIds));
}

/** How many questions the unlock adds — for the paywall copy. */
export function extraCount(all: readonly Gatable[], bundledIds: ReadonlySet<number>): number {
  let n = 0;
  for (const q of all) if (!isOfficial(q, bundledIds)) n++;
  return n;
}
