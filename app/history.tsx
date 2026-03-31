import { View, Text, FlatList, Pressable, StyleSheet, Alert } from "react-native";
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

const MODE_LABELS: Record<string, string> = {
  exam: "Examen",
  practice: "Practică",
  learn: "Învață",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const day = d.getDate().toString().padStart(2, "0");
  const month = (d.getMonth() + 1).toString().padStart(2, "0");
  const hours = d.getHours().toString().padStart(2, "0");
  const mins = d.getMinutes().toString().padStart(2, "0");
  return `${day}.${month}.${d.getFullYear()} ${hours}:${mins}`;
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

  const handleResume = (session: ActiveSession) => {
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

  const renderActiveSession = ({ item }: { item: ActiveSession }) => {
    const answered = item.answers.filter((a) => a !== null).length;
    const progress = Math.round((answered / item.answers.length) * 100);
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.activeBadge}>
            <Text style={styles.activeBadgeText}>În curs</Text>
          </View>
          <Text style={styles.dateText}>{timeAgo(item.updatedAt)}</Text>
        </View>
        <Text style={styles.modeLabel}>{MODE_LABELS[item.mode] || item.mode}</Text>
        <View style={styles.activeProgressBar}>
          <View style={[styles.activeProgressFill, { width: `${progress}%` }]} />
        </View>
        <Text style={styles.activeProgressText}>
          {answered} / {item.answers.length} răspunse ({progress}%)
        </Text>
        <View style={styles.activeActions}>
          <Pressable
            style={styles.resumeButton}
            onPress={() => handleResume(item)}
          >
            <Text style={styles.resumeText}>Continuă</Text>
          </Pressable>
          <Pressable
            style={styles.deleteButton}
            onPress={() => handleDeleteSession(item.id)}
          >
            <Text style={styles.deleteText}>Șterge</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  const renderHistoryItem = ({ item }: { item: SessionRecord }) => {
    const passed = item.score >= 70;
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.modeLabel}>{MODE_LABELS[item.mode] || item.mode}</Text>
          <Text style={styles.dateText}>{formatDate(item.date)}</Text>
        </View>
        <View style={styles.cardBody}>
          <Text style={[styles.score, passed ? styles.scorePass : styles.scoreFail]}>
            {item.score}%
          </Text>
          <Text style={styles.detail}>
            {item.correct}/{item.total} corecte
          </Text>
          <View style={[styles.badge, passed ? styles.badgePass : styles.badgeFail]}>
            <Text style={[styles.badgeText, passed ? styles.badgeTextPass : styles.badgeTextFail]}>
              {passed ? "ADMIS" : "RESPINS"}
            </Text>
          </View>
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
                <>
                  <Text style={styles.sectionTitle}>Sesiuni active</Text>
                  {sessions.map((s) => (
                    <View key={s.id} style={{ marginBottom: 10 }}>
                      {renderActiveSession({ item: s })}
                    </View>
                  ))}
                </>
              )}
              {history.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>Rezultate</Text>
                  {history.map((h) => (
                    <View key={h.id} style={{ marginBottom: 10 }}>
                      {renderHistoryItem({ item: h })}
                    </View>
                  ))}
                  <Pressable style={styles.clearButton} onPress={handleClearHistory}>
                    <Text style={styles.clearText}>Șterge istoricul</Text>
                  </Pressable>
                </>
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
    padding: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.textSecondary,
    marginBottom: 10,
    marginTop: 6,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  modeLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.primary,
  },
  dateText: {
    fontSize: 12,
    color: colors.textMuted,
  },
  cardBody: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  score: {
    fontSize: 28,
    fontWeight: "800",
  },
  scorePass: {
    color: colors.success,
  },
  scoreFail: {
    color: colors.error,
  },
  detail: {
    fontSize: 14,
    color: colors.textSecondary,
    flex: 1,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgePass: {
    backgroundColor: colors.correctBg,
  },
  badgeFail: {
    backgroundColor: colors.wrongBg,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  badgeTextPass: {
    color: colors.success,
  },
  badgeTextFail: {
    color: colors.error,
  },
  // Active sessions
  activeBadge: {
    backgroundColor: colors.warning + "20",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  activeBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.warning,
  },
  activeProgressBar: {
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    marginTop: 8,
    marginBottom: 6,
  },
  activeProgressFill: {
    height: 4,
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  activeProgressText: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: 10,
  },
  activeActions: {
    flexDirection: "row",
    gap: 10,
  },
  resumeButton: {
    flex: 1,
    backgroundColor: colors.primary,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: "center",
  },
  resumeText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  },
  deleteButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  deleteText: {
    fontSize: 14,
    fontWeight: "600",
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
    marginTop: 16,
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  clearText: {
    fontSize: 14,
    color: colors.error,
    fontWeight: "600",
  },
}); }
