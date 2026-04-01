import { Platform } from "react-native";
import mobileAds, {
  InterstitialAd,
  AdEventType,
  TestIds,
  AdsConsent,
  AdsConsentStatus,
} from "react-native-google-mobile-ads";
import { loadSettings } from "./settings";

const USE_TEST_ADS = false;

const BANNER_ID = USE_TEST_ADS
  ? TestIds.BANNER
  : Platform.select({
      android: "ca-app-pub-5532596750415162/7937707131",
      ios: "ca-app-pub-5532596750415162/9400834170",
      default: TestIds.BANNER,
    })!;

const INTERSTITIAL_ID = USE_TEST_ADS
  ? TestIds.INTERSTITIAL
  : Platform.select({
      android: "ca-app-pub-5532596750415162/9392261165",
      ios: "ca-app-pub-5532596750415162/7830730079",
      default: TestIds.INTERSTITIAL,
    })!;

export { BANNER_ID };

let adsInitialized = false;

export async function initAds(): Promise<void> {
  if (adsInitialized) return;
  if (process.env.DISABLE_ADS === "true") return;
  try {
    const settings = await loadSettings();
    if (settings.adsDisabled) return;

    // GDPR consent check before ad initialization
    try {
      const consentInfo = await AdsConsent.requestInfoUpdate();
      if (consentInfo.isConsentFormAvailable && consentInfo.status === AdsConsentStatus.REQUIRED) {
        await AdsConsent.showForm();
      }
    } catch (e) {
      if (__DEV__) console.warn("Consent check failed:", e);
    }

    await mobileAds().initialize();
    adsInitialized = true;
  } catch (e) {
    if (__DEV__) console.warn("AdMob init failed:", e);
  }
}

// --- Interstitial ---

let interstitial: InterstitialAd | null = null;
let isLoaded = false;

function loadInterstitial(): void {
  interstitial = InterstitialAd.createForAdRequest(INTERSTITIAL_ID, {
    requestNonPersonalizedAdsOnly: true,
  });

  interstitial.addAdEventListener(AdEventType.LOADED, () => {
    isLoaded = true;
  });

  interstitial.addAdEventListener(AdEventType.CLOSED, () => {
    isLoaded = false;
    loadInterstitial(); // Preload next one
  });

  interstitial.addAdEventListener(AdEventType.ERROR, () => {
    isLoaded = false;
  });

  interstitial.load();
}

export function preloadInterstitial(): void {
  if (!interstitial) loadInterstitial();
}

export async function showInterstitial(): Promise<void> {
  if (process.env.DISABLE_ADS === "true") return;
  const settings = await loadSettings();
  if (settings.adsDisabled) return;
  if (isLoaded && interstitial) {
    interstitial.show();
  }
}
