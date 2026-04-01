import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ThemeProvider, useTheme } from "../src/lib/ThemeContext";
import { initAds, preloadInterstitial } from "../src/lib/ads";
import { validateAdsFree } from "../src/lib/vouchers";

function AppStack() {
  const { theme, isDark } = useTheme();

  useEffect(() => {
    validateAdsFree().then(() => initAds().then(() => preloadInterstitial())).catch((e) => { if (__DEV__) console.warn("Ad init chain failed:", e); });
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
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AppStack />
    </ThemeProvider>
  );
}
