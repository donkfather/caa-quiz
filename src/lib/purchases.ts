import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import Purchases, {
  PURCHASES_ERROR_CODE,
  type CustomerInfo,
  type CustomerInfoUpdateListener,
  type PurchasesPackage,
} from "react-native-purchases";

/** RevenueCat entitlement that unlocks the app after the free trial. Must match
 * the dashboard exactly.
 *
 * KEEP IT "no_ads": the id dates from when this one-time purchase removed ads,
 * and everyone who bought it then holds exactly this entitlement. It is never
 * shown to users. Renaming it here without renaming it in the RevenueCat
 * dashboard at the same moment would lock every past buyer out. */
export const ENTITLEMENT_ID = "no_ads";

/** The store this build buys from, for user-facing copy. */
export const STORE_NAME = Platform.OS === "ios" ? "App Store" : "Google Play";

// PUBLIC SDK keys (appl_… / goog_…), injected per build via app.config.js extra
// from EXPO_PUBLIC_RC_* env vars. Safe to embed in the client (unlike the
// secret v2 API key, which must never ship). Without a key the SDK stays
// disabled: the entitlement reads as unknown and nothing can be bought — so a
// build without keys locks everyone out once their trial ends.
const API_KEY = Platform.select({
  ios: Constants.expoConfig?.extra?.revenueCatIosKey as string | undefined,
  android: Constants.expoConfig?.extra?.revenueCatAndroidKey as string | undefined,
  default: undefined,
});

let configured = false;
let configurePromise: Promise<boolean> | null = null;

/** Configure the Purchases SDK once per process. Resolves to whether it's
 * usable. Idempotent and never throws. */
export function configurePurchases(): Promise<boolean> {
  if (configured) return Promise.resolve(true);
  if (configurePromise) return configurePromise;
  configurePromise = (async () => {
    if (!API_KEY) {
      if (__DEV__) console.warn("RevenueCat: no SDK key for this platform — purchases disabled");
      return false;
    }
    try {
      Purchases.configure({ apiKey: API_KEY });
      configured = true;
      return true;
    } catch (e) {
      if (__DEV__) console.warn("RevenueCat configure failed:", e);
      return false;
    }
  })();
  return configurePromise;
}

function entitlementActive(info: CustomerInfo): boolean {
  return info.entitlements.active[ENTITLEMENT_ID] !== undefined;
}

/** Calls `cb` with the unlock entitlement every time RevenueCat's
 * CustomerInfo changes — including a purchase that settles after
 * purchasePackage returned (Ask to Buy, a pending Play payment, a purchase
 * made on another device with the same store account). Without it a user who
 * just paid would stay on the lock screen until the app is reopened. Returns
 * the unsubscribe function. No-op without an SDK key. Never throws. */
export function onUnlockEntitlementChanged(cb: (entitled: boolean) => void): () => void {
  let removed = false;
  let listener: CustomerInfoUpdateListener | null = null;
  void configurePurchases().then((ok) => {
    if (!ok || removed) return;
    listener = (info) => {
      try {
        cb(entitlementActive(info));
      } catch (e) {
        if (__DEV__) console.warn("CustomerInfo listener threw:", e);
      }
    };
    try {
      Purchases.addCustomerInfoUpdateListener(listener);
    } catch (e) {
      if (__DEV__) console.warn("RevenueCat addCustomerInfoUpdateListener failed:", e);
      listener = null;
    }
  });
  return () => {
    removed = true;
    if (!listener) return;
    try {
      Purchases.removeCustomerInfoUpdateListener(listener);
    } catch {
      // Already gone.
    }
    listener = null;
  };
}

/** true/false when known, null when it couldn't be checked (not configured /
 * offline / error). Callers MUST treat null as "unknown" and never downgrade an
 * entitled user on it. */
export async function hasUnlockEntitlement(): Promise<boolean | null> {
  if (!(await configurePurchases())) return null;
  try {
    return entitlementActive(await Purchases.getCustomerInfo());
  } catch (e) {
    if (__DEV__) console.warn("RevenueCat getCustomerInfo failed:", e);
    return null;
  }
}

async function getUnlockPackage(): Promise<PurchasesPackage | null> {
  if (!(await configurePurchases())) return null;
  try {
    const offering = (await Purchases.getOfferings()).current;
    return offering?.availablePackages[0] ?? null;
  } catch (e) {
    if (__DEV__) console.warn("RevenueCat getOfferings failed:", e);
    return null;
  }
}

/** Silent, one-per-install purchase sync for a reinstall (see access.ts).
 *
 * A reinstall gets a new anonymous RevenueCat app user id, which does not see
 * the old one-time purchase until the store receipt is sent again. Unlike
 * restorePurchases(), syncPurchasesForResult() never asks for the store
 * account's credentials, so it is safe to run without a tap. Never call
 * restorePurchases() automatically — on iOS it can prompt for the Apple ID.
 *
 * Resolves to the entitlement after the sync (true/false), or null when it
 * couldn't run (not configured / offline / error). */
export async function syncUnlockSilently(): Promise<boolean | null> {
  if (!(await configurePurchases())) return null;
  try {
    const { customerInfo } = await Purchases.syncPurchasesForResult();
    return entitlementActive(customerInfo);
  } catch (e) {
    if (__DEV__) console.warn("RevenueCat syncPurchasesForResult failed:", e);
    return null;
  }
}

/** AsyncStorage key of the last store price string seen for the unlock.
 * Survives "Șterge toate datele" (dataReset.ts) — it is not user data. */
export const PRICE_CACHE_KEY = "unlock_price_v1";

async function readCachedPrice(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(PRICE_CACHE_KEY);
    return typeof v === "string" && v.trim() ? v : null;
  } catch {
    return null;
  }
}

/** Localized price string for the one-time unlock (e.g. "RON 19,99"), straight
 * from the store. When the offering can't be loaded right now (offline, store
 * hiccup) it falls back to the last string the store returned on this device;
 * null only when none was ever loaded. The cached string is the store's own
 * text — never computed or reformatted here. */
export async function getUnlockPriceString(): Promise<string | null> {
  const live = (await getUnlockPackage())?.product.priceString ?? null;
  if (live) {
    try {
      await AsyncStorage.setItem(PRICE_CACHE_KEY, live);
    } catch {
      // Best-effort: the live value is returned either way.
    }
    return live;
  }
  return readCachedPrice();
}

/** `pending` = the store accepted the payment but hasn't settled it (e.g.
 * parental approval, cash payment) — not a failure; the UI must not say so. */
export type PurchaseResult = { success: boolean; cancelled?: boolean; pending?: boolean; message?: string };

export async function purchaseUnlock(): Promise<PurchaseResult> {
  const pkg = await getUnlockPackage();
  if (!pkg) return { success: false, message: "Produsul nu este disponibil momentan." };
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    if (entitlementActive(customerInfo)) return { success: true };
    return { success: false, message: "Achiziția nu a putut fi confirmată. Încearcă „Restaurează achizițiile”." };
  } catch (e) {
    const err = e as { userCancelled?: boolean | null; code?: string };
    // react-native-purchases throws on user cancel (not a resolved value).
    if (err?.userCancelled) return { success: false, cancelled: true };
    // Deferred payment (e.g. awaiting parental approval or a cash payment):
    // not a failure — saying so would invite the user to pay twice.
    if (err?.code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) {
      return {
        success: false,
        pending: true,
        message: "Plata este în curs de procesare. Aplicația se deblochează automat după confirmare.",
      };
    }
    // Google Play's ITEM_ALREADY_OWNED: this store account already owns the
    // unlock, but this install's anonymous RevenueCat user doesn't see it yet
    // (e.g. a reinstall whose silent sync hasn't completed). Re-send the
    // receipt silently — no credentials prompt — and unlock; only if that
    // fails, point the user at Restore instead of calling it a failure.
    if (err?.code === PURCHASES_ERROR_CODE.PRODUCT_ALREADY_PURCHASED_ERROR) {
      if ((await syncUnlockSilently()) === true) return { success: true };
      return {
        success: false,
        message: "Ai cumpărat deja aplicația cu acest cont. Apasă „Restaurează achizițiile” ca să o deblochezi.",
      };
    }
    if (__DEV__) console.warn("RevenueCat purchase failed:", e);
    return { success: false, message: "Achiziția nu a putut fi finalizată." };
  }
}

/** true if a purchase was restored, false if there was nothing to restore,
 * null on error/offline. */
export async function restorePurchases(): Promise<boolean | null> {
  if (!(await configurePurchases())) return null;
  try {
    return entitlementActive(await Purchases.restorePurchases());
  } catch (e) {
    if (__DEV__) console.warn("RevenueCat restore failed:", e);
    return null;
  }
}
