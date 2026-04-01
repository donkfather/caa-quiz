import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useCallback } from "react";
import { useTheme } from "../src/lib/ThemeContext";
import { EXAM_QUESTION_COUNT, TOTAL_QUESTIONS } from "../src/lib/questions";
import { getStats, getActiveSessions, getHistory, QuizStats } from "../src/lib/storage";
import { getStreak, getUnlockedBadges, BADGE_DEFS, StreakData } from "../src/lib/gamification";

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme: colors } = useTheme();
  const [stats, setStats] = useState<QuizStats | null>(null);
  const [activeSessions, setActiveSessions] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);
  const [streak, setStreak] = useState<StreakData>({ current: 0, best: 0, lastQuizDate: null });
  const [badgeCount, setBadgeCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      getStats().then(setStats);
      getActiveSessions().then((s) => setActiveSessions(s.length));
      getHistory().then((h) => setHistoryCount(h.length));
      getStreak().then(setStreak);
      getUnlockedBadges().then((b) => setBadgeCount(b.size));
    }, []),
  );

  const avgScore =
    stats && stats.totalAnswered > 0
      ? Math.round((stats.totalCorrect / stats.totalAnswered) * 100)
      : 0;

  const hasHistory = activeSessions > 0 || historyCount > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingHorizontal: 20, paddingTop: insets.top + 20 }}>
      {/* Header */}
      <View style={{ marginBottom: 24 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 32, fontWeight: "800", color: colors.text, marginBottom: 6 }}>Chestionare Barca</Text>
          <Pressable onPress={() => router.push("/settings")} hitSlop={8} accessibilityLabel="Deschide setări" accessibilityRole="button">
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.primary }}>Setări</Text>
          </Pressable>
        </View>
        <Text style={{ fontSize: 15, color: colors.textSecondary }}>
          {TOTAL_QUESTIONS} întrebări pentru examenul CAA — Clasa C și D
        </Text>
      </View>

      {/* Stats card */}
      {stats && stats.totalQuizzes > 0 && (
        <View style={{ backgroundColor: colors.bgCard, borderRadius: 16, padding: 16, marginBottom: 24 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-around" }}>
            <View style={{ alignItems: "center" }}>
              <Text style={{ fontSize: 24, fontWeight: "700", color: colors.primary }}>{stats.totalQuizzes}</Text>
              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Teste</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ fontSize: 24, fontWeight: "700", color: colors.primary }}>{avgScore}%</Text>
              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Media</Text>
            </View>
            <View style={{ alignItems: "center" }}>
              <Text style={{ fontSize: 24, fontWeight: "700", color: colors.primary }}>{stats.bestScore}%</Text>
              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>Record</Text>
            </View>
          </View>
        </View>
      )}

      {/* Streak + Badges */}
      <Pressable
        style={{ flexDirection: "row", backgroundColor: colors.bgCard, borderRadius: 14, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: colors.border, alignItems: "center" }}
        onPress={() => router.push("/badges")}
        accessibilityLabel={`Streak: ${streak.current} zile, ${badgeCount} realizări. Deschide realizări`}
        accessibilityRole="button"
      >
        <Text style={{ fontSize: 24 }}>🔥</Text>
        <View style={{ marginLeft: 10, flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>
            {streak.current} {streak.current === 1 ? "zi" : "zile"}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textMuted }}>
            {badgeCount}/{BADGE_DEFS.length} realizări
          </Text>
        </View>
        <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
      </Pressable>

      {/* Nautical divider */}
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 20 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
        <Text style={{ marginHorizontal: 12, fontSize: 16, color: colors.textMuted }}>⚓</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      </View>

      {/* Actions */}
      <View style={{ gap: 12 }}>
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 22, paddingHorizontal: 18, borderRadius: 14, gap: 14, backgroundColor: colors.primary }}
          onPress={() => router.push("/quiz?mode=exam")}
          accessibilityLabel="Începe examen"
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 28 }}>⚓</Text>
          <View>
            <Text style={{ fontSize: 17, fontWeight: "700", color: "#fff" }}>Examen</Text>
            <Text style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>
              {EXAM_QUESTION_COUNT} întrebări aleatorii
            </Text>
          </View>
        </Pressable>

        <Pressable
          style={{ flexDirection: "row", alignItems: "center", padding: 18, borderRadius: 14, gap: 14, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }}
          onPress={() => router.push("/quiz?mode=practice")}
          accessibilityLabel="Modul practică"
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 28 }}>📖</Text>
          <View>
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>Practică</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
              Toate {TOTAL_QUESTIONS} întrebările
            </Text>
          </View>
        </Pressable>

        <View style={{ flexDirection: "row", alignItems: "center", padding: 18, borderRadius: 14, gap: 14, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, opacity: 0.5 }} accessibilityLabel="Învață — în curând">
          <Text style={{ fontSize: 28 }}>🎓</Text>
          <View>
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.textMuted }}>Învață</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>În curând</Text>
          </View>
        </View>
      </View>

      {/* History */}
      {hasHistory && (
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", marginTop: 20, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: colors.bgCard, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}
          onPress={() => router.push("/history")}
          accessibilityLabel="Deschide istoric"
          accessibilityRole="button"
        >
          <Text style={{ fontSize: 15, color: colors.textSecondary, flex: 1 }}>Istoric</Text>
          {activeSessions > 0 && (
            <View style={{ backgroundColor: colors.warning, borderRadius: 10, minWidth: 20, height: 20, alignItems: "center", justifyContent: "center", paddingHorizontal: 6, marginRight: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#fff" }}>{activeSessions}</Text>
            </View>
          )}
          <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
        </Pressable>
      )}

      <View style={{ position: "absolute", bottom: 40, left: 20, right: 20 }}>
        <Text style={{ textAlign: "center", fontSize: 12, color: colors.textMuted }}>
          Pregătire pentru examenul teoretic CAA — Clasa C și D
        </Text>
        <Text style={{ textAlign: "center", fontSize: 10, color: colors.textMuted, opacity: 0.5, marginTop: 4 }}>
          Ultima actualizare a datelor: 2025
        </Text>
      </View>
    </View>
  );
}
