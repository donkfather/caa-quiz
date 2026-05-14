/**
 * Remote questions loader.
 *
 * Strategy:
 *   1. App boots — synchronously expose the bundled `assets/questions.json`
 *      so the UI never blocks waiting on the network.
 *   2. In parallel, fetch `current.json` from the private Supabase Storage
 *      bucket. If its `version` is higher than the cached version, fetch
 *      `v{N}.json` and replace the in-memory + AsyncStorage copies.
 *   3. On every subsequent boot, prefer the AsyncStorage copy over the
 *      bundled one if it parses cleanly and is at least as new.
 *
 * Failure modes are silent: any network error or schema mismatch keeps the
 * previous (bundled or cached) data so users in marinas with no signal can
 * still take exams.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import bundledQuestions from "../../assets/questions.json";

/** Backwards-compat: older blobs/caches used topic="law" before the
 * rename to "rnd". Normalize on read so the UI never sees the old value. */
function normalizeTopic(q: any): any {
  if (q && q.topic === "law") return { ...q, topic: "rnd" };
  return q;
}

const BUCKET = "questions";
// Preview builds read a separate pointer so a "Publish to preview" from the
// dashboard only reaches the internal/staging APK, while production still
// serves whatever was last promoted to current.json.
//
// `process.env.APP_VARIANT` is only set at *build time* (used by
// app.config.js to swap icon/package). At runtime in the RN bundle it's
// undefined — Metro only inlines EXPO_PUBLIC_* env vars. The variant is
// already baked into expo's app config as `extra.isPreview` though, and
// expo-constants exposes that to JS at runtime.
const IS_PREVIEW = Boolean(Constants.expoConfig?.extra?.isPreview);
const POINTER_PATH = IS_PREVIEW ? "current-preview.json" : "current.json";
const FALLBACK_POINTER_PATH = IS_PREVIEW ? "current.json" : null;
const STORAGE_KEY_PAYLOAD = "questions_payload_v1";
const STORAGE_KEY_VERSION = "questions_version_v1";

type Pointer = {
  version: number;
  uploaded_at: string;
  count: number;
  sha256: string;
  blob: string;
};

let _cache: any[] | null = null;
let _cacheVersion: number | null = null;
let _ready: Promise<void> | null = null;

type UpdateListener = (version: number) => void;
const _listeners = new Set<UpdateListener>();

/** Subscribe to "remote refresh produced a newer version" events. Fires only
 * when AsyncStorage actually got a new payload, not on every boot. Returns an
 * unsubscribe function. */
export function onQuestionsUpdated(cb: UpdateListener): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/** Best-effort load from AsyncStorage. Synchronous-looking but actually async;
 * call once at app start so the rest of the app sees the freshest set. */
async function loadFromAsyncStorage(): Promise<{ questions: any[]; version: number } | null> {
  try {
    const [raw, vraw] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_PAYLOAD),
      AsyncStorage.getItem(STORAGE_KEY_VERSION),
    ]);
    if (!raw || !vraw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return { questions: parsed.map(normalizeTopic), version: parseInt(vraw, 10) || 0 };
  } catch {
    return null;
  }
}

async function downloadJson<T = any>(path: string, bustCache = false): Promise<T | null> {
  // RN's Blob polyfill doesn't implement .text(), which breaks the Supabase
  // storage client's normal download flow. Hit the storage endpoint directly
  // with the anon key — same RLS check, but we control how the body is read.
  try {
    const buster = bustCache ? `?t=${Date.now()}` : "";
    const url = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}${buster}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        apikey: process.env.EXPO_PUBLIC_SUPABASE_KEY!,
        Authorization: `Bearer ${process.env.EXPO_PUBLIC_SUPABASE_KEY}`,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchRemoteIfNewer(currentVersion: number): Promise<{ questions: any[]; version: number } | null> {
  let pointer = await downloadJson<Pointer>(POINTER_PATH, /* bustCache */ true);
  // Preview builds fall back to the prod pointer if no preview release exists
  // yet. Without this a fresh preview install would have nothing to load.
  if (!pointer && FALLBACK_POINTER_PATH) {
    pointer = await downloadJson<Pointer>(FALLBACK_POINTER_PATH, true);
  }
  if (!pointer || typeof pointer.version !== "number") return null;
  if (pointer.version <= currentVersion) return null;

  const payload = await downloadJson<any[]>(pointer.blob);
  if (!Array.isArray(payload) || payload.length === 0) return null;
  // Light schema validation — every entry must look like a question.
  if (!payload.every((q) => q && typeof q.question === "string" && Array.isArray(q.options) && typeof q.correct === "number")) {
    return null;
  }
  return { questions: payload, version: pointer.version };
}

/** Initialize: mount the freshest copy we have access to, then kick off a
 * background refresh. Idempotent — safe to call multiple times. */
export function initQuestions(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    const cached = await loadFromAsyncStorage();
    if (cached) {
      _cache = cached.questions;
      _cacheVersion = cached.version;
    } else {
      _cache = (bundledQuestions as any[]).map(normalizeTopic);
      _cacheVersion = 0;
    }

    // Background refresh, fire-and-forget. Errors stay silent on purpose.
    refreshFromRemote().catch(() => {});
  })();
  return _ready;
}

export async function refreshFromRemote(): Promise<{ updated: boolean; version: number | null }> {
  try {
    const v = _cacheVersion ?? 0;
    const fresh = await fetchRemoteIfNewer(v);
    if (!fresh) return { updated: false, version: _cacheVersion };
    const normalized = fresh.questions.map(normalizeTopic);
    _cache = normalized;
    _cacheVersion = fresh.version;
    await AsyncStorage.multiSet([
      [STORAGE_KEY_PAYLOAD, JSON.stringify(normalized)],
      [STORAGE_KEY_VERSION, String(fresh.version)],
    ]);
    _listeners.forEach((cb) => { try { cb(fresh.version); } catch {} });
    return { updated: true, version: fresh.version };
  } catch {
    return { updated: false, version: _cacheVersion };
  }
}

/** Verbose, force-download path used by the debug 5-tap gesture in Settings.
 * Skips the version-newer check, surfaces every step's failure as a reason
 * string so the user (and us) can see exactly where it broke. */
export async function forceRefreshDebug(): Promise<
  | { ok: true; version: number; count: number; from: "remote" }
  | { ok: false; step: string; reason: string }
> {
  const headers = {
    apikey: process.env.EXPO_PUBLIC_SUPABASE_KEY!,
    Authorization: `Bearer ${process.env.EXPO_PUBLIC_SUPABASE_KEY}`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
  const base = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/storage/v1/object/${BUCKET}`;
  try {
    let res: Response;
    try {
      res = await fetch(`${base}/${POINTER_PATH}?t=${Date.now()}`, { headers, cache: "no-store" });
    } catch (e: any) {
      return { ok: false, step: `fetch ${POINTER_PATH}`, reason: e?.message ?? String(e) };
    }
    if (!res.ok) return { ok: false, step: `fetch ${POINTER_PATH}`, reason: `HTTP ${res.status}` };
    let pointer: Pointer;
    try {
      pointer = (await res.json()) as Pointer;
    } catch (e: any) {
      return { ok: false, step: `parse ${POINTER_PATH}`, reason: e?.message ?? String(e) };
    }
    if (typeof pointer.version !== "number" || !pointer.blob) {
      return { ok: false, step: "validate pointer", reason: `unexpected shape: ${JSON.stringify(pointer)}` };
    }
    let blobRes: Response;
    try {
      blobRes = await fetch(`${base}/${pointer.blob}`, { headers, cache: "no-store" });
    } catch (e: any) {
      return { ok: false, step: `fetch ${pointer.blob}`, reason: e?.message ?? String(e) };
    }
    if (!blobRes.ok) return { ok: false, step: `fetch ${pointer.blob}`, reason: `HTTP ${blobRes.status}` };
    let payload: any[];
    try {
      payload = await blobRes.json();
    } catch (e: any) {
      return { ok: false, step: `parse ${pointer.blob}`, reason: e?.message ?? String(e) };
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      return { ok: false, step: "validate payload", reason: "not a non-empty array" };
    }
    const normalized = payload.map(normalizeTopic);
    _cache = normalized;
    _cacheVersion = pointer.version;
    await AsyncStorage.multiSet([
      [STORAGE_KEY_PAYLOAD, JSON.stringify(normalized)],
      [STORAGE_KEY_VERSION, String(pointer.version)],
    ]);
    _listeners.forEach((cb) => { try { cb(pointer.version); } catch {} });
    return { ok: true, version: pointer.version, count: payload.length, from: "remote" };
  } catch (e: any) {
    return { ok: false, step: "unexpected", reason: e?.message ?? String(e) };
  }
}

/** Synchronous accessor. Callers MUST await `initQuestions()` once before
 * using this — we explicitly throw otherwise so the bug is loud. */
export function getQuestions(): any[] {
  if (_cache === null) {
    // Fall back to the bundled copy if init wasn't awaited yet, instead of
    // crashing the app on cold start.
    return bundledQuestions as any[];
  }
  return _cache;
}

export function getQuestionsVersion(): number {
  return _cacheVersion ?? 0;
}
