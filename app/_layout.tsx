import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as SplashScreen from "expo-splash-screen";
import {
  useFonts as useInter,
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold,
} from "@expo-google-fonts/inter";
import {
  Lora_400Regular, Lora_500Medium, Lora_700Bold, Lora_400Regular_Italic,
} from "@expo-google-fonts/lora";
import { ThemeProvider, useTheme } from "../src/lib/ThemeContext";
import { AccessProvider, useAccess } from "../src/lib/AccessContext";
import { FONTS } from "../src/lib/fonts";
import { refreshAllQuestions, allQuestions } from "../src/lib/questions";
import { onQuestionsUpdated } from "../src/lib/questionsRemote";
import { migrateIdScheme } from "../src/lib/idMigration";
import TrialIntro from "../src/components/TrialIntro";
import Paywall from "../src/components/Paywall";

SplashScreen.preventAutoHideAsync().catch(() => {});

// Upper bound on how long the native splash may stay up. Fonts and the access
// check normally resolve well before this; if anything hangs, the splash goes
// anyway and a spinner shows until it resolves, so nobody is stranded on it.
const SPLASH_MAX_MS = 4000;

// Make Inter the default for every <Text>. CourseMarkdown overrides
// body paragraphs with Lora.
const TextAny = Text as any;
TextAny.defaultProps = TextAny.defaultProps || {};
TextAny.defaultProps.style = [{ fontFamily: FONTS.uiRegular }, TextAny.defaultProps.style].filter(Boolean);

// Decides what the whole app shows: nothing (behind the splash) until fonts
// and access are known, then the trial intro, the lock screen, or the app.
function AppShell({ fontsReady }: { fontsReady: boolean }) {
  const { theme, isDark } = useTheme();
  const { state } = useAccess();
  const insets = useSafeAreaInsets();
  const [updateBanner, setUpdateBanner] = useState<number | null>(null);
  // The offer opens on every app start while the trial runs; "Continuă
  // perioada gratuită" closes it until the next start. Plain state on purpose:
  // AppShell mounts once per process, so a cold start shows it again.
  const [trialOfferClosed, setTrialOfferClosed] = useState(false);
  // Not on the very first open: someone who just started the trial from the
  // intro screen goes straight into the app. The offer waits for the next start.
  useEffect(() => {
    if (state?.kind === "new") setTrialOfferClosed(true);
  }, [state?.kind]);
  const [bannerOpacity] = useState(() => new Animated.Value(0));

  // Only migrate once the loaded question set uses the new (DB-aligned)
  // id scheme — otherwise we'd shift user data against a stale 0-based
  // payload still cached locally.
  const maybeMigrate = () => {
    if (!allQuestions.length) return;
    let minId = Infinity;
    for (const q of allQuestions) if (q.id < minId) minId = q.id;
    if (minId >= 1) migrateIdScheme();
  };

  useEffect(() => {
    // Pull cached + remote question set in the background. Falls back to
    // bundled JSON if offline; never blocks the UI. Runs whatever the access
    // state, so the set is current the moment a locked user unlocks.
    refreshAllQuestions().then(maybeMigrate).catch((e) => { if (__DEV__) console.warn("Question refresh failed:", e); });

    const unsubscribe = onQuestionsUpdated((version) => {
      maybeMigrate();
      setUpdateBanner(version);
      Animated.sequence([
        Animated.timing(bannerOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
        Animated.delay(4000),
        Animated.timing(bannerOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start(() => setUpdateBanner(null));
    });
    return unsubscribe;
  }, []);

  const ready = fontsReady && state !== null;
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  let content: ReactNode;
  let showsApp = false;
  if (!fontsReady || state === null) {
    // Hidden behind the splash; only visible if SPLASH_MAX_MS ran out first.
    content = (
      <View style={[styles.loading, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.primary} accessibilityLabel="Se încarcă" />
      </View>
    );
  } else if (state.kind === "new") {
    content = <TrialIntro />;
  } else if (state.kind === "expired") {
    content = <Paywall />;
  } else if (state.kind === "trial" && !trialOfferClosed) {
    content = <Paywall trial={{ daysLeft: state.daysLeft, onContinue: () => setTrialOfferClosed(true) }} />;
  } else {
    showsApp = true;
    content = (
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.bg },
          headerTintColor: theme.text,
          headerTitleStyle: { fontWeight: "600" },
          contentStyle: { backgroundColor: theme.bg },
          animation: "slide_from_right",
        }}
      >
        <Stack.Screen name="index" options={{ title: "Acasă", headerShown: false, headerBackTitle: "Acasă" }} />
        <Stack.Screen name="history" options={{ title: "Istoric" }} />
        <Stack.Screen name="settings" options={{ title: "Setări" }} />
        <Stack.Screen name="unlock" options={{ headerShown: false, presentation: "modal", animation: "slide_from_bottom" }} />
        <Stack.Screen name="badges" options={{ title: "Realizări" }} />
        <Stack.Screen name="learn/index" options={{ title: "Învață" }} />
        <Stack.Screen name="learn/[moduleId]" options={{ title: "Modul" }} />
        <Stack.Screen name="learn/section" options={{ title: "Secțiune" }} />
        <Stack.Screen name="courses/index" options={{ title: "Cursuri" }} />
        <Stack.Screen name="courses/[moduleId]" options={{ title: "Curs" }} />
        <Stack.Screen name="courses/section" options={{ title: "Secțiune" }} />
      </Stack>
    );
  }

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      {content}
      {showsApp && updateBanner !== null && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.banner,
            { top: insets.top + 8, backgroundColor: theme.success, opacity: bannerOpacity },
          ]}
        >
          <Text style={styles.bannerText}>Întrebări actualizate la v{updateBanner}</Text>
        </Animated.View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  banner: {
    position: "absolute",
    left: 16,
    right: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  bannerText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useInter({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold,
    Lora_400Regular, Lora_500Medium, Lora_700Bold, Lora_400Regular_Italic,
  });
  // A font that fails to load must not brick the app — fall back to system fonts.
  const fontsReady = fontsLoaded || fontError != null;

  useEffect(() => {
    const timer = setTimeout(() => { SplashScreen.hideAsync().catch(() => {}); }, SPLASH_MAX_MS);
    return () => clearTimeout(timer);
  }, []);

  // Providers mount right away (not after fonts) so the access check runs in
  // parallel with font loading; AppShell renders no text until fonts are ready.
  return (
    <ThemeProvider>
      <AccessProvider>
        <AppShell fontsReady={fontsReady} />
      </AccessProvider>
    </ThemeProvider>
  );
}
