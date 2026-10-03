import { useEffect, useRef, useState, type ComponentType } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CirclePlay, Lock, LockOpen, Sparkles } from "lucide-react-native";
import { useTheme } from "../lib/ThemeContext";
import { FONTS } from "../lib/fonts";
import { useAccess } from "../lib/AccessContext";
import { TRIAL_DAYS } from "../lib/accessCore";
import { extraQuestionCount } from "../lib/questions";
import {
  ActionButton,
  LegalLinks,
  STORE_NAME,
  Tile,
  UnlockFeatures,
  ExtrasHighlight,
  intrebari,
  paywallStyles as shared,
  useUnlockFlow,
  zile,
} from "./Paywall";

// One-time screen shown before any trial exists (access state "new"). Apple
// 3.1.1 requires that, before a time-based trial starts, the app states how
// long it lasts, what stops working when it ends and what unlocking costs —
// so the trial only starts when the user taps "Începe perioada gratuită".

type IconType = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

function Step({
  Icon,
  color,
  title,
  text,
  last = false,
}: {
  Icon: IconType;
  color: string;
  title: string;
  text: string;
  last?: boolean;
}) {
  const { theme: t } = useTheme();
  return (
    <View style={styles.step}>
      <View style={styles.stepRail}>
        <View style={[styles.stepDot, { backgroundColor: color + "26" }]}>
          <Icon size={16} color={color} strokeWidth={2.2} />
        </View>
        {!last && <View style={[styles.stepLine, { backgroundColor: t.border }]} />}
      </View>
      <View style={[styles.stepBody, !last && { paddingBottom: 16 }]}>
        <Text style={[styles.stepTitle, { color: t.text }]}>{title}</Text>
        <Text style={[styles.stepText, { color: t.textSecondary }]}>{text}</Text>
      </View>
    </View>
  );
}

export default function TrialIntro() {
  const insets = useSafeAreaInsets();
  const { theme: t } = useTheme();
  const { startTrial } = useAccess();
  const { price, busy, buy, restore } = useUnlockFlow();
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const anyBusy = starting || busy !== null;

  // startTrial never throws by contract (offline falls back to a local
  // trial); the catch is a last line of defence so the button can't stick.
  // On success the provider flips the state and _layout swaps this screen out.
  const onStart = async () => {
    if (startingRef.current || busy !== null) return;
    startingRef.current = true;
    setStarting(true);
    try {
      await startTrial();
    } catch {
      Alert.alert("Eroare", "Nu am putut porni perioada gratuită. Încearcă din nou.");
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  };

  const days = zile(TRIAL_DAYS);
  const extras = extraQuestionCount();
  const plusExtras = extras > 0 ? `, plus ${intrebari(extras)} suplimentare` : ", plus întrebările suplimentare";
  const unlockText = price
    ? `O singură plată de ${price} deblochează aplicația pentru totdeauna${plusExtras}. Fără abonament și fără plăți automate.`
    : `O singură plată deblochează aplicația pentru totdeauna${plusExtras} — prețul îl vezi în ${STORE_NAME} înainte să confirmi. Fără abonament și fără plăți automate.`;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={[
          shared.scroll,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 20 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={shared.hero}>
          <Tile Icon={Sparkles} color={t.primary} size={30} tile={68} />
          <Text style={[shared.title, { color: t.text }]} accessibilityRole="header">
            Încearcă gratuit {days}
          </Text>
          <Text style={[shared.lead, { color: t.textSecondary }]}>
            Întrebările oficiale ANR, simulări de examen și cursuri — fără cont și fără reclame.
          </Text>
        </View>

        <UnlockFeatures heading={`Gratuit ${days}`} />
        <View style={{ height: 14 }} />
        <ExtrasHighlight when="trial" />

        <View style={[shared.card, { backgroundColor: t.bgCard, borderColor: t.border, marginTop: 14, gap: 12 }]}>
          <Text style={[shared.eyebrow, { color: t.textSecondary }]} accessibilityRole="header">
            Cum funcționează
          </Text>
          <View>
            <Step
              Icon={CirclePlay}
              color={t.success}
              title="Azi"
              text={`Pornești perioada gratuită: ai acces la întrebările oficiale, simulări și cursuri timp de ${days} și nu plătești nimic.`}
            />
            <Step
              Icon={Lock}
              color={t.warning}
              title={`După ${days}`}
              text="Toată aplicația se blochează: întrebările, simulările de examen, cursurile, istoricul și setările. Progresul tău rămâne salvat și îl regăsești după deblocare."
            />
            <Step Icon={LockOpen} color={t.primary} title="Deblocare" text={unlockText} last />
          </View>
        </View>

        <View style={shared.bottom}>
          <ActionButton
            label={starting ? "Se pornește…" : "Începe perioada gratuită"}
            accessibilityLabel="Începe perioada gratuită"
            accessibilityHint={`Pornește accesul gratuit de ${days}`}
            onPress={onStart}
            busy={starting}
            disabled={anyBusy}
          />
          <ActionButton
            variant="secondary"
            label={busy === "buy" ? "Se procesează…" : price ? `Cumpără + întrebări în plus — ${price}` : "Cumpără + întrebări în plus"}
            accessibilityLabel={price ? `Cumpără acum aplicația pentru ${price}` : "Cumpără acum aplicația"}
            accessibilityHint={`Deschide plata în ${STORE_NAME}`}
            onPress={buy}
            busy={busy === "buy"}
            disabled={anyBusy}
          />
          <ActionButton
            variant="link"
            label={busy === "restore" ? "Se restaurează…" : "Am cumpărat deja — Restaurează achizițiile"}
            accessibilityLabel="Am cumpărat deja. Restaurează achizițiile"
            accessibilityHint="Verifică dacă ai cumpărat deja aplicația sau eliminarea reclamelor cu acest cont"
            onPress={restore}
            busy={busy === "restore"}
            disabled={anyBusy}
          />
          <LegalLinks />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  step: {
    flexDirection: "row",
    gap: 12,
  },
  stepRail: {
    alignItems: "center",
    width: 32,
  },
  stepDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLine: {
    flex: 1,
    width: 2,
    marginVertical: 4,
    borderRadius: 1,
  },
  stepBody: {
    flex: 1,
    paddingTop: 5,
  },
  stepTitle: {
    fontFamily: FONTS.uiBold,
    fontSize: 15,
  },
  stepText: {
    fontFamily: FONTS.uiRegular,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 2,
  },
});
