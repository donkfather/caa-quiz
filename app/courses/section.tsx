import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, Modal, Image, FlatList, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTheme } from "../../src/lib/ThemeContext";
import { getCloudModule, CloudModule, CloudGlossaryEntry, cloudImageUrl } from "../../src/lib/cloudCourse";
import { CourseMarkdown } from "../../src/components/CourseMarkdown";

const FONT_SCALES = [0.9, 1.0, 1.15, 1.3] as const;
const FONT_STORAGE_KEY = "courseFontScale.v1";

interface ContentCard { kind: "content"; title: string | null; body: string }
interface QuizCard { kind: "quiz"; q: { question: string; options: string[]; correct: number } }
type Card = ContentCard | QuizCard;

function splitIntoCards(content: string): ContentCard[] {
  const lines = (content || "").split(/\r?\n/);
  const cards: ContentCard[] = [];
  let cur: { title: string | null; body: string[] } = { title: null, body: [] };
  for (const ln of lines) {
    const m = ln.match(/^###\s+(.*)$/);
    if (m) {
      if (cur.title || cur.body.length) cards.push({ kind: "content", title: cur.title, body: cur.body.join("\n").trim() });
      cur = { title: m[1].trim(), body: [] };
    } else cur.body.push(ln);
  }
  if (cur.title || cur.body.length) cards.push({ kind: "content", title: cur.title, body: cur.body.join("\n").trim() });
  return cards;
}

export default function CourseSectionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const { moduleId, sectionIdx: sectionIdxStr } = useLocalSearchParams<{ moduleId: string; sectionIdx: string }>();
  const sectionIdx = parseInt(sectionIdxStr || "0", 10);
  const listRef = useRef<FlatList>(null);

  const [mod, setMod] = useState<CloudModule | null | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<Record<number, number>>({}); // cardIdx -> pickedOptionIdx
  const [termPopover, setTermPopover] = useState<CloudGlossaryEntry | null>(null);
  const [scaleIdx, setScaleIdx] = useState(1); // index into FONT_SCALES

  useEffect(() => {
    getCloudModule(moduleId).then(setMod).catch(() => setMod(null));
  }, [moduleId]);

  useEffect(() => {
    AsyncStorage.getItem(FONT_STORAGE_KEY).then(v => {
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isNaN(n) && n >= 0 && n < FONT_SCALES.length) setScaleIdx(n);
    });
  }, []);

  const bumpScale = () => {
    const next = (scaleIdx + 1) % FONT_SCALES.length;
    setScaleIdx(next);
    AsyncStorage.setItem(FONT_STORAGE_KEY, String(next)).catch(() => {});
  };
  const scale = FONT_SCALES[scaleIdx];

  const cards = useMemo((): Card[] => {
    if (!mod) return [];
    const sec = mod.sections?.[sectionIdx];
    if (!sec) return [];
    const content = splitIntoCards(sec.content || "");
    const quiz: QuizCard[] = (sec.quiz || []).map(q => ({ kind: "quiz", q }));
    return [...content, ...quiz];
  }, [mod, sectionIdx]);

  if (mod === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }
  if (!mod || !mod.sections?.[sectionIdx]) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.textMuted }}>Secțiune negăsită</Text>
      </View>
    );
  }

  const sec = mod.sections[sectionIdx];
  const hasNextSection = sectionIdx < (mod.sections?.length || 0) - 1;
  const isLastCard = page >= cards.length - 1;
  const cardWidth = screenWidth;

  const goNext = () => {
    if (!isLastCard) {
      const next = page + 1;
      listRef.current?.scrollToIndex({ index: next, animated: true });
      setPage(next);
    } else if (hasNextSection) {
      router.replace(`/courses/section?moduleId=${moduleId}&sectionIdx=${sectionIdx + 1}`);
    } else {
      router.back();
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: sec.title,
          headerRight: () => (
            <Pressable
              onPress={bumpScale}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={`Mărimea textului — pasul ${scaleIdx + 1} din ${FONT_SCALES.length}`}
              style={({ pressed }) => ({
                opacity: pressed ? 0.55 : 1,
                paddingHorizontal: 4,
              })}
            >
              <Text style={{ color: theme.primary, fontWeight: "700", letterSpacing: 0.5 }}>
                <Text style={{ fontSize: 13 }}>A</Text>
                <Text style={{ fontSize: 19 }}>A</Text>
              </Text>
            </Pressable>
          ),
        }}
      />
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        {/* Progress dots */}
        <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 4 }}>
          {cards.map((_, i) => (
            <View
              key={i}
              style={{
                flex: 1, height: 3, borderRadius: 2,
                backgroundColor: i === page ? theme.primary : i < page ? (theme as any).success || theme.primary : theme.border,
              }}
            />
          ))}
        </View>

        <Text style={{ textAlign: "center", fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>
          {page + 1} / {cards.length}
        </Text>

        {/* Swipeable cards */}
        <FlatList
          ref={listRef}
          data={cards}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(_, i) => String(i)}
          onMomentumScrollEnd={(e) => {
            const idx = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
            setPage(idx);
          }}
          getItemLayout={(_, i) => ({ length: cardWidth, offset: cardWidth * i, index: i })}
          renderItem={({ item: card, index: ci }) => (
            <ScrollView
              style={{ width: cardWidth }}
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 120 }}
              showsVerticalScrollIndicator={false}
            >
              {card.kind === "content" ? (
                <View>
                  {card.title ? (
                    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 14 }}>
                      <View style={{ width: 4, height: 22, borderRadius: 2, backgroundColor: theme.primary, marginRight: 10 }} />
                      <Text style={{ fontSize: 19, fontWeight: "700", color: theme.text }}>{card.title}</Text>
                    </View>
                  ) : null}
                  <CourseMarkdown
                    content={card.body}
                    glossary={sec.glossary}
                    onTermPress={(e) => setTermPopover(e)}
                    scale={scale}
                  />
                </View>
              ) : (
                <QuizCardView
                  q={card.q}
                  picked={picked[ci] ?? null}
                  onPick={(i: number) => {
                    setPicked((prev) => prev[ci] != null ? prev : { ...prev, [ci]: i });
                  }}
                  theme={theme}
                />
              )}
            </ScrollView>
          )}
        />

        {/* Bottom navigation — matches /learn */}
        <View
          style={{
            position: "absolute",
            bottom: 0, left: 0, right: 0,
            paddingHorizontal: 20,
            paddingBottom: insets.bottom + 12,
            paddingTop: 12,
            backgroundColor: theme.bg,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            flexDirection: "row",
            gap: 12,
          }}
        >
          {page > 0 && (
            <Pressable
              style={{ flex: 1, backgroundColor: theme.bgCard, borderRadius: 12, padding: 14, alignItems: "center", borderWidth: 1, borderColor: theme.border }}
              onPress={() => {
                const prev = page - 1;
                listRef.current?.scrollToIndex({ index: prev, animated: true });
                setPage(prev);
              }}
              accessibilityRole="button"
            >
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text }}>Înapoi</Text>
            </Pressable>
          )}
          <Pressable
            style={{ flex: 2, backgroundColor: theme.primary, borderRadius: 12, padding: 14, alignItems: "center" }}
            onPress={goNext}
            accessibilityRole="button"
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#fff" }}>
              {isLastCard
                ? hasNextSection
                  ? "Secțiunea următoare"
                  : "Modul complet!"
                : "Continuă"}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Term popover */}
      <Modal visible={!!termPopover} transparent animationType="fade" onRequestClose={() => setTermPopover(null)}>
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}
          onPress={() => setTermPopover(null)}
        >
          <Pressable
            style={{ backgroundColor: theme.bgCard, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 20, paddingBottom: insets.bottom + 20, paddingHorizontal: 20 }}
            onPress={() => {}}
          >
            <Text style={{ fontSize: 18, fontWeight: "700", color: theme.text, marginBottom: 10 }}>
              {termPopover?.term}
            </Text>
            {termPopover?.image ? (() => {
              const url = cloudImageUrl(termPopover.image!);
              return url ? (
                <Image source={{ uri: url }} style={{ width: "100%", aspectRatio: 16 / 10, borderRadius: 8, marginBottom: 10, backgroundColor: theme.bg }} resizeMode="contain" />
              ) : null;
            })() : null}
            {termPopover?.definition ? (
              <Text style={{ fontSize: 14, color: theme.text, lineHeight: 21 }}>
                {termPopover.definition}
              </Text>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function QuizCardView({ q, picked, onPick, theme }: any) {
  return (
    <View>
      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.primary, letterSpacing: 1, marginBottom: 8 }}>
        QUIZ
      </Text>
      <Text style={{ fontSize: 17, fontWeight: "600", color: theme.text, marginBottom: 16 }}>
        {q.question}
      </Text>
      {q.options.map((opt: string, i: number) => {
        const isPicked = picked === i;
        const isCorrect = picked !== null && i === q.correct;
        const isWrong = picked !== null && isPicked && i !== q.correct;
        const bg = isCorrect ? "#16a34a22" : isWrong ? "#dc262622" : (isPicked ? theme.primary + "18" : theme.bgCard);
        const border = isCorrect ? "#16a34a" : isWrong ? "#dc2626" : (isPicked ? theme.primary : theme.border);
        return (
          <Pressable
            key={i}
            style={{ padding: 14, borderRadius: 10, borderWidth: 1, borderColor: border, backgroundColor: bg, marginBottom: 8 }}
            onPress={() => onPick(i)}
            accessibilityRole="button"
          >
            <Text style={{ color: theme.text, fontSize: 15 }}>{opt}</Text>
          </Pressable>
        );
      })}
      {picked !== null && (
        <Text style={{ marginTop: 8, fontSize: 13, color: picked === q.correct ? "#16a34a" : "#dc2626" }}>
          {picked === q.correct ? "Corect!" : "Răspunsul corect este marcat."}
        </Text>
      )}
    </View>
  );
}
