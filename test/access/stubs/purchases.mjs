// RevenueCat side of access.ts. Tests drive it through globals:
//   __ent()  -> hasUnlockEntitlement() result (value or promise)
//   __sync() -> syncUnlockSilently() result (default: false = nothing found)
// Every call is counted in __calls so tests can assert what was (not) called.
// Key names must match src/lib/purchases.ts (asserted in dataReset.test.mjs).
export const PRICE_CACHE_KEY = "unlock_price_v1";
const count = (name) => {
  globalThis.__calls ??= {};
  globalThis.__calls[name] = (globalThis.__calls[name] ?? 0) + 1;
};
export async function hasUnlockEntitlement() { count("entitlement"); return globalThis.__ent(); }
export async function syncUnlockSilently() {
  count("sync");
  return globalThis.__sync ? globalThis.__sync() : false;
}
export async function restorePurchases() { count("restore"); throw new Error("restorePurchases must never run automatically"); }
// CustomerInfo listener: tests fire it with globalThis.__ciFire(entitled).
export function onUnlockEntitlementChanged(cb) {
  count("listen");
  globalThis.__ciFire = cb;
  return () => {
    if (globalThis.__ciFire === cb) globalThis.__ciFire = null;
  };
}
