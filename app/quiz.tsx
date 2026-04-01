import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";

function useTimer() {
  const startTime = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startTime.current), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.floor(elapsed / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return { elapsed, display: `${m}:${s.toString().padStart(2, "0")}` };
}
import { useTheme } from "../src/lib/ThemeContext";
import Svg, { Circle, Line, Polygon, Text as SvgText, G } from "react-native-svg";
import {
  getQuizQuestions,
  getAllQuestions,
  allQuestions,
  Question,
  EXAM_QUESTION_COUNT,
} from "../src/lib/questions";
import {
  saveQuizResult,
  saveActiveSession,
  deleteActiveSession,
  ActiveSession,
} from "../src/lib/storage";
import {
  recordQuizForStreak,
  addSeenQuestions,
  checkAndUnlockBadges,
  BADGE_DEFS,
} from "../src/lib/gamification";
import { AdBanner } from "../src/components/AdBanner";
import { showInterstitial } from "../src/lib/ads";

type Mode = "exam" | "practice" | "learn";

export default function QuizScreen() {
  const { mode, sessionId } = useLocalSearchParams<{ mode: Mode; sessionId?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme: colors } = useTheme();
  const styles = makeStyles(colors);

  const timer = useTimer();

  // Build or restore session
  const sessionRef = useRef<ActiveSession | null>(null);

  const questions = useMemo(() => {
    // If resuming, we'll set questions from the session in useEffect
    if (mode === "exam") return getQuizQuestions(EXAM_QUESTION_COUNT);
    return getAllQuestions();
  }, [mode]);

  const [questionList, setQuestionList] = useState<Question[]>(questions);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [finished, setFinished] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [newBadges, setNewBadges] = useState<string[]>([]);

  // Initialize session
  useEffect(() => {
    if (initialized) return;

    let ql = questions;
    let startIndex = 0;
    let startAnswers: (number | null)[] = new Array(ql.length).fill(null);
    let sid = sessionId || `${Date.now()}`;

    // Check if resuming
    if (sessionId) {
      const AsyncStorage = require("@react-native-async-storage/async-storage").default;
      AsyncStorage.getItem("quiz_sessions").then((raw: string | null) => {
        if (raw) {
          const sessions: ActiveSession[] = JSON.parse(raw);
          const existing = sessions.find((s) => s.id === sessionId);
          if (existing) {
            const restored = existing.questionIds.map((id) => allQuestions[id]).filter(Boolean);
            if (restored.length > 0) {
              setQuestionList(restored);
              setIndex(existing.currentIndex);
              setAnswers(existing.answers);
              sessionRef.current = existing;
              setInitialized(true);
              return;
            }
          }
        }
        // Fallback: start fresh
        createNewSession(ql, sid);
      });
    } else {
      createNewSession(ql, sid);
    }

    function createNewSession(ql: Question[], sid: string) {
      const questionIds = ql.map((q) => allQuestions.findIndex((aq) => aq.id === q.id));
      const session: ActiveSession = {
        id: sid,
        mode: mode || "exam",
        questionIds,
        answers: new Array(ql.length).fill(null),
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessionRef.current = session;
      setAnswers(session.answers);
      // Don't persist until first answer — empty sessions won't clutter history
      setInitialized(true);
    }
  }, []);

  const q = questionList[index];
  const total = questionList.length;
  const isLearn = mode === "learn";

  // Derived stats
  const correct = answers.filter((a, i) => a !== null && a === questionList[i]?.correct).length;
  const wrong = answers.filter((a, i) => a !== null && a !== questionList[i]?.correct).length;
  const remaining = total - correct - wrong;

  const handleSelect = useCallback(
    (optionIndex: number) => {
      if (selected !== null) return;
      setSelected(optionIndex);
      setAnswers((prev) => {
        const next = [...prev];
        next[index] = optionIndex;
        // Persist
        if (sessionRef.current) {
          sessionRef.current.answers = next;
          sessionRef.current.currentIndex = index;
          saveActiveSession(sessionRef.current);
        }
        return next;
      });
      if (isLearn) setShowAnswer(true);
    },
    [selected, index, isLearn],
  );

  const handleNext = useCallback(async () => {
    if (index + 1 >= total) {
      // Calculate final stats from answers
      const finalAnswers = sessionRef.current?.answers || answers;
      const finalCorrect = finalAnswers.filter(
        (a, i) => a !== null && a === questionList[i]?.correct,
      ).length;
      const finalTotal = finalAnswers.filter((a) => a !== null).length;
      if (finalTotal > 0) saveQuizResult(mode || "exam", finalCorrect, finalTotal);
      if (sessionRef.current) deleteActiveSession(sessionRef.current.id);
      // Gamification
      const seenIds = questionList.map((q) => q.id);
      await recordQuizForStreak();
      await addSeenQuestions(seenIds);
      const badges = await checkAndUnlockBadges();
      setNewBadges(badges);
      setFinished(true);
      return;
    }
    const nextIndex = index + 1;
    setIndex(nextIndex);
    setSelected(null);
    setShowAnswer(false);
    if (sessionRef.current) {
      sessionRef.current.currentIndex = nextIndex;
      saveActiveSession(sessionRef.current);
    }
  }, [index, total, mode, answers, questionList]);

  const handleFinish = useCallback(async () => {
    await showInterstitial();
    router.back();
  }, [router]);

  const getOptionStyle = (optionIndex: number) => {
    if (selected === null) return styles.option;
    if (optionIndex === q.correct) return [styles.option, styles.optionCorrect];
    if (optionIndex === selected && selected !== q.correct)
      return [styles.option, styles.optionWrong];
    return [styles.option, selected !== null && styles.optionDisabled];
  };

  const modeLabel =
    mode === "exam" ? "Examen" : mode === "learn" ? "Învață" : "Practică";

  if (!initialized || !q) {
    return (
      <View style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={styles.progressText}>Se încarcă...</Text>
      </View>
    );
  }

  if (finished) {
    const score = correct + wrong > 0 ? Math.round((correct / (correct + wrong)) * 100) : 0;
    const passed = score >= 70;
    const elapsedStr = timer.display;
    return (
      <>
        <Stack.Screen options={{ title: "Rezultat", headerBackVisible: false }} />
        <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
          <View style={styles.resultCard}>
            <Text style={styles.resultEmoji}>{passed ? "🎉" : "📚"}</Text>
            <Text style={styles.resultTitle}>
              {passed ? "Felicitări!" : "Mai exersează!"}
            </Text>
            <Text style={styles.resultScore}>{score}%</Text>
            <Text style={styles.resultDetail}>
              {correct} corecte, {wrong} greșite din {correct + wrong}
            </Text>
            <Text style={styles.resultTime}>Timp: {elapsedStr}</Text>
            <View style={[styles.badge, passed ? styles.badgePass : styles.badgeFail]}>
              <Text style={[styles.badgeText, passed ? styles.badgeTextPass : styles.badgeTextFail]}>
                {passed ? "ADMIS" : "RESPINS"}
              </Text>
            </View>
          </View>
          {newBadges.length > 0 && (
            <View style={{ backgroundColor: colors.bgCard, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: colors.warning + "40" }}>
              <Text style={{ fontSize: 14, fontWeight: "700", color: colors.warning, textAlign: "center", marginBottom: 8 }}>
                Realizări noi deblocate!
              </Text>
              {newBadges.map((key) => {
                const def = BADGE_DEFS.find((b) => b.key === key);
                return def ? (
                  <Text key={key} style={{ fontSize: 13, color: colors.text, textAlign: "center" }}>
                    🏅 {def.name} — {def.description}
                  </Text>
                ) : null;
              })}
            </View>
          )}
          <Pressable style={[styles.button, styles.primaryButton]} onPress={handleFinish}>
            <Text style={styles.buttonText}>Înapoi</Text>
          </Pressable>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: modeLabel, headerBackTitle: "Acasă" }} />
      <View style={[styles.container, { paddingBottom: insets.bottom + 16 }]}>
        {/* Progress bar */}
        <View style={styles.progressBar}>
          <View style={[styles.progressFillCorrect, { width: `${(correct / total) * 100}%` }]} />
          <View style={[styles.progressFillWrong, { width: `${(wrong / total) * 100}%` }]} />
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <Text style={styles.statCorrect}>{correct} ✓</Text>
          <Text style={styles.statWrong}>{wrong} ✗</Text>
          <Text style={styles.progressText}>{timer.display}</Text>
          <Text style={styles.progressText}>{index + 1} / {total}</Text>
        </View>

        {/* Question + options — pushed to bottom */}
        <ScrollView style={styles.scrollArea} contentContainerStyle={[styles.scrollContent, { justifyContent: "flex-end", flexGrow: 1 }]}>
          {/* Compass rose watermark */}
          <View style={{ position: "absolute", top: -40, right: -60, opacity: 0.04 }} pointerEvents="none">
            <Svg width={320} height={320} viewBox="0 0 200 200">
              {/* Outer rings */}
              <Circle cx="100" cy="100" r="95" stroke={colors.text} strokeWidth="1.5" fill="none" />
              <Circle cx="100" cy="100" r="88" stroke={colors.text} strokeWidth="0.5" fill="none" />
              <Circle cx="100" cy="100" r="40" stroke={colors.text} strokeWidth="1" fill="none" />
              <Circle cx="100" cy="100" r="8" stroke={colors.text} strokeWidth="1.5" fill="none" />
              {/* Tick marks around outer ring */}
              {Array.from({ length: 36 }).map((_, i) => {
                const angle = (i * 10 * Math.PI) / 180;
                const r1 = i % 9 === 0 ? 78 : i % 3 === 0 ? 83 : 86;
                const r2 = 88;
                return (
                  <Line key={`tick-${i}`}
                    x1={100 + r1 * Math.sin(angle)} y1={100 - r1 * Math.cos(angle)}
                    x2={100 + r2 * Math.sin(angle)} y2={100 - r2 * Math.cos(angle)}
                    stroke={colors.text} strokeWidth={i % 9 === 0 ? 2 : i % 3 === 0 ? 1.2 : 0.6} />
                );
              })}
              {/* Cardinal star points (N, E, S, W) */}
              <Polygon points="100,5 106,85 100,70 94,85" fill={colors.text} />
              <Polygon points="100,195 106,115 100,130 94,115" fill={colors.text} opacity="0.5" />
              <Polygon points="5,100 85,94 70,100 85,106" fill={colors.text} opacity="0.5" />
              <Polygon points="195,100 115,94 130,100 115,106" fill={colors.text} opacity="0.5" />
              {/* Intercardinal points (NE, SE, SW, NW) */}
              <Polygon points="167,33 112,88 120,100 88,88" fill={colors.text} opacity="0.3" />
              <Polygon points="167,167 112,112 100,120 88,112" fill={colors.text} opacity="0.3" />
              <Polygon points="33,167 88,112 80,100 112,112" fill={colors.text} opacity="0.3" />
              <Polygon points="33,33 88,88 100,80 112,88" fill={colors.text} opacity="0.3" />
              {/* Cardinal letters */}
              <SvgText x="100" y="22" textAnchor="middle" fontSize="14" fontWeight="bold" fill={colors.text}>N</SvgText>
              <SvgText x="100" y="192" textAnchor="middle" fontSize="11" fill={colors.text} opacity="0.6">S</SvgText>
              <SvgText x="188" y="104" textAnchor="middle" fontSize="11" fill={colors.text} opacity="0.6">E</SvgText>
              <SvgText x="13" y="104" textAnchor="middle" fontSize="11" fill={colors.text} opacity="0.6">V</SvgText>
            </Svg>
          </View>

          <Text style={styles.question}>{q.question}</Text>

          <View style={styles.options}>
            {q.options.map((opt, i) => {
              const isCorrectAnswer = selected !== null && i === q.correct;
              const isWrongAnswer = selected !== null && i === selected && selected !== q.correct;
              return (
                <Pressable
                  key={i}
                  style={getOptionStyle(i)}
                  onPress={() => handleSelect(i)}
                  disabled={selected !== null}
                >
                  <Text style={styles.optionLabel}>
                    {String.fromCharCode(65 + i)}
                  </Text>
                  <Text style={styles.optionText}>{opt}</Text>
                  {isCorrectAnswer && (
                    <View style={styles.answerBadgeCorrect}>
                      <Text style={styles.answerBadgeCorrectText}>CORECT</Text>
                    </View>
                  )}
                  {isWrongAnswer && (
                    <View style={styles.answerBadgeWrong}>
                      <Text style={styles.answerBadgeWrongText}>GREȘIT</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>

          <Pressable
            style={[styles.button, styles.nextButton, selected === null && { opacity: 0 }]}
            onPress={handleNext}
            disabled={selected === null}
          >
            <Text style={styles.buttonText}>
              {index + 1 >= total ? "Vezi rezultatul" : "Următoarea →"}
            </Text>
          </Pressable>
        </ScrollView>
        <AdBanner />
      </View>
    </>
  );
}

function makeStyles(colors: any) { return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 20,
  },
  progressBar: {
    height: 8,
    backgroundColor: colors.bgCard,
    borderRadius: 4,
    marginTop: 12,
    marginBottom: 8,
    flexDirection: "row",
    overflow: "hidden",
  },
  progressFillCorrect: {
    height: 8,
    backgroundColor: colors.success,
  },
  progressFillWrong: {
    height: 8,
    backgroundColor: colors.error,
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  statCorrect: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.success,
  },
  statWrong: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.error,
  },
  progressText: {
    fontSize: 13,
    color: colors.textMuted,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  question: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.text,
    lineHeight: 26,
    marginBottom: 20,
  },
  options: {
    gap: 10,
  },
  option: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.bgCard,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1.5,
    borderColor: colors.border,
    gap: 12,
  },
  optionCorrect: {
    backgroundColor: colors.correctBg,
    borderColor: colors.success,
  },
  optionWrong: {
    backgroundColor: colors.wrongBg,
    borderColor: colors.error,
  },
  optionDisabled: {
    opacity: 0.5,
  },
  optionLabel: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.primary,
    width: 20,
    marginTop: 1,
  },
  optionText: {
    fontSize: 15,
    color: colors.text,
    lineHeight: 22,
    flex: 1,
  },
  button: {
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 16,
  },
  primaryButton: {
    backgroundColor: colors.primary,
  },
  nextButton: {
    backgroundColor: colors.primary,
    marginTop: 20,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
  },
  resultCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 20,
    padding: 32,
    alignItems: "center",
    marginTop: 40,
    marginBottom: 24,
  },
  resultEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  resultTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: colors.text,
    marginBottom: 8,
  },
  resultScore: {
    fontSize: 56,
    fontWeight: "800",
    color: colors.primary,
    marginBottom: 4,
  },
  resultDetail: {
    fontSize: 15,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  resultTime: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: 16,
  },
  badge: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
  },
  badgePass: {
    backgroundColor: colors.correctBg,
  },
  badgeFail: {
    backgroundColor: colors.wrongBg,
  },
  badgeText: {
    fontSize: 14,
    fontWeight: "700",
  },
  badgeTextPass: {
    color: colors.success,
  },
  badgeTextFail: {
    color: colors.error,
  },
  // Answer badges
  answerBadgeCorrect: {
    backgroundColor: colors.correctBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    alignSelf: "center",
  },
  answerBadgeCorrectText: {
    fontSize: 10,
    fontWeight: "800",
    color: colors.success,
  },
  answerBadgeWrong: {
    backgroundColor: colors.wrongBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    alignSelf: "center",
  },
  answerBadgeWrongText: {
    fontSize: 10,
    fontWeight: "800",
    color: colors.error,
  },
}); }
