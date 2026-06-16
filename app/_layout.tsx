import { useEffect, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
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
import { FONTS } from "../src/lib/fonts";
import { initAds, preloadInterstitial } from "../src/lib/ads";
import { configurePurchases } from "../src/lib/purchases";
import { validateAdsFree } from "../src/lib/vouchers";
import { refreshAllQuestions, allQuestions } from "../src/lib/questions";
import { onQuestionsUpdated } from "../src/lib/questionsRemote";
import { migrateIdScheme } from "../src/lib/idMigration";

SplashScreen.preventAutoHideAsync().catch(() => {});

// Make Inter the default for every <Text>. CourseMarkdown overrides
// body paragraphs with Lora.
const TextAny = Text as any;
TextAny.defaultProps = TextAny.defaultProps || {};
TextAny.defaultProps.style = [{ fontFamily: FONTS.uiRegular }, TextAny.defaultProps.style].filter(Boolean);

function AppStack() {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const [updateBanner, setUpdateBanner] = useState<number | null>(null);
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
    // configurePurchases MUST run first: validateAdsFree reads the RevenueCat
    // entitlement into settings.adsDisabled, and initAds skips AdMob init when
    // that flag is already true — so a paying user never initializes ads.
    configurePurchases()
      .then(() => validateAdsFree())
      .then(() => initAds())
      .then(() => preloadInterstitial())
      .catch((e) => { if (__DEV__) console.warn("Ad init chain failed:", e); });
    // Pull cached + remote question set in the background. Falls back to
    // bundled JSON if offline; never blocks the UI.
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

  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
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
        <Stack.Screen name="badges" options={{ title: "Realizări" }} />
        <Stack.Screen name="learn/index" options={{ title: "Învață" }} />
        <Stack.Screen name="learn/[moduleId]" options={{ title: "Modul" }} />
        <Stack.Screen name="learn/section" options={{ title: "Secțiune" }} />
        <Stack.Screen name="courses/index" options={{ title: "Cursuri" }} />
        <Stack.Screen name="courses/[moduleId]" options={{ title: "Curs" }} />
        <Stack.Screen name="courses/section" options={{ title: "Secțiune" }} />
      </Stack>
      {updateBanner !== null && (
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
  const [fontsLoaded] = useInter({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold,
    Lora_400Regular, Lora_500Medium, Lora_700Bold, Lora_400Regular_Italic,
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <ThemeProvider>
      <AppStack />
    </ThemeProvider>
  );
}
