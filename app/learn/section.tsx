import { useState, useRef, useMemo } from "react";
import { View, Text, Pressable, ScrollView, FlatList, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/lib/ThemeContext";
import { getModule } from "../../src/lib/courseData";
import type { QuizQuestion } from "../../src/lib/courseData";
import { ReportButton } from "../../src/components/ReportButton";

// ─── Content parsing ────────────────────────────────────────────

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "definition"; term: string; english: string | null; text: string }
  | { type: "highlight"; text: string }
  | { type: "header"; text: string }
  | { type: "bullet"; text: string };

type Card =
  | { type: "content"; title: string; blocks: ContentBlock[] }
  | { type: "quiz"; questions: QuizQuestion[] };

function parseBlocks(raw: string): ContentBlock[] {
  if (!raw) return [];
  const blocks: ContentBlock[] = [];
  for (const para of raw.split("\n\n").filter(Boolean)) {
    const t = para.trim();
    if (!t) continue;
    if (t.startsWith("### ")) { blocks.push({ type: "header", text: t.slice(4).trim() }); continue; }
    if (t.startsWith("• ")) { blocks.push({ type: "bullet", text: t.slice(2).trim() }); continue; }
    const dm = t.match(/^\*\*(.+?)\*\*\s*(?:\((.+?)\))?\s*—\s*(.+)$/);
    if (dm) { blocks.push({ type: "definition", term: dm[1].trim(), english: dm[2]?.trim() || null, text: dm[3].trim() }); continue; }
    if (t.length < 120 && /\d{3,}/.test(t)) { blocks.push({ type: "highlight", text: t }); continue; }
    blocks.push({ type: "text", text: t });
  }
  return blocks;
}

/** Split content blocks into cards: each ### header starts a new card.
 *  If no headers, chunk every ~4 blocks into a card. Quiz cards inserted between content. */
function buildCards(content: string, quiz: QuizQuestion[]): Card[] {
  const allBlocks = parseBlocks(content);
  if (allBlocks.length === 0 && quiz.length === 0) return [];

  // Split by headers
  const groups: { title: string; blocks: ContentBlock[] }[] = [];
  let current: { title: string; blocks: ContentBlock[] } = { title: "", blocks: [] };

  for (const block of allBlocks) {
    if (block.type === "header") {
      if (current.blocks.length > 0) groups.push(current);
      current = { title: block.text, blocks: [] };
    } else {
      current.blocks.push(block);
    }
  }
  if (current.blocks.length > 0) groups.push(current);

  // Merge short cards (< 3 blocks) with the next card
  const merged: typeof groups = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const totalText = g.blocks.reduce((acc, b) => acc + ("text" in b ? b.text.length : 0), 0);
    if (totalText < 180 && g.blocks.length < 3 && i + 1 < groups.length) {
      // Merge into next card: add current blocks + a header block + next blocks
      const next = groups[i + 1];
      if (g.title) next.blocks.unshift({ type: "header", text: g.title } as ContentBlock);
      next.blocks.unshift(...g.blocks);
      // Don't push current, let next iteration handle the merged card
    } else {
      merged.push(g);
    }
  }
  groups.length = 0;
  groups.push(...merged);

  // If only 1 group with many blocks, split into chunks of ~5
  if (groups.length <= 1 && allBlocks.length > 6) {
    const blocks = groups[0]?.blocks ?? allBlocks.filter((b) => b.type !== "header");
    const chunked: typeof groups = [];
    for (let i = 0; i < blocks.length; i += 5) {
      chunked.push({ title: "", blocks: blocks.slice(i, i + 5) });
    }
    groups.length = 0;
    groups.push(...chunked);
  }

  // Build cards: all content first, quiz at the end
  const cards: Card[] = [];

  for (const group of groups) {
    cards.push({ type: "content", title: group.title, blocks: group.blocks });
  }

  // Quiz as the last card
  if (quiz.length > 0) {
    cards.push({ type: "quiz", questions: quiz });
  }

  return cards;
}

// ─── Rendering components ───────────────────────────────────────

function RichText({ text, style, theme }: { text: string; style: any; theme: any }) {
  const parts = text.split(/(\*\*.+?\*\*)/g);
  return (
    <Text style={style}>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**")
          ? <Text key={i} style={{ fontWeight: "700", color: theme.primary }}>{part.slice(2, -2)}</Text>
          : <Text key={i}>{part}</Text>
      )}
    </Text>
  );
}

function BlockView({ block, theme }: { block: ContentBlock; theme: any }) {
  switch (block.type) {
    case "header":
      return (
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 8 }}>
          <View style={{ width: 4, height: 18, borderRadius: 2, backgroundColor: theme.primary, marginRight: 10 }} />
          <Text style={{ fontSize: 17, fontWeight: "700", color: theme.text }}>{block.text}</Text>
        </View>
      );
    case "definition":
      return (
        <View style={{ marginBottom: 8, paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: theme.primary + "40" }}>
          <Text style={{ fontSize: 15, color: theme.text, lineHeight: 22 }}>
            <Text style={{ fontWeight: "700", color: theme.primary }}>{block.term}</Text>
            {block.english ? <Text style={{ color: theme.textMuted }}>{`  (${block.english})`}</Text> : null}
            {"  —  "}
            <Text>{block.text}</Text>
          </Text>
        </View>
      );
    case "bullet":
      return (
        <View style={{ flexDirection: "row", marginBottom: 4, paddingLeft: 4 }}>
          <Text style={{ color: theme.primary, marginRight: 8, fontSize: 15 }}>•</Text>
          <RichText text={block.text} style={{ fontSize: 14, lineHeight: 22, color: theme.text, flex: 1 }} theme={theme} />
        </View>
      );
    case "highlight":
      return (
        <View style={{ backgroundColor: theme.primary + "12", borderRadius: 10, padding: 12, marginBottom: 10 }}>
          <RichText text={block.text} style={{ fontSize: 14, color: theme.text, lineHeight: 22 }} theme={theme} />
        </View>
      );
    default:
      return <RichText text={block.text} style={{ fontSize: 15, lineHeight: 24, color: theme.text, marginBottom: 10 }} theme={theme} />;
  }
}

function InlineQuiz({ questions, theme, onDone, refPrefix }: { questions: QuizQuestion[]; theme: any; onDone: () => void; refPrefix: string }) {
  const [qIdx, setQIdx] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const done = qIdx >= questions.length;

  const retry = () => {
    setQIdx(0);
    setSelected(null);
    setScore(0);
  };

  if (done) {
    return (
      <View style={{ alignItems: "center", paddingVertical: 20 }}>
        <Ionicons name={score === questions.length ? "trophy" : "stats-chart"} size={40} color={score === questions.length ? theme.warning : theme.primary} style={{ marginBottom: 8 }} />
        <Text style={{ fontSize: 20, fontWeight: "700", color: theme.text }}>
          {score}/{questions.length} corecte
        </Text>
        <Text style={{ fontSize: 13, color: theme.textMuted, marginTop: 4, marginBottom: 16 }}>
          {score === questions.length ? "Excelent!" : "Revizuieste materialul si incearca din nou."}
        </Text>
        <View style={{ gap: 10, width: "100%" }}>
          <Pressable
            style={{ backgroundColor: theme.bgCard, borderRadius: 10, paddingVertical: 12, alignItems: "center", borderWidth: 1, borderColor: theme.border }}
            onPress={retry}
          >
            <Text style={{ color: theme.text, fontWeight: "600", fontSize: 14 }}>Reincearca</Text>
          </Pressable>
          <Pressable
            style={{ backgroundColor: theme.primary, borderRadius: 10, paddingVertical: 12, alignItems: "center" }}
            onPress={onDone}
          >
            <Text style={{ color: "#fff", fontWeight: "600", fontSize: 14 }}>Continua</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const q = questions[qIdx];
  const handleAnswer = (optIdx: number) => {
    if (selected !== null) {
      // Second tap: go to next question
      setSelected(null);
      setQIdx((i) => i + 1);
      return;
    }
    setSelected(optIdx);
    if (optIdx === q.correct) setScore((s) => s + 1);
  };

  return (
    <View>
      <Text style={{ fontSize: 11, color: theme.textMuted, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Verifica · {qIdx + 1}/{questions.length}
      </Text>
      <Text style={{ fontSize: 16, fontWeight: "600", color: theme.text, marginBottom: 14 }}>{q.question}</Text>
      <ReportButton target={{ kind: "learn", externalRef: `${refPrefix}/${qIdx}`, questionText: q.question }} />
      {q.options.map((opt, oIdx) => {
        let bg = theme.bgCard;
        let border = theme.border;
        if (selected !== null) {
          if (oIdx === q.correct) { bg = theme.correctBg; border = theme.correct; }
          else if (oIdx === selected && oIdx !== q.correct) { bg = theme.wrongBg; border = theme.wrong; }
        }
        return (
          <Pressable
            key={oIdx}
            style={{ backgroundColor: bg, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1.5, borderColor: border }}
            onPress={() => handleAnswer(oIdx)}
          >
            <Text style={{ fontSize: 14, color: theme.text }}>{opt}</Text>
          </Pressable>
        );
      })}
      {selected !== null && (
        <Text style={{ textAlign: "center", fontSize: 12, color: theme.textMuted, marginTop: 4 }}>
          Apasa oriunde pentru urmatoarea intrebare
        </Text>
      )}
    </View>
  );
}

// ─── Main screen ────────────────────────────────────────────────

export default function SectionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const { moduleId, sectionIdx } = useLocalSearchParams<{ moduleId: string; sectionIdx: string }>();
  const flatListRef = useRef<FlatList>(null);

  const mod = getModule(moduleId);
  const idx = parseInt(sectionIdx ?? "0", 10);
  const section = mod?.sections?.[idx];

  const [currentPage, setCurrentPage] = useState(0);

  const cards = useMemo(
    () => (section ? buildCards(section.content ?? "", section.quiz ?? []) : []),
    [section],
  );

  if (!mod || !section || cards.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.textMuted }}>Sectiune negasita</Text>
      </View>
    );
  }

  const hasNextSection = idx < mod.sections.length - 1;
  const isLastCard = currentPage >= cards.length - 1;
  const cardWidth = screenWidth;

  const goNext = () => {
    if (!isLastCard) {
      const next = currentPage + 1;
      flatListRef.current?.scrollToIndex({ index: next, animated: true });
      setCurrentPage(next);
    } else if (hasNextSection) {
      router.replace(`/learn/section?moduleId=${moduleId}&sectionIdx=${idx + 1}`);
    } else {
      router.back();
    }
  };

  const goBack = () => {
    if (currentPage > 0) {
      const prev = currentPage - 1;
      flatListRef.current?.scrollToIndex({ index: prev, animated: true });
      setCurrentPage(prev);
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: section.title }} />
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        {/* Progress dots */}
        <View style={{ flexDirection: "row", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 4 }}>
          {cards.map((_, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                backgroundColor: i === currentPage ? theme.primary : i < currentPage ? theme.success : theme.border,
              }}
            />
          ))}
        </View>

        {/* Page counter */}
        <Text style={{ textAlign: "center", fontSize: 11, color: theme.textMuted, marginBottom: 4 }}>
          {currentPage + 1} / {cards.length}
        </Text>

        {/* Swipeable cards */}
        <FlatList
          ref={flatListRef}
          data={cards}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(_, i) => String(i)}
          onMomentumScrollEnd={(e) => {
            const page = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
            setCurrentPage(page);
          }}
          getItemLayout={(_, i) => ({ length: cardWidth, offset: cardWidth * i, index: i })}
          renderItem={({ item: card }) => (
            <ScrollView
              style={{ width: cardWidth }}
              contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 100 }}
              showsVerticalScrollIndicator={false}
            >
              {card.type === "content" ? (
                <>
                  {card.title ? (
                    <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 14 }}>
                      <View style={{ width: 4, height: 22, borderRadius: 2, backgroundColor: theme.primary, marginRight: 10 }} />
                      <Text style={{ fontSize: 19, fontWeight: "700", color: theme.text }}>{card.title}</Text>
                    </View>
                  ) : null}
                  {card.blocks.map((block, bIdx) => (
                    <BlockView key={bIdx} block={block} theme={theme} />
                  ))}
                </>
              ) : (
                <InlineQuiz questions={card.questions} theme={theme} onDone={goNext} refPrefix={`${moduleId}/${idx}`} />
              )}
            </ScrollView>
          )}
        />

        {/* Bottom navigation */}
        <View
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
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
          {currentPage > 0 && (
            <Pressable
              style={{ flex: 1, backgroundColor: theme.bgCard, borderRadius: 12, padding: 14, alignItems: "center", borderWidth: 1, borderColor: theme.border }}
              onPress={goBack}
            >
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.text }}>Inapoi</Text>
            </Pressable>
          )}
          <Pressable
            style={{ flex: 2, backgroundColor: theme.primary, borderRadius: 12, padding: 14, alignItems: "center" }}
            onPress={goNext}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#fff" }}>
              {isLastCard
                ? hasNextSection
                  ? "Sectiunea urmatoare"
                  : "Modul complet!"
                : "Continua"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}
