import Constants from "expo-constants";
import { supabase } from "./supabase";
import { getDeviceId } from "./vouchers";
import { getQuestionsVersion } from "./questionsRemote";

export type ReportTarget =
  | { kind: "main"; questionId: number }
  | { kind: "learn"; externalRef: string; questionText: string };

export type ReportResult =
  | { success: true }
  | { success: false; reason: "rate_limited" | "network" | "unknown"; message: string };

export async function reportQuestion(target: ReportTarget, message: string): Promise<ReportResult> {
  try {
    const deviceId = await getDeviceId();
    const appVersion = (Constants.expoConfig as any)?.version ?? null;
    const { data, error } = await supabase.rpc("submit_question_report", {
      p_kind: target.kind,
      p_device_id: deviceId,
      p_question_id: target.kind === "main" ? target.questionId : null,
      p_external_ref: target.kind === "learn" ? target.externalRef : null,
      p_question_text: target.kind === "learn" ? target.questionText : null,
      p_message: message?.trim() ? message.trim() : null,
      p_app_version: appVersion,
      p_questions_version: getQuestionsVersion() || null,
    });
    if (error) {
      if ((error.message ?? "").includes("rate_limited")) {
        return { success: false, reason: "rate_limited", message: "Ai trimis prea multe raportări. Așteaptă un minut." };
      }
      return { success: false, reason: "unknown", message: error.message ?? "Eroare necunoscută." };
    }
    if (typeof data === "number") return { success: true };
    return { success: false, reason: "unknown", message: "Răspuns neașteptat de la server." };
  } catch (e: any) {
    return { success: false, reason: "network", message: e?.message ?? "Eroare de conexiune." };
  }
}
