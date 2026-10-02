import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, BackHandler, Platform } from "react-native";
import { wipeLocalData } from "../lib/dataReset";
import { cancelStreakReminder } from "../lib/notifications";
import { STORE_NAME } from "../lib/purchases";

/** "Șterge toate datele": the confirmation, the wipe and the follow-up alerts,
 * shared by Settings and the lock screen. The lock screen needs it too: once
 * the trial has ended Settings can't be reached, and the privacy policy
 * promises the in-app deletion at any time. */
export function useWipeDataFlow() {
  // The wipe first asks the server to delete this device's reports (up to ~5 s).
  const [wiping, setWiping] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async () => {
    setWiping(true);
    try {
      await cancelStreakReminder();
    } catch {
      // Best-effort — a stale reminder must not block the wipe.
    }
    try {
      await wipeLocalData();
    } catch {
      if (mounted.current) setWiping(false);
      Alert.alert("Eroare", "Datele nu au putut fi șterse. Încearcă din nou.");
      return;
    }
    if (mounted.current) setWiping(false);
    if (Platform.OS === "android") {
      BackHandler.exitApp();
      return;
    }
    Alert.alert(
      "Datele au fost șterse",
      "Te rugăm să închizi aplicația complet (glisează în sus din bara de jos) și să o redeschizi.",
    );
  }, []);

  const confirmWipe = useCallback(() => {
    Alert.alert(
      "Șterge toate datele",
      `Se șterg de pe telefon istoricul testelor, streak-ul, realizările și setările, iar de pe server raportările de erori trimise de pe acest dispozitiv. Perioada de încercare nu se resetează, iar achiziția rămâne în contul tău de ${STORE_NAME}. Acțiunea nu poate fi anulată.`,
      [
        { text: "Anulează", style: "cancel" },
        { text: "Șterge", style: "destructive", onPress: () => void run() },
      ],
    );
  }, [run]);

  return { wiping, confirmWipe };
}
