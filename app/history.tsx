import { View, Text, FlatList, Pressable, StyleSheet, Alert } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useState, useCallback } from "react";
import { useTheme } from "../src/lib/ThemeContext";
import {
  getHistory,
  clearHistory,
  getActiveSessions,
  deleteActiveSession,
  SessionRecord,
  ActiveSession,
} from "../src/lib/storage";
import { useFocusEffect, useRouter } from "expo-router";
import { showInterstitial } from "../src/lib/ads";

const MODE_LABELS: Record<string, string> = {
  exam: "Examen",
  practice: "Practică",
  learn: "Învață",
};

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate().toString().padStart(2, "0");
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${day}.${month}.${d.getFullYear()}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `acum ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `acum ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `acum ${days}z`;
}

/**
 * Circular progress ring using the classic RN "two half-circles" technique.
 * Works without react-native-svg.
 */
function ProgressRing({
  progress,
  size,
  strokeWidth,
  color,
  trackColor,
  centerBg,
}: {
  progress: number;
  size: number;
  strokeWidth: number;
  color: string;
  trackColor: string;
  centerBg: string;
}) {
  const half = size / 2;
  const innerSize = size - strokeWidth * 2;
  const clamped = Math.min(Math.max(progress, 0), 100);
  const angle = (clamped / 100) * 360;

  // Right half rotates from 0 to 180
  const rightRotation = Math.min(angle, 180);
  // Left half rotates from 0 to 180 (only when angle > 180)
  const leftRotation = Math.max(angle - 180, 0);

  return (
    <View style={{ width: size, height: size }}>
      {/* Track (full circle border) */}
      <View style={{
        position: "absolute",
        width: size,
        height: size,
        borderRadius: half,
        borderWidth: strokeWidth,
        borderColor: trackColor,
      }} />

      {/* Right half clip */}
      <View style={{
        position: "absolute",
        top: 0,
        left: half,
        width: half,
        height: size,
        overflow: "hidden",
      }}>
        <View style={{
          width: size,
          height: size,
          borderRadius: half,
          borderWidth: strokeWidth,
          borderColor: color,
          borderLeftColor: "transparent",
          borderBottomColor: "transparent",
          position: "absolute",
          right: 0,
          top: 0,
          transform: [{ rotate: `${rightRotation}deg` }],
        }} />
      </View>

      {/* Left half clip — only visible past 180 degrees */}
      {angle > 180 && (
        <View style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: half,
          height: size,
          overflow: "hidden",
        }}>
          <View style={{
            width: size,
            height: size,
            borderRadius: half,
            borderWidth: strokeWidth,
            borderColor: color,
            borderRightColor: "transparent",
            borderTopColor: "transparent",
            position: "absolute",
            left: 0,
            top: 0,
            transform: [{ rotate: `${leftRotation}deg` }],
          }} />
        </View>
      )}

      {/* Center label */}
      <View style={{
        position: "absolute",
        top: strokeWidth,
        left: strokeWidth,
        width: innerSize,
        height: innerSize,
        borderRadius: innerSize / 2,
        backgroundColor: centerBg,
        alignItems: "center",
        justifyContent: "center",
      }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color }}>{clamped}%</Text>
      </View>
    </View>
  );
}

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { theme: colors } = useTheme();
  const styles = makeStyles(colors);
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [history, setHistory] = useState<SessionRecord[]>([]);

  useFocusEffect(
    useCallback(() => {
      getActiveSessions().then(setSessions);
      getHistory().then(setHistory);
    }, []),
  );

  const handleDeleteSession = (id: string) => {
    Alert.alert("Șterge sesiunea", "Progresul va fi pierdut.", [
      { text: "Anulează", style: "cancel" },
      {
        text: "Șterge",
        style: "destructive",
        onPress: async () => {
          await deleteActiveSession(id);
          setSessions((prev) => prev.filter((s) => s.id !== id));
        },
      },
    ]);
  };

  const handleResume = async (session: ActiveSession) => {
    await showInterstitial();
    router.push(`/quiz?mode=${session.mode}&sessionId=${session.id}`);
  };

  const handleClearHistory = () => {
    Alert.alert("Șterge istoricul", "Toate rezultatele vor fi șterse.", [
      { text: "Anulează", style: "cancel" },
      {
        text: "Șterge",
        style: "destructive",
        onPress: async () => {
          await clearHistory();
          setHistory([]);
        },
      },
    ]);
  };

  // Group history by date
  const groupedHistory = history.reduce<Record<string, SessionRecord[]>>((acc, item) => {
    const dateKey = formatDateShort(item.date);
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(item);
    return acc;
  }, {});
  const dateGroups = Object.entries(groupedHistory);

  const renderActiveSession = (item: ActiveSession) => {
    const answered = item.answers.filter((a) => a !== null).length;
    const progress = Math.round((answered / item.answers.length) * 100);
    return (
      <Pressable key={item.id} style={[styles.activeCard, { overflow: "hidden" }]} onPress={() => handleResume(item)}>
        <Pressable
          onPress={() => handleDeleteSession(item.id)}
          hitSlop={12}
          style={{ position: "absolute", top: 10, right: 10, zIndex: 2 }}
        >
          <Feather name="trash-2" size={20} color={colors.error} style={{ opacity: 0.35 }} />
        </Pressable>
        <View style={{ alignSelf: "flex-start", marginRight: 20 }}>
          <Text style={styles.activeMeta}>
            {MODE_LABELS[item.mode] || item.mode} · {timeAgo(item.updatedAt)}
          </Text>
          <Text style={styles.activeDetail}>
            {answered} / {item.answers.length} răspunse · {progress}%
          </Text>
        </View>
        <Text style={{ fontSize: 11, color: colors.textMuted, opacity: 0.4, marginTop: 6, alignSelf: "flex-start" }}>
          Apasă pentru a continua
        </Text>
        {/* Progress bar at bottom */}
        <View style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: `${progress}%`,
          height: 4,
          backgroundColor: colors.primary,
        }} />
      </Pressable>
    );
  };

  const renderHistoryItem = (item: SessionRecord) => {
    const passed = item.score >= 70;
    return (
      <View key={item.id} style={styles.historyRow}>
        <Text style={[styles.historyScore, passed ? styles.scorePass : styles.scoreFail]}>
          {item.score}%
        </Text>
        <View style={styles.historyInfo}>
          <Text style={styles.historyMode}>
            {MODE_LABELS[item.mode] || item.mode}
          </Text>
          <Text style={styles.historyMeta}>
            {item.correct}/{item.total} corecte
          </Text>
        </View>
        <View style={[styles.passBadge, passed ? styles.passBadgePass : styles.passBadgeFail]}>
          <Text style={[styles.passBadgeText, passed ? styles.passBadgeTextPass : styles.passBadgeTextFail]}>
            {passed ? "ADMIS" : "RESPINS"}
          </Text>
        </View>
      </View>
    );
  };

  const hasContent = sessions.length > 0 || history.length > 0;

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      {!hasContent ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Niciun test efectuat</Text>
          <Text style={styles.emptySubtext}>Rezultatele vor apărea aici</Text>
        </View>
      ) : (
        <FlatList
          data={[]}
          renderItem={() => null}
          ListHeaderComponent={
            <>
              {sessions.length > 0 && (
                <View style={{ marginBottom: 28 }}>
                  <Text style={styles.sectionLabel}>Sesiuni active</Text>
                  <View style={{ gap: 14 }}>
                    {sessions.map((s) => renderActiveSession(s))}
                  </View>
                </View>
              )}
              {dateGroups.length > 0 && (
                <View>
                  <Text style={styles.sectionLabel}>Rezultate</Text>
                  {dateGroups.map(([date, items], gi) => (
                    <View key={date} style={gi > 0 ? { marginTop: 20 } : undefined}>
                      {dateGroups.length > 1 && (
                        <Text style={styles.dateGroupLabel}>{date}</Text>
                      )}
                      <View style={styles.historyList}>
                        {items.map((h, i) => (
                          <View key={h.id}>
                            {renderHistoryItem(h)}
                            {i < items.length - 1 && <View style={styles.separator} />}
                          </View>
                        ))}
                      </View>
                    </View>
                  ))}
                  <Pressable style={styles.clearButton} onPress={handleClearHistory}>
                    <Text style={styles.clearText}>Șterge istoricul</Text>
                  </Pressable>
                </View>
              )}
            </>
          }
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

function makeStyles(colors: any) { return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  list: {
    padding: 20,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 12,
  },
  // Active sessions — no border, lighter bg
  activeCard: {
    backgroundColor: colors.bgCard,
    borderRadius: 14,
    padding: 16,
    alignItems: "center",
  },
  activeTop: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    marginBottom: 14,
  },
  activeMeta: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 4,
  },
  activeDetail: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  resumeButton: {
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 24,
    alignItems: "center",
    alignSelf: "stretch",
    marginBottom: 10,
  },
  resumeText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
  deleteText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.error,
  },
  // History results
  dateGroupLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.textMuted,
    marginBottom: 8,
  },
  historyList: {
    backgroundColor: colors.bgCard,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    gap: 14,
  },
  separator: {
    height: 1,
    backgroundColor: colors.border,
    opacity: 0.5,
  },
  historyScore: {
    fontSize: 22,
    fontWeight: "800",
    width: 56,
  },
  scorePass: {
    color: colors.success,
  },
  scoreFail: {
    color: colors.error,
  },
  historyInfo: {
    flex: 1,
  },
  historyMode: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.text,
    marginBottom: 2,
  },
  historyMeta: {
    fontSize: 12,
    color: colors.textMuted,
  },
  passBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  passBadgePass: {
    backgroundColor: colors.correctBg,
  },
  passBadgeFail: {
    backgroundColor: colors.wrongBg,
  },
  passBadgeText: {
    fontSize: 10,
    fontWeight: "800",
  },
  passBadgeTextPass: {
    color: colors.success,
  },
  passBadgeTextFail: {
    color: colors.error,
  },
  // Empty & clear
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.textSecondary,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 6,
  },
  clearButton: {
    marginTop: 20,
    paddingVertical: 14,
    alignItems: "center",
  },
  clearText: {
    fontSize: 13,
    color: colors.error,
    fontWeight: "600",
  },
}); }
