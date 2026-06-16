/**
 * Font family constants. Loaded by the root layout via `useFonts`.
 *
 * Pairing:
 *   ui   — Inter, used for headings, buttons, and chrome.
 *   body — Lora (serif), used for long-form course/learning content.
 */
export const FONTS = {
  uiRegular: "Inter_400Regular",
  uiMedium: "Inter_500Medium",
  uiSemibold: "Inter_600SemiBold",
  uiBold: "Inter_700Bold",
  uiExtraBold: "Inter_800ExtraBold",
  bodyRegular: "Lora_400Regular",
  bodyMedium: "Lora_500Medium",
  bodyBold: "Lora_700Bold",
  bodyItalic: "Lora_400Regular_Italic",
} as const;
