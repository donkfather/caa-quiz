import {
  View,
  Text,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useEffect } from "react";
import { useRouter } from "expo-router";
import {
  AppSettings,
  ThemeMode,
  loadSettings,
  saveSettings,
  redeemVoucher,
} from "../src/lib/settings";
import { useTheme } from "../src/lib/ThemeContext";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Întunecat" },
  { value: "light", label: "Luminos" },
  { value: "auto", label: "Automat" },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t, themeMode, setThemeMode } = useTheme();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [voucher, setVoucher] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const updateTheme = async (mode: ThemeMode) => {
    setThemeMode(mode);
    const next = { ...settings, themeMode: mode };
    setSettings(next);
  };

  const handleRedeem = async () => {
    if (!voucher.trim()) return;
    setRedeeming(true);
    const success = await redeemVoucher(voucher);
    setRedeeming(false);
    if (success) {
      setSettings({ ...settings, adsDisabled: true });
      setVoucher("");
      Alert.alert("Succes", "Reclamele au fost dezactivate.");
    } else {
      Alert.alert("Cod invalid", "Codul introdus nu este valid.");
    }
  };

  return (
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

      {/* Voucher */}
      <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>Dezactivare reclame</Text>
      <View style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border }]}>
        {settings.adsDisabled ? (
          <View style={styles.voucherRow}>
            <Text style={[styles.voucherStatus, { color: t.success }]}>
              Reclamele sunt dezactivate
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.voucherRow}>
              <TextInput
                style={[
                  styles.voucherInput,
                  { color: t.text, backgroundColor: t.bg, borderColor: t.border },
                ]}
                placeholder="Introdu codul"
                placeholderTextColor={t.textMuted}
                value={voucher}
                onChangeText={setVoucher}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                style={[styles.redeemButton, { backgroundColor: t.primary }]}
                onPress={handleRedeem}
                disabled={redeeming}
              >
                <Text style={styles.redeemText}>
                  {redeeming ? "..." : "Activează"}
                </Text>
              </Pressable>
            </View>
            <Text style={[styles.voucherHint, { color: t.textMuted }]}>
              Introdu un cod promoțional pentru a dezactiva reclamele
            </Text>
          </>
        )}
      </View>

      {/* App info */}
      <Text style={[styles.footerText, { color: t.textMuted }]}>
        Quiz Navigație CAA v1.0.0
      </Text>
    </View>
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
