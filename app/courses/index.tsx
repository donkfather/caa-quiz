import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { useRouter, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/lib/ThemeContext";
import { ensureCloudCourses, listCloudModules, CloudModuleSummary } from "../../src/lib/cloudCourse";

export default function CoursesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const [mods, setMods] = useState<CloudModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    try {
      if (force) await ensureCloudCourses({ force: true });
      const m = await listCloudModules();
      setMods(m);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Nu am putut încărca cursurile.");
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  if (mods === null && !error) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Cursuri" }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 20 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />}
      >
        {error && (
          <View style={{ padding: 12, marginBottom: 12, backgroundColor: theme.bgCard, borderRadius: 8, borderWidth: 1, borderColor: theme.border }}>
            <Text style={{ color: theme.textMuted, fontSize: 13 }}>{error}</Text>
            <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>Trage în jos pentru reîncărcare.</Text>
          </View>
        )}
        {mods && mods.length === 0 && !error && (
          <Text style={{ color: theme.textMuted, fontSize: 14, textAlign: "center", marginTop: 40 }}>
            Niciun curs publicat încă.
          </Text>
        )}
        {mods && mods.length > 0 && (
          <Text style={{ fontSize: 13, color: theme.textMuted, marginBottom: 16 }}>
            {mods.length} module · conținut sincronizat din cloud
          </Text>
        )}
        {mods?.map((m, idx) => (
          <Pressable
            key={m.id}
            style={{
              backgroundColor: theme.bgCard,
              borderRadius: 14, padding: 16, marginBottom: 12,
              borderWidth: 1, borderColor: theme.border,
            }}
            onPress={() => router.push(`/courses/${m.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`Modul: ${m.title}`}
          >
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
              <View style={{
                width: 32, height: 32, borderRadius: 8,
                backgroundColor: theme.primary + "20",
                alignItems: "center", justifyContent: "center", marginRight: 12,
              }}>
                <Text style={{ fontSize: 14, fontWeight: "800", color: theme.primary }}>{idx + 1}</Text>
              </View>
              <Text style={{ fontSize: 16, fontWeight: "700", color: theme.text, flex: 1 }}>
                {m.title}
              </Text>
            </View>
            {m.description ? (
              <Text style={{ fontSize: 13, color: theme.textMuted, marginLeft: 44 }}>
                {m.description}
              </Text>
            ) : null}
            <Text style={{ fontSize: 11, color: theme.textMuted, marginTop: 8, marginLeft: 44 }}>
              {m.sectionCount} secțiuni{m.quizCount ? ` · ${m.quizCount} întrebări` : ""}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </>
  );
}
