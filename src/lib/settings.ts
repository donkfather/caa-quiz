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

// saveSettings overwrites the whole blob, so concurrent read-modify-write from
// different callers (reconcile, purchase, restore, voucher, reminder, theme)
// can clobber each other's fields. Serialize every mutation through one queue
// that does a FRESH load → mutate → save, so writes can't interleave.
let writeQueue: Promise<unknown> = Promise.resolve();

export function updateSettings(mutate: (s: AppSettings) => void): Promise<AppSettings> {
  const next = writeQueue.then(async () => {
    const s = await loadSettings();
    mutate(s);
    await saveSettings(s);
    return s;
  });
  // Keep the queue alive even if one mutation rejects.
  writeQueue = next.catch(() => {});
  return next;
}
