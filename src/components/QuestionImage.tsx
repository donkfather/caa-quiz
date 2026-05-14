import { useState } from "react";
import { Image, View, ActivityIndicator, StyleSheet } from "react-native";
import { useTheme } from "../lib/ThemeContext";

function imageUrl(filename: string): string {
  const base = process.env.EXPO_PUBLIC_SUPABASE_URL;
  // Public bucket — no auth needed. <Image> can't set headers, so the public
  // endpoint is the only path that works with raw URL fetches.
  return `${base}/storage/v1/object/public/question-images/${encodeURIComponent(filename)}`;
}

export function QuestionImage({ filename }: { filename: string | null | undefined }) {
  const { theme: t } = useTheme();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!filename || failed) return null;
  return (
    <View style={[styles.wrap, { borderColor: t.border, backgroundColor: t.bgCard }]}>
      {!loaded && (
        <ActivityIndicator color={t.textMuted} style={StyleSheet.absoluteFillObject} />
      )}
      <Image
        source={{ uri: imageUrl(filename) }}
        style={styles.image}
        resizeMode="contain"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        accessibilityLabel="Imagine întrebare"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
    marginBottom: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  image: {
    width: "100%",
    height: "100%",
  },
});
