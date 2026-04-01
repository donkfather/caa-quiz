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
} from "react-native";
import { AdsConsent } from "react-native-google-mobile-ads";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import {
  AppSettings,
  ThemeMode,
  loadSettings,
  saveSettings,
} from "../src/lib/settings";
import { redeemVoucher } from "../src/lib/vouchers";
import { useTheme } from "../src/lib/ThemeContext";
import { scheduleStreakReminder, cancelStreakReminder, testNotification } from "../src/lib/notifications";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Întunecat" },
  { value: "light", label: "Luminos" },
  { value: "auto", label: "Automat" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t, themeMode, setThemeMode } = useTheme();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [voucher, setVoucher] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [voucherModalVisible, setVoucherModalVisible] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const updateTheme = async (mode: ThemeMode) => {
    setThemeMode(mode);
    const next = { ...settings, themeMode: mode };
    setSettings(next);
  };

  const toggleReminder = async (enabled: boolean) => {
    const next = { ...settings, reminderEnabled: enabled };
    setSettings(next);
    await saveSettings(next);
    if (enabled) {
      await scheduleStreakReminder(next.reminderHour, next.reminderMinute);
    } else {
      await cancelStreakReminder();
    }
  };

  const changeHour = async (delta: number) => {
    const newHour = (settings.reminderHour + delta + 24) % 24;
    const next = { ...settings, reminderHour: newHour };
    setSettings(next);
    await saveSettings(next);
    if (next.reminderEnabled) {
      await scheduleStreakReminder(newHour, next.reminderMinute);
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
          />
        </View>
        {settings.reminderEnabled && (
          <View style={styles.timePickerRow}>
            <Text style={[styles.timeLabel, { color: t.textSecondary }]}>Ora:</Text>
            <View style={styles.timePicker}>
              <Pressable
                onPress={() => changeHour(-1)}
                style={[styles.timeButton, { backgroundColor: t.bg }]}
              >
                <Text style={[styles.timeButtonText, { color: t.text }]}>−</Text>
              </Pressable>
              <Text style={[styles.timeValue, { color: t.text }]}>{formattedHour}</Text>
              <Pressable
                onPress={() => changeHour(1)}
                style={[styles.timeButton, { backgroundColor: t.bg }]}
              >
                <Text style={[styles.timeButtonText, { color: t.text }]}>+</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* Voucher */}
      <Pressable
        style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border, padding: 14, marginTop: 16 }]}
        onPress={() => !settings.adsDisabled && setVoucherModalVisible(true)}
        disabled={settings.adsDisabled}
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

      {/* Dev tools */}
      {__DEV__ && settings.adsDisabled && (
        <Pressable
          style={{ marginTop: 12, padding: 14, borderRadius: 12, backgroundColor: t.bgCard, alignItems: "center", borderWidth: 1, borderColor: t.border }}
          onPress={async () => {
            const next = { ...settings, adsDisabled: false };
            setSettings(next);
            await saveSettings(next);
            Alert.alert("Dev", "Reclamele au fost reactivate.");
          }}
        >
          <Text style={{ fontSize: 14, color: t.error, fontWeight: "600" }}>Reactivează reclame (dev)</Text>
        </Pressable>
      )}
      {__DEV__ && (
        <Pressable
          style={{ marginTop: 16, padding: 14, borderRadius: 12, backgroundColor: t.bgCard, alignItems: "center", borderWidth: 1, borderColor: t.border }}
          onPress={testNotification}
        >
          <Text style={{ fontSize: 14, color: t.warning, fontWeight: "600" }}>Test notificare (dev)</Text>
        </Pressable>
      )}

      {/* Legal & Privacy */}
      <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>Legal</Text>
      <View style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border }]}>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderBottomColor: t.border }}
          onPress={() => Linking.openURL("https://sites.google.com/view/chestionare-barca-privacy/home")}
        >
          <Text style={{ fontSize: 15, color: t.text }}>Politica de confidentialitate</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14 }}
          onPress={async () => {
            try {
              await AdsConsent.showForm();
            } catch {
              Alert.alert("Info", "Formularul de consimtamant nu este disponibil momentan.");
            }
          }}
        >
          <Text style={{ fontSize: 15, color: t.text }}>Preferinte reclame</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
      </View>

      {/* App info */}
      <Text style={[styles.footerText, { color: t.textMuted }]}>
        Chestionare Barca v1.0.0
      </Text>
    </View>

    {/* Voucher Modal */}
    <Modal
        visible={voucherModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setVoucherModalVisible(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 }}
          onPress={() => setVoucherModalVisible(false)}
        >
          <Pressable
            style={{ backgroundColor: t.bgCard, borderRadius: 16, padding: 24 }}
            onPress={() => {}}
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
              >
                <Text style={{ fontSize: 15, fontWeight: "600", color: t.textSecondary }}>Anulează</Text>
              </Pressable>
              <Pressable
                style={{ flex: 1, padding: 14, borderRadius: 10, alignItems: "center", backgroundColor: t.primary }}
                onPress={handleRedeem}
                disabled={redeeming}
              >
                <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>
                  {redeeming ? "..." : "Activează"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
    </Modal>
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
