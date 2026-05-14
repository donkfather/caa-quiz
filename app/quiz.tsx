import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";

function useTimer(opts?: { limitSec?: number; onExpire?: () => void; paused?: boolean }) {
  const startTime = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const expiredRef = useRef(false);
  const onExpireRef = useRef(opts?.onExpire);
  onExpireRef.current = opts?.onExpire;
  useEffect(() => {
    if (opts?.paused) return;
    const id = setInterval(() => {
      const e = Date.now() - startTime.current;
      setElapsed(e);
      if (opts?.limitSec && !expiredRef.current && e >= opts.limitSec * 1000) {
        expiredRef.current = true;
        onExpireRef.current?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [opts?.paused, opts?.limitSec]);

  const limitMs = opts?.limitSec ? opts.limitSec * 1000 : null;
  const remainingMs = limitMs !== null ? Math.max(0, limitMs - elapsed) : null;
  const shownMs = remainingMs !== null ? remainingMs : elapsed;
  const secs = Math.floor(shownMs / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return {
    elapsed,
    display: `${m}:${s.toString().padStart(2, "0")}`,
    remainingMs,
    isCountdown: remainingMs !== null,
  };
}
import { useTheme } from "../src/lib/ThemeContext";
import Svg, { Circle, Line, Polygon, Text as SvgText, G } from "react-native-svg";
import {
  getExamQuestions,
  getAllQuestions,
  getPracticeQuestions,
  genShuffleOrder,
  applyOptionOrder,
  allQuestions,
  Question,
  Topic,
  License,
  ExamType,
  EXAM_CONFIGS,
} from "../src/lib/questions";
import {
  saveQuizResult,
  saveActiveSession,
  deleteActiveSession,
  getRecentExamQuestionIds,
  pushRecentExamQuestionIds,
  ActiveSession,
} from "../src/lib/storage";
import {
  recordQuizForStreak,
  addSeenQuestions,
  checkAndUnlockBadges,
  BADGE_DEFS,
} from "../src/lib/gamification";
import { AdBanner } from "../src/components/AdBanner";
import { ReportButton } from "../src/components/ReportButton";
import { QuestionImage } from "../src/components/QuestionImage";
import { recordAnswer, pickAdaptive } from "../src/lib/questionStats";
import { showInterstitial } from "../src/lib/ads";

type Mode = "exam" | "practice" | "learn";

export default function QuizScreen() {
  const { mode, sessionId, topic, license, examType, adaptive } = useLocalSearchParams<{ mode: Mode; sessionId?: string; topic?: Topic; license?: License; examType?: ExamType; adaptive?: string }>();
  const isAdaptive = adaptive === "1";
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme: colors } = useTheme();
  const styles = makeStyles(colors);

  const examCfg = mode === "exam" && examType ? EXAM_CONFIGS[examType] : null;

  // Build or restore session
  const sessionRef = useRef<ActiveSession | null>(null);

  // Non-exam modes can be built synchronously; exam mode is built lazily
  // inside the init effect so it can read the recent-questions buffer
  // (anti-overlap memory) from AsyncStorage first.
  const questions = useMemo<Question[]>(() => {
    if (mode === "exam") return [];
    if (isAdaptive) return []; // built async in init effect
    const filters: { topic?: Topic; license?: License } = {};
    if (topic) filters.topic = topic;
    if (license) filters.license = license;
    const filterArg = Object.keys(filters).length > 0 ? filters : undefined;
    // Practice shuffles the question ORDER here; the per-question option
    // permutation is generated later in the init effect so it can be saved
    // alongside the session and reapplied on resume. Learn-mode keeps the
    // DB-id order so the lesson narrative reads naturally.
    return mode === "practice"
      ? getPracticeQuestions(filterArg)
      : getAllQuestions(filterArg);
  }, [mode, topic, license, examType, isAdaptive]);

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

    let sid = sessionId || `${Date.now()}`;

    // Check if resuming
    if (sessionId) {
      const AsyncStorage = require("@react-native-async-storage/async-storage").default;
      AsyncStorage.getItem("quiz_sessions").then((raw: string | null) => {
        if (raw) {
          const sessions: ActiveSession[] = JSON.parse(raw);
          const existing = sessions.find((s) => s.id === sessionId);
          if (existing) {
            const restoredRaw = existing.questionIds.map((id) => allQuestions[id]).filter(Boolean);
            if (restoredRaw.length > 0) {
              // Re-apply the saved option permutations so the user's stored
              // answers still line up with the choices they originally saw.
              // Legacy sessions (no optionOrders) get identity permutations.
              const orders = existing.optionOrders;
              const restored = restoredRaw.map((q, i) =>
                orders && orders[i] ? applyOptionOrder(q, orders[i]) : q,
              );
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
        startFreshSession(sid);
      });
    } else {
      startFreshSession(sid);
    }

    async function startFreshSession(sid: string) {
      let baseQl: Question[]; // questions in their canonical option order
      if (mode === "exam") {
        const t: ExamType = examType || "cat-c";
        const recent = await getRecentExamQuestionIds();
        baseQl = getExamQuestions(t, recent);
        await pushRecentExamQuestionIds(baseQl.map((q) => q.id));
      } else if (isAdaptive) {
        baseQl = await pickAdaptive(getAllQuestions(), 20);
      } else {
        baseQl = questions;
      }

      // For practice + adaptive, generate a per-question option permutation
      // and save it on the session so resume reapplies the same order. Exam
      // and learn keep their canonical option order.
      const shouldShuffleOptions = mode === "practice" || isAdaptive;
      const optionOrders = shouldShuffleOptions
        ? baseQl.map((q) => genShuffleOrder(q.options.length))
        : undefined;
      const ql = optionOrders
        ? baseQl.map((q, i) => applyOptionOrder(q, optionOrders[i]))
        : baseQl;

      setQuestionList(ql);
      setAnswers(new Array(ql.length).fill(null));

      const questionIds = ql.map((q) => allQuestions.findIndex((aq) => aq.id === q.id));
      const session: ActiveSession = {
        id: sid,
        mode: mode || "exam",
        questionIds,
        optionOrders,
        answers: new Array(ql.length).fill(null),
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        topic: topic || undefined,
        license: license || undefined,
        examType: examType || undefined,
      };
      sessionRef.current = session;
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
      const currentQ = questionList[index];
      if (currentQ) recordAnswer(currentQ.id, optionIndex === currentQ.correct);
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
    [selected, index, isLearn, questionList],
  );

  const finalizeRef = useRef<(() => Promise<void>) | null>(null);
  const finalize = useCallback(async () => {
    const finalAnswers = sessionRef.current?.answers || answers;
    const finalCorrect = finalAnswers.filter(
      (a, i) => a !== null && a === questionList[i]?.correct,
    ).length;
    const finalAnswered = finalAnswers.filter((a) => a !== null).length;
    // For exams, "total" is the full exam length, not just answered
    const reportTotal = examCfg ? examCfg.total : finalAnswered;
    const passed = examCfg ? finalCorrect >= examCfg.passThreshold : finalCorrect / Math.max(finalAnswered, 1) >= 0.7;
    if (finalAnswered > 0 || examCfg) {
      saveQuizResult(mode || "exam", finalCorrect, reportTotal, {
        topic: topic || undefined,
        license: license || undefined,
        examType: examType || undefined,
        passed,
      });
    }
    if (sessionRef.current) deleteActiveSession(sessionRef.current.id);
    const seenIds = questionList.map((q) => q.id);
    await recordQuizForStreak();
    await addSeenQuestions(seenIds);
    const badges = await checkAndUnlockBadges();
    setNewBadges(badges);
    setFinished(true);
  }, [answers, questionList, mode, topic, license, examType, examCfg]);
  finalizeRef.current = finalize;

  const handleNext = useCallback(async () => {
    if (index + 1 >= total) {
      await finalize();
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
  }, [index, total, finalize]);

  const timer = useTimer({
    limitSec: examCfg?.durationSec,
    paused: finished,
    onExpire: () => { finalizeRef.current?.(); },
  });

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

  const modeLabel = examCfg
    ? examCfg.shortLabel
    : mode === "exam"
    ? "Examen"
    : mode === "learn"
    ? "Învață"
    : "Practică";

  if (!initialized || !q) {
    return (
      <View style={[styles.container, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={styles.progressText}>Se încarcă...</Text>
      </View>
    );
  }

  if (finished) {
    const denominator = examCfg ? examCfg.total : Math.max(correct + wrong, 1);
    const score = Math.round((correct / denominator) * 100);
    const passed = examCfg ? correct >= examCfg.passThreshold : score >= 70;
    const elapsedSec = Math.floor(timer.elapsed / 1000);
    const em = Math.floor(elapsedSec / 60);
    const es = elapsedSec % 60;
    const elapsedStr = `${em}:${es.toString().padStart(2, "0")}`;
    return (
      <>
        <Stack.Screen options={{ title: "Rezultat", headerBackVisible: false }} />
        <View style={[styles.container, { paddingTop: insets.top + 20 }]}>
          <View style={styles.resultCard}>
            <Text style={styles.resultEmoji}>{passed ? "🎉" : "📚"}</Text>
            <Text style={styles.resultTitle}>
              {passed ? "Felicitări!" : "Mai exersează!"}
            </Text>
            <Text style={styles.resultScore}>
              {examCfg ? `${correct}/${examCfg.total}` : `${score}%`}
            </Text>
            <Text style={styles.resultDetail}>
              {examCfg
                ? `${correct} corecte din ${examCfg.total} · minim ${examCfg.passThreshold}`
                : `${correct} corecte, ${wrong} greșite din ${correct + wrong}`}
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
          <Pressable style={[styles.button, styles.primaryButton]} onPress={handleFinish} accessibilityLabel="Înapoi la ecranul principal" accessibilityRole="button">
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
          <Text
            style={[
              styles.progressText,
              timer.isCountdown && timer.remainingMs !== null && timer.remainingMs < 60_000 && { color: colors.error, fontWeight: "700" },
            ]}
          >
            {timer.isCountdown ? "⏱ " : ""}{timer.display}
          </Text>
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
          {q.image_path ? <QuestionImage filename={q.image_path} /> : null}
          <ReportButton target={{ kind: "main", questionId: q.id }} />

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
                  accessibilityLabel={`Răspuns ${String.fromCharCode(65 + i)}: ${opt}`}
                  accessibilityRole="button"
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
            accessibilityLabel={index + 1 >= total ? "Vezi rezultatul" : "Următoarea întrebare"}
            accessibilityRole="button"
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
