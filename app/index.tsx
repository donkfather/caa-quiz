import { View, Text, Pressable, StyleSheet, Modal, ScrollView } from "react-native";
import { Flame, Anchor, CirclePlay, BookOpen, GraduationCap, Library, History } from "lucide-react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useCallback, useEffect, type ComponentType } from "react";
import { useTheme } from "../src/lib/ThemeContext";
import { TOPIC_LABELS, LICENSE_LABELS, Topic, License, ExamType, EXAM_CONFIGS, getQuestionCount, totalQuestions } from "../src/lib/questions";
import { onQuestionsUpdated } from "../src/lib/questionsRemote";
import { getStats, getActiveSessions, getHistory, QuizStats, ActiveSession } from "../src/lib/storage";
import { showInterstitial } from "../src/lib/ads";
import { getStreak, getUnlockedBadges, BADGE_DEFS, StreakData } from "../src/lib/gamification";

// Cursuri (cloud course platform) is not prod-ready — deferred to v1.1.
// Flip to true to re-enable the home entry point.
const COURSES_ENABLED = false;

// Per-action accent colours for the home-screen icon tiles (color-coded).
const ACTION_ACCENT = {
  practica: "#34d399", // emerald
  invata: "#a78bfa", // violet
  cursuri: "#22d3ee", // cyan
  istoric: "#94a3b8", // slate
};

// Lucide icon inside a tinted rounded tile. `onBlue` renders white-on-translucent
// for use on the solid primary card.
function IconTile({
  Icon,
  color,
  onBlue = false,
  size = 22,
  tile = 42,
}: {
  Icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  color: string;
  onBlue?: boolean;
  size?: number;
  tile?: number;
}) {
  return (
    <View
      style={{
        width: tile,
        height: tile,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: onBlue ? "rgba(255,255,255,0.18)" : color + "26",
      }}
    >
      <Icon size={size} color={onBlue ? "#fff" : color} strokeWidth={2} />
    </View>
  );
}

function sessionLabel(s: ActiveSession): string {
  if (s.mode === "exam") return s.examType ? (EXAM_CONFIGS[s.examType as ExamType]?.shortLabel ?? "Examen") : "Examen";
  if (s.mode === "practice") {
    if (s.topic) return TOPIC_LABELS[s.topic as Topic] ?? "Practică";
    if (s.license) return `Practică ${LICENSE_LABELS[s.license as License] ?? ""}`.trim();
    return "Practică";
  }
  return s.mode;
}

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme: colors } = useTheme();
  const [stats, setStats] = useState<QuizStats | null>(null);
  const [activeSessions, setActiveSessions] = useState(0);
  const [latestSession, setLatestSession] = useState<ActiveSession | null>(null);
  const [historyCount, setHistoryCount] = useState(0);
  const [streak, setStreak] = useState<StreakData>({ current: 0, best: 0, lastQuizDate: null });
  const [badgeCount, setBadgeCount] = useState(0);
  const [practiceModal, setPracticeModal] = useState(false);
  const [examModal, setExamModal] = useState(false);
  // Live total count. The bundled JSON has fewer questions than the most
  // recent remote bundle, and the remote refresh resolves asynchronously
  // after first paint — so we re-read on focus and on every remote update.
  const [total, setTotal] = useState(totalQuestions());

  useEffect(() => {
    const unsub = onQuestionsUpdated(() => setTotal(totalQuestions()));
    return unsub;
  }, []);

  useFocusEffect(
    useCallback(() => {
      setTotal(totalQuestions());
      getStats().then(setStats);
      getActiveSessions().then((s) => {
        setActiveSessions(s.length);
        const sorted = [...s].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        setLatestSession(sorted[0] ?? null);
      });
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
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
      >
      {/* Header */}
      <View style={{ marginBottom: 24 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <Text style={{ fontSize: 32, fontWeight: "800", color: colors.text, marginBottom: 6, flexShrink: 1 }}>Chestionare Barca</Text>
          <Pressable onPress={() => router.push("/settings")} hitSlop={8} accessibilityLabel="Deschide setări" accessibilityRole="button">
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.primary }}>Setări</Text>
          </Pressable>
        </View>
        <Text style={{ fontSize: 15, color: colors.textSecondary }}>
          {total} întrebări pentru examenul CAA — Clasa C și D
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
        <IconTile Icon={Flame} color={colors.warning} size={20} tile={38} />
        <View style={{ marginLeft: 12, flex: 1 }}>
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
        <Anchor size={16} color={colors.textMuted} strokeWidth={2} style={{ marginHorizontal: 12 }} />
        <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      </View>

      {/* Actions */}
      <View style={{ gap: 12 }}>
        {latestSession && (
          <Pressable
            style={{ flexDirection: "row", alignItems: "center", padding: 16, borderRadius: 14, gap: 14, backgroundColor: colors.bgCard, borderWidth: 1.5, borderColor: colors.warning + "88" }}
            onPress={async () => {
              const s = latestSession;
              await showInterstitial();
              let url = `/quiz?mode=${s.mode}&sessionId=${s.id}`;
              if (s.topic) url += `&topic=${s.topic}`;
              if (s.license) url += `&license=${s.license}`;
              if (s.examType) url += `&examType=${s.examType}`;
              router.push(url);
            }}
            accessibilityLabel="Continuă ultima sesiune"
            accessibilityRole="button"
          >
            <IconTile Icon={CirclePlay} color={colors.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>Continuă ultima sesiune</Text>
              <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                {sessionLabel(latestSession)} · întrebarea {Math.min(latestSession.currentIndex + 1, latestSession.questionIds.length)}/{latestSession.questionIds.length}
              </Text>
            </View>
            <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
          </Pressable>
        )}

        <Pressable
          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 22, paddingHorizontal: 18, borderRadius: 14, gap: 14, backgroundColor: colors.primary }}
          onPress={() => setExamModal(true)}
          accessibilityLabel="Începe examen"
          accessibilityRole="button"
        >
          <IconTile Icon={Anchor} color="#ffffff" onBlue />
          <View>
            <Text style={{ fontSize: 17, fontWeight: "700", color: "#fff" }}>Examen</Text>
            <Text style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", marginTop: 2 }}>
              Categoria C, D sau diferență
            </Text>
          </View>
        </Pressable>

        <Pressable
          style={{ flexDirection: "row", alignItems: "center", padding: 18, borderRadius: 14, gap: 14, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }}
          onPress={() => setPracticeModal(true)}
          accessibilityLabel="Modul practică"
          accessibilityRole="button"
        >
          <IconTile Icon={BookOpen} color={ACTION_ACCENT.practica} />
          <View>
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>Practică</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>
              Toate {total} întrebările
            </Text>
          </View>
        </Pressable>

        <Pressable
          style={{ flexDirection: "row", alignItems: "center", padding: 18, borderRadius: 14, gap: 14, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }}
          onPress={() => router.push("/learn")}
          accessibilityLabel="Invata teorie"
          accessibilityRole="button"
        >
          <IconTile Icon={GraduationCap} color={ACTION_ACCENT.invata} />
          <View>
            <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>Învață</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>8 module de teorie + quiz</Text>
          </View>
        </Pressable>

        {COURSES_ENABLED && (
          <Pressable
            style={{ flexDirection: "row", alignItems: "center", padding: 18, borderRadius: 14, gap: 14, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border }}
            onPress={() => router.push("/courses")}
            accessibilityLabel="Cursuri cloud"
            accessibilityRole="button"
          >
            <IconTile Icon={Library} color={ACTION_ACCENT.cursuri} />
            <View>
              <Text style={{ fontSize: 17, fontWeight: "700", color: colors.text }}>Cursuri</Text>
              <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }}>Conținut actualizat din cloud</Text>
            </View>
          </Pressable>
        )}
      </View>

      {/* History */}
      {hasHistory && (
        <Pressable
          style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 20, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: colors.bgCard, borderRadius: 12, borderWidth: 1, borderColor: colors.border }}
          onPress={() => router.push("/history")}
          accessibilityLabel="Deschide istoric"
          accessibilityRole="button"
        >
          <IconTile Icon={History} color={ACTION_ACCENT.istoric} size={20} tile={38} />
          <Text style={{ fontSize: 15, color: colors.textSecondary, flex: 1 }}>Istoric</Text>
          {activeSessions > 0 && (
            <View style={{ backgroundColor: colors.warning, borderRadius: 10, minWidth: 20, height: 20, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: "#fff" }}>{activeSessions}</Text>
            </View>
          )}
          <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
        </Pressable>
      )}

        <View style={{ marginTop: "auto", paddingTop: 28 }}>
          <Text style={{ textAlign: "center", fontSize: 12, color: colors.textMuted }}>
            Pregătire pentru examenul teoretic CAA — Clasa C și D
          </Text>
          <Text style={{ textAlign: "center", fontSize: 10, color: colors.textMuted, opacity: 0.5, marginTop: 4 }}>
            Ultima actualizare a datelor: 2025
          </Text>
        </View>
      </ScrollView>

      {/* Exam picker modal */}
      <Modal visible={examModal} transparent animationType="fade" onRequestClose={() => setExamModal(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}
          onPress={() => setExamModal(false)}
        >
          <Pressable
            style={{ backgroundColor: colors.bgCard, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 20, paddingBottom: insets.bottom + 20, paddingHorizontal: 20, maxHeight: "80%" }}
            onPress={() => {}}
          >
            <Text style={{ fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 }}>Alege examenul</Text>
            <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>Examen complet sau de diferență</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {(Object.values(EXAM_CONFIGS) as typeof EXAM_CONFIGS[ExamType][]).map((cfg) => (
                <Pressable
                  key={cfg.type}
                  style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: colors.bg, marginBottom: 8 }}
                  onPress={() => { setExamModal(false); router.push(`/quiz?mode=exam&examType=${cfg.type}`); }}
                  accessibilityLabel={cfg.label}
                  accessibilityRole="button"
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{cfg.label}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{cfg.description}</Text>
                  </View>
                  <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Practice filter modal */}
      <Modal visible={practiceModal} transparent animationType="fade" onRequestClose={() => setPracticeModal(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}
          onPress={() => setPracticeModal(false)}
        >
          <Pressable
            style={{ backgroundColor: colors.bgCard, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 20, paddingBottom: insets.bottom + 20, paddingHorizontal: 20, maxHeight: "80%" }}
            onPress={() => {}}
          >
            <Text style={{ fontSize: 20, fontWeight: "700", color: colors.text, marginBottom: 4 }}>Practică</Text>
            <Text style={{ fontSize: 13, color: colors.textMuted, marginBottom: 16 }}>Alege o categorie sau rezolvă totul</Text>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Adaptive — weak + unseen */}
              <Pressable
                style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: colors.primary + "18", borderWidth: 1, borderColor: colors.primary + "55", marginBottom: 8 }}
                onPress={() => { setPracticeModal(false); router.push("/quiz?mode=practice&adaptive=1"); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>Antrenament personalizat</Text>
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>20 întrebări · greșite des + nevăzute</Text>
                </View>
                <Text style={{ fontSize: 20, color: colors.primary }}>›</Text>
              </Pressable>

              {/* All questions */}
              <Pressable
                style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: colors.bg, marginBottom: 8 }}
                onPress={() => { setPracticeModal(false); router.push("/quiz?mode=practice"); }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>Toate întrebările</Text>
                  <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{total} întrebări</Text>
                </View>
                <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
              </Pressable>

              {/* License filter */}
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginTop: 12, marginBottom: 8, marginLeft: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Categorie permis</Text>
              {(Object.entries(LICENSE_LABELS) as [License, string][]).map(([key, label]) => (
                <Pressable
                  key={key}
                  style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: colors.bg, marginBottom: 8 }}
                  onPress={() => { setPracticeModal(false); router.push(`/quiz?mode=practice&license=${key}`); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{label}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{getQuestionCount({ license: key })} întrebări</Text>
                  </View>
                  <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
                </Pressable>
              ))}

              {/* Topic filter */}
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.textSecondary, marginTop: 12, marginBottom: 8, marginLeft: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Materie</Text>
              {(Object.entries(TOPIC_LABELS) as [Topic, string][]).map(([key, label]) => (
                <Pressable
                  key={key}
                  style={{ flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: colors.bg, marginBottom: 8 }}
                  onPress={() => { setPracticeModal(false); router.push(`/quiz?mode=practice&topic=${key}`); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontWeight: "600", color: colors.text }}>{label}</Text>
                    <Text style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>{getQuestionCount({ topic: key })} întrebări</Text>
                  </View>
                  <Text style={{ fontSize: 20, color: colors.textMuted }}>›</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
