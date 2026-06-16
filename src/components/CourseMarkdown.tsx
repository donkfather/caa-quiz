import React from "react";
import { View, Text, Image, Pressable } from "react-native";
import { useTheme } from "../lib/ThemeContext";
import { cloudImageUrl, CloudGlossaryEntry } from "../lib/cloudCourse";
import { FONTS } from "../lib/fonts";

type Block =
  | { kind: "h3"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "img"; alt: string; src: string }
  | { kind: "table"; headers: string[]; rows: string[][] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = (text || "").split(/\r?\n/);
  const isImg = (l: string) => /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(l);
  const isBullet = (l: string) => /^[•·\-*]\s/.test(l);
  const isTableRow = (l: string) => /^\s*\|/.test(l);
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}/.test(l);

  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }

    const hm = ln.match(/^###\s+(.*)$/);
    if (hm) { blocks.push({ kind: "h3", text: hm[1] }); i++; continue; }

    if (isImg(ln)) {
      const m = ln.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/)!;
      blocks.push({ kind: "img", alt: m[1], src: m[2].trim() });
      i++; continue;
    }

    if (isBullet(ln)) {
      const items: string[] = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push(lines[i].replace(/^[•·\-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (isTableRow(ln) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const splitRow = (s: string) => s.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
      const headers = splitRow(ln);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    // paragraph: collect until blank or block-start
    const para: string[] = [ln]; i++;
    while (i < lines.length && lines[i].trim()
      && !/^###\s/.test(lines[i])
      && !isBullet(lines[i])
      && !isImg(lines[i])
      && !isTableRow(lines[i])) { para.push(lines[i]); i++; }
    blocks.push({ kind: "p", text: para.join(" ") });
  }
  return blocks;
}

interface Span { kind: "t" | "b" | "term"; text: string }

function parseInline(s: string): Span[] {
  const out: Span[] = [];
  // Pull **bold** spans first
  const boldRx = /\*\*([^*]+)\*\*/g;
  const pieces: { text: string; bold: boolean }[] = [];
  let last = 0; let m: RegExpExecArray | null;
  while ((m = boldRx.exec(s)) !== null) {
    if (m.index > last) pieces.push({ text: s.slice(last, m.index), bold: false });
    pieces.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) pieces.push({ text: s.slice(last), bold: false });
  // For each piece, pull :term: glossary refs
  const termRx = /:([^:\s][^:]{0,80}[^:\s]):/g;
  for (const p of pieces) {
    if (p.bold) { out.push({ kind: "b", text: p.text }); continue; }
    let l = 0;
    while ((m = termRx.exec(p.text)) !== null) {
      if (m.index > l) out.push({ kind: "t", text: p.text.slice(l, m.index) });
      out.push({ kind: "term", text: m[1] });
      l = m.index + m[0].length;
    }
    if (l < p.text.length) out.push({ kind: "t", text: p.text.slice(l) });
    termRx.lastIndex = 0;
  }
  return out;
}

interface Props {
  content: string;
  glossary?: CloudGlossaryEntry[];
  onTermPress?: (entry: CloudGlossaryEntry) => void;
  /** Base font scale (1.0 = default). All text sizes & line heights are
   *  multiplied by this. */
  scale?: number;
}

export function CourseMarkdown({ content, glossary, onTermPress, scale = 1 }: Props) {
  const { theme } = useTheme();
  const blocks = parseBlocks(content);
  const glossaryMap = new Map<string, CloudGlossaryEntry>();
  for (const g of glossary || []) glossaryMap.set(g.term.toLowerCase(), g);

  const renderInline = (spans: Span[], key: string, baseStyle: any) => (
    <Text key={key} style={baseStyle}>
      {spans.map((sp, i) => {
        if (sp.kind === "b") return <Text key={i} style={{ fontFamily: FONTS.bodyBold, color: theme.primary }}>{sp.text}</Text>;
        if (sp.kind === "term") {
          const entry = glossaryMap.get(sp.text.toLowerCase());
          if (entry) {
            return (
              <Text
                key={i}
                style={{
                  fontFamily: FONTS.uiBold,
                  color: theme.primary,
                  backgroundColor: theme.primary + "1A",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
                onPress={() => onTermPress?.(entry)}
              >{` ${sp.text} `}</Text>
            );
          }
          return <Text key={i}>{sp.text}</Text>;
        }
        return <Text key={i}>{sp.text}</Text>;
      })}
    </Text>
  );

  // Base sizes (multiplied by scale). Line heights are deliberately generous
  // so the dotted-underline term decoration doesn't clip into the next line.
  const fs = (n: number) => Math.round(n * scale);
  const lh = (n: number) => Math.round(n * scale);

  // Body content gets Lora (serif, easier long-form reading); headers stay
  // on Inter so the UI/content contrast feels deliberate.
  return (
    <View>
      {blocks.map((b, idx) => {
        if (b.kind === "h3") {
          return (
            <Text key={idx} style={{ fontFamily: FONTS.uiBold, fontSize: fs(18), lineHeight: lh(26), color: theme.text, marginTop: 16, marginBottom: 8 }}>
              {b.text}
            </Text>
          );
        }
        if (b.kind === "p") {
          return renderInline(parseInline(b.text), String(idx), {
            fontFamily: FONTS.bodyRegular, fontSize: fs(15), lineHeight: lh(26), color: theme.text, marginBottom: 14,
          });
        }
        if (b.kind === "ul") {
          return (
            <View key={idx} style={{ marginBottom: 14 }}>
              {b.items.map((it, i) => (
                <View key={i} style={{ flexDirection: "row", marginBottom: 6 }}>
                  <Text style={{ color: theme.primary, marginRight: 8, fontSize: fs(15), lineHeight: lh(26) }}>•</Text>
                  {renderInline(parseInline(it), `i${i}`, { flex: 1, fontFamily: FONTS.bodyRegular, fontSize: fs(15), lineHeight: lh(26), color: theme.text })}
                </View>
              ))}
            </View>
          );
        }
        if (b.kind === "img") {
          const url = cloudImageUrl(b.src);
          if (!url) return null;
          return (
            <View key={idx} style={{ marginVertical: 12 }}>
              <Image
                source={{ uri: url }}
                style={{ width: "100%", aspectRatio: 16 / 10, borderRadius: 8, backgroundColor: theme.bgCard }}
                resizeMode="contain"
                accessibilityLabel={b.alt || b.src}
              />
              {b.alt ? (
                <Text style={{ fontSize: 12, color: theme.textMuted, textAlign: "center", marginTop: 4 }}>
                  {b.alt}
                </Text>
              ) : null}
            </View>
          );
        }
        if (b.kind === "table") {
          const colCount = b.headers.length;
          return (
            <View key={idx} style={{ marginVertical: 12, borderWidth: 1, borderColor: theme.border, borderRadius: 6, overflow: "hidden" }}>
              <View style={{ flexDirection: "row", backgroundColor: theme.bgCard }}>
                {b.headers.map((h, i) => (
                  <Text key={i} style={{ flex: 1, padding: 6, fontWeight: "700", fontSize: fs(12), lineHeight: lh(18), color: theme.text, borderRightWidth: i < colCount - 1 ? 1 : 0, borderColor: theme.border }}>
                    {h}
                  </Text>
                ))}
              </View>
              {b.rows.map((row, r) => (
                <View key={r} style={{ flexDirection: "row", borderTopWidth: 1, borderColor: theme.border, backgroundColor: r % 2 ? theme.bgCard : "transparent" }}>
                  {row.map((c, i) => (
                    <Text key={i} style={{ flex: 1, padding: 6, fontSize: fs(12), lineHeight: lh(18), color: theme.text, borderRightWidth: i < colCount - 1 ? 1 : 0, borderColor: theme.border }}>
                      {c}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          );
        }
        return null;
      })}
    </View>
  );
}
