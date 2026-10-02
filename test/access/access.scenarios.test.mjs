// Scenario tests for src/lib/access.ts — the stateful side of the trial /
// unlock rules — run against in-memory stubs (see register.mjs, loader.mjs).
// Each fresh() re-imports access.ts with a new query string, which is what a
// new app process looks like: module state reset, AsyncStorage kept only
// with { keep: true }.
//
//   npm test   (or: node --import ./test/access/register.mjs --test test/access/*.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = new URL("../../src/lib/access.ts", import.meta.url).href;
const DAY = 86_400_000;
let n = 0;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const absent = () => ({ data: { exists: false, started_at: null, ends_at: null, server_now: iso(Date.now()) }, error: null });
const found = (endsAt) => ({ data: { exists: true, started_at: iso(endsAt - 5 * DAY), ends_at: iso(endsAt), server_now: iso(Date.now()) }, error: null });
const cacheOf = () => JSON.parse(globalThis.__store.get("access_v1") ?? "null");
const calls = (name) => globalThis.__calls?.[name] ?? 0;
const SYNC_FLAG = "rc_synced_v1";

/** A new "process". sync defaults to "completed, nothing found" (false). */
async function fresh({
  ent = () => null,
  rpc = async () => { throw new Error("offline"); },
  sync = () => false,
  legacy = false,
  keep = false,
} = {}) {
  if (!keep) globalThis.__store?.clear();
  globalThis.__readFail = false;
  globalThis.__calls = {};
  globalThis.__ent = ent; globalThis.__rpc = rpc; globalThis.__sync = sync; globalThis.__legacy = legacy;
  return import(`${SRC}?n=${++n}`);
}

test("new user online -> new; start -> 5-day trial from server", async () => {
  const calls = [];
  let row = null;
  const A = await fresh({ ent: () => false, rpc: async (name, args) => {
    calls.push(name);
    if (name === "get_trial") return row ? found(row) : absent();
    row ??= Date.now() + 5 * DAY; return found(row);
  }});
  assert.deepEqual(await A.refreshAccess(), { kind: "new" });
  const s = await A.startTrial();
  assert.equal(s.kind, "trial"); assert.equal(s.daysLeft, 5);
  assert.equal(cacheOf().trialEndsAt, row);
  assert.deepEqual(calls, ["get_trial", "start_trial"]);
});

test("offline start -> local 5-day trial; later online registers it once, local end kept", async () => {
  let A = await fresh();
  assert.deepEqual(await A.refreshAccess(), { kind: "new" });
  const s = await A.startTrial();
  assert.equal(s.kind, "trial"); assert.equal(s.daysLeft, 5);
  const localEnd = cacheOf().trialEndsAt;
  const calls = [];
  globalThis.__rpc = async (name) => { calls.push(name); return name === "get_trial" ? absent() : found(Date.now() + 5 * DAY + 10_000); };
  const s2 = await A.refreshAccess();
  await sleep(10);
  assert.equal(s2.kind, "trial"); assert.equal(s2.endsAt, localEnd);
  assert.deepEqual(calls, ["get_trial", "start_trial"], "registered the offline trial");
  await A.refreshAccess(); // server still says absent in this stub -> may register again, but never extends
  assert.equal(cacheOf().trialEndsAt, localEnd);
});

test("payer: unlocked; offline stays unlocked; refund locks", async () => {
  const A = await fresh({ ent: () => true, rpc: async () => absent() });
  assert.deepEqual(await A.refreshAccess(), { kind: "unlocked" });
  globalThis.__ent = () => null; globalThis.__rpc = async () => { throw new Error("offline"); };
  assert.deepEqual(await A.refreshAccess(), { kind: "unlocked" });
  globalThis.__ent = () => false; globalThis.__rpc = async () => found(Date.now() - DAY);
  assert.equal((await A.refreshAccess()).kind, "expired");
  assert.equal(cacheOf().unlocked, false);
});

test("legacy adsDisabled: trusted while unknown, not against a definitive false", async () => {
  const A = await fresh({ legacy: true });
  assert.deepEqual(await A.refreshAccess(), { kind: "unlocked" });
  const B = await fresh({ legacy: true, ent: () => false, rpc: async () => absent() });
  assert.deepEqual(await B.refreshAccess(), { kind: "new" });
});

test("race: a stale 'false' landing after markUnlocked cannot relock", async () => {
  let release;
  const A = await fresh({ ent: () => new Promise((r) => { release = () => r(false); }), rpc: async () => found(Date.now() - DAY) });
  const p = A.refreshAccess();
  await sleep(5);
  assert.deepEqual(await A.markUnlocked(), { kind: "unlocked" });
  release();
  assert.deepEqual(await p, { kind: "unlocked" });
  assert.equal(cacheOf().unlocked, true);
  assert.deepEqual(A.getAccessSnapshot(), { kind: "unlocked" });
});

test("storage read failure never overwrites a payer's cache", async () => {
  const A = await fresh({ ent: () => true, rpc: async () => absent() });
  await A.refreshAccess();
  const before = globalThis.__store.get("access_v1");
  const B = await fresh({ keep: true }); // new process, offline, unknown entitlement
  globalThis.__readFail = true;
  await B.refreshAccess();
  globalThis.__readFail = false;
  assert.equal(globalThis.__store.get("access_v1"), before);
  assert.deepEqual(await B.refreshAccess(), { kind: "unlocked" }, "cache intact once storage reads again");
});

test("dedupe: concurrent refreshes share one run", async () => {
  let gets = 0;
  const A = await fresh({ ent: () => false, rpc: async () => { gets++; await sleep(20); return absent(); } });
  const [a, b] = [A.refreshAccess(), A.refreshAccess()];
  assert.equal(a, b);
  await a;
  assert.equal(gets, 1);
});

test("cold start primes from cache before slow network; 'new' is not primed", async () => {
  const A = await fresh({ ent: () => false, rpc: async () => found(Date.now() + 2 * DAY) });
  await A.refreshAccess();
  const B = await fresh({ keep: true, ent: () => new Promise(() => {}), rpc: () => new Promise(() => {}) });
  void B.refreshAccess();
  await sleep(20);
  assert.equal(B.getAccessSnapshot()?.kind, "trial", "primed from cache while network hangs");
  const C = await fresh({ ent: () => new Promise(() => {}), rpc: () => new Promise(() => {}) });
  void C.refreshAccess();
  await sleep(20);
  assert.equal(C.getAccessSnapshot(), null, "empty cache is not primed as 'new'");
});

test("timeouts: hung RevenueCat + hung RPC still resolve (~6s)", async () => {
  const A = await fresh({ ent: () => new Promise(() => {}), rpc: () => new Promise(() => {}) });
  const t0 = Date.now();
  assert.deepEqual(await A.refreshAccess(), { kind: "new" });
  const dt = Date.now() - t0;
  assert.ok(dt >= 5900 && dt < 7000, `took ${dt}ms`);
});

test("startTrial never revives an expired trial (online or offline)", async () => {
  const ended = Date.now() - DAY;
  const A = await fresh({ ent: () => false, rpc: async () => found(ended) });
  assert.equal((await A.refreshAccess()).kind, "expired");
  assert.equal((await A.startTrial()).kind, "expired");
  globalThis.__rpc = async () => { throw new Error("offline"); };
  assert.equal((await A.startTrial()).kind, "expired");
  assert.equal(cacheOf().trialEndsAt, ended);
});

test("devExpireTrial is a no-op outside dev/preview", async () => {
  const A = await fresh({ ent: () => false, rpc: async () => found(Date.now() + DAY) });
  await A.refreshAccess();
  assert.equal((await A.devExpireTrial()).kind, "trial");
});

test("listeners get every published state; unsubscribe works", async () => {
  const A = await fresh({ ent: () => false, rpc: async () => absent() });
  const seen = [];
  const off = A.onAccessChanged((s) => seen.push(s.kind));
  await A.refreshAccess();
  off();
  await A.markUnlocked();
  assert.deepEqual(seen, ["new"]);
});

test("corrupt cache value is repaired by the next write", async () => {
  globalThis.__store?.clear();
  globalThis.__store.set("access_v1", "{not json");
  const A = await fresh({ keep: true, ent: () => false, rpc: async () => found(Date.now() + DAY) });
  assert.equal((await A.refreshAccess()).kind, "trial");
  assert.equal(typeof cacheOf().trialEndsAt, "number");
});

// ── Silent purchase sync (reinstalled past buyers) ─────────────────────────

test("reinstalled buyer: definitive false -> silent sync -> unlocked, with no intro/paywall flash", async () => {
  const A = await fresh({ ent: () => false, sync: () => true, rpc: async () => found(Date.now() - DAY) });
  const seen = [];
  A.onAccessChanged((s) => seen.push(s.kind));
  assert.deepEqual(await A.refreshAccess(), { kind: "unlocked" });
  assert.deepEqual(seen, ["unlocked"], "the first and only published state is unlocked");
  assert.equal(calls("sync"), 1);
  assert.equal(calls("restore"), 0, "restorePurchases is never called automatically");
  assert.equal(globalThis.__store.get(SYNC_FLAG), "1");
  assert.equal(cacheOf().unlocked, true);
  // Next launch: entitlement now true by itself; no second sync.
  const B = await fresh({ keep: true, ent: () => true, rpc: async () => found(Date.now() - DAY) });
  assert.deepEqual(await B.refreshAccess(), { kind: "unlocked" });
  assert.equal(calls("sync"), 0);
});

test("sync that finds nothing: flag set, state as before, never retried", async () => {
  const A = await fresh({ ent: () => false, sync: () => false, rpc: async () => found(Date.now() - DAY) });
  assert.equal((await A.refreshAccess()).kind, "expired");
  assert.equal(calls("sync"), 1);
  assert.equal(globalThis.__store.get(SYNC_FLAG), "1");
  const B = await fresh({ keep: true, ent: () => false, rpc: async () => found(Date.now() - DAY) });
  assert.equal((await B.refreshAccess()).kind, "expired");
  assert.equal(calls("sync"), 0, "completed once per install");
});

/** Run `fn` with Date.now moved `ms` into the future. */
async function later(ms, fn) {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test("sync error / timeout-as-null: flag NOT set, retried after a back-off and on the next launch", async () => {
  const A = await fresh({ ent: () => false, sync: () => null, rpc: async () => absent() });
  assert.deepEqual(await A.refreshAccess(), { kind: "new" });
  assert.equal(globalThis.__store.has(SYNC_FLAG), false);
  await A.refreshAccess(); // e.g. straight back to the foreground
  assert.equal(calls("sync"), 1, "not hammered: no retry inside the back-off");
  await later(A.SYNC_RETRY_MS + 1_000, () => A.refreshAccess());
  assert.equal(calls("sync"), 2, "retried in the same process once the back-off passed");

  const B = await fresh({ keep: true, ent: () => false, sync: () => Promise.reject(new Error("network")), rpc: async () => absent() });
  assert.deepEqual(await B.refreshAccess(), { kind: "new" });
  assert.equal(calls("sync"), 1, "retried on the next launch");
  assert.equal(globalThis.__store.has(SYNC_FLAG), false, "a rejected sync doesn't set the flag either");

  const C = await fresh({ keep: true, ent: () => false, sync: () => true, rpc: async () => absent() });
  assert.deepEqual(await C.refreshAccess(), { kind: "unlocked" });
  assert.equal(globalThis.__store.get(SYNC_FLAG), "1");
});

test("reinstalled buyer whose first sync rejected unlocks on a later resume, without a relaunch", async () => {
  const expiredRow = async () => found(Date.now() - DAY);
  let syncOk = false;
  const A = await fresh({
    ent: () => false,
    sync: () => (syncOk ? true : Promise.reject(new Error("flaky network"))),
    rpc: expiredRow,
  });
  assert.equal((await A.refreshAccess()).kind, "expired", "cold start: sync failed, paywall");
  syncOk = true; // on Wi-Fi now
  const s = await later(A.SYNC_RETRY_MS + 1_000, () => A.refreshAccess()); // AppState "active"
  assert.deepEqual(s, { kind: "unlocked" });
  assert.equal(calls("sync"), 2);
  assert.equal(globalThis.__store.get(SYNC_FLAG), "1");
  await later(2 * A.SYNC_RETRY_MS, () => A.refreshAccess());
  assert.equal(calls("sync"), 2, "a completed sync is not repeated");
});

test("sync not attempted: entitlement true, entitlement unknown, device already unlocked", async () => {
  const A = await fresh({ ent: () => true, sync: () => true, rpc: async () => absent() });
  assert.deepEqual(await A.refreshAccess(), { kind: "unlocked" });
  assert.equal(calls("sync"), 0, "entitlement true");

  const B = await fresh({ ent: () => null, sync: () => true, rpc: async () => absent() });
  assert.deepEqual(await B.refreshAccess(), { kind: "new" });
  assert.equal(calls("sync"), 0, "entitlement unknown");
  assert.equal(globalThis.__store.has(SYNC_FLAG), false);

  // Device holds an unlock (cache) and RevenueCat now says false: a refund.
  // No sync — the definitive false locks, as before.
  const C = await fresh({ ent: () => true, rpc: async () => found(Date.now() - DAY) });
  await C.refreshAccess();
  const D = await fresh({ keep: true, ent: () => false, sync: () => true, rpc: async () => found(Date.now() - DAY) });
  assert.equal((await D.refreshAccess()).kind, "expired");
  assert.equal(calls("sync"), 0, "cache already unlocked");

  // Bought in this process; a stale false arrives afterwards.
  const E = await fresh({ ent: () => false, sync: () => false, rpc: async () => absent() });
  await E.markUnlocked();
  assert.deepEqual(await E.refreshAccess(), { kind: "unlocked" });
  assert.equal(calls("sync"), 0, "unlocked this process");
});

test("sync that hangs is bounded by the entitlement timeout (~5 s) and not flagged", async () => {
  const A = await fresh({ ent: () => false, sync: () => new Promise(() => {}), rpc: async () => absent() });
  const t0 = Date.now();
  assert.deepEqual(await A.refreshAccess(), { kind: "new" });
  const dt = Date.now() - t0;
  assert.ok(dt >= 4900 && dt < 6000, `took ${dt}ms`);
  assert.equal(globalThis.__store.has(SYNC_FLAG), false);
});

// ── Store updates while the app is open (CustomerInfo listener) ────────────

test("a purchase that settles later unlocks the open paywall (Ask to Buy / pending payment)", async () => {
  const A = await fresh({ ent: () => false, rpc: async () => found(Date.now() - DAY) });
  const unwatch = A.watchStorePurchases();
  assert.equal(calls("listen"), 1);
  assert.equal((await A.refreshAccess()).kind, "expired");
  globalThis.__ciFire(true); // RevenueCat posts the approved transaction
  await sleep(10);
  assert.deepEqual(A.getAccessSnapshot(), { kind: "unlocked" });
  assert.equal(cacheOf().unlocked, true);
  unwatch();
  assert.equal(globalThis.__ciFire, null, "unsubscribed");
});

test("a CustomerInfo update without the entitlement re-checks access (and retries the sync)", async () => {
  const A = await fresh({ ent: () => false, sync: () => null, rpc: async () => found(Date.now() - DAY) });
  A.watchStorePurchases();
  await A.refreshAccess();
  const before = calls("entitlement");
  globalThis.__ent = () => true; // RevenueCat's cache turned entitled after a late post
  globalThis.__ciFire(false); // an update arrives that this tick reads as false…
  await sleep(10);
  assert.equal(calls("entitlement"), before + 1, "…and triggers a full refresh");
  assert.deepEqual(A.getAccessSnapshot(), { kind: "unlocked" });
});

test("the listener never locks: an update while unlocked is ignored", async () => {
  const A = await fresh({ ent: () => true, rpc: async () => absent() });
  A.watchStorePurchases();
  await A.refreshAccess();
  const before = calls("entitlement");
  globalThis.__ent = () => false;
  globalThis.__ciFire(false);
  await sleep(10);
  assert.equal(calls("entitlement"), before);
  assert.deepEqual(A.getAccessSnapshot(), { kind: "unlocked" });
});

// ── Offline-started trials are registered with their real start ───────────

/** A server that behaves like the migration: insert-if-absent with the start
 * clamped to [now - 5 days, now], keyed by device. */
function trialServer() {
  const rows = new Map();
  const log = [];
  const rpc = async (name, args) => {
    log.push({ name, args });
    const now = Date.now();
    const key = args.p_device_key;
    if (name === "start_trial" && !rows.has(key)) {
      const claimed = args.p_started_at ? Date.parse(args.p_started_at) : now;
      rows.set(key, Math.max(Math.min(claimed, now), now - 5 * DAY));
    }
    if (name === "get_trial" || name === "start_trial") {
      const start = rows.get(key);
      return start === undefined ? absent() : found(start + 5 * DAY);
    }
    return { data: null, error: null };
  };
  return { rpc, rows, log };
}

test("a trial started offline is registered with its local start: a reinstall gets no new window", async () => {
  const srv = trialServer();
  const A = await fresh({ ent: () => false });
  assert.equal((await A.startTrial()).kind, "trial"); // offline tap at T0
  const localStart = cacheOf().trialEndsAt - 5 * DAY;
  // 5.1 days later the device reaches the server for the first time.
  globalThis.__rpc = srv.rpc;
  const s = await later(5.1 * DAY, () => A.refreshAccess());
  await sleep(10);
  assert.equal(s.kind, "expired");
  const reg = srv.log.find((c) => c.name === "start_trial");
  assert.ok(reg, "registered");
  assert.equal(Date.parse(reg.args.p_started_at), localStart, "sent the local start, not 'now'");
  // Reinstall: storage gone, same device key, still online.
  const B = await fresh({ ent: () => false, rpc: srv.rpc });
  assert.equal((await later(5.2 * DAY, () => B.refreshAccess())).kind, "expired");
});

test("the online tap sends no start time (the server uses its own clock)", async () => {
  const srv = trialServer();
  const A = await fresh({ ent: () => false, rpc: srv.rpc });
  await A.refreshAccess();
  assert.equal((await A.startTrial()).kind, "trial");
  const tap = srv.log.find((c) => c.name === "start_trial");
  assert.equal(tap.args.p_started_at, undefined);
});

// ── Known payers don't send the device key ─────────────────────────────────

test("known payer: get_trial is skipped while RevenueCat says yes, asked again on a refund", async () => {
  const names = [];
  const rpc = async (name) => { names.push(name); return found(Date.now() - DAY); };
  const A = await fresh({ ent: () => true, rpc });
  assert.deepEqual(await A.refreshAccess(), { kind: "unlocked" });
  assert.deepEqual(names, ["get_trial"], "first launch: not yet known as a payer, asked in parallel");
  const B = await fresh({ keep: true, ent: () => true, rpc });
  assert.deepEqual(await B.refreshAccess(), { kind: "unlocked" });
  assert.deepEqual(names, ["get_trial"], "known payer + yes: no device key sent");
  const C = await fresh({ keep: true, ent: () => false, rpc });
  assert.equal((await C.refreshAccess()).kind, "expired", "refund: the trial record still applies");
  assert.deepEqual(names, ["get_trial", "get_trial"]);
});
