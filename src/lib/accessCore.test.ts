// Run: node --test src/lib/accessCore.test.ts   (Node >= 23.6 strips types natively)
// Excluded from tsconfig: the ".ts" import extension below is what Node needs
// and what tsc would reject without allowImportingTsExtensions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS,
  EMPTY_CACHE,
  TRIAL_DAYS,
  TRIAL_MS,
  advanceClock,
  parseCache,
  parseIsoMs,
  parseServerTrial,
  resolveAccess,
  startLocalTrial,
} from "./accessCore.ts";
import type { AccessCache, ResolveInput } from "./accessCore.ts";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01 12:00Z
const HOUR = 3_600_000;

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    cache: { ...EMPTY_CACHE },
    entitlement: null,
    server: null,
    deviceNow: T0,
    legacyAdsDisabled: false,
    ...over,
  };
}

function cache(over: Partial<AccessCache> = {}): AccessCache {
  return { ...EMPTY_CACHE, ...over };
}

test("constants: 5-day trial", () => {
  assert.equal(TRIAL_DAYS, 5);
  assert.equal(TRIAL_MS, 5 * DAY_MS);
  assert.deepEqual(EMPTY_CACHE, { unlocked: false, trialEndsAt: null, maxSeenNow: 0, lastDeviceNow: 0 });
  assert.ok(Object.isFrozen(EMPTY_CACHE));
});

// ── Payers ────────────────────────────────────────────────────────────────

test("payer with entitlement true -> unlocked, even with an expired trial", () => {
  const r = resolveAccess(
    input({ entitlement: true, cache: cache({ trialEndsAt: T0 - DAY_MS }) }),
  );
  assert.deepEqual(r.state, { kind: "unlocked" });
  assert.equal(r.cache.unlocked, true);
});

test("payer offline (entitlement null) with cache.unlocked stays unlocked", () => {
  const r = resolveAccess(input({ entitlement: null, cache: cache({ unlocked: true }) }));
  assert.deepEqual(r.state, { kind: "unlocked" });
  assert.equal(r.cache.unlocked, true);
});

test("legacy adsDisabled + unknown entitlement -> unlocked and remembered", () => {
  const r = resolveAccess(input({ entitlement: null, legacyAdsDisabled: true }));
  assert.deepEqual(r.state, { kind: "unlocked" });
  assert.equal(r.cache.unlocked, true);
});

test("legacy adsDisabled + definitive false -> NOT unlocked", () => {
  const r = resolveAccess(
    input({ entitlement: false, legacyAdsDisabled: true, cache: cache({ trialEndsAt: T0 - HOUR }) }),
  );
  assert.equal(r.state.kind, "expired");
  assert.equal(r.cache.unlocked, false);
});

test("legacy adsDisabled + definitive false + no trial -> new, not unlocked", () => {
  const r = resolveAccess(input({ entitlement: false, legacyAdsDisabled: true }));
  assert.deepEqual(r.state, { kind: "new" });
});

test("refund: cache.unlocked + definitive false -> locked and cache cleared", () => {
  const r = resolveAccess(
    input({ entitlement: false, cache: cache({ unlocked: true, trialEndsAt: T0 - DAY_MS }) }),
  );
  assert.deepEqual(r.state, { kind: "expired", endedAt: T0 - DAY_MS });
  assert.equal(r.cache.unlocked, false);
});

test("refunded payer still inside a trial gets the rest of the trial", () => {
  const r = resolveAccess(
    input({ entitlement: false, cache: cache({ unlocked: true, trialEndsAt: T0 + DAY_MS }) }),
  );
  assert.equal(r.state.kind, "trial");
});

// ── Trial lifecycle ───────────────────────────────────────────────────────

test("brand-new user, nothing anywhere -> new", () => {
  const r = resolveAccess(input());
  assert.deepEqual(r.state, { kind: "new" });
  assert.deepEqual(r.cache, { unlocked: false, trialEndsAt: null, maxSeenNow: T0, lastDeviceNow: T0 });
});

test("brand-new user, server says absent -> new", () => {
  const r = resolveAccess(input({ server: { kind: "absent", serverNow: T0 } }));
  assert.deepEqual(r.state, { kind: "new" });
});

test("server found + no cache (reinstall) -> trial using the server end", () => {
  const endsAt = T0 + 2 * DAY_MS;
  const r = resolveAccess(input({ server: { kind: "found", endsAt, serverNow: T0 } }));
  assert.deepEqual(r.state, { kind: "trial", endsAt, msLeft: 2 * DAY_MS, daysLeft: 2 });
  assert.equal(r.cache.trialEndsAt, endsAt);
});

test("server found + no cache, already past the end -> expired", () => {
  const endsAt = T0 - HOUR;
  const r = resolveAccess(input({ server: { kind: "found", endsAt, serverNow: T0 } }));
  assert.deepEqual(r.state, { kind: "expired", endedAt: endsAt });
});

test("earliest of cache vs server wins (cache earlier)", () => {
  const r = resolveAccess(
    input({
      cache: cache({ trialEndsAt: T0 + DAY_MS }),
      server: { kind: "found", endsAt: T0 + 3 * DAY_MS, serverNow: T0 },
    }),
  );
  assert.equal(r.state.kind, "trial");
  assert.equal(r.cache.trialEndsAt, T0 + DAY_MS);
});

test("earliest of cache vs server wins (server earlier)", () => {
  const r = resolveAccess(
    input({
      cache: cache({ trialEndsAt: T0 + 3 * DAY_MS }),
      server: { kind: "found", endsAt: T0 - HOUR, serverNow: T0 },
    }),
  );
  assert.deepEqual(r.state, { kind: "expired", endedAt: T0 - HOUR });
  assert.equal(r.cache.trialEndsAt, T0 - HOUR);
});

test("server unreachable: the cached trial still applies", () => {
  const r = resolveAccess(input({ cache: cache({ trialEndsAt: T0 + HOUR }), server: null }));
  assert.equal(r.state.kind, "trial");
});

test("clock rollback cannot revive an expired trial", () => {
  const endsAt = T0 - HOUR;
  // Last seen now = T0 (after the end). User winds the device clock back 2 days.
  const r = resolveAccess(
    input({ cache: cache({ trialEndsAt: endsAt, maxSeenNow: T0 }), deviceNow: T0 - 2 * DAY_MS }),
  );
  assert.deepEqual(r.state, { kind: "expired", endedAt: endsAt });
  assert.equal(r.cache.maxSeenNow, T0, "maxSeenNow never moves backwards");
});

test("clock rollback during a trial does not add time", () => {
  const endsAt = T0 + DAY_MS;
  const r = resolveAccess(
    input({ cache: cache({ trialEndsAt: endsAt, maxSeenNow: T0 }), deviceNow: T0 - 3 * DAY_MS }),
  );
  assert.deepEqual(r.state, { kind: "trial", endsAt, msLeft: DAY_MS, daysLeft: 1 });
});

// Time passing offline, one check per real day. `clock(real)` is what the
// device shows on that real day.
function simulateOffline(start: AccessCache, days: number, clock: (real: number) => number) {
  let c = start;
  const kinds: string[] = [];
  for (let d = 1; d <= days; d++) {
    const r = resolveAccess(input({ cache: c, deviceNow: clock(T0 + d * DAY_MS) }));
    c = r.cache;
    kinds.push(r.state.kind);
  }
  return kinds;
}

test("clock wound back once while offline: real days still count, trial ends on time", () => {
  // Trial started online at T0 (ends T0+5d); then the clock is set back a
  // year and the app is kept away from the server.
  const started = resolveAccess(
    input({ server: { kind: "found", endsAt: T0 + TRIAL_MS, serverNow: T0 } }),
  ).cache;
  // The rewind is noticed at the first check after it (a minute later here):
  // only the time between the last check and the rewind goes uncounted.
  const rewound = resolveAccess(input({ cache: started, deviceNow: T0 + 60_000 - 365 * DAY_MS })).cache;
  const kinds = simulateOffline(rewound, 30, (real) => real - 365 * DAY_MS);
  assert.deepEqual(kinds.slice(0, 4), ["trial", "trial", "trial", "trial"]);
  assert.equal(kinds[4], "trial", "day 5 minus the uncounted minute");
  assert.ok(kinds.slice(5).every((k) => k === "expired"), kinds.join(","));
});

test("clock set forward, trial started offline, clock set back: no extra time", () => {
  const F = T0 + 365 * DAY_MS; // the forward clock
  const first = resolveAccess(input({ deviceNow: F })).cache;
  const local = startLocalTrial(first, advanceClock(first, F).now);
  assert.equal(local.trialEndsAt, F + TRIAL_MS);
  // Real time resumes at T0 + 1 day, clock correct from then on.
  const kinds = simulateOffline(local, 10, (real) => real);
  assert.ok(kinds.slice(5).every((k) => k === "expired"), kinds.join(","));
  // And the server, once reached, caps a local end to now + 5 days.
  const r = resolveAccess(
    input({ cache: local, deviceNow: T0, server: { kind: "absent", serverNow: T0 } }),
  );
  assert.equal(r.cache.trialEndsAt, T0 + TRIAL_MS);
});

test("repeated rewinds offline only lose the moment of each rewind", () => {
  // The clock is wound back by half a day before every daily check.
  const started = resolveAccess(
    input({ server: { kind: "found", endsAt: T0 + TRIAL_MS, serverNow: T0 } }),
  ).cache;
  let c = started;
  let device = T0;
  let state = "";
  for (let d = 1; d <= 12; d++) {
    device += DAY_MS / 2; // half a day really passes, then…
    c = resolveAccess(input({ cache: c, deviceNow: device })).cache;
    device -= DAY_MS / 2; // …the clock is wound back
    device += DAY_MS / 2;
    const r = resolveAccess(input({ cache: c, deviceNow: device }));
    c = r.cache;
    state = r.state.kind;
  }
  assert.equal(state, "expired");
});

test("advanceClock: legacy cache without a baseline behaves like max(device, lastSeen)", () => {
  assert.equal(advanceClock(cache({ maxSeenNow: T0 }), T0 + HOUR).now, T0 + HOUR);
  assert.equal(advanceClock(cache({ maxSeenNow: T0 }), T0 - HOUR).now, T0);
  assert.equal(advanceClock(cache(), T0).now, T0, "first check");
  assert.equal(advanceClock(cache({ maxSeenNow: T0, lastDeviceNow: T0 }), Number.NaN).now, T0, "bad device clock holds");
  assert.equal(advanceClock(cache({ maxSeenNow: T0, lastDeviceNow: T0 }), T0 + HOUR, T0 - DAY_MS).now, T0 - DAY_MS, "server wins");
});

test("server time later than device time is used", () => {
  const endsAt = T0 + HOUR;
  const r = resolveAccess(
    input({
      cache: cache({ trialEndsAt: endsAt }),
      deviceNow: T0, // device thinks the trial has an hour left…
      server: { kind: "found", endsAt, serverNow: T0 + 2 * HOUR }, // …server knows it ended
    }),
  );
  assert.deepEqual(r.state, { kind: "expired", endedAt: endsAt });
  assert.equal(r.cache.maxSeenNow, T0 + 2 * HOUR);
});

test("server time is authoritative even when earlier than the device (clock set forward heals online)", () => {
  // Offline, a clock set forward by mistake ended the trial early…
  const endsAt = T0 + DAY_MS;
  const ahead = resolveAccess(
    input({ cache: cache({ trialEndsAt: endsAt, maxSeenNow: T0 - HOUR, lastDeviceNow: T0 - HOUR }), deviceNow: T0 + 2 * DAY_MS }),
  );
  assert.equal(ahead.state.kind, "expired");
  // …and the first server answer puts the real time back.
  const r = resolveAccess(
    input({ cache: ahead.cache, deviceNow: T0 + 2 * DAY_MS, server: { kind: "found", endsAt, serverNow: T0 } }),
  );
  assert.equal(r.state.kind, "trial");
  assert.equal(r.cache.maxSeenNow, T0);
  assert.equal(r.cache.lastDeviceNow, T0 + 2 * DAY_MS, "baseline is the device clock, for the next offline check");
});

test("exact boundary: effectiveNow === trialEndsAt -> expired", () => {
  const r = resolveAccess(input({ cache: cache({ trialEndsAt: T0 }), deviceNow: T0 }));
  assert.deepEqual(r.state, { kind: "expired", endedAt: T0 });
});

test("one ms before the boundary is still a trial with 1 day left", () => {
  const r = resolveAccess(input({ cache: cache({ trialEndsAt: T0 + 1 }), deviceNow: T0 }));
  assert.deepEqual(r.state, { kind: "trial", endsAt: T0 + 1, msLeft: 1, daysLeft: 1 });
});

test("daysLeft rounds up", () => {
  const cases: Array<[number, number]> = [
    [TRIAL_MS, 5], // just started
    [TRIAL_MS - 1, 5],
    [4 * DAY_MS + 1, 5],
    [4 * DAY_MS, 4],
    [DAY_MS + 1, 2],
    [DAY_MS, 1],
    [HOUR, 1],
  ];
  for (const [msLeft, days] of cases) {
    const r = resolveAccess(input({ cache: cache({ trialEndsAt: T0 + msLeft }) }));
    assert.equal(r.state.kind, "trial");
    if (r.state.kind === "trial") {
      assert.equal(r.state.msLeft, msLeft);
      assert.equal(r.state.daysLeft, days, `msLeft=${msLeft}`);
    }
  }
});

test("returned cache records effectiveNow", () => {
  const r = resolveAccess(input({ cache: cache({ maxSeenNow: T0 - DAY_MS }), deviceNow: T0 }));
  assert.equal(r.cache.maxSeenNow, T0);
});

test("resolveAccess does not mutate its input cache", () => {
  const c = cache({ unlocked: true, trialEndsAt: T0 + DAY_MS, maxSeenNow: T0 - DAY_MS });
  const before = { ...c };
  resolveAccess(input({ cache: c, entitlement: false, deviceNow: T0 }));
  assert.deepEqual(c, before);
});

// ── startLocalTrial ───────────────────────────────────────────────────────

test("startLocalTrial starts a 5-day trial from now", () => {
  const c = startLocalTrial(EMPTY_CACHE, T0);
  assert.equal(c.trialEndsAt, T0 + TRIAL_MS);
  assert.equal(EMPTY_CACHE.trialEndsAt, null, "does not mutate the input");
  const r = resolveAccess(input({ cache: c }));
  assert.deepEqual(r.state, { kind: "trial", endsAt: T0 + TRIAL_MS, msLeft: TRIAL_MS, daysLeft: 5 });
});

test("startLocalTrial never extends an existing trial", () => {
  const running = cache({ trialEndsAt: T0 + HOUR });
  assert.equal(startLocalTrial(running, T0 + DAY_MS).trialEndsAt, T0 + HOUR);
  const ended = cache({ trialEndsAt: T0 - DAY_MS });
  assert.equal(startLocalTrial(ended, T0).trialEndsAt, T0 - DAY_MS);
});

test("an offline start cannot outlast the server record", () => {
  // Started offline at T0; the server had an earlier trial for this device.
  const local = startLocalTrial(EMPTY_CACHE, T0);
  const r = resolveAccess(
    input({ cache: local, server: { kind: "found", endsAt: T0 - DAY_MS, serverNow: T0 } }),
  );
  assert.deepEqual(r.state, { kind: "expired", endedAt: T0 - DAY_MS });
});

// ── parseCache ────────────────────────────────────────────────────────────

test("parseCache sanitizes storage junk", () => {
  assert.deepEqual(parseCache(null), EMPTY_CACHE);
  assert.deepEqual(parseCache("x"), EMPTY_CACHE);
  assert.deepEqual(parseCache({ unlocked: "yes", trialEndsAt: "soon", maxSeenNow: Number.NaN }), EMPTY_CACHE);
  assert.deepEqual(parseCache({ unlocked: true, trialEndsAt: T0, maxSeenNow: T0 - 1, extra: 1 }), {
    unlocked: true,
    trialEndsAt: T0,
    maxSeenNow: T0 - 1,
    lastDeviceNow: 0,
  });
  assert.equal(parseCache({ lastDeviceNow: T0 }).lastDeviceNow, T0);
  assert.deepEqual(parseCache({ trialEndsAt: Infinity, maxSeenNow: -5 }), EMPTY_CACHE);
});

// ── Server payloads ───────────────────────────────────────────────────────

test("parseIsoMs handles Postgres timestamptz jsonb output", () => {
  const want = Date.UTC(2026, 9, 7, 10, 0, 0, 123);
  assert.equal(parseIsoMs("2026-10-07T10:00:00.123456+00:00"), want);
  assert.equal(parseIsoMs("2026-10-07T10:00:00.123Z"), want);
  assert.equal(parseIsoMs("2026-10-07 10:00:00.123+00"), want);
  assert.equal(parseIsoMs("2026-10-07T13:00:00.123+03:00"), want);
  assert.equal(parseIsoMs("2026-10-07T07:30:00.123-0230"), want);
  assert.equal(parseIsoMs("2026-10-07T10:00:00.57Z"), Date.UTC(2026, 9, 7, 10, 0, 0, 570));
  assert.equal(parseIsoMs("2026-10-07T10:00:00Z"), Date.UTC(2026, 9, 7, 10, 0, 0));
  assert.equal(parseIsoMs("2026-10-07T10:00:00"), Date.UTC(2026, 9, 7, 10, 0, 0), "no zone = UTC");
  assert.equal(parseIsoMs("not a date"), null);
  assert.equal(parseIsoMs(""), null);
  assert.equal(parseIsoMs(null), null);
  assert.equal(parseIsoMs({}), null);
});

test("parseServerTrial maps get_trial/start_trial jsonb", () => {
  const now = "2026-10-01T12:00:00.000000+00:00";
  assert.deepEqual(parseServerTrial({ exists: false, started_at: null, ends_at: null, server_now: now }), {
    kind: "absent",
    serverNow: T0,
  });
  assert.deepEqual(
    parseServerTrial({
      exists: true,
      started_at: "2026-09-30T12:00:00+00:00",
      ends_at: "2026-10-05T12:00:00+00:00",
      server_now: now,
    }),
    { kind: "found", endsAt: T0 + 4 * DAY_MS, serverNow: T0 },
  );
  // Stringified jsonb is accepted too.
  assert.deepEqual(parseServerTrial(JSON.stringify({ exists: false, server_now: now })), {
    kind: "absent",
    serverNow: T0,
  });
});

test("parseServerTrial: anything malformed is 'unreachable', never 'absent'", () => {
  assert.equal(parseServerTrial(null), null);
  assert.equal(parseServerTrial(undefined), null);
  assert.equal(parseServerTrial("{oops"), null);
  assert.equal(parseServerTrial({ exists: false }), null, "no server_now");
  assert.equal(parseServerTrial({ exists: true, ends_at: null, server_now: "2026-10-01T12:00:00Z" }), null);
  assert.equal(parseServerTrial({ exists: "no", server_now: "2026-10-01T12:00:00Z" }), null);
});
