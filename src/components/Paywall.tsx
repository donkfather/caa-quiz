import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Anchor, BookOpen, GraduationCap, History, Lock } from "lucide-react-native";
import { useTheme } from "../lib/ThemeContext";
import { FONTS } from "../lib/fonts";
import { useAccess } from "../lib/AccessContext";
import { STORE_NAME, getUnlockPriceString, type PurchaseResult } from "../lib/purchases";
import { useWipeDataFlow } from "./useWipeDataFlow";
import { TRIAL_DAYS } from "../lib/accessCore";

// The lock screen shown when the free trial has ended, plus the pieces the
// trial intro and Settings share with it (purchase/restore flow, legal links,
// Romanian day counts) — kept here so the copy and the alert wording exist once.

export const PRIVACY_URL = "https://sites.google.com/view/chestionare-barca-privacy-pol/home";
export const TERMS_URL = "https://sites.google.com/view/chestionare-barca-terms-and-co/home";
export { STORE_NAME };

// Same palette as the home-screen icon tiles, so a feature looks the same here.
const ACCENT = {
  questions: "#34d399", // emerald (Practică)
  theory: "#a78bfa", // violet (Învață)
  history: "#94a3b8", // slate (Istoric)
};

/** Romanian day count: "o zi", "5 zile", "20 de zile". Numbers whose last two
 * digits are 00 or 20–99 take "de" (except 0). */
export function zile(n: number): string {
  if (n === 1) return "o zi";
  const lastTwo = n % 100;
  return n >= 20 && (lastTwo === 0 || lastTwo >= 20) ? `${n} de zile` : `${n} zile`;
}

type IconType = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

/** Lucide icon in a tinted rounded tile — the home screen's visual language. */
export function Tile({ Icon, color, size = 20, tile = 40 }: { Icon: IconType; color: string; size?: number; tile?: number }) {
  return (
    <View
      style={{
        width: tile,
        height: tile,
        borderRadius: Math.round(tile * 0.3),
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: color + "26",
      }}
    >
      <Icon size={size} color={color} strokeWidth={2} />
    </View>
  );
}

function FeatureRow({ Icon, color, title, text }: { Icon: IconType; color: string; title: string; text: string }) {
  const { theme: t } = useTheme();
  return (
    <View style={styles.featureRow}>
      <Tile Icon={Icon} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.featureTitle, { color: t.text }]}>{title}</Text>
        <Text style={[styles.featureText, { color: t.textSecondary }]}>{text}</Text>
      </View>
    </View>
  );
}

/** What the unlock covers. `withProgress` adds the reassurance that local
 * history survives the lock (true: the lock never deletes anything). */
export function UnlockFeatures({ heading, withProgress = false }: { heading: string; withProgress?: boolean }) {
  const { theme: t } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.bgCard, borderColor: t.border }]}>
      <Text style={[styles.eyebrow, { color: t.textSecondary }]} accessibilityRole="header">
        {heading}
      </Text>
      <FeatureRow
        Icon={BookOpen}
        color={ACCENT.questions}
        title="Toate întrebările"
        text="Practică pe categorii, pe materii și antrenament personalizat"
      />
      <FeatureRow
        Icon={Anchor}
        color={t.primary}
        title="Simulări de examen"
        text="Categoria C, D și examenele de diferență"
      />
      <FeatureRow
        Icon={GraduationCap}
        color={ACCENT.theory}
        title="Cursuri de teorie"
        text="Module de învățare, fiecare cu quiz la final"
      />
      {withProgress && (
        <FeatureRow
          Icon={History}
          color={ACCENT.history}
          title="Progresul tău rămâne"
          text="Istoricul, realizările și recordul de streak sunt păstrate"
        />
      )}
    </View>
  );
}

type ButtonVariant = "primary" | "secondary" | "link";

export function ActionButton({
  label,
  onPress,
  variant = "primary",
  busy = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { theme: t, isDark } = useTheme();
  const inactive = disabled || busy;
  // White on the light theme's primary is 5.2:1; on the dark theme's lighter
  // primary it would be ~2.5:1, so the dark theme uses its navy background as
  // the label colour instead (~7:1). Secondary / link labels use the light
  // theme's darker blue: plain primary is only ~4.1:1 on the tinted restore
  // card (primaryDark ~5.3:1); the dark theme's primary already passes.
  const fg = variant === "primary" ? (isDark ? t.bg : "#fff") : isDark ? t.primary : t.primaryDark;
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && { backgroundColor: t.primary },
        variant === "secondary" && { borderWidth: 1.5, borderColor: t.primary },
        variant === "link" && styles.linkButton,
        disabled && !busy && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {busy && <ActivityIndicator size="small" color={fg} />}
      <Text
        style={[
          variant === "link" ? styles.linkText : styles.buttonText,
          { color: fg },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Privacy + terms links. `withWipe` adds "Șterge toate datele" — on the lock
 * screen, where Settings (its usual home) can't be reached. */
export function LegalLinks({ withWipe = false }: { withWipe?: boolean }) {
  const { theme: t } = useTheme();
  const { wiping, confirmWipe } = useWipeDataFlow();
  const open = (url: string) => {
    Linking.openURL(url).catch(() => {});
  };
  return (
    <View style={styles.legal}>
      <Pressable
        onPress={() => open(PRIVACY_URL)}
        hitSlop={10}
        accessibilityRole="link"
        accessibilityLabel="Deschide politica de confidențialitate"
      >
        <Text style={[styles.legalText, { color: t.textSecondary }]}>Politica de confidențialitate</Text>
      </Pressable>
      <Pressable
        onPress={() => open(TERMS_URL)}
        hitSlop={10}
        accessibilityRole="link"
        accessibilityLabel="Deschide termeni și condiții"
      >
        <Text style={[styles.legalText, { color: t.textSecondary }]}>Termeni și condiții</Text>
      </Pressable>
      {withWipe && (
        <Pressable
          onPress={confirmWipe}
          disabled={wiping}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Șterge toate datele"
          accessibilityHint="Șterge istoricul, setările și raportările trimise de pe acest dispozitiv"
          accessibilityState={{ disabled: wiping, busy: wiping }}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          {wiping && <ActivityIndicator size="small" color={t.textSecondary} />}
          <Text style={[styles.legalText, { color: t.textSecondary }]}>
            {wiping ? "Se șterg datele…" : "Șterge toate datele"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export type UnlockBusy = "buy" | "restore" | null;

/** Price + buy/restore handlers with the app's alert wording. On success the
 * AccessProvider flips the access state itself, so the gate in _layout swaps
 * the lock screen for the app — callers only render. Guards against double
 * taps, stays silent when the user cancels the store sheet. */
export function useUnlockFlow() {
  const { purchase, restore } = useAccess();
  const [price, setPrice] = useState<string | null>(null);
  const [priceLoading, setPriceLoading] = useState(true);
  const [busy, setBusy] = useState<UnlockBusy>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    getUnlockPriceString()
      .then((p) => { if (mounted.current) setPrice(p); })
      .catch(() => {})
      .finally(() => { if (mounted.current) setPriceLoading(false); });
    return () => { mounted.current = false; };
  }, []);

  const buy = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("buy");
    let res: PurchaseResult;
    try {
      res = await purchase();
    } catch {
      res = { success: false };
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
    if (res.success) {
      Alert.alert("Mulțumim!", "Aplicația este deblocată. Spor la învățat!");
    } else if (res.pending) {
      // Deferred payment: not an error, and saying so would invite paying twice.
      Alert.alert("Plată în așteptare", res.message ?? "Plata este în curs de procesare.");
    } else if (!res.cancelled) {
      // No message = the store finished but the unlock isn't active yet —
      // point the user at Restore rather than telling them it failed.
      Alert.alert(
        "Eroare",
        res.message ??
          "Nu am putut confirma achiziția. Dacă plata a fost făcută, apasă „Restaurează achizițiile”.",
      );
    }
  }, [purchase]);

  const restoreFlow = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("restore");
    let r: boolean | null;
    try {
      r = await restore();
    } catch {
      r = null;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
    if (r === true) {
      Alert.alert("Achiziție restaurată", "Aplicația este deblocată.");
    } else if (r === false) {
      Alert.alert(
        "Nicio achiziție găsită",
        `Nu am găsit nicio achiziție pe contul tău de ${STORE_NAME} de pe acest dispozitiv. Dacă ai plătit cu alt cont, conectează-te cu acela și încearcă din nou.`,
      );
    } else {
      Alert.alert("Eroare", "Nu am putut verifica achizițiile. Verifică conexiunea și încearcă din nou.");
    }
  }, [restore]);

  return { price, priceLoading, busy, buy, restore: restoreFlow };
}

export default function Paywall() {
  const insets = useSafeAreaInsets();
  const { theme: t } = useTheme();
  const { price, priceLoading, busy, buy, restore } = useUnlockFlow();

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 20 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Tile Icon={Lock} color={t.warning} size={30} tile={68} />
          <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">
            Perioada de încercare s-a încheiat
          </Text>
          <Text style={[styles.lead, { color: t.textSecondary }]}>
            Ai avut acces complet timp de {zile(TRIAL_DAYS)}. Deblochează aplicația ca să continui pregătirea pentru
            examen.
          </Text>
        </View>

        <UnlockFeatures heading="Ce deblochezi" withProgress />

        <View style={styles.bottom}>
          <View style={styles.priceBlock}>
            {price != null ? (
              <Text style={[styles.price, { color: t.text }]}>{price}</Text>
            ) : priceLoading ? (
              <ActivityIndicator color={t.textMuted} accessibilityLabel="Se încarcă prețul" />
            ) : null}
            <Text style={[styles.priceNote, { color: t.textSecondary }]}>
              O singură plată · fără abonament · fără plăți automate
            </Text>
            {price == null && !priceLoading && (
              <Text style={[styles.priceNote, { color: t.textSecondary, marginTop: 4 }]}>
                Prețul nu s-a putut încărca. Îl vezi în {STORE_NAME} înainte să confirmi.
              </Text>
            )}
          </View>

          <ActionButton
            label={busy === "buy" ? "Se procesează…" : price ? `Deblochează — ${price}` : "Deblochează aplicația"}
            accessibilityLabel={price ? `Deblochează aplicația pentru ${price}` : "Deblochează aplicația"}
            accessibilityHint={`Deschide plata în ${STORE_NAME}`}
            onPress={buy}
            busy={busy === "buy"}
            disabled={busy !== null}
          />

          <View style={[styles.restoreCard, { backgroundColor: t.primary + "14", borderColor: t.primary + "55" }]}>
            <Text style={[styles.restoreTitle, { color: t.text }]}>Ai plătit deja pentru eliminarea reclamelor?</Text>
            <Text style={[styles.restoreText, { color: t.textSecondary }]}>
              Achiziția ta deblochează acum toată aplicația. Apasă „Restaurează achizițiile”, cu același cont de{" "}
              {STORE_NAME} cu care ai plătit.
            </Text>
            <ActionButton
              variant="secondary"
              label={busy === "restore" ? "Se restaurează…" : "Restaurează achizițiile"}
              accessibilityLabel="Restaurează achizițiile"
              accessibilityHint="Verifică dacă ai cumpărat deja aplicația cu acest cont"
              onPress={restore}
              busy={busy === "restore"}
              disabled={busy !== null}
            />
          </View>

          <LegalLinks withWipe />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
  },
  hero: {
    alignItems: "center",
    marginBottom: 24,
  },
  title: {
    fontFamily: FONTS.uiExtraBold,
    fontSize: 28,
    lineHeight: 34,
    textAlign: "center",
    marginTop: 18,
  },
  lead: {
    fontFamily: FONTS.uiRegular,
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
    marginTop: 10,
    maxWidth: 420,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 14,
  },
  eyebrow: {
    fontFamily: FONTS.uiSemibold,
    fontSize: 12,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  featureTitle: {
    fontFamily: FONTS.uiBold,
    fontSize: 15,
  },
  featureText: {
    fontFamily: FONTS.uiRegular,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
  },
  // Pushed to the bottom of the screen when there's room; scrolls otherwise.
  bottom: {
    marginTop: "auto",
    paddingTop: 24,
    gap: 14,
  },
  priceBlock: {
    alignItems: "center",
    minHeight: 40,
    justifyContent: "center",
  },
  price: {
    fontFamily: FONTS.uiExtraBold,
    fontSize: 30,
  },
  priceNote: {
    fontFamily: FONTS.uiMedium,
    fontSize: 13,
    textAlign: "center",
    marginTop: 2,
  },
  button: {
    minHeight: 52,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  buttonText: {
    fontFamily: FONTS.uiBold,
    fontSize: 17,
    textAlign: "center",
    flexShrink: 1,
  },
  linkButton: {
    minHeight: 44,
    paddingVertical: 10,
  },
  linkText: {
    fontFamily: FONTS.uiSemibold,
    fontSize: 15,
    textAlign: "center",
    flexShrink: 1,
  },
  restoreCard: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  restoreTitle: {
    fontFamily: FONTS.uiBold,
    fontSize: 16,
  },
  restoreText: {
    fontFamily: FONTS.uiRegular,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  legal: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    columnGap: 20,
    rowGap: 8,
    marginTop: 6,
  },
  legalText: {
    fontFamily: FONTS.uiMedium,
    fontSize: 13,
    textDecorationLine: "underline",
  },
});

// Exported so TrialIntro lays out the same way without redefining them.
export const paywallStyles = styles;
