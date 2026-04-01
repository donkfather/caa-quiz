import AsyncStorage from "@react-native-async-storage/async-storage";

const SETTINGS_KEY = "app_settings";

export type ThemeMode = "dark" | "light" | "auto";

export interface AppSettings {
  themeMode: ThemeMode;
  adsDisabled: boolean;
  reminderEnabled: boolean;
  reminderHour: number; // 0-23
  reminderMinute: number;
}

const defaults: AppSettings = {
  themeMode: "dark",
  adsDisabled: false,
  reminderEnabled: false,
  reminderHour: 20,
  reminderMinute: 0,
};

export async function loadSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return defaults;
  return { ...defaults, ...JSON.parse(raw) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
