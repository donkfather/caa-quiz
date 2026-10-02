import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { ACCESS_CACHE_KEY, RC_SYNC_FLAG_KEY } from "./access";
import { PRICE_CACHE_KEY } from "./purchases";
import { DEVICE_KEY_MIRROR_KEY, readReportDeviceId } from "./deviceKey";

const FORGET_TIMEOUT_MS = 5_000;

/** AsyncStorage keys a wipe keeps, because they decide or support ACCESS, not
 * the user's data. Wiping them would let "Șterge toate datele" change who may
 * use the app (re-show the trial intro, drop an offline payer's unlock, re-run
 * the purchase sync) — the privacy policy discloses that they stay:
 * - the access cache (trial end + last unlock verdict, no personal data),
 * - the AsyncStorage mirror of the trial device key (deviceKey.ts),
 * - the "silent purchase sync done" flag (access.ts),
 * - the last store price string (purchases.ts). */
export const KEPT_ON_WIPE: readonly string[] = [
  ACCESS_CACHE_KEY,
  DEVICE_KEY_MIRROR_KEY,
  RC_SYNC_FLAG_KEY,
  PRICE_CACHE_KEY,
];

/** Server side of the wipe: delete this device's question reports
 * (forget_device, reports only since vouchers were retired). Best-effort — a
 * wipe offline still clears the device; errors and timeouts are swallowed. */
async function forgetReportsOnServer(): Promise<void> {
  let deviceId: string | null;
  try {
    deviceId = await readReportDeviceId();
  } catch {
    return;
  }
  if (!deviceId) return; // never reported anything from this install
  const id = deviceId;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FORGET_TIMEOUT_MS);
    Promise.resolve()
      .then(() => supabase.rpc("forget_device", { p_device_id: id }))
      .then(
        ({ error }) => {
          if (error && __DEV__) console.warn("forget_device error:", error.message);
        },
        (e) => {
          if (__DEV__) console.warn("forget_device failed:", e);
        },
      )
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/** "Șterge toate datele":
 * 1. asks the server to delete this device's question reports (best-effort,
 *    ~5 s max), then
 * 2. clears everything this app stores on the device — progress, history,
 *    settings, cached questions, the report id — except the access keys in
 *    KEPT_ON_WIPE.
 *
 * Deliberately left alone (the privacy policy discloses it):
 * - the trial device key in SecureStore / the Keychain (deviceKey.ts), and
 * - the server's trial record (only a hash of that key + start time).
 * Keeping them is what stops "wipe data" from restarting the free trial. A
 * payer loses nothing: the purchase lives in their store account and is
 * re-read from RevenueCat on the next refresh. Throws only if the local wipe
 * itself fails. */
export async function wipeLocalData(): Promise<void> {
  await forgetReportsOnServer();
  const keep = new Set(KEPT_ON_WIPE);
  const keys = await AsyncStorage.getAllKeys();
  const doomed = keys.filter((k) => !keep.has(k));
  if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
}
