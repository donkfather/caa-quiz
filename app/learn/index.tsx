import { View, Text, Pressable, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../src/lib/ThemeContext";
import courseIndex from "../../src/data/course/index.json";

export default function LearnScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: insets.bottom + 20 }}
    >
      <Text style={{ fontSize: 14, color: theme.textMuted, marginBottom: 20 }}>
        {courseIndex.totalModules} module · {courseIndex.totalSections} sectiuni · {courseIndex.totalQuestions} intrebari
      </Text>

      {courseIndex.modules.map((mod, idx) => (
        <Pressable
          key={mod.id}
          style={{
            backgroundColor: theme.bgCard,
            borderRadius: 14,
            padding: 16,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: theme.border,
          }}
          onPress={() => router.push(`/learn/${mod.id}`)}
          accessibilityLabel={`Modul ${idx + 1}: ${mod.title}`}
          accessibilityRole="button"
        >
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                backgroundColor: theme.primary + "20",
                alignItems: "center",
                justifyContent: "center",
                marginRight: 12,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "800", color: theme.primary }}>
                {idx + 1}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: "700", color: theme.text }}>
                {mod.title}
              </Text>
            </View>
          </View>
          <Text style={{ fontSize: 13, color: theme.textMuted, marginLeft: 44 }}>
            {mod.description}
          </Text>
          <Text style={{ fontSize: 11, color: theme.textMuted, marginTop: 8, marginLeft: 44 }}>
            {mod.sectionCount} sectiuni · {mod.questionCount} intrebari
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
