import {
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
  Switch,
  Modal,
  Linking,
  BackHandler,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import {
  AppSettings,
  ThemeMode,
  loadSettings,
  updateSettings,
} from "../src/lib/settings";
import Constants from "expo-constants";
import { forgetDevice, redeemVoucher, validateAdsFree, grantAdsFree } from "../src/lib/vouchers";
import { getNoAdsPriceString, purchaseNoAds, restorePurchases } from "../src/lib/purchases";
import { showConsentForm } from "../src/lib/ads";
import { useTheme } from "../src/lib/ThemeContext";
import { scheduleStreakReminder, cancelStreakReminder, testNotification } from "../src/lib/notifications";
import { getQuestionsVersion, onQuestionsUpdated, refreshFromRemote, forceRefreshDebug } from "../src/lib/questionsRemote";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Întunecat" },
  { value: "light", label: "Luminos" },
  { value: "auto", label: "Automat" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);

// Ad removal is now the RevenueCat "remove ads" IAP on BOTH platforms. The old
// promo-code path (Android-only) is retired; flip to true to bring it back.
const PROMO_CODES_ENABLED = false;

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t, themeMode, setThemeMode } = useTheme();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [voucher, setVoucher] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [voucherModalVisible, setVoucherModalVisible] = useState(false);
  const [questionsVersion, setQuestionsVersion] = useState(getQuestionsVersion());
  const [versionTaps, setVersionTaps] = useState(0);
  const [forceLoading, setForceLoading] = useState(false);
  const [iapPrice, setIapPrice] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    // Re-validate the ad-free state with the server before showing it, so we
    // don't display "disabled" when it was already revoked / restored from a
    // device backup.
    validateAdsFree().finally(() => loadSettings().then(setSettings));
    getNoAdsPriceString().then(setIapPrice).catch(() => {});
    setQuestionsVersion(getQuestionsVersion());
    refreshFromRemote().then((r) => {
      if (r.version != null) setQuestionsVersion(r.version);
    });
    const unsub = onQuestionsUpdated((v) => setQuestionsVersion(v));
    return unsub;
  }, []);

  const isPreviewBuild = Constants.expoConfig?.extra?.isPreview === true;

  if (!settings) return null;

  const updateTheme = async (mode: ThemeMode) => {
    setThemeMode(mode);
    const next = { ...settings, themeMode: mode };
    setSettings(next);
  };

  const toggleReminder = async (enabled: boolean) => {
    const next = await updateSettings((s) => { s.reminderEnabled = enabled; });
    setSettings(next);
    if (enabled) {
      await scheduleStreakReminder(next.reminderHour, next.reminderMinute);
    } else {
      await cancelStreakReminder();
    }
  };

  const changeHour = async (delta: number) => {
    const newHour = (settings.reminderHour + delta + 24) % 24;
    const next = await updateSettings((s) => { s.reminderHour = newHour; });
    setSettings(next);
    if (next.reminderEnabled) {
      await scheduleStreakReminder(newHour, next.reminderMinute);
    }
  };

  const handleBuyNoAds = async () => {
    setPurchasing(true);
    const res = await purchaseNoAds();
    setPurchasing(false);
    if (res.success) {
      setSettings(await grantAdsFree());
      Alert.alert("Mulțumim!", "Reclamele au fost eliminate.");
    } else if (!res.cancelled) {
      Alert.alert("Eroare", res.message ?? "Achiziția nu a putut fi finalizată.");
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    const r = await restorePurchases();
    setRestoring(false);
    if (r === true) {
      setSettings(await grantAdsFree());
      Alert.alert("Restaurat", "Achizițiile au fost restaurate.");
    } else if (r === false) {
      Alert.alert("Nicio achiziție", "Nu am găsit achiziții de restaurat pe acest cont.");
    } else {
      Alert.alert("Eroare", "Nu am putut verifica achizițiile. Verifică conexiunea și încearcă din nou.");
    }
  };

  const handleRedeem = async () => {
    if (!voucher.trim()) return;
    setRedeeming(true);
    const result = await redeemVoucher(voucher);
    setRedeeming(false);
    if (result.success) {
      setSettings({ ...settings, adsDisabled: true });
      setVoucher("");
      setVoucherModalVisible(false);
      Alert.alert("Succes", "Reclamele au fost dezactivate.");
    } else {
      Alert.alert("Eroare", result.message);
    }
  };

  const formattedHour = `${settings.reminderHour.toString().padStart(2, "0")}:${settings.reminderMinute.toString().padStart(2, "0")}`;

  return (
    <>
    <View style={[styles.container, { backgroundColor: t.bg, paddingBottom: insets.bottom }]}>
      {/* Theme */}
      <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>Temă</Text>
      <View style={[styles.segmented, { backgroundColor: t.bgCard, borderColor: t.border }]}>
        {THEME_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            style={[
              styles.segmentedItem,
              themeMode === opt.value && { backgroundColor: t.primary },
            ]}
            onPress={() => updateTheme(opt.value)}
            accessibilityLabel={`Temă ${opt.label.toLowerCase()}`}
            accessibilityRole="button"
            accessibilityState={{ selected: themeMode === opt.value }}
          >
            <Text style={[
              styles.segmentedLabel,
              { color: themeMode === opt.value ? "#fff" : t.textSecondary },
            ]}>
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Reminder */}
      <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>Reminder zilnic</Text>
      <View style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border }]}>
        <View style={styles.reminderRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.reminderLabel, { color: t.text }]}>Notificare streak</Text>
            <Text style={[styles.reminderHint, { color: t.textMuted }]}>
              Primește un reminder să nu pierzi streak-ul
            </Text>
          </View>
          <Switch
            value={settings.reminderEnabled}
            onValueChange={toggleReminder}
            trackColor={{ false: t.border, true: t.primary + "60" }}
            thumbColor={settings.reminderEnabled ? t.primary : t.textMuted}
            accessibilityLabel="Activează reminder"
          />
        </View>
        {settings.reminderEnabled && (
          <View style={styles.timePickerRow}>
            <Text style={[styles.timeLabel, { color: t.textSecondary }]}>Ora:</Text>
            <View style={styles.timePicker}>
              <Pressable
                onPress={() => changeHour(-1)}
                style={[styles.timeButton, { backgroundColor: t.bg }]}
                accessibilityLabel="Micșorează ora"
                accessibilityRole="button"
              >
                <Text style={[styles.timeButtonText, { color: t.text }]}>−</Text>
              </Pressable>
              <Text style={[styles.timeValue, { color: t.text }]}>{formattedHour}</Text>
              <Pressable
                onPress={() => changeHour(1)}
                style={[styles.timeButton, { backgroundColor: t.bg }]}
                accessibilityLabel="Mărește ora"
                accessibilityRole="button"
              >
                <Text style={[styles.timeButtonText, { color: t.text }]}>+</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* Remove ads (IAP) — the remove-ads path on BOTH iOS and Android.
          Always shown so the required "Restore purchases" control is reachable
          (Apple 3.1.1 / Play). The buy row appears once the price loads. */}
      {(Platform.OS === "ios" || Platform.OS === "android" || iapPrice != null || settings.adsDisabled) && (
        <>
          <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>Reclame</Text>
          <View style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border }]}>
            {settings.adsDisabled ? (
              <View style={{ padding: 14 }}>
                <Text style={{ fontSize: 15, color: t.success, fontWeight: "600" }}>
                  Reclamele sunt dezactivate
                </Text>
              </View>
            ) : iapPrice != null ? (
              <Pressable
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderBottomColor: t.border }}
                onPress={handleBuyNoAds}
                disabled={purchasing || restoring}
                accessibilityLabel="Elimină reclamele"
                accessibilityRole="button"
              >
                <Text style={{ fontSize: 15, color: t.text }}>
                  {purchasing ? "Se procesează…" : "Elimină reclamele"}
                </Text>
                <Text style={{ fontSize: 15, color: t.primary, fontWeight: "600" }}>{iapPrice}</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14 }}
              onPress={handleRestore}
              disabled={purchasing || restoring}
              accessibilityLabel="Restaurează achizițiile"
              accessibilityRole="button"
            >
              <Text style={{ fontSize: 15, color: t.text }}>
                {restoring ? "Se restaurează…" : "Restaurează achizițiile"}
              </Text>
              <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
            </Pressable>
          </View>
        </>
      )}

      {/* Voucher */}
      {PROMO_CODES_ENABLED && (
        <Pressable
          style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border, padding: 14, marginTop: 16 }]}
          onPress={() => !settings.adsDisabled && setVoucherModalVisible(true)}
          disabled={settings.adsDisabled}
          accessibilityLabel={settings.adsDisabled ? "Reclamele sunt dezactivate" : "Introdu cod promoțional"}
          accessibilityRole="button"
        >
          {settings.adsDisabled ? (
            <Text style={{ fontSize: 15, color: t.success, fontWeight: "600" }}>
              Reclamele sunt dezactivate
            </Text>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 15, color: t.text }}>Ai un cod promoțional?</Text>
              <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
            </View>
          )}
        </Pressable>
      )}

      {/* Dev tools */}
      {(__DEV__ || isPreviewBuild) && settings.adsDisabled && (
        <Pressable
          style={{ marginTop: 12, padding: 14, borderRadius: 12, backgroundColor: t.bgCard, alignItems: "center", borderWidth: 1, borderColor: t.border }}
          onPress={async () => {
            setSettings(await updateSettings((s) => { s.adsDisabled = false; }));
            Alert.alert("Reset", "Reclamele au fost reactivate.");
          }}
        >
          <Text style={{ fontSize: 14, color: t.error, fontWeight: "600" }}>
            Reactivează reclame ({isPreviewBuild && !__DEV__ ? "preview" : "dev"})
          </Text>
        </Pressable>
      )}
      {(__DEV__ || isPreviewBuild) && (
        <Pressable
          style={{ marginTop: 16, padding: 14, borderRadius: 12, backgroundColor: t.bgCard, alignItems: "center", borderWidth: 1, borderColor: t.border }}
          onPress={testNotification}
          accessibilityLabel="Test notificare"
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 14, color: t.warning, fontWeight: "600" }}>Test notificare (dev)</Text>
        </Pressable>
      )}

      {/* Legal & Privacy */}
      <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>Legal</Text>
      <View style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border }]}>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderBottomColor: t.border }}
          onPress={() => Linking.openURL("https://sites.google.com/view/chestionare-barca-privacy-pol/home")}
          accessibilityLabel="Deschide politica de confidențialitate"
          accessibilityRole="link"
        >
          <Text style={{ fontSize: 15, color: t.text }}>Politica de confidentialitate</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderBottomColor: t.border }}
          onPress={() => Linking.openURL("https://sites.google.com/view/chestionare-barca-terms-and-co/home")}
          accessibilityLabel="Deschide termeni și condiții"
          accessibilityRole="link"
        >
          <Text style={{ fontSize: 15, color: t.text }}>Termeni și condiții</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderBottomColor: t.border }}
          onPress={async () => {
            const r = await showConsentForm();
            if (!r.ok) {
              Alert.alert(
                "Preferințe reclame",
                "Nu există preferințe de gestionat pentru regiunea ta.",
              );
            }
          }}
          accessibilityLabel="Gestionează preferințele de reclame"
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 15, color: t.text }}>Preferințe reclame</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14 }}
          onPress={() =>
            Alert.alert(
              "Șterge toate datele",
              PROMO_CODES_ENABLED
                ? "Vei pierde streak-ul, realizările, codurile promoționale activate și setările. Acțiunea nu poate fi anulată."
                : "Vei pierde streak-ul, realizările și setările. Acțiunea nu poate fi anulată.",
              [
                { text: "Anulează", style: "cancel" },
                {
                  text: "Șterge",
                  style: "destructive",
                  onPress: async () => {
                    await cancelStreakReminder();
                    await forgetDevice();
                    if (Platform.OS === "android") {
                      BackHandler.exitApp();
                      return;
                    }
                    Alert.alert(
                      "Datele au fost șterse",
                      "Te rugăm să închizi aplicația complet (glisează în sus din bara de jos) și să o redeschizi.",
                    );
                  },
                },
              ],
            )
          }
          accessibilityLabel="Șterge toate datele"
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 15, color: t.error }}>Șterge toate datele</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
      </View>

      {/* App info */}
      <Text style={[styles.footerText, { color: t.textMuted }]}>
        Chestionare Barca v1.0.0
      </Text>
      <Pressable
        onPress={async () => {
          const next = versionTaps + 1;
          if (next < 5) {
            setVersionTaps(next);
            setTimeout(() => setVersionTaps((cur) => (cur === next ? 0 : cur)), 1500);
            return;
          }
          setVersionTaps(0);
          setForceLoading(true);
          const r = await forceRefreshDebug();
          setForceLoading(false);
          if (r.ok) {
            setQuestionsVersion(r.version);
            Alert.alert("Sincronizat", `Versiunea ${r.version} • ${r.count} întrebări descărcate.`);
          } else {
            Alert.alert("Eroare sincronizare", `Pas: ${r.step}\nMotiv: ${r.reason}`);
          }
        }}
        accessibilityLabel="Versiune întrebări"
        accessibilityHint="Apasă de 5 ori pentru a forța sincronizarea"
      >
        <Text style={[styles.footerText, { color: t.textMuted, marginTop: 4 }]}>
          {forceLoading
            ? "Se sincronizează…"
            : questionsVersion > 0
              ? `Întrebări v${questionsVersion}`
              : "Întrebări (versiune locală)"}
          {versionTaps > 0 && versionTaps < 5 ? `  (${5 - versionTaps})` : ""}
        </Text>
      </Pressable>
    </View>

    {/* Voucher Modal */}
    {PROMO_CODES_ENABLED && (
    <Modal
        visible={voucherModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setVoucherModalVisible(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 }}
          onPress={() => setVoucherModalVisible(false)}
          accessibilityLabel="Închide formularul"
          accessibilityRole="button"
        >
          <Pressable
            style={{ backgroundColor: t.bgCard, borderRadius: 16, padding: 24 }}
            onPress={() => {}}
            accessibilityRole="none"
          >
            <Text style={{ fontSize: 18, fontWeight: "700", color: t.text, marginBottom: 4 }}>
              Cod promoțional
            </Text>
            <Text style={{ fontSize: 13, color: t.textMuted, marginBottom: 16 }}>
              Introdu codul pentru a dezactiva reclamele
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 16,
                color: t.text,
                backgroundColor: t.bg,
                marginBottom: 14,
              }}
              placeholder="Introdu codul"
              placeholderTextColor={t.textMuted}
              value={voucher}
              onChangeText={setVoucher}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                style={{ flex: 1, padding: 14, borderRadius: 10, alignItems: "center", borderWidth: 1, borderColor: t.border }}
                onPress={() => { setVoucherModalVisible(false); setVoucher(""); }}
                accessibilityLabel="Anulează"
                accessibilityRole="button"
              >
                <Text style={{ fontSize: 15, fontWeight: "600", color: t.textSecondary }}>Anulează</Text>
              </Pressable>
              <Pressable
                style={{ flex: 1, padding: 14, borderRadius: 10, alignItems: "center", backgroundColor: t.primary }}
                onPress={handleRedeem}
                disabled={redeeming}
                accessibilityLabel="Activează codul promoțional"
                accessibilityRole="button"
              >
                <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>
                  {redeeming ? "..." : "Activează"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
    </Modal>
    )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 8,
    marginTop: 16,
    marginLeft: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  segmented: {
    flexDirection: "row",
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
    padding: 3,
  },
  segmentedItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 10,
  },
  segmentedLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  // Reminder
  reminderRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
  },
  reminderLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
  reminderHint: {
    fontSize: 12,
    marginTop: 2,
  },
  timePickerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 12,
  },
  timeLabel: {
    fontSize: 14,
  },
  timePicker: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  timeButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  timeButtonText: {
    fontSize: 20,
    fontWeight: "600",
  },
  timeValue: {
    fontSize: 20,
    fontWeight: "700",
    minWidth: 60,
    textAlign: "center",
  },
  // Voucher
  voucherRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 10,
  },
  voucherInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  redeemButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  redeemText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  },
  voucherHint: {
    fontSize: 12,
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  voucherStatus: {
    fontSize: 15,
    fontWeight: "600",
  },
  footerText: {
    fontSize: 12,
    textAlign: "center",
    marginTop: 32,
  },
});
