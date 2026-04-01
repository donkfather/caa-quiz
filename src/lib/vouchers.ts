import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { loadSettings, saveSettings } from "./settings";

const DEVICE_ID_KEY = "device_id";

async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/** Check if this device still has a valid ad-free redemption. */
export async function validateAdsFree(): Promise<boolean> {
  try {
    const settings = await loadSettings();
    if (!settings.adsDisabled) return false;

    const deviceId = await getDeviceId();
    const { data, error } = await supabase.rpc("check_ads_free", { p_device_id: deviceId });

    if (error || data !== true) {
      settings.adsDisabled = false;
      await saveSettings(settings);
      return false;
    }
    return true;
  } catch {
    // Offline — keep current state
    return true;
  }
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
      const settings = await loadSettings();
      settings.adsDisabled = true;
      await saveSettings(settings);
      return { success: true };
    }

    return { success: false, message: ERROR_MESSAGES[data] || "Eroare necunoscută." };
  } catch {
    return { success: false, message: "Eroare de conexiune. Verifică internetul." };
  }
}
