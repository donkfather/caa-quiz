import { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator } from "react-native";
import { useRouter, useLocalSearchParams, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/lib/ThemeContext";
import { getCloudModule, CloudModule } from "../../src/lib/cloudCourse";

export default function CourseModuleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { moduleId } = useLocalSearchParams<{ moduleId: string }>();
  const [mod, setMod] = useState<CloudModule | null | undefined>(undefined);

  useEffect(() => {
    getCloudModule(moduleId).then(setMod).catch(() => setMod(null));
  }, [moduleId]);

  if (mod === undefined) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }
  if (!mod) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.textMuted }}>Modul negăsit</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: mod.title }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.bg }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 20 }}
      >
        {mod.description ? (
          <Text style={{ fontSize: 14, color: theme.textMuted, marginBottom: 20 }}>
            {mod.description}
          </Text>
        ) : null}

        {(mod.sections || []).map((sec, idx) => {
          const quizCount = sec.quiz?.length ?? 0;
          const hasContent = (sec.content?.length ?? 0) > 0;
          return (
            <Pressable
              key={sec.id || idx}
              style={{
                backgroundColor: theme.bgCard,
                borderRadius: 12, padding: 14, marginBottom: 10,
                borderWidth: 1, borderColor: theme.border,
                opacity: hasContent ? 1 : 0.5,
              }}
              onPress={() => hasContent && router.push(`/courses/section?moduleId=${moduleId}&sectionIdx=${idx}`)}
              disabled={!hasContent}
              accessibilityRole="button"
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{
                  width: 28, height: 28, borderRadius: 14,
                  backgroundColor: theme.primary + "18",
                  alignItems: "center", justifyContent: "center", marginRight: 12,
                }}>
                  <Text style={{ fontSize: 12, fontWeight: "700", color: theme.primary }}>{idx + 1}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.text }}>{sec.title}</Text>
                  <View style={{ flexDirection: "row", marginTop: 4, gap: 12 }}>
                    {!!sec.images?.length && (
                      <Text style={{ fontSize: 11, color: theme.textMuted }}>{sec.images.length} imagini</Text>
                    )}
                    {quizCount > 0 && (
                      <Text style={{ fontSize: 11, color: theme.primary }}>{quizCount} întrebări</Text>
                    )}
                  </View>
                </View>
                <Text style={{ fontSize: 18, color: theme.textMuted }}>›</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </>
  );
}
