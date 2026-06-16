import { Platform } from "react-native";
import Constants from "expo-constants";
import Purchases, {
  type CustomerInfo,
  type PurchasesPackage,
} from "react-native-purchases";

/** RevenueCat entitlement that removes ads. Must match the dashboard exactly. */
export const ENTITLEMENT_ID = "no_ads";

// PUBLIC SDK keys (appl_… / goog_…), injected per build via app.config.js extra
// from EXPO_PUBLIC_RC_* env vars. Safe to embed in the client (unlike the
// secret v2 API key, which must never ship). Undefined until configured in the
// RevenueCat dashboard + build env — the SDK then stays disabled and the app
// behaves exactly as before.
const API_KEY = Platform.select({
  ios: Constants.expoConfig?.extra?.revenueCatIosKey as string | undefined,
  android: Constants.expoConfig?.extra?.revenueCatAndroidKey as string | undefined,
  default: undefined,
});

let configured = false;
let configurePromise: Promise<boolean> | null = null;

/** Configure the Purchases SDK once per process. Resolves to whether it's
 * usable. Idempotent and never throws (mirrors initAds). */
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

/** true/false when known, null when it couldn't be checked (not configured /
 * offline / error). Callers MUST treat null as "unknown" and never downgrade an
 * entitled user on it. */
export async function hasNoAdsEntitlement(): Promise<boolean | null> {
  if (!(await configurePurchases())) return null;
  try {
    return entitlementActive(await Purchases.getCustomerInfo());
  } catch (e) {
    if (__DEV__) console.warn("RevenueCat getCustomerInfo failed:", e);
    return null;
  }
}

async function getNoAdsPackage(): Promise<PurchasesPackage | null> {
  if (!(await configurePurchases())) return null;
  try {
    const offering = (await Purchases.getOfferings()).current;
    return offering?.availablePackages[0] ?? null;
  } catch (e) {
    if (__DEV__) console.warn("RevenueCat getOfferings failed:", e);
    return null;
  }
}

/** Localized price string for the remove-ads package (e.g. "RON 19,99"), or
 * null when the offering isn't available yet. */
export async function getNoAdsPriceString(): Promise<string | null> {
  return (await getNoAdsPackage())?.product.priceString ?? null;
}

export type PurchaseResult = { success: boolean; cancelled?: boolean; message?: string };

export async function purchaseNoAds(): Promise<PurchaseResult> {
  const pkg = await getNoAdsPackage();
  if (!pkg) return { success: false, message: "Produsul nu este disponibil momentan." };
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { success: entitlementActive(customerInfo) };
  } catch (e) {
    // react-native-purchases throws on user cancel (not a resolved value).
    if ((e as { userCancelled?: boolean })?.userCancelled) return { success: false, cancelled: true };
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
