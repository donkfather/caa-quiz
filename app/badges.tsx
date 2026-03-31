import { View, Text, Image, StyleSheet, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useCallback } from "react";
import { useFocusEffect } from "expo-router";
import { useTheme } from "../src/lib/ThemeContext";
import {
  BADGE_DEFS,
  getUnlockedBadges,
  getStreak,
  StreakData,
} from "../src/lib/gamification";

const BADGE_IMAGES: Record<string, any> = {
  prima_cursa: require("../assets/badges/prima_cursa.png"),
  marinar: require("../assets/badges/marinar.png"),
  capitan: require("../assets/badges/capitan.png"),
  perfect: require("../assets/badges/perfect.png"),
  persistent: require("../assets/badges/persistent.png"),
  dedicat: require("../assets/badges/dedicat.png"),
  explorer: require("../assets/badges/explorer.png"),
  admis: require("../assets/badges/admis.png"),
};

const BADGE_IMAGES_LOCKED: Record<string, any> = {
  prima_cursa: require("../assets/badges/prima_cursa_locked.png"),
  marinar: require("../assets/badges/marinar_locked.png"),
  capitan: require("../assets/badges/capitan_locked.png"),
  perfect: require("../assets/badges/perfect_locked.png"),
  persistent: require("../assets/badges/persistent_locked.png"),
  dedicat: require("../assets/badges/dedicat_locked.png"),
  explorer: require("../assets/badges/explorer_locked.png"),
  admis: require("../assets/badges/admis_locked.png"),
};

export default function BadgesScreen() {
  const insets = useSafeAreaInsets();
  const { theme: colors } = useTheme();
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [streak, setStreak] = useState<StreakData>({ current: 0, best: 0, lastQuizDate: null });

  useFocusEffect(
    useCallback(() => {
      getUnlockedBadges().then(setUnlocked);
      getStreak().then(setStreak);
    }, []),
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 20 }}
    >
      {/* Streak card */}
      <View style={{
        backgroundColor: colors.bgCard,
        borderRadius: 16,
        padding: 20,
        marginBottom: 24,
        alignItems: "center",
        borderWidth: 1,
        borderColor: colors.border,
      }}>
        <Text style={{ fontSize: 40 }}>🔥</Text>
        <Text style={{ fontSize: 36, fontWeight: "800", color: colors.text, marginTop: 4 }}>
          {streak.current}
        </Text>
        <Text style={{ fontSize: 14, color: colors.textSecondary, marginTop: 2 }}>
          {streak.current === 1 ? "zi consecutivă" : "zile consecutive"}
        </Text>
        <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 8 }}>
          Record: {streak.best} zile
        </Text>
      </View>

      {/* Badges grid */}
      <Text style={{ fontSize: 16, fontWeight: "700", color: colors.textSecondary, marginBottom: 12 }}>
        Realizări — {unlocked.size}/{BADGE_DEFS.length}
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {BADGE_DEFS.map((badge) => {
          const isUnlocked = unlocked.has(badge.key);
          return (
            <View
              key={badge.key}
              style={{
                width: "47%",
                backgroundColor: colors.bgCard,
                borderRadius: 14,
                padding: 14,
                alignItems: "center",
                borderWidth: 1,
                borderColor: isUnlocked ? colors.primary + "40" : colors.border,
              }}
            >
              <Image
                source={isUnlocked ? BADGE_IMAGES[badge.key] : BADGE_IMAGES_LOCKED[badge.key]}
                style={{ width: 64, height: 64, marginBottom: 8 }}
                resizeMode="contain"
              />
              <Text style={{
                fontSize: 14,
                fontWeight: "700",
                color: isUnlocked ? colors.text : colors.textMuted,
                textAlign: "center",
              }}>
                {badge.name}
              </Text>
              <Text style={{
                fontSize: 11,
                color: colors.textMuted,
                textAlign: "center",
                marginTop: 3,
              }}>
                {badge.description}
              </Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}
