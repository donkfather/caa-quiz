export interface Theme {
  bg: string;
  bgCard: string;
  bgCardHover: string;
  primary: string;
  primaryDark: string;
  success: string;
  error: string;
  warning: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  correct: string;
  correctBg: string;
  wrong: string;
  wrongBg: string;
}

export const darkTheme: Theme = {
  bg: "#0f172a",
  bgCard: "#1e293b",
  bgCardHover: "#334155",
  primary: "#60a5fa",
  primaryDark: "#3b82f6",
  success: "#4ade80",
  error: "#f87171",
  warning: "#fbbf24",
  text: "#ffffff",
  textSecondary: "#cbd5e1",
  textMuted: "#94a3b8",
  border: "#334155",
  correct: "#166534",
  correctBg: "#14532d",
  wrong: "#991b1b",
  wrongBg: "#7f1d1d",
};

export const lightTheme: Theme = {
  bg: "#eef1f5",
  bgCard: "#f8fafc",
  bgCardHover: "#eef1f5",
  primary: "#2563eb",
  primaryDark: "#1d4ed8",
  success: "#15803d",
  error: "#dc2626",
  warning: "#d97706",
  text: "#0f172a",
  textSecondary: "#334155",
  textMuted: "#64748b",
  border: "#e2e8f0",
  correct: "#166534",
  correctBg: "#dcfce7",
  wrong: "#991b1b",
  wrongBg: "#fee2e2",
};

// Default export for backward compat
export const colors = darkTheme;
