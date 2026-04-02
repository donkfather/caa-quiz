import { View, Text, Pressable, ScrollView } from "react-native";
import { useRouter, useLocalSearchParams, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/lib/ThemeContext";
import { getModule } from "../../src/lib/courseData";

export default function ModuleScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { moduleId } = useLocalSearchParams<{ moduleId: string }>();

  const mod = getModule(moduleId);
  if (!mod) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: theme.textMuted }}>Modul negasit</Text>
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
        <Text style={{ fontSize: 14, color: theme.textMuted, marginBottom: 20 }}>
          {mod.description}
        </Text>

        {mod.sections.map((section, idx) => {
          const quizCount = section.quiz?.length ?? 0;
          const hasContent = (section.content?.length ?? 0) > 0;

          return (
            <Pressable
              key={section.id}
              style={{
                backgroundColor: theme.bgCard,
                borderRadius: 12,
                padding: 14,
                marginBottom: 10,
                borderWidth: 1,
                borderColor: theme.border,
                opacity: hasContent ? 1 : 0.5,
              }}
              onPress={() => {
                if (hasContent) {
                  router.push(`/learn/section?moduleId=${moduleId}&sectionIdx=${idx}`);
                }
              }}
              disabled={!hasContent}
              accessibilityLabel={`Sectiunea ${idx + 1}: ${section.title}`}
              accessibilityRole="button"
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 14,
                    backgroundColor: theme.primary + "18",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 12,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "700", color: theme.primary }}>
                    {idx + 1}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.text }}>
                    {section.title}
                  </Text>
                  <View style={{ flexDirection: "row", marginTop: 4, gap: 12 }}>
                    {section.images && section.images.length > 0 && (
                      <Text style={{ fontSize: 11, color: theme.textMuted }}>
                        {section.images.length} imagini
                      </Text>
                    )}
                    {quizCount > 0 && (
                      <Text style={{ fontSize: 11, color: theme.primary }}>
                        {quizCount} intrebari
                      </Text>
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
