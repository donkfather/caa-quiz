import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { loadSettings, updateSettings, type AppSettings } from "./settings";
import { hasNoAdsEntitlement } from "./purchases";

const DEVICE_ID_KEY = "device_id";

export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Server check for a voucher-based ad-free redemption. Tri-state:
 * true/false when known, null when it couldn't be determined (offline/error). */
async function checkVoucherActive(): Promise<boolean | null> {
  try {
    const deviceId = await getDeviceId();
    const { data, error } = await supabase.rpc("check_ads_free", { p_device_id: deviceId });
    if (error) return null;
    return data === true;
  } catch {
    return null;
  }
}

let reconcileInFlight: Promise<boolean> | null = null;
let grantGeneration = 0;

/** Mark ads as removed (purchase / restore / voucher redemption). Writes via
 * the serialized settings queue and bumps a generation counter so a concurrent
 * reconcile can't revoke the grant it raced with. Returns updated settings. */
export function grantAdsFree(): Promise<AppSettings> {
  grantGeneration++;
  return updateSettings((s) => {
    s.adsDisabled = true;
  });
}

/** Reconcile `settings.adsDisabled` from BOTH ad-free sources — a voucher
 * redemption OR the RevenueCat "no_ads" entitlement. Grants when either is a
 * definitive yes; revokes ONLY when both are a definitive no AND no grant
 * landed during our checks; preserves the current value whenever either source
 * is unknown (offline/error), so a transient failure can never re-enable ads
 * for an entitled/paying user. Deduped with an in-flight guard and writes via
 * the serialized settings queue so it can't clobber a concurrent grant. Kept
 * under the name `validateAdsFree` for its existing call sites. */
export function validateAdsFree(): Promise<boolean> {
  if (reconcileInFlight) return reconcileInFlight;
  const p = (async () => {
    const genAtStart = grantGeneration;
    const settings = await loadSettings();
    const rc = await hasNoAdsEntitlement(); // true | false | null

    // Only hit the voucher server when ads are already disabled — the voucher
    // path is the only thing that sets that flag, so a never-granted device has
    // nothing to validate (treat as a definitive "no", no network call).
    const voucher: boolean | null = settings.adsDisabled ? await checkVoucherActive() : false;

    if (rc === true || voucher === true) {
      return (await updateSettings((s) => { s.adsDisabled = true; })).adsDisabled;
    }
    if (rc === false && voucher === false) {
      // Definitive revoke — but skip if a grant landed during our checks.
      return (await updateSettings((s) => {
        if (grantGeneration === genAtStart) s.adsDisabled = false;
      })).adsDisabled;
    }
    // Either source unknown → preserve current.
    return (await loadSettings()).adsDisabled;
  })();
  reconcileInFlight = p;
  p.finally(() => {
    reconcileInFlight = null;
  });
  return p;
}

export type RedeemResult =
  | { success: true }
  | { success: false; message: string };

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Codul nu este valid.",
  expired: "Codul a expirat.",
  used_up: "Codul a fost utilizat de prea multe ori.",
  already_redeemed: "Ai folosit deja acest cod.",
};

export async function forgetDevice(): Promise<void> {
  try {
    const deviceId = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (deviceId) {
      await supabase.rpc("forget_device", { p_device_id: deviceId });
    }
  } catch {
    // Best-effort — even if the server call fails we still wipe locally.
  }
  await AsyncStorage.clear();
}

export async function redeemVoucher(code: string): Promise<RedeemResult> {
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return { success: false, message: "Codul nu poate fi gol." };

  try {
    const deviceId = await getDeviceId();
    const { data, error } = await supabase.rpc("try_redeem_voucher", {
      p_code: trimmed,
      p_device_id: deviceId,
    });

    if (error) {
      return { success: false, message: "Eroare la activare. Încearcă din nou." };
    }

    if (data === "success") {
      await grantAdsFree();
      return { success: true };
    }

    return { success: false, message: ERROR_MESSAGES[data] || "Eroare necunoscută." };
  } catch {
    return { success: false, message: "Eroare de conexiune. Verifică internetul." };
  }
}
