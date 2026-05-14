import { useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../lib/ThemeContext";
import { reportQuestion, ReportTarget } from "../lib/reports";

export function ReportButton({ target }: { target: ReportTarget }) {
  const { theme: t } = useTheme();
  const [visible, setVisible] = useState(false);
  const [lockedTarget, setLockedTarget] = useState<ReportTarget | null>(null);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const open = () => {
    // Freeze the target at open time so a re-render (parent navigation,
    // index advance) can't swap which question we're submitting against.
    setLockedTarget(target);
    setVisible(true);
  };

  const submit = async () => {
    if (!lockedTarget) return;
    setSubmitting(true);
    const res = await reportQuestion(lockedTarget, message);
    setSubmitting(false);
    if (res.success) {
      setVisible(false);
      setMessage("");
      Alert.alert("Mulțumim", "Raportarea a fost trimisă.");
    } else {
      Alert.alert("Eroare", res.message);
    }
  };

  return (
    <>
      <Pressable
        onPress={open}
        hitSlop={10}
        style={styles.flag}
        accessibilityLabel="Raportează problemă cu această întrebare"
        accessibilityRole="button"
      >
        <Text style={[styles.flagText, { color: t.textMuted }]}>⚐ raportează</Text>
      </Pressable>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", padding: 24 }}
          onPress={() => !submitting && setVisible(false)}
          accessibilityLabel="Închide formularul"
          accessibilityRole="button"
        >
          <Pressable
            style={{ backgroundColor: t.bgCard, borderRadius: 16, padding: 24 }}
            onPress={() => {}}
            accessibilityRole="none"
          >
            <Text style={{ fontSize: 18, fontWeight: "700", color: t.text, marginBottom: 4 }}>
              Raportează întrebare
            </Text>
            <Text style={{ fontSize: 13, color: t.textMuted, marginBottom: 16 }}>
              Spune-ne ce e greșit (opțional).
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: t.border,
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 12,
                fontSize: 15,
                color: t.text,
                backgroundColor: t.bg,
                marginBottom: 14,
                minHeight: 90,
                textAlignVertical: "top",
              }}
              placeholder="Ex: răspunsul corect e greșit, întrebarea e neclară…"
              placeholderTextColor={t.textMuted}
              value={message}
              onChangeText={setMessage}
              multiline
              autoFocus
              maxLength={500}
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Pressable
                style={{ flex: 1, padding: 14, borderRadius: 10, alignItems: "center", borderWidth: 1, borderColor: t.border }}
                onPress={() => { setVisible(false); setMessage(""); }}
                disabled={submitting}
                accessibilityLabel="Anulează"
                accessibilityRole="button"
              >
                <Text style={{ fontSize: 15, fontWeight: "600", color: t.textSecondary }}>Anulează</Text>
              </Pressable>
              <Pressable
                style={{ flex: 1, padding: 14, borderRadius: 10, alignItems: "center", backgroundColor: t.primary, opacity: submitting ? 0.6 : 1 }}
                onPress={submit}
                disabled={submitting}
                accessibilityLabel="Trimite raportare"
                accessibilityRole="button"
              >
                <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>
                  {submitting ? "..." : "Trimite"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flag: {
    alignSelf: "flex-end",
    paddingVertical: 6,
    paddingHorizontal: 6,
    marginBottom: 12,
  },
  flagText: {
    fontSize: 11,
    opacity: 0.55,
    letterSpacing: 0.3,
  },
});
