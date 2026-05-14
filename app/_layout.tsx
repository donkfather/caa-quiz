import { useEffect, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "../src/lib/ThemeContext";
import { initAds, preloadInterstitial } from "../src/lib/ads";
import { validateAdsFree } from "../src/lib/vouchers";
import { refreshAllQuestions, allQuestions } from "../src/lib/questions";
import { onQuestionsUpdated } from "../src/lib/questionsRemote";
import { migrateIdScheme } from "../src/lib/idMigration";

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
    validateAdsFree().then(() => initAds().then(() => preloadInterstitial())).catch((e) => { if (__DEV__) console.warn("Ad init chain failed:", e); });
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
  return (
    <ThemeProvider>
      <AppStack />
    </ThemeProvider>
  );
}
