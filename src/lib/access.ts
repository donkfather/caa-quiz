import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { loadSettings } from "./settings";
import { hasUnlockEntitlement, onUnlockEntitlementChanged, syncUnlockSilently } from "./purchases";
import { getDeviceKey } from "./deviceKey";
import { DEV_TOOLS_ENABLED } from "./buildFlags";
import {
  EMPTY_CACHE,
  TRIAL_MS,
  advanceClock,
  parseCache,
  parseServerTrial,
  resolveAccess,
  startLocalTrial,
  type AccessCache,
  type AccessState,
  type Entitlement,
  type ServerTrial,
} from "./accessCore";

export type { AccessState, AccessCache } from "./accessCore";

// Stateful side of the access rules (the rules themselves are in accessCore.ts):
// gathers the inputs — device cache, RevenueCat entitlement, server trial
// record, legacy payer flag — resolves them, persists the result and notifies
// subscribers. Never throws; every network call has a timeout; never logs in
// production.

/** AsyncStorage key of the device's access cache. Survives "Șterge toate
 * datele" (dataReset.ts): a wipe must not change who has access. */
export const ACCESS_CACHE_KEY = "access_v1";
/** AsyncStorage flag: the silent RevenueCat sync has completed on this
 * install. Also survives a data wipe (it is not user data). */
export const RC_SYNC_FLAG_KEY = "rc_synced_v1";
const CACHE_KEY = ACCESS_CACHE_KEY;
const ENTITLEMENT_TIMEOUT_MS = 5_000;
const RPC_TIMEOUT_MS = 6_000;
/** After a silent sync that errored or timed out, the earliest a later
 * refresh in the same process (foreground, store update) may try again. */
export const SYNC_RETRY_MS = 30_000;

// ── Snapshot + subscribers ────────────────────────────────────────────────

let snapshot: AccessState | null = null;
const listeners = new Set<(s: AccessState) => void>();

/** Last resolved state, or null until the first refresh resolves. */
export function getAccessSnapshot(): AccessState | null {
  return snapshot;
}

export function onAccessChanged(cb: (s: AccessState) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function publish(state: AccessState): void {
  snapshot = state;
  for (const cb of [...listeners]) {
    try {
      cb(state);
    } catch (e) {
      if (__DEV__) console.warn("access listener threw:", e);
    }
  }
}

// ── Inputs ────────────────────────────────────────────────────────────────

/** Resolve `work` or `fallback` after `ms`, whichever comes first. Rejections
 * also resolve to `fallback`. */
function withTimeout<T>(work: () => Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (v: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      if (__DEV__ && !settled) console.warn(`${label}: timed out after ${ms} ms`);
      finish(fallback);
    }, ms);
    Promise.resolve()
      .then(work)
      .then(finish, (e) => {
        if (__DEV__) console.warn(`${label} failed:`, e);
        finish(fallback);
      });
  });
}

function fetchEntitlement(): Promise<Entitlement> {
  return withTimeout(() => hasUnlockEntitlement(), ENTITLEMENT_TIMEOUT_MS, null, "entitlement");
}

// ── Silent purchase sync (once per install) ───────────────────────────────
//
// A reinstall gets a new anonymous RevenueCat app user id that does not see
// the old one-time purchase until the store receipt is re-sent — so a past
// buyer would land on the trial intro / paywall and have to find "Restore".
// syncPurchasesForResult() re-sends it WITHOUT asking for store credentials
// (restorePurchases() can prompt for the Apple ID, so it is never called
// automatically). It runs at most once per install, only when RevenueCat
// gave a DEFINITIVE "not entitled" and this device holds no unlock, and
// before the verdict is published — so a past buyer on a fresh install goes
// straight from the splash to the app, never via the intro or the paywall.
// The flag is set only when the sync completed (either answer). An error /
// timeout is retried by a later refresh — the next return to the foreground
// or store update, at most once per SYNC_RETRY_MS — or on the next launch, so
// a buyer whose one attempt hit a flaky connection isn't left on the paywall
// until the OS kills the app.

let syncDoneThisProcess = false;
let lastSyncAttemptAt: number | null = null;

async function readSyncFlag(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(RC_SYNC_FLAG_KEY)) === "1";
  } catch {
    // Unknown — treat as done rather than delay every launch by a sync.
    return true;
  }
}

/** Returns the entitlement to use: the sync's answer when it ran and
 * completed, otherwise the one passed in. */
async function maybeSyncPurchases(entitlement: Entitlement): Promise<Entitlement> {
  if (entitlement !== false || unlockedThisProcess || syncDoneThisProcess) return entitlement;
  if (lastSyncAttemptAt !== null && Math.abs(Date.now() - lastSyncAttemptAt) < SYNC_RETRY_MS) return entitlement;
  const { cache } = await readCache();
  if (cache.unlocked) return entitlement;
  if (await readSyncFlag()) {
    syncDoneThisProcess = true;
    return entitlement;
  }
  lastSyncAttemptAt = Date.now();
  const synced = await withTimeout(() => syncUnlockSilently(), ENTITLEMENT_TIMEOUT_MS, null, "syncPurchases");
  if (synced === null) return entitlement;
  syncDoneThisProcess = true;
  try {
    await AsyncStorage.setItem(RC_SYNC_FLAG_KEY, "1");
  } catch {
    // Best-effort: worst case the (silent) sync runs once more next launch.
  }
  return synced;
}

/** get_trial — read-only, never creates a row. Any error = unreachable (null). */
function fetchServerTrial(): Promise<ServerTrial> {
  return withTimeout(
    async () => {
      const { key } = await getDeviceKey();
      const { data, error } = await supabase.rpc("get_trial", { p_device_key: key });
      if (error) {
        if (__DEV__) console.warn("get_trial error:", error.message);
        return null;
      }
      return parseServerTrial(data);
    },
    RPC_TIMEOUT_MS,
    null,
    "get_trial",
  );
}

/** start_trial — insert-if-absent; an existing row is never moved. Returns the
 * stored row, or null when it couldn't be reached / replied with garbage.
 * `startedAtMs` registers a trial that was started offline with its real
 * start; the server clamps it to [now − trial length, now], so it can only
 * ever make the recorded trial earlier, never later. */
function callStartTrial(startedAtMs?: number): Promise<ServerTrial> {
  return withTimeout(
    async () => {
      const { key, platform } = await getDeviceKey();
      const args: Record<string, string> = { p_device_key: key, p_platform: platform };
      if (startedAtMs !== undefined) args.p_started_at = new Date(startedAtMs).toISOString();
      const { data, error } = await supabase.rpc("start_trial", args);
      if (error) {
        if (__DEV__) console.warn("start_trial error:", error.message);
        return null;
      }
      const parsed = parseServerTrial(data);
      return parsed?.kind === "found" ? parsed : null;
    },
    RPC_TIMEOUT_MS,
    null,
    "start_trial",
  );
}

/** settings.adsDisabled from the ad-supported build — only a purchase set it. */
async function readLegacyAdsDisabled(): Promise<boolean> {
  try {
    return (await loadSettings()).adsDisabled === true;
  } catch {
    return false;
  }
}

// ── Cache (serialized) ────────────────────────────────────────────────────

// Last cache this process committed. Used only when storage can't be read, so
// a transient read failure doesn't resolve from (and then persist) an empty
// cache — which would wipe a payer's offline unlock.
let memCache: AccessCache | null = null;

async function readCache(): Promise<{ cache: AccessCache; readOk: boolean }> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(CACHE_KEY);
  } catch (e) {
    if (__DEV__) console.warn("access cache read failed:", e);
    return { cache: memCache ? { ...memCache } : { ...EMPTY_CACHE }, readOk: false };
  }
  // A corrupt value is not a read failure: start clean and let the next write
  // repair it (otherwise it would block every write forever).
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { cache: parseCache(parsed), readOk: true };
}

async function writeCache(cache: AccessCache): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    if (__DEV__) console.warn("access cache write failed:", e);
  }
}

// Every cache mutation runs through one queue doing a FRESH read → resolve →
// write → publish (same idea as updateSettings), so a refresh, a trial start
// and a purchase can't clobber each other. Network calls happen BEFORE
// queueing, so a slow server never blocks a purchase from landing.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

// Last definitive entitlement this process saw, for resolves that don't
// re-ask RevenueCat (trial start, dev expire).
let lastEntitlement: Entitlement = null;
// Set once a purchase/restore succeeded in this process. From then on a
// definitive `false` is treated as unknown: it can only come from a check that
// raced the purchase (e.g. an AppState refresh as the store sheet closed).
// A genuine refund is picked up on the next launch.
let unlockedThisProcess = false;

interface Observation {
  entitlement: Entitlement;
  server: ServerTrial;
  legacyAdsDisabled: boolean;
}

function commit(
  obs: Observation,
  mutate?: (cache: AccessCache, effectiveNow: number) => AccessCache,
): Promise<{ state: AccessState; cache: AccessCache }> {
  return serialized(async () => {
    const { cache: fresh, readOk } = await readCache();
    const deviceNow = Date.now();
    const cache = mutate ? mutate(fresh, advanceClock(fresh, deviceNow).now) : fresh;
    const entitlement = obs.entitlement === false && unlockedThisProcess ? null : obs.entitlement;
    if (entitlement !== null) lastEntitlement = entitlement;

    const out = resolveAccess({
      cache,
      entitlement,
      server: obs.server,
      deviceNow,
      legacyAdsDisabled: obs.legacyAdsDisabled,
    });
    memCache = out.cache;
    // Only persist what was built on a successful read (or an explicit change).
    if (readOk || mutate) await writeCache(out.cache);
    publish(out.state);
    return out;
  });
}

function fallbackState(): AccessState {
  return snapshot ?? { kind: "new" };
}

// A trial started offline exists only on this device; once the server is
// reachable, record it — with its LOCAL start, not the time of registration —
// so a reinstall can't start a fresh one. Registering it as "starting now"
// would hand a reinstall a brand-new window even after the local trial ended.
// The local end still wins (earliest), so this never lengthens the running
// trial; an already-ended local trial is registered too, as already over.
let registering = false;
function registerLocalTrial(trialEndsAt: number): void {
  if (registering) return;
  registering = true;
  void callStartTrial(trialEndsAt - TRIAL_MS).then(() => {
    registering = false;
  });
}

// Cold start: publish the device's own verdict right away so a payer or trial
// user isn't held behind the 5–6 s network timeouts when offline; the network
// result replaces it moments later. "new" is NOT primed — an empty cache is
// also what a reinstall looks like until the server answers, and flashing the
// trial intro at someone whose trial already ran would be wrong. Read-only.
async function primeFromCache(): Promise<void> {
  try {
    const [{ cache }, legacyAdsDisabled] = await Promise.all([readCache(), readLegacyAdsDisabled()]);
    const { state } = resolveAccess({ cache, entitlement: null, server: null, deviceNow: Date.now(), legacyAdsDisabled });
    if (state.kind !== "new" && snapshot === null) publish(state);
  } catch {
    // The full refresh will publish anyway.
  }
}

// ── Public API ────────────────────────────────────────────────────────────

let refreshInFlight: Promise<AccessState> | null = null;

/** Re-check everything and publish. Concurrent calls share one in-flight run. */
export function refreshAccess(): Promise<AccessState> {
  if (refreshInFlight) return refreshInFlight;
  if (snapshot === null) void primeFromCache();
  const p = (async (): Promise<AccessState> => {
    try {
      // The sync (when needed) is chained onto the entitlement check, so it
      // overlaps the trial RPC instead of following it.
      const entitlementP = fetchEntitlement().then(maybeSyncPurchases);
      // A device already known as a payer doesn't send its device key just to
      // be told what it doesn't need: get_trial waits for RevenueCat and runs
      // only if the answer is not a "yes" (a refund, or no answer at all).
      // Everyone else asks both in parallel, so nobody waits for the sum of
      // the two timeouts.
      const knownPayer = (await readCache()).cache.unlocked;
      const serverP = knownPayer
        ? entitlementP.then((e) => (e === true ? null : fetchServerTrial()))
        : fetchServerTrial();
      const [entitlement, server, legacyAdsDisabled] = await Promise.all([
        entitlementP,
        serverP,
        readLegacyAdsDisabled(),
      ]);
      const { state, cache } = await commit({ entitlement, server, legacyAdsDisabled });
      if (server?.kind === "absent" && cache.trialEndsAt !== null && state.kind !== "unlocked") {
        registerLocalTrial(cache.trialEndsAt);
      }
      return state;
    } catch (e) {
      if (__DEV__) console.warn("refreshAccess failed:", e);
      return fallbackState();
    }
  })();
  refreshInFlight = p;
  void p.then(() => {
    if (refreshInFlight === p) refreshInFlight = null;
  });
  return p;
}

let startInFlight: Promise<AccessState> | null = null;

/** Called by the trial intro screen. Registers the trial on the server; if
 * that fails, starts it on the device. Never extends an existing trial (the
 * server keeps its row; startLocalTrial keeps an existing end). */
export function startTrial(): Promise<AccessState> {
  if (startInFlight) return startInFlight;
  const p = (async (): Promise<AccessState> => {
    try {
      const [server, legacyAdsDisabled] = await Promise.all([callStartTrial(), readLegacyAdsDisabled()]);
      const { state } = await commit(
        { entitlement: lastEntitlement, server, legacyAdsDisabled },
        server ? undefined : (c, now) => startLocalTrial(c, now),
      );
      return state;
    } catch (e) {
      if (__DEV__) console.warn("startTrial failed:", e);
      return fallbackState();
    }
  })();
  startInFlight = p;
  void p.then(() => {
    if (startInFlight === p) startInFlight = null;
  });
  return p;
}

/** After a successful purchase or restore. */
export async function markUnlocked(): Promise<AccessState> {
  unlockedThisProcess = true;
  lastEntitlement = true;
  try {
    const legacyAdsDisabled = await readLegacyAdsDisabled();
    const { state } = await commit(
      { entitlement: true, server: null, legacyAdsDisabled },
      (c) => ({ ...c, unlocked: true }),
    );
    return state;
  } catch (e) {
    if (__DEV__) console.warn("markUnlocked failed:", e);
    publish({ kind: "unlocked" });
    return { kind: "unlocked" };
  }
}

/** Keeps access in step with the store while the app is open: RevenueCat
 * reports every CustomerInfo change (a pending purchase that settled, Ask to
 * Buy approved, a purchase on another device with the same store account, a
 * late answer after a timed-out launch check). An active entitlement unlocks
 * at once; anything else re-runs refreshAccess (which also gives a failed
 * silent sync its retry) unless the device is already unlocked — this
 * listener only ever unlocks; refunds are picked up by the normal refreshes.
 * Returns the unsubscribe function. */
export function watchStorePurchases(): () => void {
  return onUnlockEntitlementChanged((entitled) => {
    if (snapshot?.kind === "unlocked") return;
    if (entitled) void markUnlocked();
    else void refreshAccess();
  });
}

/** Dev / preview builds only (a no-op refresh in store builds — see
 * buildFlags.ts for how a store build is told apart): end the trial
 * on this device now, to test the lockscreen. It sticks until the app is
 * reinstalled — "Șterge toate datele" keeps the access cache — because the
 * earliest end wins over the server's. A payer stays unlocked. */
export async function devExpireTrial(): Promise<AccessState> {
  if (!DEV_TOOLS_ENABLED) return refreshAccess();
  try {
    const legacyAdsDisabled = await readLegacyAdsDisabled();
    const { state } = await commit(
      { entitlement: lastEntitlement, server: null, legacyAdsDisabled },
      (c, now) => ({ ...c, trialEndsAt: Math.min(c.trialEndsAt ?? Infinity, now - 1) }),
    );
    return state;
  } catch (e) {
    if (__DEV__) console.warn("devExpireTrial failed:", e);
    return fallbackState();
  }
}
