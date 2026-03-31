import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext } from "react";
import type { Theme } from "./colors";
import { darkTheme, lightTheme } from "./colors";

const SETTINGS_KEY = "app_settings";

export type ThemeMode = "dark" | "light" | "auto";

export interface AppSettings {
  themeMode: ThemeMode;
  adsDisabled: boolean;
}

const defaults: AppSettings = {
  themeMode: "dark",
  adsDisabled: false,
};

export async function loadSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return defaults;
  return { ...defaults, ...JSON.parse(raw) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Voucher codes — SHA-256 hashes of valid codes
// Generate with: echo -n "YOUR_CODE" | shasum -a 256
const VALID_HASHES = new Set([
  "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3", // "123" for testing
]);

export async function redeemVoucher(code: string): Promise<boolean> {
  // Simple hash using SubtleCrypto
  const encoder = new TextEncoder();
  const data = encoder.encode(code.trim().toLowerCase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  if (VALID_HASHES.has(hash)) {
    const settings = await loadSettings();
    settings.adsDisabled = true;
    await saveSettings(settings);
    return true;
  }
  return false;
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): Theme {
  if (mode === "auto") return systemDark ? darkTheme : lightTheme;
  return mode === "dark" ? darkTheme : lightTheme;
}
