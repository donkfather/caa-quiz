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
  useWindowDimensions,
} from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Anchor, ArrowRight, BookOpen, CircleCheck, GraduationCap, History, Lock, Plus, ShieldCheck, X, Zap } from "lucide-react-native";
import { allQuestions, extraQuestionCount } from "../lib/questions";
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

/** The regular price after the launch period, in RON. The paywall shows the
 * live store price as a launch price against it ("apoi 29,99 RON"). This is a
 * promise about the FUTURE price, not a claim about a past one — so the store
 * price MUST actually be raised to this amount when the launch period ends,
 * or this line has to go. Set to null to hide the launch-price display. */
export const LAUNCH_REGULAR_PRICE_RON: number | null = 29.99;

/** "17,99 RON" → 17.99. null if the store string isn't a RON amount. */
function parseRon(priceString: string): number | null {
  if (!/RON|lei/i.test(priceString)) return null;
  const m = priceString.replace(/\s/g, "").match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatRon(n: number): string {
  return `${n.toFixed(2).replace(".", ",")}${NBSP}RON`;
}

// Same palette as the home-screen icon tiles, so a feature looks the same here.
const ACCENT = {
  questions: "#34d399", // emerald (Practică)
  theory: "#a78bfa", // violet (Învață)
  history: "#94a3b8", // slate (Istoric)
};

/** Non-breaking space: keeps a number on the same line as its noun ("5 zile"
 * must never wrap as "5" / "zile"). */
export const NBSP = "\u00A0";

/** Romanian day count: "o zi", "5 zile", "20 de zile". Numbers whose last two
 * digits are 00 or 20–99 take "de" (except 0). Never wraps inside. */
export function zile(n: number): string {
  if (n === 1) return `o${NBSP}zi`;
  const lastTwo = n % 100;
  return n >= 20 && (lastTwo === 0 || lastTwo >= 20) ? `${n}${NBSP}de${NBSP}zile` : `${n}${NBSP}zile`;
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

/** "303 întrebări" / "320 de întrebări": Romanian takes "de" when the last two
 * digits are 00 or 20–99 (and the number is at least 20). */
export function intrebari(n: number): string {
  const lastTwo = n % 100;
  return n >= 20 && (lastTwo === 0 || lastTwo >= 20) ? `${n}${NBSP}de${NBSP}întrebări` : `${n}${NBSP}întrebări`;
}

/** The one thing buying adds over the trial: the extra questions. It gets its
 * own highlighted card on every screen that sells the unlock, because as a
 * line inside the feature list nobody noticed it. */
export function ExtrasHighlight({ when }: { when: "trial" | "unlock" }) {
  const { theme: t } = useTheme();
  const n = extraQuestionCount();
  return (
    <View
      style={[styles.card, { backgroundColor: t.primary + "1f", borderColor: t.primary, borderWidth: 2, flexDirection: "row", alignItems: "center", gap: 14 }]}
      accessible
      accessibilityLabel={`Deblochează aplicația și primești acces și la încă ${n > 0 ? intrebari(n) : "multe întrebări"} extra`}
    >
      <Tile Icon={Plus} color={t.primary} size={26} tile={52} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.extrasBig, { color: t.text }]}>
          {n > 0 ? `+${intrebari(n)} extra` : "Întrebări extra"}
        </Text>
        <Text style={[styles.featureText, { color: t.textSecondary, marginTop: 4 }]}>
          {`Deblochează aplicația și primești acces și la încă ${n > 0 ? intrebari(n) : "multe întrebări"} extra${
            when === "trial" ? ", pe lângă lista oficială ANR." : "."
          }`}
        </Text>
      </View>
    </View>
  );
}

/** What the trial and the unlock both cover. The extras are not in this list
 * on purpose — ExtrasHighlight shows them. `withProgress` adds the
 * reassurance that local history survives the lock (true: the lock never
 * deletes anything). */
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
        title="Întrebările oficiale ANR"
        text="Toată lista oficială: practică pe categorii, pe materii și antrenament personalizat"
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
  trailing: Trailing,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Icon after the label (e.g. an arrow on the main call to action). */
  trailing?: IconType;
  /** Smaller button for inline rows (restore). */
  compact?: boolean;
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
        compact && styles.buttonCompact,
        disabled && !busy && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
      ]}
    >
      {busy && <ActivityIndicator size="small" color={fg} />}
      <Text
        style={[
          variant === "link" ? styles.linkText : styles.buttonText,
          compact && { fontSize: 14 },
          { color: fg },
        ]}
      >
        {label}
      </Text>
      {Trailing && <Trailing size={compact ? 16 : 22} color={fg} strokeWidth={2.4} />}
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

/** A tilted phone showing a real question from the app, with a lock badge —
 * the paywall's hero picture, drawn with views so it follows the theme and
 * needs no image asset. The question is the app's own first official one. */
function PhoneMock() {
  const { theme: t } = useTheme();
  const q = allQuestions.find((x) => x.id === 1) ?? allQuestions[0];
  if (!q) return null;
  return (
    <View style={{ width: 104, height: 168 }} accessible={false} importantForAccessibility="no-hide-descendants">
      <View
        style={{
          position: "absolute",
          top: 0,
          right: 6,
          width: 96,
          height: 160,
          borderRadius: 18,
          borderWidth: 3,
          borderColor: t.border,
          backgroundColor: t.bgCard,
          padding: 9,
          transform: [{ rotate: "8deg" }],
          overflow: "hidden",
        }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: t.border, marginBottom: 8 }}>
          <View style={{ width: "45%", height: 4, borderRadius: 2, backgroundColor: t.primary }} />
        </View>
        <Text style={{ fontFamily: FONTS.uiBold, fontSize: 8, lineHeight: 11, color: t.text }} numberOfLines={3}>
          {q.question}
        </Text>
        {q.options.slice(0, 3).map((o, i) => {
          const right = i === q.correct;
          return (
            <View
              key={i}
              style={{
                marginTop: 6,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: right ? t.success : t.border,
                backgroundColor: right ? t.success + "26" : "transparent",
                paddingHorizontal: 5,
                paddingVertical: 4,
                flexDirection: "row",
                gap: 4,
              }}
            >
              <Text style={{ fontFamily: FONTS.uiBold, fontSize: 8, color: right ? t.success : t.textMuted }}>
                {String.fromCharCode(65 + i)}
              </Text>
              <Text style={{ flex: 1, fontFamily: FONTS.uiRegular, fontSize: 8, color: t.textSecondary }} numberOfLines={1}>
                {o}
              </Text>
            </View>
          );
        })}
      </View>
      <View
        style={{
          position: "absolute",
          right: -4,
          bottom: 4,
          width: 42,
          height: 42,
          borderRadius: 13,
          backgroundColor: t.bgCard,
          borderWidth: 1,
          borderColor: t.warning + "88",
          alignItems: "center",
          justifyContent: "center",
          shadowColor: "#000",
          shadowOpacity: 0.35,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
          elevation: 8,
        }}
      >
        <Lock size={22} color={t.warning} strokeWidth={2.4} />
      </View>
    </View>
  );
}

/** Soft colour glow behind the hero (SVG, so no extra native dependency). */
function Glow() {
  const { theme: t } = useTheme();
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id="g1" cx="85%" cy="8%" r="65%">
          <Stop offset="0" stopColor={t.primary} stopOpacity="0.32" />
          <Stop offset="1" stopColor={t.primary} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="g2" cx="0%" cy="45%" r="55%">
          <Stop offset="0" stopColor={ACCENT.theory} stopOpacity="0.12" />
          <Stop offset="1" stopColor={ACCENT.theory} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#g1)" />
      <Rect x="0" y="0" width="100%" height="100%" fill="url(#g2)" />
    </Svg>
  );
}

function TrustItem({ Icon, color, title, text }: { Icon: IconType; color: string; title: string; text: string }) {
  const { theme: t } = useTheme();
  return (
    <View style={styles.trustItem}>
      <Icon size={17} color={color} strokeWidth={2.2} />
      <View style={{ flexShrink: 1 }}>
        <Text style={[styles.trustTitle, { color: t.text }]}>{title}</Text>
        <Text style={[styles.trustText, { color: t.textSecondary }]}>{text}</Text>
      </View>
    </View>
  );
}

/** The store price, shown as a launch price against the regular one when the
 * regular price is set and genuinely higher; otherwise just the store price. */
function LaunchPrice({ price }: { price: string }) {
  const { theme: t } = useTheme();
  const now = parseRon(price);
  const regular = LAUNCH_REGULAR_PRICE_RON;
  if (now == null || regular == null || regular <= now) {
    return <Text style={[styles.price, { color: t.text }]}>{price}</Text>;
  }
  const pct = Math.round((1 - now / regular) * 100);
  return (
    <View style={{ alignItems: "center" }} accessible accessibilityLabel={`Preț de lansare ${price}, minus ${pct} la sută. Apoi ${formatRon(regular)}.`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={[styles.price, { color: t.text }]}>{price}</Text>
        <Text style={[styles.oldPrice, { color: t.textMuted }]}>{formatRon(regular)}</Text>
        <View style={[styles.discount, { backgroundColor: "#dc2626" }]}>
          <Text style={styles.discountText}>−{pct}%</Text>
        </View>
      </View>
      <Text style={[styles.priceNote, { color: t.textSecondary }]}>Preț de lansare · apoi {formatRon(regular)}</Text>
    </View>
  );
}

/** The paywall. Two modes:
 * - default: the trial is over and the app is locked until the unlock.
 * - `trial`: shown on app start while the trial runs (see AppShell) and from
 *   the trial banner, with a way back into the app (✕ and "Mai târziu").
 * Built to fit one phone screen without scrolling; the ScrollView only
 * matters on very small screens or with large system text.
 * Prices only ever come from the store — never a made-up "was" price. */
export default function Paywall({ trial }: { trial?: { daysLeft: number; onContinue: () => void } } = {}) {
  const insets = useSafeAreaInsets();
  const { theme: t, isDark } = useTheme();
  const { width } = useWindowDimensions();
  const { price, priceLoading, busy, buy, restore } = useUnlockFlow();
  const n = extraQuestionCount();
  const extras = n > 0 ? intrebari(n) : "multe întrebări";
  const showPhone = width >= 360;
  const onPrimary = isDark ? t.bg : "#fff";

  const badge = trial
    ? trial.daysLeft <= 1
      ? "ULTIMA ZI GRATUITĂ"
      : `GRATUIT ÎNCĂ ${zile(trial.daysLeft).toUpperCase()}`
    : "ACCES COMPLET";

  const features = [
    { Icon: BookOpen, color: ACCENT.questions, title: "Lista oficială ANR", text: "Pe categorii și materii" },
    { Icon: Anchor, color: t.primary, title: "Simulări de examen", text: "Clasa C, D, diferențe" },
    { Icon: GraduationCap, color: ACCENT.theory, title: "Cursuri de teorie", text: "Module cu quiz" },
    { Icon: History, color: t.warning, title: "Progres păstrat", text: "Istoric și realizări" },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Glow />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 6, paddingBottom: insets.bottom + 10 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topRow}>
          <View style={[styles.pill, { borderColor: t.warning, backgroundColor: t.warning + "1f" }]}>
            <Lock size={12} color={t.warning} strokeWidth={2.6} />
            <Text style={[styles.pillText, { color: t.warning }]}>{badge}</Text>
          </View>
          {trial && (
            <Pressable
              onPress={trial.onContinue}
              hitSlop={14}
              accessibilityRole="button"
              accessibilityLabel="Închide oferta"
              accessibilityHint="Continuă perioada gratuită"
              style={{ padding: 4 }}
            >
              <X size={24} color={t.textSecondary} strokeWidth={2.2} />
            </Pressable>
          )}
        </View>

        <View style={styles.heroRow}>
          <View style={{ flex: 1, justifyContent: "center" }}>
            <Text style={[styles.bigTitle, { color: t.text }]} accessibilityRole="header">
              {trial ? "Acces complet " : "Continuă pregătirea "}
              <Text style={{ color: t.primary }}>{trial ? "la toate întrebările" : "pentru examen"}</Text>
            </Text>
            <Text style={[styles.leadLeft, { color: t.textSecondary }]}>
              {trial ? "Acum ai lista oficială ANR." : `Ai avut acces gratuit timp de ${zile(TRIAL_DAYS)}.`}
            </Text>
          </View>
          {showPhone && <PhoneMock />}
        </View>

        <View
          style={[styles.extrasCard, { borderColor: t.primary, backgroundColor: t.primary + "1c" }]}
          accessible
          accessibilityLabel={`Deblochează aplicația și primești acces și la încă ${extras} extra. Incluse.`}
        >
          <View style={[styles.extrasIcon, { backgroundColor: t.primary }]}>
            <Plus size={24} color={onPrimary} strokeWidth={2.8} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.extrasBig, { color: t.text, flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit>
                {n > 0 ? `+${intrebari(n)} extra` : "Întrebări extra"}
              </Text>
              <View style={[styles.included, { backgroundColor: t.success }]}>
                <Text style={[styles.includedText, { color: onPrimary }]}>INCLUSE</Text>
              </View>
            </View>
            <Text style={[styles.extrasText, { color: t.textSecondary }]}>
              Deblochează aplicația și primești acces și la încă {extras} extra.
            </Text>
          </View>
        </View>

        <View style={styles.grid}>
          {features.map((f) => (
            <View key={f.title} style={[styles.gridItem, { backgroundColor: t.bgCard, borderColor: t.border }]}>
              <Tile Icon={f.Icon} color={f.color} size={18} tile={34} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.gridTitle, { color: t.text }]} numberOfLines={1} adjustsFontSizeToFit>{f.title}</Text>
                <Text style={[styles.gridText, { color: t.textSecondary }]} numberOfLines={1} adjustsFontSizeToFit>{f.text}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.bottom}>
          <View style={styles.priceBlock}>
            {price != null ? (
              <LaunchPrice price={price} />
            ) : priceLoading ? (
              <ActivityIndicator color={t.textMuted} accessibilityLabel="Se încarcă prețul" />
            ) : (
              <Text style={[styles.priceNote, { color: t.textSecondary }]}>Prețul îl vezi în {STORE_NAME} înainte să confirmi.</Text>
            )}
            <Text style={[styles.priceNote, { color: t.textSecondary }]} numberOfLines={1} adjustsFontSizeToFit>
              {["Plată unică", "fără abonament", "fără plăți automate"].map((p) => p.replace(/ /g, NBSP)).join(" · ")}
            </Text>
          </View>

          <ActionButton
            label={busy === "buy" ? "Se procesează…" : "Deblochează aplicația acum"}
            trailing={busy === "buy" ? undefined : ArrowRight}
            accessibilityLabel={price ? `Deblochează aplicația acum pentru ${price}` : "Deblochează aplicația acum"}
            accessibilityHint={`Deschide plata în ${STORE_NAME}`}
            onPress={buy}
            busy={busy === "buy"}
            disabled={busy !== null}
          />

          <View style={styles.trustRow}>
            <TrustItem Icon={ShieldCheck} color={t.success} title="Plată sigură" text={STORE_NAME} />
            <TrustItem Icon={Zap} color={t.warning} title="Acces imediat" text="după plată" />
            <TrustItem Icon={CircleCheck} color={t.success} title="O singură plată" text="fără costuri ascunse" />
          </View>

          <View style={styles.linksRow}>
            {trial && (
              <Pressable onPress={trial.onContinue} disabled={busy !== null} hitSlop={10} accessibilityRole="button" accessibilityHint="Închide oferta și deschide aplicația">
                <Text style={[styles.smallLink, { color: t.textSecondary }]}>Mai târziu</Text>
              </Pressable>
            )}
            <Pressable
              onPress={restore}
              disabled={busy !== null}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Restaurează achizițiile"
              accessibilityHint="Ai plătit deja pentru eliminarea reclamelor? Verifică achizițiile acestui cont"
              style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              {busy === "restore" && <ActivityIndicator size="small" color={t.primary} />}
              <Text style={[styles.smallLink, { color: isDark ? t.primary : t.primaryDark }]}>
                {busy === "restore" ? "Se restaurează…" : "Ai plătit deja? Restaurează"}
              </Text>
            </Pressable>
          </View>

          <LegalLinks withWipe={!trial} />
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
  extrasBig: {
    fontFamily: FONTS.uiBold,
    fontSize: 19,
    lineHeight: 24,
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
    paddingTop: 10,
    gap: 9,
  },
  priceBlock: {
    alignItems: "center",
    minHeight: 40,
    justifyContent: "center",
  },
  price: {
    fontFamily: FONTS.uiExtraBold,
    fontSize: 32,
    lineHeight: 38,
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
  buttonCompact: {
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
  },
  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1.5,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: {
    fontFamily: FONTS.uiBold,
    fontSize: 12,
    letterSpacing: 0.6,
  },
  bigTitle: {
    fontFamily: FONTS.uiExtraBold,
    fontSize: 25,
    lineHeight: 30,
  },
  leadLeft: {
    fontFamily: FONTS.uiRegular,
    fontSize: 14,
    lineHeight: 19,
    marginTop: 6,
  },
  extrasCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 2,
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginTop: 10,
    marginBottom: 10,
  },
  oldPrice: {
    fontFamily: FONTS.uiSemibold,
    fontSize: 18,
    textDecorationLine: "line-through",
  },
  discount: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  discountText: {
    fontFamily: FONTS.uiExtraBold,
    fontSize: 15,
    color: "#fff",
  },
  extrasText: {
    fontFamily: FONTS.uiRegular,
    fontSize: 13,
    lineHeight: 17,
    marginTop: 3,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 34,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  gridItem: {
    flexBasis: "47%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 14,
    padding: 9,
  },
  gridTitle: {
    fontFamily: FONTS.uiBold,
    fontSize: 13,
  },
  gridText: {
    fontFamily: FONTS.uiRegular,
    fontSize: 11,
    marginTop: 1,
  },
  linksRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    columnGap: 22,
    minHeight: 30,
  },
  smallLink: {
    fontFamily: FONTS.uiSemibold,
    fontSize: 14,
  },
  extrasIcon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  included: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  includedText: {
    fontFamily: FONTS.uiExtraBold,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  listCard: {
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 16,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
  },
  trustRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 6,
  },
  trustItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flex: 1,
  },
  trustTitle: {
    fontFamily: FONTS.uiBold,
    fontSize: 11,
  },
  trustText: {
    fontFamily: FONTS.uiRegular,
    fontSize: 10,
  },
  restoreRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
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
    columnGap: 16,
    rowGap: 4,
  },
  legalText: {
    fontFamily: FONTS.uiMedium,
    fontSize: 11,
    textDecorationLine: "underline",
  },
});

// Exported so TrialIntro lays out the same way without redefining them.
export const paywallStyles = styles;
