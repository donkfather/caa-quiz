import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import * as SecureStore from "expo-secure-store";

// Stable per-device key for the free-trial record. The server only ever
// stores its sha256 (get_trial / start_trial hash it), never the raw value.
//
// Why each source:
// - Android: ANDROID_ID survives uninstall/reinstall (it is scoped to the app
//   signing key + device user), so reinstalling can't restart the trial.
// - iOS: there is no reinstall-proof ID an app may read, but Keychain items
//   survive app deletion — so a random key lives there.
// - Both: mirrored in AsyncStorage as a last resort if the primary store fails.
//   wipeLocalData() keeps that mirror, like the Keychain / ANDROID_ID.

export type DevicePlatform = "ios" | "android" | "web";

// SecureStore keys may only contain [A-Za-z0-9._-].
const SECURE_KEY = "trial_device_key_v1";
/** AsyncStorage key of the device-key mirror. Survives "Șterge toate datele"
 * (dataReset.ts KEPT_ON_WIPE), like the SecureStore copy and ANDROID_ID. */
export const DEVICE_KEY_MIRROR_KEY = "trial_device_key_v1";
const MIRROR_KEY = DEVICE_KEY_MIRROR_KEY;
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

function currentPlatform(): DevicePlatform {
  const os = Platform.OS;
  return os === "ios" || os === "android" ? os : "web";
}

function isKey(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= 8;
}

/** 32 hex chars (128 bits). Uses crypto.getRandomValues when the runtime has
 * it; Hermes may not, so Math.random backs it up — uniqueness is all a trial
 * key needs, not unpredictability. */
function randomHex32(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  let filled = false;
  if (c?.getRandomValues) {
    try {
      c.getRandomValues(bytes);
      filled = true;
    } catch {
      // fall through to Math.random
    }
  }
  if (!filled) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    // Mix in the clock so two devices with identically seeded PRNGs still differ.
    let t = Date.now();
    for (let i = 0; i < 6; i++) {
      bytes[i] ^= t & 0xff;
      t = Math.floor(t / 256);
    }
  }
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function readMirror(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(MIRROR_KEY);
    return isKey(v) ? v : null;
  } catch {
    return null;
  }
}

async function writeMirror(key: string): Promise<void> {
  try {
    await AsyncStorage.setItem(MIRROR_KEY, key);
  } catch {
    // Best-effort.
  }
}

/** The random key kept in SecureStore (Keychain on iOS). Order: SecureStore →
 * AsyncStorage mirror → fresh. If SecureStore *threw* (as opposed to holding
 * nothing) we never write to it, so a transient Keychain failure can't
 * overwrite the real key with a new one. */
async function loadOrCreateStoredKey(useSecureStore: boolean): Promise<string> {
  let secureUsable = useSecureStore;
  if (secureUsable) {
    try {
      const v = await SecureStore.getItemAsync(SECURE_KEY, SECURE_OPTS);
      if (isKey(v)) {
        await writeMirror(v);
        return v;
      }
    } catch (e) {
      if (__DEV__) console.warn("deviceKey: SecureStore read failed:", e);
      secureUsable = false;
    }
  }

  const key = (await readMirror()) ?? randomHex32();
  if (secureUsable) {
    try {
      await SecureStore.setItemAsync(SECURE_KEY, key, SECURE_OPTS);
    } catch (e) {
      if (__DEV__) console.warn("deviceKey: SecureStore write failed:", e);
    }
  }
  await writeMirror(key);
  return key;
}

async function computeDeviceKey(): Promise<{ key: string; platform: DevicePlatform }> {
  const platform = currentPlatform();
  try {
    if (platform === "android") {
      let androidId: string | null = null;
      try {
        androidId = Application.getAndroidId();
      } catch (e) {
        if (__DEV__) console.warn("deviceKey: getAndroidId failed:", e);
      }
      if (isKey(androidId)) {
        await writeMirror(androidId);
        return { key: androidId, platform };
      }
      return { key: await loadOrCreateStoredKey(true), platform };
    }
    // SecureStore has no web implementation; the mirror (localStorage) is it.
    return { key: await loadOrCreateStoredKey(platform === "ios"), platform };
  } catch {
    // Unreachable in practice (every step above is guarded) — but never throw.
    return { key: (await readMirror()) ?? randomHex32(), platform };
  }
}

// Question-report id (moved here unchanged from the retired vouchers.ts).
// Deliberately NOT the trial key: question_reports stores this id as-is, so
// it must stay a throwaway random value — never the Android ID or Keychain
// key, which the trial table only ever holds hashed. Same storage key and
// format as before, so existing devices keep their id (the report rate limit
// is keyed on it); wipeLocalData() asks the server to delete its reports
// (forget_device), then resets it.
const REPORT_ID_KEY = "device_id";

/** The report id if this install ever created one, else null. Never creates
 * one (the data wipe uses it to ask the server to delete the reports). */
export async function readReportDeviceId(): Promise<string | null> {
  const id = await AsyncStorage.getItem(REPORT_ID_KEY);
  return id ? id : null;
}

export async function getReportDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(REPORT_ID_KEY);
  if (!id) {
    id = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(REPORT_ID_KEY, id);
  }
  return id;
}

let keyPromise: Promise<{ key: string; platform: DevicePlatform }> | null = null;

/** Stable device key + platform for the trial RPCs. Memoized per process so
 * concurrent first calls can't each mint a different random key. Never throws. */
export function getDeviceKey(): Promise<{ key: string; platform: DevicePlatform }> {
  if (!keyPromise) keyPromise = computeDeviceKey();
  return keyPromise;
}
