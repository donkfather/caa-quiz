import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  Switch,
  Linking,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useEffect } from "react";
import {
  AppSettings,
  ThemeMode,
  loadSettings,
  updateSettings,
} from "../src/lib/settings";
import Constants from "expo-constants";
import { useTheme } from "../src/lib/ThemeContext";
import { useAccess } from "../src/lib/AccessContext";
import { devExpireTrial } from "../src/lib/access";
import { DEV_TOOLS_ENABLED, IS_PREVIEW_BUILD } from "../src/lib/buildFlags";
import { useWipeDataFlow } from "../src/components/useWipeDataFlow";
import { useUnlockFlow, zile, PRIVACY_URL, TERMS_URL } from "../src/components/Paywall";
import { scheduleStreakReminder, cancelStreakReminder, testNotification } from "../src/lib/notifications";
import { getQuestionsVersion, onQuestionsUpdated, refreshFromRemote, forceRefreshDebug } from "../src/lib/questionsRemote";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "dark", label: "Întunecat" },
  { value: "light", label: "Luminos" },
  { value: "auto", label: "Automat" },
];

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { theme: t, themeMode, setThemeMode } = useTheme();
  const { state: access, refresh } = useAccess();
  const { price, busy, buy, restore } = useUnlockFlow();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [questionsVersion, setQuestionsVersion] = useState(getQuestionsVersion());
  const [versionTaps, setVersionTaps] = useState(0);
  const [forceLoading, setForceLoading] = useState(false);
  const { wiping, confirmWipe } = useWipeDataFlow();

  useEffect(() => {
    loadSettings().then(setSettings);
    // Re-check the purchase / trial with the store and server before showing
    // the access status, so it isn't stale (e.g. a refund or a restore made on
    // another device).
    refresh().catch(() => {});
    setQuestionsVersion(getQuestionsVersion());
    refreshFromRemote().then((r) => {
      if (r.version != null) setQuestionsVersion(r.version);
    });
    const unsub = onQuestionsUpdated((v) => setQuestionsVersion(v));
    return unsub;
  }, []);

  const appVersion = Constants.expoConfig?.version;

  if (!settings) return null;

  const unlocked = access?.kind === "unlocked";
  const trialDays = access?.kind === "trial" ? access.daysLeft : null;

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

  const formattedHour = `${settings.reminderHour.toString().padStart(2, "0")}:${settings.reminderMinute.toString().padStart(2, "0")}`;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]}
    >
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
            <Text style={[styles.hint, { color: t.textMuted }]}>
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

      {/* Access — the one-time RevenueCat unlock (same store product that used
          to remove ads). "Restore purchases" is always reachable (Apple 3.1.1 /
          Play); the purchase flow + alerts live in useUnlockFlow. */}
      <Text style={[styles.sectionTitle, { color: t.textSecondary }]}>Acces</Text>
      <View style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border }]}>
        {unlocked ? (
          <View style={[styles.row, { borderBottomWidth: 1, borderBottomColor: t.border }]}>
            <Text style={{ fontSize: 15, color: t.success, fontWeight: "600" }}>
              Aplicația este deblocată
            </Text>
          </View>
        ) : (
          <>
            {trialDays !== null && (
              <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: t.border }}>
                <Text style={{ fontSize: 15, color: t.text, fontWeight: "600" }}>
                  {trialDays <= 1
                    ? "Perioadă gratuită — ultima zi"
                    : `Perioadă gratuită — mai ai ${zile(trialDays)}`}
                </Text>
                <Text style={[styles.hint, { color: t.textMuted }]}>
                  Apoi aplicația se blochează până o deblochezi. Deblocarea include și întrebările suplimentare. O singură plată, fără abonament.
                </Text>
              </View>
            )}
            <Pressable
              style={[styles.row, { borderBottomWidth: 1, borderBottomColor: t.border }]}
              onPress={buy}
              disabled={busy !== null}
              accessibilityLabel={price ? `Deblochează aplicația pentru ${price}` : "Deblochează aplicația"}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy !== null, busy: busy === "buy" }}
            >
              <Text style={{ fontSize: 15, color: t.text, flexShrink: 1 }}>
                {busy === "buy" ? "Se procesează…" : "Deblochează aplicația"}
              </Text>
              {busy === "buy" ? (
                <ActivityIndicator size="small" color={t.primary} />
              ) : price != null ? (
                <Text style={{ fontSize: 15, color: t.primary, fontWeight: "600" }}>{price}</Text>
              ) : (
                <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
              )}
            </Pressable>
          </>
        )}
        <Pressable
          style={styles.row}
          onPress={restore}
          disabled={busy !== null}
          accessibilityLabel="Restaurează achizițiile"
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null, busy: busy === "restore" }}
        >
          <Text style={{ fontSize: 15, color: t.text, flexShrink: 1 }}>
            {busy === "restore" ? "Se restaurează…" : "Restaurează achizițiile"}
          </Text>
          {busy === "restore" ? (
            <ActivityIndicator size="small" color={t.primary} />
          ) : (
            <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
          )}
        </Pressable>
      </View>

      {/* Dev tools — compiled in, but unreachable in store builds (see
          src/lib/buildFlags.ts: build-time flag + Android package check). */}
      {DEV_TOOLS_ENABLED && access?.kind === "trial" && (
        <Pressable
          style={{ marginTop: 12, padding: 14, borderRadius: 12, backgroundColor: t.bgCard, alignItems: "center", borderWidth: 1, borderColor: t.border }}
          onPress={async () => {
            await devExpireTrial();
            await refresh();
          }}
          accessibilityLabel="Expiră perioada de probă"
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 14, color: t.error, fontWeight: "600" }}>
            Expiră perioada de probă ({IS_PREVIEW_BUILD && !__DEV__ ? "preview" : "dev"})
          </Text>
        </Pressable>
      )}
      {DEV_TOOLS_ENABLED && (
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
          style={[styles.row, { borderBottomWidth: 1, borderBottomColor: t.border }]}
          onPress={() => Linking.openURL(PRIVACY_URL)}
          accessibilityLabel="Deschide politica de confidențialitate"
          accessibilityRole="link"
        >
          <Text style={{ fontSize: 15, color: t.text }}>Politica de confidențialitate</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
        <Pressable
          style={[styles.row, { borderBottomWidth: 1, borderBottomColor: t.border }]}
          onPress={() => Linking.openURL(TERMS_URL)}
          accessibilityLabel="Deschide termeni și condiții"
          accessibilityRole="link"
        >
          <Text style={{ fontSize: 15, color: t.text }}>Termeni și condiții</Text>
          <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
        </Pressable>
        <Pressable
          style={styles.row}
          onPress={confirmWipe}
          disabled={wiping}
          accessibilityLabel="Șterge toate datele"
          accessibilityRole="button"
          accessibilityState={{ disabled: wiping, busy: wiping }}
        >
          <Text style={{ fontSize: 15, color: t.error }}>{wiping ? "Se șterg datele…" : "Șterge toate datele"}</Text>
          {wiping ? (
            <ActivityIndicator size="small" color={t.error} />
          ) : (
            <Text style={{ fontSize: 20, color: t.textMuted }}>›</Text>
          )}
        </Pressable>
      </View>

      {/* App info */}
      <Text style={[styles.footerText, { color: t.textMuted }]}>
        Chestionare Barca{appVersion ? ` v${appVersion}` : ""}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
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
  // A tappable list row inside a card: label left, value / chevron right.
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: 14,
  },
  hint: {
    fontSize: 12,
    marginTop: 2,
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
  footerText: {
    fontSize: 12,
    textAlign: "center",
    marginTop: 32,
  },
});
