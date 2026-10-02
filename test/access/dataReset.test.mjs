// "Șterge toate datele" (src/lib/dataReset.ts): deletes this device's question
// reports on the server (best-effort), then clears local storage EXCEPT the
// keys that decide access — so a wipe can neither restart the trial nor drop
// an offline payer's unlock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Load the AsyncStorage stub first: it creates globalThis.__store.
import "@react-native-async-storage/async-storage";

const SRC = new URL("../../src/lib/dataReset.ts", import.meta.url).href;
const lib = (f) => readFileSync(new URL(`../../src/lib/${f}`, import.meta.url), "utf8");
const KEPT = ["access_v1", "trial_device_key_v1", "rc_synced_v1", "unlock_price_v1"];
let n = 0;

function seed() {
  globalThis.__store.clear();
  globalThis.__readFail = false;
  for (const k of KEPT) globalThis.__store.set(k, `kept:${k}`);
  for (const k of ["app_settings", "quiz_history", "quiz_sessions", "question_stats_v1", "device_id"]) {
    globalThis.__store.set(k, `data:${k}`);
  }
}
const load = () => import(`${SRC}?n=${++n}`);
const remaining = () => [...globalThis.__store.keys()].sort();

test("stub key names match the real modules (so the kept list is the real one)", () => {
  assert.match(lib("access.ts"), /ACCESS_CACHE_KEY = "access_v1"/);
  assert.match(lib("access.ts"), /RC_SYNC_FLAG_KEY = "rc_synced_v1"/);
  assert.match(lib("purchases.ts"), /PRICE_CACHE_KEY = "unlock_price_v1"/);
  assert.match(lib("deviceKey.ts"), /DEVICE_KEY_MIRROR_KEY = "trial_device_key_v1"/);
  assert.match(lib("deviceKey.ts"), /REPORT_ID_KEY = "device_id"/);
});

test("asks the server to forget the report id BEFORE clearing, then keeps only the access keys", async () => {
  seed();
  const rpcs = [];
  globalThis.__rpc = async (name, args) => {
    rpcs.push({ name, args, storeHadId: globalThis.__store.has("device_id") });
    return { data: null, error: null };
  };
  const { wipeLocalData, KEPT_ON_WIPE } = await load();
  assert.deepEqual([...KEPT_ON_WIPE].sort(), [...KEPT].sort());
  await wipeLocalData();
  assert.deepEqual(rpcs, [{ name: "forget_device", args: { p_device_id: "data:device_id" }, storeHadId: true }]);
  assert.deepEqual(remaining(), [...KEPT].sort());
  for (const k of KEPT) assert.equal(globalThis.__store.get(k), `kept:${k}`, `${k} untouched`);
});

test("no report id on this install -> no server call; local wipe still runs", async () => {
  seed();
  globalThis.__store.delete("device_id");
  let called = 0;
  globalThis.__rpc = async () => { called++; return { data: null, error: null }; };
  const { wipeLocalData } = await load();
  await wipeLocalData();
  assert.equal(called, 0);
  assert.deepEqual(remaining(), [...KEPT].sort());
});

test("server error or rejection is swallowed; local wipe still runs", async () => {
  for (const rpc of [
    async () => ({ data: null, error: { message: "boom" } }),
    async () => { throw new Error("offline"); },
  ]) {
    seed();
    globalThis.__rpc = rpc;
    const { wipeLocalData } = await load();
    await wipeLocalData();
    assert.deepEqual(remaining(), [...KEPT].sort());
  }
});

test("a hung server call is bounded (~5 s), then the local wipe runs", async () => {
  seed();
  globalThis.__rpc = () => new Promise(() => {});
  const { wipeLocalData } = await load();
  const t0 = Date.now();
  await wipeLocalData();
  const dt = Date.now() - t0;
  assert.ok(dt >= 4900 && dt < 6000, `took ${dt}ms`);
  assert.deepEqual(remaining(), [...KEPT].sort());
});
