// Pure access rules: who may use the app right now (payer / trial / expired).
//
// No react-native or expo imports and only erasable TypeScript syntax (no
// enums, namespaces or parameter properties), so this file runs unchanged
// under `node --test` with Node's built-in type stripping. Everything stateful
// (storage, RevenueCat, Supabase) lives in access.ts and feeds plain values in.

/** Offline fallback only — the authoritative length is `interval '5 days'` in
 * the get_trial / start_trial DB functions. Keep the two in sync. */
export const TRIAL_DAYS = 5;
export const DAY_MS = 86_400_000;
export const TRIAL_MS = TRIAL_DAYS * DAY_MS;

/** RevenueCat entitlement: true/false when known, null = unknown (offline /
 * SDK error / not configured). */
export type Entitlement = true | false | null;

/** What access.ts persists on the device (AsyncStorage "access_v1"). */
export interface AccessCache {
  /** Last known "has paid" verdict. Survives offline launches. */
  unlocked: boolean;
  /** Earliest trial end ever seen (ms epoch), from the server or a local start. */
  trialEndsAt: number | null;
  /** The app's own idea of "now" at the last check (ms epoch) — the clock
   * guard. Despite the name it is not a plain maximum: when the server
   * answers it is set to the server's clock (see advanceClock). */
  maxSeenNow: number;
  /** The raw device clock at the last check (ms epoch; 0 = unknown). Only the
   * device clock's forward movement since then is added to maxSeenNow, so
   * winding the clock back offline pauses nothing and buys nothing. */
  lastDeviceNow: number;
}

// Frozen so a careless caller can't mutate the shared default; always spread.
export const EMPTY_CACHE: AccessCache = Object.freeze({
  unlocked: false,
  trialEndsAt: null,
  maxSeenNow: 0,
  lastDeviceNow: 0,
});

/** The server's trial record for this device. null = server unreachable. */
export type ServerTrial =
  | { kind: "found"; endsAt: number; serverNow: number }
  | { kind: "absent"; serverNow: number }
  | null;

export type AccessState =
  | { kind: "unlocked" }
  | { kind: "new" } // no trial recorded anywhere -> show the trial intro
  | { kind: "trial"; endsAt: number; msLeft: number; daysLeft: number }
  | { kind: "expired"; endedAt: number };

export interface ResolveInput {
  cache: AccessCache;
  entitlement: Entitlement;
  server: ServerTrial;
  deviceNow: number;
  /** Old settings.adsDisabled — only ever set by a purchase in the ad build.
   * Trusted ONLY while the entitlement is unknown. */
  legacyAdsDisabled: boolean;
}

function isTime(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Earliest of the given trial ends, ignoring missing ones. Earliest wins so
 * neither a reinstall (fresh cache) nor an offline start (no server) can ever
 * extend a trial. */
function earliest(a: number | null, b: number | null): number | null {
  if (isTime(a) && isTime(b)) return Math.min(a, b);
  if (isTime(a)) return a;
  if (isTime(b)) return b;
  return null;
}

/** The clock the access rules run on.
 *
 * - The server answered: its clock is authoritative (this also heals a device
 *   clock that was set forward by mistake).
 * - Offline: the last known "now" plus however far the DEVICE clock has moved
 *   forward since the last check. A clock wound back adds nothing at that
 *   check and becomes the new baseline, so real time keeps counting from
 *   there — a rewind can neither revive an ended trial nor freeze a running
 *   one (a plain max(device, lastSeen) would freeze it until the rewound clock
 *   caught up again).
 *
 * Returns the effective now and the device clock to remember as the baseline. */
export function advanceClock(
  cache: AccessCache,
  deviceNow: number,
  serverNow: number | null = null,
): { now: number; deviceNow: number } {
  const dev = isTime(deviceNow) ? deviceNow : 0;
  const prev = isTime(cache.maxSeenNow) ? cache.maxSeenNow : 0;
  // Caches written before lastDeviceNow existed: the old rule kept
  // maxSeenNow >= the device clock, so it is the right baseline.
  const base = isTime(cache.lastDeviceNow) ? cache.lastDeviceNow : prev;
  let local: number;
  if (prev === 0) local = dev; // first check on this install
  else if (dev === 0) local = prev; // unusable device clock: hold
  else local = prev + Math.max(0, dev - base);
  const now = isTime(serverNow) ? serverNow : local;
  return { now, deviceNow: dev || base };
}

export function resolveAccess(input: ResolveInput): { state: AccessState; cache: AccessCache } {
  const { cache, entitlement, server, deviceNow, legacyAdsDisabled } = input;

  // 1. A definitive answer from the store wins (false = refund / never paid).
  //    Unknown NEVER downgrades someone we already saw as a payer.
  const unlocked =
    entitlement === true ||
    (entitlement === null && (cache.unlocked === true || legacyAdsDisabled === true));

  // 2. Clock guard (see advanceClock).
  const serverNow = server && isTime(server.serverNow) ? server.serverNow : null;
  const clock = advanceClock(cache, deviceNow, serverNow);
  const effectiveNow = clock.now;

  // 3. Earliest known trial end across device and server. With the server's
  //    clock in hand, no trial can end more than TRIAL_MS from now — a local
  //    trial started on a clock set forward is cut back to real time.
  let trialEndsAt = earliest(
    cache.trialEndsAt,
    server && server.kind === "found" ? server.endsAt : null,
  );
  if (trialEndsAt !== null && serverNow !== null) {
    trialEndsAt = Math.min(trialEndsAt, serverNow + TRIAL_MS);
  }

  // 4. Verdict.
  let state: AccessState;
  if (unlocked) {
    state = { kind: "unlocked" };
  } else if (trialEndsAt === null) {
    state = { kind: "new" };
  } else if (effectiveNow < trialEndsAt) {
    const msLeft = trialEndsAt - effectiveNow;
    state = { kind: "trial", endsAt: trialEndsAt, msLeft, daysLeft: Math.ceil(msLeft / DAY_MS) };
  } else {
    state = { kind: "expired", endedAt: trialEndsAt };
  }

  // 5. What to persist.
  return {
    state,
    cache: { unlocked, trialEndsAt, maxSeenNow: effectiveNow, lastDeviceNow: clock.deviceNow },
  };
}

/** Start a trial without the server (offline). Never extends: a cache that
 * already has a trial end is returned unchanged (as a copy). */
export function startLocalTrial(cache: AccessCache, now: number): AccessCache {
  if (cache.trialEndsAt !== null) return { ...cache };
  return { ...cache, trialEndsAt: now + TRIAL_MS };
}

/** Sanitize whatever came out of storage (JSON.parse result, possibly from an
 * older/corrupt write) into a valid cache. Anything unrecognized is dropped. */
export function parseCache(raw: unknown): AccessCache {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CACHE };
  const r = raw as Record<string, unknown>;
  return {
    unlocked: r.unlocked === true,
    trialEndsAt: isTime(r.trialEndsAt) ? r.trialEndsAt : null,
    maxSeenNow: isTime(r.maxSeenNow) ? r.maxSeenNow : 0,
    lastDeviceNow: isTime(r.lastDeviceNow) ? r.lastDeviceNow : 0,
  };
}

// Postgres serializes timestamptz into jsonb as e.g.
// "2026-10-07T10:00:00.123456+00:00" — six fractional digits, sometimes an
// hour-only offset. Hermes' Date.parse is stricter than V8's, so parse the
// ISO shape ourselves instead of trusting the engine.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** ISO-8601 timestamp -> ms epoch, or null when unparseable. A missing zone is
 * read as UTC (server timestamps always are). */
export function parseIsoMs(value: unknown): number | null {
  if (typeof value === "number") return isTime(value) ? value : null;
  if (typeof value !== "string") return null;
  const m = ISO_RE.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  // Milliseconds from the digit string itself — Number("0.57") * 1000 is 569.99…
  const ms = frac ? Number(`${frac}00`.slice(0, 3)) : 0;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), s ? Number(s) : 0, ms);
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offMin = Number(digits.slice(0, 2)) * 60 + (digits.length > 2 ? Number(digits.slice(2, 4)) : 0);
    t -= sign * offMin * 60_000;
  }
  return isTime(t) ? t : null;
}

/** get_trial / start_trial jsonb -> ServerTrial. Anything malformed is treated
 * as "server unreachable" (null) — never as "absent", which would invite a new
 * trial on the strength of a garbled reply. */
export function parseServerTrial(data: unknown): ServerTrial {
  let d = data;
  if (typeof d === "string") {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  const serverNow = parseIsoMs(r.server_now);
  if (serverNow === null) return null;
  if (r.exists === false) return { kind: "absent", serverNow };
  if (r.exists !== true) return null;
  const endsAt = parseIsoMs(r.ends_at);
  if (endsAt === null) return null;
  return { kind: "found", endsAt, serverNow };
}
