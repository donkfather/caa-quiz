/**
 * CAA HQ — question manager dashboard.
 *
 * Static SPA. All state lives in Supabase: questions table, question_versions
 * table (auto-populated by a Postgres trigger), and a `revert_question` RPC.
 * The dashboard is just a thin client.
 *
 * Auth: Supabase email+password, gated by RLS to membership in the
 * `public.admins` table (checked via the `is_admin()` SQL function). The
 * client uses the anon key + the user's JWT; the database enforces the rule.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const TOPICS_BUILTIN = ["colreg", "navigation", "seamanship", "maneuvering", "first_aid", "rnd", "weather", "signs"];
function loadCustomTopics() {
  try { return JSON.parse(localStorage.getItem("caahq-custom-topics") || "[]"); } catch { return []; }
}
function saveCustomTopics(list) {
  try { localStorage.setItem("caahq-custom-topics", JSON.stringify(list)); } catch {}
}
function allTopicSlugs() {
  const seen = new Set();
  const out = [];
  for (const t of TOPICS_BUILTIN) if (!seen.has(t)) { seen.add(t); out.push(t); }
  for (const t of loadCustomTopics()) if (typeof t === "string" && !seen.has(t)) { seen.add(t); out.push(t); }
  return out;
}
// `TOPICS` is kept as a backwards-compat array reference; rebuild on demand
// after the Labels page adds a custom topic.
let TOPICS = allTopicSlugs();
function refreshTOPICSBinding() { TOPICS = allTopicSlugs(); }
/** Treat a question/candidate's topic membership as a Set: prefer the new
 * `topics` array, fall back to the legacy single `topic` field so rows that
 * haven't been migrated still display and filter correctly. */
function topicsOf(q) {
  const arr = Array.isArray(q?.topics) && q.topics.length > 0 ? q.topics : (q?.topic ? [q.topic] : []);
  return arr;
}
function primaryTopic(q) {
  return topicsOf(q)[0] || "";
}
const TOPIC_COLOR = (t) => (t && TOPICS_BUILTIN.includes(t)) ? `var(--${t})` : "var(--muted-bright)";
const LICENSES = ["C", "D"];
const AUTOSAVE_DELAY = 1500;

// Required slots per exam type — mirrors EXAM_CONFIGS in mobile src/lib/questions.ts.
const EXAM_REQUIREMENTS = {
  "cat-c": [["colreg", 8], ["seamanship", 6], ["navigation", 6], ["maneuvering", 6]],
  "cat-d": [["rnd", 10], ["seamanship", 8], ["maneuvering", 8]],
  "dif-c": [["colreg", 10]],
  "dif-d": [["rnd", 10]],
};

// Per-filename cache-busting version. Set when we upload/replace a file
// so the browser doesn't serve the cached old bytes after a Replace.
const _imageVersions = new Map();
function bumpImageVersion(filename) {
  if (filename) _imageVersions.set(filename, Date.now());
}
function imageUrl(filename) {
  if (!filename) return "";
  const base = `${SUPABASE_URL}/storage/v1/object/public/question-images/${encodeURIComponent(filename)}`;
  const v = _imageVersions.get(filename);
  return v ? `${base}?v=${v}` : base;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "caahq-auth" },
});

const SKIPPED_KEY = "caahq.skipped";
function loadSkippedIds() {
  try {
    const raw = localStorage.getItem(SKIPPED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(n => parseInt(n, 10)).filter(Number.isFinite) : []);
  } catch { return new Set(); }
}
function saveSkippedIds() {
  try { localStorage.setItem(SKIPPED_KEY, JSON.stringify([...state.skippedIds])); }
  catch { /* localStorage unavailable / full — non-fatal */ }
}

// ─────────────── state ───────────────
const state = {
  user: null,
  questions: [],
  currentId: null,
  current: null,        // editable copy
  dirty: false,
  saveTimer: null,
  filterTopic: "all",
  filterLic: "",
  searchTerm: "",
  tab: "edit",
  history: [],
  historyCounts: new Map(),  // question_id → version count
  reports: [],
  reportsFilter: "open",     // "open" | "all"
  candidates: [],
  skippedIds: loadSkippedIds(), // Set<number> — local-only "review later" list, per browser
  candidateStatus: "pending", // "pending" | "pending-similar" | "pending-clean" | "skipped" | "all"
  candidateTopic: "",
  candidateSearch: "",       // diacritic-insensitive substring filter over question + options
  candidateSource: "",       // exact source_file match, "" = any
  candidateLicense: "",      // "C" / "D" / "C+D" / "" = any
  candidateSim: "",          // "high" / "mid" / "low" / "" = any (uses similar_scores[0])
  candidateLicenses: new Map(),  // candidate.id → ["C","D"]
  currentCandidateId: null,
  presence: new Map(),        // email → { ts, focus: { kind, id } | null }
  isOwner: false,
  page: "overview",            // SPA route — set by goPage()
  integrity: null,             // last scan result; { brokenImages, zeroCorrect, multiCorrect, duplicates, scannedAt }
  labels: null,                // { [slug]: "Display label" } — loaded from localStorage
  selected: new Set(),         // question ids in bulk selection
};

// ─────────────── boot / auth gate ───────────────
async function boot() {
  applyThemeFromStorage();
  // Wire login form
  document.getElementById("login-form").addEventListener("submit", onLogin);
  document.getElementById("reset-link").addEventListener("click", onResetLink);
  document.getElementById("logout-btn").addEventListener("click", onLogout);

  const { data } = await supabase.auth.getSession();
  if (data?.session?.user) {
    // Restored sessions still need the admin-allowlist check; an account
    // removed from `admins` should not get past the gate even if their JWT
    // is still valid.
    const { data: isAdmin } = await supabase.rpc("is_admin");
    if (isAdmin) {
      state.user = data.session.user;
      await launchApp();
    } else {
      await supabase.auth.signOut();
      showLogin();
    }
  } else {
    showLogin();
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_OUT") {
      state.user = null;
      showLogin();
    }
  });
}

async function onLogin(e) {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";

  document.getElementById("login-submit").disabled = true;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    document.getElementById("login-submit").disabled = false;
    errEl.textContent = error.message || "Sign-in failed.";
    return;
  }
  // Server-side membership check — credentials may be valid but the user
  // might not be in the admins allowlist yet.
  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) {
    await supabase.auth.signOut();
    document.getElementById("login-submit").disabled = false;
    errEl.textContent = "Your account is signed in but not in the admin allowlist. Ask an existing admin to add you.";
    return;
  }
  document.getElementById("login-submit").disabled = false;
  state.user = data.user;
  await launchApp();
}

async function onResetLink(e) {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  if (!email) { document.getElementById("login-error").textContent = "Enter your email first."; return; }
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  const errEl = document.getElementById("login-error");
  errEl.style.color = error ? "" : "var(--ok)";
  errEl.textContent = error ? error.message : `Password reset link sent to ${email}.`;
}

async function onLogout() {
  await supabase.auth.signOut();
}

function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
}

async function launchApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("user-pill").textContent = state.user.email;
  detectEnvTag();
  applyRailCollapsedFromStorage();
  attachShell();
  refreshTopicLabelsEverywhere();
  await loadQuestions();
  await loadHistoryCounts();
  // Owner check controls visibility of Settings → Access (the folded Admins
  // panel). Non-owners still have the rest of Settings.
  const { data: ownerFlag } = await supabase.rpc("is_owner");
  state.isOwner = ownerFlag === true;

  if (state.questions.length) selectQuestion(state.questions[0].id);
  render();
  refreshReportsCountBadge();
  refreshImportCountBadge();
  // Restore the deep-linked view from the URL hash.
  syncViewFromHash();
  window.addEventListener("hashchange", syncViewFromHash);
  startRealtime();
}

// ─────────────── router ───────────────
const PAGES = ["overview", "questions", "images", "import", "labels", "export", "audit", "settings", "course"];

function syncViewFromHash() {
  let h = window.location.hash || "";
  // legacy migration: bare #import → #/import
  if (h === "#import") { history.replaceState(null, "", "#/import"); h = "#/import"; }
  const m = h.match(/^#\/(\w+)$/);
  const target = m && PAGES.includes(m[1]) ? m[1] : "overview";
  if (state.page !== target) goPage(target, { updateHash: false });
}

function goPage(name, { updateHash = true } = {}) {
  if (!PAGES.includes(name)) name = "overview";
  state.page = name;
  for (const p of PAGES) {
    const el = document.getElementById("page-" + p);
    if (!el) continue;
    el.classList.toggle("hidden", p !== name);
  }
  // Course page anchors toasts to bottom-right (heavy editor — top-right
  // overlaps the toolbar).
  document.body.classList.toggle("toast-bottom", name === "course");
  renderRail();
  if (updateHash) {
    const h = "#/" + name;
    if (window.location.hash !== h) history.replaceState(null, "", h);
  }
  // page-specific renderers
  if (name === "overview") renderOverviewPage().catch(err => console.error("overview:", err));
  else if (name === "images") onImagesPageOpen();
  else if (name === "import") onImportPageOpen();
  else if (name === "labels") renderLabelsPage();
  else if (name === "export") renderExportPage().catch(err => console.error("export:", err));
  else if (name === "audit") renderAuditPage().catch(err => console.error("audit:", err));
  else if (name === "settings") renderSettingsPage().catch(err => console.error("settings:", err));
  else if (name === "course") renderCoursePage();
}

function renderRail() {
  for (const btn of document.querySelectorAll(".rail-item[data-page]")) {
    btn.classList.toggle("active", btn.dataset.page === state.page);
  }
  // Reports rail item flashes active while the drawer is open.
  const reportsBtn = document.getElementById("rail-reports");
  if (reportsBtn) {
    const drawerOpen = !document.getElementById("reports-modal").classList.contains("hidden");
    reportsBtn.classList.toggle("active", drawerOpen);
  }
  const qcount = document.getElementById("rail-questions-count");
  if (qcount && state.questions) qcount.textContent = state.questions.length.toLocaleString();
}

function toggleRail() {
  const shell = document.getElementById("app");
  const next = !shell.classList.contains("rail-collapsed");
  shell.classList.toggle("rail-collapsed", next);
  try { localStorage.setItem("caahq-rail-collapsed", next ? "1" : "0"); } catch {}
}

function applyRailCollapsedFromStorage() {
  // Default to collapsed; only expand if the user has explicitly chosen so.
  try {
    const raw = localStorage.getItem("caahq-rail-collapsed");
    const collapsed = raw === null ? true : raw === "1";
    document.getElementById("app").classList.toggle("rail-collapsed", collapsed);
  } catch {
    document.getElementById("app").classList.add("rail-collapsed");
  }
}

function toggleFocusMode() {
  const next = !document.documentElement.classList.contains("focus-mode");
  document.documentElement.classList.toggle("focus-mode", next);
  // Update any focus-toggle button labels live
  document.querySelectorAll("[data-focus-toggle]").forEach(b => {
    b.title = next ? "Exit focus (Esc)" : "Focus mode";
    b.classList.toggle("active", next);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.documentElement.classList.contains("focus-mode")) {
    toggleFocusMode();
  }
});

function isLightTheme() {
  return document.documentElement.classList.contains("theme-light");
}
function toggleTheme() {
  const next = !isLightTheme();
  document.documentElement.classList.toggle("theme-light", next);
  try { localStorage.setItem("caahq-theme", next ? "light" : "dark"); } catch {}
  applyThemeLabel();
}
function applyThemeFromStorage() {
  try {
    const v = localStorage.getItem("caahq-theme");
    if (v === "light") document.documentElement.classList.add("theme-light");
  } catch {}
}
function applyThemeLabel() {
  const lbl = document.getElementById("theme-toggle-label");
  if (lbl) lbl.textContent = isLightTheme() ? "Dark theme" : "Light theme";
}

function detectEnvTag() {
  const el = document.getElementById("env-tag");
  if (!el) return;
  const host = window.location.hostname;
  if (host.endsWith(".pages.dev") || host === "localhost" || host === "127.0.0.1") {
    el.textContent = "STAGING"; el.className = "env-tag staging";
  } else {
    el.textContent = "PROD"; el.className = "env-tag prod";
  }
}

// ─────────────── data layer ───────────────
async function loadQuestions() {
  const { data, error } = await supabase
    .from("questions")
    .select("id, question, options, correct, topic, topics, license, image_path, updated_at")
    .order("id", { ascending: true });
  if (error) { toast("bad", "Couldn't load questions", error.message); return; }
  state.questions = data || [];
}

async function loadReports({ openOnly = false } = {}) {
  let q = supabase
    .from("question_reports")
    .select("id, kind, question_id, external_ref, question_text, message, app_version, questions_version, resolved_at, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (openOnly) q = q.is("resolved_at", null);
  const { data, error } = await q;
  if (error) { toast("bad", "Couldn't load reports", error.message); return []; }
  return data || [];
}

async function loadOpenReportsCount() {
  const { count, error } = await supabase
    .from("question_reports")
    .select("id", { count: "exact", head: true })
    .is("resolved_at", null);
  if (error) return 0;
  return count || 0;
}

async function loadCandidates({ status, topic } = {}) {
  // status values: "pending", "pending-similar", "pending-clean", "skipped", "all"
  let q = supabase
    .from("question_candidates")
    .select("id, source_file, source_nr, topic, topics, question, options, correct, license, status, duplicate_of, imported_question_id, similar_ids, similar_scores, image_path")
    .order("id", { ascending: true })
    .limit(2000);
  if (status && status !== "all") {
    q = q.eq("status", "pending");
  }
  if (topic) q = q.eq("topic", topic);
  const { data, error } = await q;
  if (error) { toast("bad", "Couldn't load candidates", error.message); return []; }
  // "has match" / "no match" / "skipped" sub-filters applied client-side.
  let rows = data || [];
  if (status === "pending-similar") rows = rows.filter(c => (c.similar_ids || []).length > 0);
  else if (status === "pending-clean") rows = rows.filter(c => (c.similar_ids || []).length === 0);
  // Skip list is local to this browser. In "skipped" view we show only the
  // ones the user has flagged; in any other pending* view we hide them so
  // they don't get in the way.
  if (status === "skipped") {
    rows = rows.filter(c => state.skippedIds.has(c.id));
  } else if (status && status.startsWith("pending")) {
    rows = rows.filter(c => !state.skippedIds.has(c.id));
  }
  return rows;
}

async function loadPendingCandidatesCount() {
  const { count, error } = await supabase
    .from("question_candidates")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (error) return 0;
  return count || 0;
}

async function acceptCandidate(c, license) {
  // Snapshot the editable fields *before* any async work. Otherwise a
  // realtime UPDATE on this candidate (e.g. the claim we're about to make)
  // can replace state.candidates[idx] with the unedited DB row, racing the
  // createQuestion below.
  const draft = {
    question: c.question,
    options: [...c.options],
    correct: c.correct,
    topic: primaryTopic(c),
    topics: topicsOf(c),
    license: license || [],
    image_path: c.image_path || null,
  };
  // Claim the candidate first. If someone else already decided it, the
  // UPDATE matches zero rows and we bail without creating a duplicate
  // question. RLS + status filter make this race-safe.
  const { data: claim, error: claimErr } = await supabase
    .from("question_candidates")
    .update({
      status: "accepted",
      decided_at: new Date().toISOString(),
      decided_by: state.user?.email ?? null,
    })
    .eq("id", c.id)
    .eq("status", "pending")
    .select();
  if (claimErr) { toast("bad", "Couldn't claim candidate", claimErr.message); return false; }
  if (!claim || claim.length === 0) {
    toast("bad", "Already decided", "Another reviewer just handled this candidate.");
    return false;
  }
  // Now create the question.
  let created;
  try {
    created = await createQuestion(draft);
  } catch (e) {
    // Roll back the claim so it can be retried.
    await supabase.from("question_candidates")
      .update({ status: "pending", decided_at: null, decided_by: null })
      .eq("id", c.id);
    toast("bad", "Couldn't create question", e.message || String(e));
    return false;
  }
  await supabase.from("question_candidates")
    .update({ imported_question_id: created.id })
    .eq("id", c.id);
  state.questions.push(created);
  return true;
}

/** Overwrite an existing question with the candidate's text/options/etc.,
 * then close the candidate as a "rejected" duplicate pointing to that
 * question. Used when the candidate is cleaner than the published row. */
async function replaceQuestionWithCandidate(c, targetQid, license) {
  const draft = {
    question: c.question,
    options: [...c.options],
    correct: c.correct,
    topic: primaryTopic(c),
    topics: topicsOf(c),
    license: license || c.license || [],
    image_path: c.image_path || null,
  };
  // Claim the candidate first so concurrent reviewers can't double-act.
  const { data: claim, error: claimErr } = await supabase
    .from("question_candidates")
    .update({
      status: "rejected",
      decided_at: new Date().toISOString(),
      decided_by: state.user?.email ?? null,
      duplicate_of: targetQid,
    })
    .eq("id", c.id)
    .eq("status", "pending")
    .select();
  if (claimErr) { toast("bad", "Couldn't claim candidate", claimErr.message); return false; }
  if (!claim || claim.length === 0) {
    toast("bad", "Already decided", "Another reviewer just handled this candidate.");
    return false;
  }
  // Now overwrite the existing question. The audit trigger will record a
  // new version automatically.
  let updated;
  try {
    updated = await updateQuestion(targetQid, draft);
  } catch (e) {
    // Roll back the claim so it can be retried.
    await supabase.from("question_candidates")
      .update({ status: "pending", decided_at: null, decided_by: null, duplicate_of: null })
      .eq("id", c.id);
    toast("bad", "Couldn't update question", e.message || String(e));
    return false;
  }
  // Refresh local mirror of the published question.
  const idx = state.questions.findIndex(q => q.id === updated.id);
  if (idx >= 0) state.questions[idx] = updated;
  else state.questions.push(updated);
  state.historyCounts.set(updated.id, (state.historyCounts.get(updated.id) || 0) + 1);
  return true;
}

async function rejectCandidate(c) {
  const { data, error } = await supabase
    .from("question_candidates")
    .update({
      status: "rejected",
      decided_at: new Date().toISOString(),
      decided_by: state.user?.email ?? null,
    })
    .eq("id", c.id)
    .eq("status", "pending")
    .select();
  if (error) { toast("bad", "Couldn't reject", error.message); return false; }
  if (!data || data.length === 0) {
    toast("bad", "Already decided", "Another reviewer just handled this candidate.");
    return false;
  }
  return true;
}

async function markReportResolved(id) {
  const { error } = await supabase
    .from("question_reports")
    .update({ resolved_at: new Date().toISOString(), resolved_by: state.user?.email ?? null })
    .eq("id", id);
  if (error) { toast("bad", "Couldn't resolve", error.message); return false; }
  return true;
}

async function loadHistoryCounts() {
  // Fetch counts grouped by question_id in one round trip.
  const { data, error } = await supabase
    .from("question_versions")
    .select("question_id");
  if (error) return;
  const counts = new Map();
  for (const row of data || []) counts.set(row.question_id, (counts.get(row.question_id) || 0) + 1);
  state.historyCounts = counts;
}

async function loadHistoryFor(questionId) {
  const { data, error } = await supabase
    .from("question_versions")
    .select("id, kind, snapshot, actor_email, note, created_at")
    .eq("question_id", questionId)
    .order("created_at", { ascending: false });
  if (error) { toast("bad", "Couldn't load history", error.message); return []; }
  return data || [];
}

async function createQuestion(payload) {
  const { data, error } = await supabase
    .from("questions")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateQuestion(id, payload) {
  const { data, error } = await supabase
    .from("questions")
    .update(payload)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteQuestion(id) {
  const { error } = await supabase.from("questions").delete().eq("id", id);
  if (error) throw error;
}

async function revertToVersion(versionId, note) {
  const { data, error } = await supabase.rpc("revert_question", {
    p_version_id: versionId,
    p_note: note ?? null,
  });
  if (error) throw error;
  return data;
}

// ─────────────── filtering ───────────────
/** Strip Romanian diacritics + lowercase so searches like "geamandura"
 * match "Geamandură" and vice versa. NFD normalisation handles both
 * pre-composed (ă, â, î) and decomposed forms. The combining marks are
 * stripped, plus a few legacy cedilla variants (ş/ţ vs ș/ț). */
function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // strip combining diacritics
    .replace(/[șş]/g, "s")
    .replace(/[țţ]/g, "t")
    .toLowerCase();
}

function visibleQuestions() {
  const needle = norm(state.searchTerm);
  return state.questions.filter(q => {
    if (state.filterTopic !== "all" && !topicsOf(q).includes(state.filterTopic)) return false;
    if (state.filterLic === "C" && !(q.license || []).includes("C")) return false;
    if (state.filterLic === "D" && !(q.license || []).includes("D")) return false;
    if (state.filterLic === "C+D" &&
        !((q.license || []).includes("C") && (q.license || []).includes("D"))) return false;
    if (needle) {
      const hay = norm(q.question + " " + (q.options || []).join(" "));
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function topicCounts() {
  const c = Object.fromEntries(allTopicSlugs().map(t => [t, 0]));
  for (const q of state.questions) {
    for (const t of topicsOf(q)) {
      if (!c.hasOwnProperty(t)) c[t] = 0; // count topics seen in data but not in TOPICS yet
      c[t]++;
    }
  }
  return c;
}

function coverageInfo() {
  const counts = topicCounts();
  const broken = [];
  for (const [exam, slots] of Object.entries(EXAM_REQUIREMENTS)) {
    for (const [topic, need] of slots) {
      const have = counts[topic] || 0;
      if (have < need) broken.push({ exam, topic, need, have });
    }
  }
  return broken;
}

// ─────────────── render ───────────────
function render() {
  document.getElementById("total-pill").textContent = `${state.questions.length} questions`;
  renderTopicFilter();
  renderCoverage();
  renderList();
  renderBulkBar();
  renderFiltersSummary();
  renderHistoryCount();
  renderTabContent();
  updateSaveStatus();
  updateWorkspaceHeadActions();
}

function renderFiltersSummary() {
  const countEl = document.getElementById("filters-count");
  const sumEl = document.getElementById("filters-summary");
  if (!countEl || !sumEl) return;
  const chips = [];
  if (state.filterTopic && state.filterTopic !== "all") {
    chips.push({ k: "topic", label: labelFor(state.filterTopic) });
  }
  if (state.filterLic) {
    const m = { "C": "Class C", "D": "Class D", "C+D": "C ∩ D" };
    chips.push({ k: "lic", label: m[state.filterLic] || state.filterLic });
  }
  if (state.searchTerm && state.searchTerm.trim()) {
    chips.push({ k: "search", label: `"${state.searchTerm.trim().slice(0, 16)}${state.searchTerm.trim().length > 16 ? "…" : ""}"` });
  }
  countEl.hidden = chips.length === 0;
  countEl.textContent = String(chips.length);
  sumEl.innerHTML = chips.map(c =>
    `<span class="chip" data-clear="${escapeHtml(c.k)}">${escapeHtml(c.label)}<span class="x" title="Clear">×</span></span>`
  ).join("");
  sumEl.querySelectorAll(".chip").forEach(c => {
    c.querySelector(".x").onclick = () => {
      const k = c.dataset.clear;
      if (k === "topic") state.filterTopic = "all";
      else if (k === "lic") state.filterLic = "";
      else if (k === "search") { state.searchTerm = ""; const s = document.getElementById("search"); if (s) s.value = ""; document.getElementById("search-clear").style.display = "none"; }
      state.selected.clear();
      renderTopicFilter();
      document.querySelectorAll("#lic-filter .lic-pill").forEach(x => x.classList.toggle("active", x.dataset.l === (state.filterLic || "")));
      renderList(); renderBulkBar(); renderFiltersSummary();
    };
  });
}

function toggleFiltersCollapse() {
  const box = document.getElementById("filters-collapse");
  if (!box) return;
  box.classList.toggle("hidden");
  try { localStorage.setItem("caahq-filters-open", box.classList.contains("hidden") ? "0" : "1"); } catch {}
}

function applyFiltersCollapsedFromStorage() {
  try {
    const open = localStorage.getItem("caahq-filters-open") === "1";
    document.getElementById("filters-collapse")?.classList.toggle("hidden", !open);
  } catch {}
}

function renderTopicFilter() {
  const host = document.getElementById("topic-filter");
  const counts = topicCounts();
  const items = ["all", ...TOPICS];
  host.innerHTML = items.map(t => {
    const count = t === "all" ? state.questions.length : (counts[t] ?? 0);
    const dot = t === "all"
      ? `<span class="dot" style="background:linear-gradient(135deg,var(--accent),var(--seamanship))"></span>`
      : `<span class="dot" style="background:${TOPIC_COLOR(t)}"></span>`;
    const display = t === "all" ? "All" : labelFor(t);
    return `<button class="topic-pill ${t === state.filterTopic ? "active" : ""}" data-t="${t}" title="${escapeHtml(t)}">${dot}<span>${escapeHtml(display)}</span><span class="count">${count}</span></button>`;
  }).join("");
  host.querySelectorAll(".topic-pill").forEach(b => {
    b.onclick = () => { state.filterTopic = b.dataset.t; state.selected.clear(); renderList(); renderBulkBar(); renderTopicFilter(); };
  });
}

function renderCoverage() {
  // Coverage chips hidden for now — the gauge is noisy while the topic mix
  // is still being filled. Re-enable by restoring the implementation below.
  const host = document.getElementById("coverage");
  if (host) { host.innerHTML = ""; host.hidden = true; }
}

function renderList() {
  const list = visibleQuestions();
  const ul = document.getElementById("qlist");
  // prune selected ids that fell out of the visible filter
  if (state.selected.size) {
    const visIds = new Set(list.map(q => q.id));
    for (const id of [...state.selected]) if (!visIds.has(id)) state.selected.delete(id);
  }
  if (!list.length) { ul.innerHTML = `<div class="empty">No questions match the current filters.</div>`; return; }
  ul.innerHTML = list.map(q => {
    const isActive = q.id === state.currentId;
    const isChecked = state.selected.has(q.id);
    const licTags = (q.license || []).map(l => `<span class="lic-tag">${l}</span>`).join("");
    const tList = topicsOf(q);
    const primary = tList[0] || "";
    const extra = tList.length > 1 ? ` <span class="topic-extra" title="${escapeHtml(tList.slice(1).join(", "))}">+${tList.length - 1}</span>` : "";
    return `
      <li class="${isActive ? "active" : ""}" data-id="${q.id}" tabindex="0">
        <div class="check"><input type="checkbox" data-check="${q.id}" ${isChecked ? "checked" : ""} aria-label="Select question ${q.id}"></div>
        <div class="topic-bar" style="background:${TOPIC_COLOR(primary)}"></div>
        <div class="body">
          <div class="qtext">${escapeHtml(q.question)}</div>
          <div class="meta">
            <span style="color:${TOPIC_COLOR(primary)};font-weight:500" title="${escapeHtml(primary)}">${escapeHtml(labelFor(primary))}${extra}</span>
            <span>·</span>
            <span>${(q.options || []).length} options</span>
            ${licTags ? `<span>·</span>${licTags}` : ""}
          </div>
        </div>
      </li>`;
  }).join("");
  ul.querySelectorAll("li").forEach(li => {
    const id = parseInt(li.dataset.id, 10);
    li.onclick = (e) => {
      if (e.target.closest(".check")) return;
      selectQuestion(id);
    };
    const cb = li.querySelector("input[type=checkbox]");
    cb.addEventListener("click", e => e.stopPropagation());
    cb.addEventListener("change", () => {
      if (cb.checked) state.selected.add(id); else state.selected.delete(id);
      renderBulkBar();
    });
  });
  ul.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
  renderPresenceMarkers();
}

function renderHistoryCount() {
  const el = document.getElementById("history-count");
  if (!state.current) { el.textContent = ""; return; }
  const n = state.historyCounts.get(state.current.id) || 0;
  el.textContent = n;
}

function renderTabContent() {
  if (state.tab === "history") return renderHistoryView();
  return renderEditor();
}

function renderEditor() {
  const host = document.getElementById("workspace-content");
  if (!state.current) {
    host.innerHTML = `<div class="placeholder">Select a question from the list, or press <kbd>N</kbd> to create a new one.</div>`;
    document.getElementById("qid").textContent = "—";
    document.getElementById("qtitle").textContent = "No question selected";
    document.getElementById("breadcrumbs").innerHTML = "";
    return;
  }
  document.getElementById("qid").textContent = `#${state.current.id}`;
  document.getElementById("qtitle").textContent = state.current.question.slice(0, 80) + (state.current.question.length > 80 ? "…" : "");
  renderBreadcrumbs();

  host.innerHTML = `
    <div class="workspace-grid">
      <div class="editor-card">
        <div class="editor-toolbar">
          <button class="btn ghost" id="copy-ai-btn" title="Copy question + options to ask an AI" style="font-size:11px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy for AI
          </button>
          <textarea class="fix-notes" id="fix-notes" rows="1" placeholder="Optional hint for the AI…">${escapeHtml(state.current._fixNotes || "")}</textarea>
          <button class="btn ghost ${(state.current._versions || []).some(v => v.label === "AI fix") ? "ai-fixed" : ""}" id="fix-ai-btn" title="Auto-fix diacritics, grammar &amp; translate to Romanian using Claude Haiku" style="font-size:11px">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.39 7.36H22l-6.19 4.5L18.2 22 12 17.5 5.8 22l2.39-8.14L2 9.36h7.61z"/></svg>
            Fix with AI
          </button>
          <div class="versions-row" id="versions-row"></div>
        </div>
        <div class="field">
          <span class="label">Question</span>
          <textarea id="f-question" placeholder="Întrebarea…">${escapeHtml(state.current.question)}</textarea>
        </div>
        <div class="field">
          <span class="label">Options</span>
          <span class="hint">Click the circle on the left to mark which option is correct.</span>
          <div class="opt-list" id="f-options"></div>
          <button class="add-opt" id="add-opt">+ Add option</button>
        </div>
      </div>
      <div class="meta-card">
        <div class="field">
          <span class="label">Topic</span>
          <span class="hint">A question can belong to multiple topics — click to toggle.</span>
          <div class="topic-grid" id="f-topic">
            ${TOPICS.map(t => `<button class="topic-choice ${topicsOf(state.current).includes(t) ? "active" : ""}" data-t="${t}" title="${escapeHtml(t)}"><span class="dot" style="background:${TOPIC_COLOR(t)}"></span>${escapeHtml(labelFor(t))}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <span class="label">Licenses</span>
          <div class="lic-toggle-row">
            ${LICENSES.map(l => `<button class="lic-toggle ${(state.current.license || []).includes(l) ? "active" : ""}" data-lic="${l}">Class ${l}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <span class="label">Image</span>
          <span class="hint">Pick from the <code>question-images</code> bucket.</span>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="f-image" type="text" placeholder="e.g. imaginiMAR-017.jpg" value="${escapeHtml(state.current.image_path || "")}" style="flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--text);padding:8px 10px;border-radius:8px;font-size:13px;font-family:ui-monospace,monospace" />
            <button class="btn ghost" id="f-image-browse" type="button">Browse</button>
          </div>
          ${state.current.image_path ? `<img src="${imageUrl(state.current.image_path)}" alt="" style="margin-top:8px;max-width:100%;max-height:240px;border-radius:8px;border:1px solid var(--line)" />` : ""}
        </div>
        <div class="danger-zone">
          <button class="btn ghost" id="dup-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Duplicate
          </button>
          <button class="btn bad-ghost" id="del-btn">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            Delete
          </button>
        </div>
      </div>
    </div>`;

  renderOptionsEditor();
  attachEditorHandlers();
}

function renderOptionsEditor() {
  const host = document.getElementById("f-options");
  host.innerHTML = state.current.options.map((opt, i) => `
    <div class="opt-row ${i === state.current.correct ? "correct" : ""}" data-i="${i}">
      <button class="mark" title="Mark as correct"><span class="circle">${i === state.current.correct ? "✓" : ""}</span></button>
      <textarea placeholder="Răspuns…">${escapeHtml(opt)}</textarea>
      <button class="del" title="Remove option" ${state.current.options.length <= 2 ? "disabled" : ""}>✕</button>
    </div>`).join("");
  host.querySelectorAll(".opt-row").forEach((row, i) => {
    row.querySelector(".mark").onclick = () => { state.current.correct = i; markDirty(); renderOptionsEditor(); };
    row.querySelector("textarea").addEventListener("input", e => { state.current.options[i] = e.target.value; markDirty(); });
    row.querySelector(".del").onclick = () => {
      if (state.current.options.length <= 2) return;
      state.current.options.splice(i, 1);
      if (state.current.correct >= state.current.options.length) state.current.correct = state.current.options.length - 1;
      else if (state.current.correct > i) state.current.correct--;
      markDirty();
      renderOptionsEditor();
    };
  });
}

function attachEditorHandlers() {
  document.getElementById("f-question").addEventListener("input", e => {
    state.current.question = e.target.value;
    markDirty();
  });
  document.getElementById("f-image-browse").onclick = () => openImagePicker({ kind: "question" });
  document.getElementById("f-image").addEventListener("input", e => {
    state.current.image_path = e.target.value.trim() || null;
    markDirty();
  });
  document.getElementById("add-opt").onclick = () => {
    state.current.options.push("");
    markDirty();
    renderOptionsEditor();
    setTimeout(() => {
      const tas = document.querySelectorAll(".opt-row textarea");
      tas[tas.length - 1]?.focus();
    }, 0);
  };
  document.querySelectorAll(".topic-choice").forEach(b => {
    b.onclick = () => {
      const t = b.dataset.t;
      const set = new Set(topicsOf(state.current));
      if (set.has(t)) set.delete(t); else set.add(t);
      // A question must always have at least one topic — refuse to deselect
      // the last one. Use the primary topic as a safety net.
      if (set.size === 0) { toast("ok", "Need at least one topic", ""); return; }
      state.current.topics = [...set];
      // Keep the legacy `topic` field in sync with the first (primary) topic
      // so older readers (mobile builds before this rollout, the publish
      // bundle, etc.) still see a sensible value.
      state.current.topic = state.current.topics[0];
      markDirty();
      b.classList.toggle("active", set.has(t));
      renderBreadcrumbs();
    };
  });
  document.querySelectorAll(".lic-toggle").forEach(b => {
    b.onclick = () => {
      const l = b.dataset.lic;
      const lics = new Set(state.current.license || []);
      if (lics.has(l)) lics.delete(l); else lics.add(l);
      state.current.license = [...lics].sort();
      markDirty();
      b.classList.toggle("active");
      renderBreadcrumbs();
    };
  });
  document.getElementById("dup-btn").onclick = () => duplicateCurrent();
  document.getElementById("del-btn").onclick = () => deleteCurrent();

  renderVersionsRow();

  const notesEl = document.getElementById("fix-notes");
  if (notesEl) notesEl.addEventListener("input", e => {
    state.current._fixNotes = e.target.value;
  });

  document.getElementById("copy-ai-btn").onclick = async () => {
    const text = formatForAi(state.current);
    try {
      await navigator.clipboard.writeText(text);
      toast("ok", "Copied", "Paste it into your AI assistant.");
    } catch {
      toast("bad", "Copy failed", "Browser denied clipboard access.");
    }
  };

  const fixBtn = document.getElementById("fix-ai-btn");
  fixBtn.onclick = async () => {
    const q = state.current;
    const originalLabel = fixBtn.innerHTML;
    fixBtn.disabled = true;
    fixBtn.innerHTML = `<span class="spinner" style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 0.7s linear infinite"></span> Fixing…`;
    try {
      const { data, error } = await supabase.functions.invoke("fix-text", {
        body: { question: q.question, options: q.options, correct: q.correct, topic: q.topic, notes: q._fixNotes || "" },
      });
      if (error) throw error;
      if (!data || data.error) throw new Error(data?.error || "unknown error");
      // Capture pending manual edits before applying the AI fix so the user
      // can cycle back to them. Skip if the live state already matches the
      // latest stored version (no divergence to preserve).
      const latest = q._versions[q._versions.length - 1];
      if (!currentSnapshotMatches(q, latest)) pushVersion(q, "My edit");
      q.question = data.question;
      q.options = data.options;
      pushVersion(q, "AI fix");
      markDirty();
      renderEditor();
      toast("ok", "Fixed", data.changes_made || "Text updated.");
    } catch (e) {
      toast("bad", "Fix failed", e?.message || String(e));
      fixBtn.disabled = false;
      fixBtn.innerHTML = originalLabel;
    }
  };
}

function renderVersionsRow() {
  const host = document.getElementById("versions-row");
  if (!host || !state.current) return;
  const q = state.current;
  seedVersions(q);
  const total = q._versions.length;
  // Determine which version (if any) matches the live editor state so we can
  // highlight that pill instead of the stale _versionIdx after edits.
  let liveIdx = -1;
  for (let i = total - 1; i >= 0; i--) {
    if (currentSnapshotMatches(q, q._versions[i])) { liveIdx = i; break; }
  }
  const activeIdx = liveIdx >= 0 ? liveIdx : -1;
  const pills = q._versions.map((v, i) => `
    <button class="ver-pill ${i === activeIdx ? "active" : ""}" data-vi="${i}" title="Switch to: ${escapeHtml(v.label)}">
      <span class="ver-pill-label">${escapeHtml(v.label)}</span>
      <span class="ver-pill-i">${i + 1}</span>
    </button>`).join("");
  host.innerHTML = `
    <button class="ver-cyc" id="ver-prev" title="Previous version" ${total < 2 ? "disabled" : ""}>◀</button>
    <div class="ver-pills">${pills}</div>
    <button class="ver-cyc" id="ver-next" title="Next version" ${total < 2 ? "disabled" : ""}>▶</button>
    <button class="ver-snap" id="ver-snap" title="Save current text as a new version">+ Snapshot</button>
  `;
  host.querySelectorAll("[data-vi]").forEach(b => {
    b.onclick = () => switchToVersion(parseInt(b.dataset.vi, 10));
  });
  document.getElementById("ver-prev").onclick = () => {
    const base = activeIdx >= 0 ? activeIdx : q._versions.length - 1;
    switchToVersion((base - 1 + total) % total);
  };
  document.getElementById("ver-next").onclick = () => {
    const base = activeIdx >= 0 ? activeIdx : 0;
    switchToVersion((base + 1) % total);
  };
  document.getElementById("ver-snap").onclick = () => {
    const latest = q._versions[q._versions.length - 1];
    if (currentSnapshotMatches(q, latest)) {
      toast("ok", "No changes", "Current text already matches the latest version.");
      return;
    }
    pushVersion(q, "My edit");
    renderVersionsRow();
    toast("ok", "Snapshot saved", "Added a new version you can cycle back to.");
  };
}

function switchToVersion(idx) {
  if (!state.current) return;
  if (!loadVersion(state.current, idx)) return;
  markDirty();
  renderEditor();
}

/** Render a vertical list of version snapshots for an import candidate. The
 * snapshots live on the candidate object (`_versions`), so they survive list
 * scrolling and only clear when the row is replaced by a realtime UPDATE. */
function renderCandidateVersionsList(host, candId) {
  const c = state.candidates.find(x => x.id === candId);
  if (!host || !c) return;
  seedVersions(c);
  let liveIdx = -1;
  for (let i = c._versions.length - 1; i >= 0; i--) {
    if (currentSnapshotMatches(c, c._versions[i])) { liveIdx = i; break; }
  }
  host.innerHTML = c._versions.map((v, i) => {
    const preview = (v.question || "").slice(0, 80);
    return `
      <button class="version-item ${i === liveIdx ? "active" : ""}" data-cvi="${i}" title="Load this version">
        <div class="version-item-head">
          <span class="version-item-label">${escapeHtml(v.label)}</span>
          <span class="version-item-i">${i + 1}</span>
        </div>
        <div class="version-item-preview">${escapeHtml(preview)}${(v.question || "").length > 80 ? "…" : ""}</div>
      </button>`;
  }).join("");
  host.querySelectorAll("[data-cvi]").forEach(b => {
    b.onclick = () => switchCandVersion(c, parseInt(b.dataset.cvi, 10));
  });
}

function switchCandVersion(c, idx) {
  if (!loadVersion(c, idx)) return;
  renderCandidateWorkspace();
}

function renderBreadcrumbs() {
  if (!state.current) { document.getElementById("breadcrumbs").innerHTML = ""; return; }
  const chips = topicsOf(state.current)
    .map(t => `<span class="topic-chip" title="${escapeHtml(t)}"><span class="dot" style="background:${TOPIC_COLOR(t)}"></span>${escapeHtml(labelFor(t))}</span>`)
    .join(" ");
  document.getElementById("breadcrumbs").innerHTML = `
    ${chips}
    <span>·</span>
    <span>${(state.current.license || []).join(" + ") || "no license"}</span>
    <span>·</span>
    <span>${state.current.options.length} options</span>
  `;
}

// ─────────────── history view ───────────────
async function renderHistoryView() {
  const host = document.getElementById("workspace-content");
  if (!state.current) { host.innerHTML = `<div class="placeholder">Select a question to see its history.</div>`; return; }

  host.innerHTML = `<div class="history-list" id="history-host"><div class="history-empty">Loading…</div></div>`;
  const versions = await loadHistoryFor(state.current.id);
  state.history = versions;

  const hostList = document.getElementById("history-host");
  if (!versions.length) { hostList.innerHTML = `<div class="history-empty">No history recorded yet.</div>`; return; }

  // versions are newest-first. Render each with a diff against the
  // version that came right before it (which is the next item in the array).
  hostList.innerHTML = versions.map((v, i) => {
    const previous = versions[i + 1]?.snapshot;
    const isLatest = i === 0;
    const isLast = i === versions.length - 1;
    return `
      <div class="version-card" data-vid="${v.id}">
        <div class="version-head">
          <span class="version-kind ${v.kind}">${v.kind}</span>
          <span class="version-time">${formatDate(v.created_at)}</span>
          <span class="version-actor">${escapeHtml(v.actor_email || "system")}</span>
          ${v.note ? `<span style="color:var(--muted);font-size:11px">· ${escapeHtml(v.note)}</span>` : ""}
          <div class="actions-row">
            ${isLatest ? `<span class="cov-chip ok">current</span>` : `
              <button class="btn ghost revert-btn" data-vid="${v.id}">Revert to this</button>
            `}
          </div>
        </div>
        ${renderDiff(previous, v.snapshot, v.kind)}
      </div>`;
  }).join("");
  hostList.querySelectorAll(".revert-btn").forEach(b => {
    b.onclick = () => doRevert(parseInt(b.dataset.vid, 10));
  });
}

function renderDiff(oldSnap, newSnap, kind) {
  const fields = ["question", "topic", "license", "options", "correct"];
  const oldV = oldSnap || {};
  const newV = newSnap || {};
  const rows = fields.map(k => {
    const oldStr = stringify(oldV[k]);
    const newStr = stringify(newV[k]);
    const changed = oldStr !== newStr;
    return { k, oldStr, newStr, changed };
  });
  if (kind === "delete") {
    return `<div class="diff" style="grid-template-columns: 1fr">
      <div class="col-head">deleted snapshot</div>
      ${fields.map(k => `<div class="field-row"><div class="k">${k}</div><div class="v">${escapeHtml(stringify(newV[k]))}</div></div>`).join("")}
    </div>`;
  }
  return `<div class="diff">
    <div class="col-old">
      <div class="col-head">previous</div>
      ${rows.map(r => `<div class="field-row ${r.changed ? "changed" : ""}"><div class="k">${r.k}</div><div class="v">${escapeHtml(r.oldStr || "—")}</div></div>`).join("")}
    </div>
    <div class="col-new">
      <div class="col-head">this version</div>
      ${rows.map(r => `<div class="field-row ${r.changed ? "changed" : ""}"><div class="k">${r.k}</div><div class="v">${escapeHtml(r.newStr || "—")}</div></div>`).join("")}
    </div>
  </div>`;
}

async function doRevert(versionId) {
  const ok = await confirmModal({
    title: "Revert this question?",
    body: "Replaces the current content with this version's content. The change is itself logged in history (kind = 'revert'), so you can revert the revert if you change your mind.",
    confirmText: "Revert",
  });
  if (!ok) return;
  try {
    const reverted = await revertToVersion(versionId, "manual revert via dashboard");
    state.current = deepClone(reverted);
    state.dirty = false;
    await loadQuestions();
    await loadHistoryCounts();
    toast("ok", "Reverted");
    render();
  } catch (e) {
    toast("bad", "Revert failed", e.message || String(e));
  }
}

// ─────────────── selection / dirty / save ───────────────
async function selectQuestion(id) {
  if (state.dirty) await flushSave();
  state.currentId = id;
  const q = state.questions.find(x => x.id === id);
  state.current = q ? deepClone(q) : null;
  if (state.current) seedVersions(state.current);
  state.dirty = false;
  if (state.tab === "history" && state.current) renderTabContent();
  else render();
  broadcastFocus();
}

function markDirty() {
  state.dirty = true;
  updateSaveStatus();
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flushSave(), AUTOSAVE_DELAY);
}

function updateSaveStatus() {
  const el = document.getElementById("save-status");
  if (!el) return;
  if (!state.current) {
    el.className = "save-status";
    el.hidden = true;
    el.querySelector(".text").textContent = "—";
    updateWorkspaceHeadActions();
    return;
  }
  el.hidden = false;
  el.className = state.dirty ? "save-status dirty" : "save-status saved";
  el.querySelector(".text").textContent = state.dirty ? "Unsaved changes…" : "Saved";
  updateWorkspaceHeadActions();
}

function updateWorkspaceHeadActions() {
  const btn = document.getElementById("save-next-btn");
  if (btn) btn.hidden = !state.current;
}

async function saveAndNext() {
  if (!state.current) return;
  const list = visibleQuestions();
  const idx = list.findIndex(q => q.id === state.currentId);
  if (idx < 0 || idx >= list.length - 1) { toast("warn", "End of list"); return; }
  await flushSave();
  if (state.dirty) return;
  selectQuestion(list[idx + 1].id);
}

// ─── bulk select ───
function renderBulkBar() {
  const bar = document.getElementById("bulk-bar");
  if (!bar) return;
  const n = state.selected.size;
  if (n === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  document.getElementById("bulk-count").textContent = `${n} selected`;
  const counts = topicCounts();
  const sel = document.getElementById("bulk-topic");
  const opts = [`<option value="">Change topic…</option>`]
    .concat(Object.entries(counts).filter(([,c]) => c > 0).map(([t, c]) => `<option value="${escapeHtml(t)}">${escapeHtml(labelFor(t))} (${c})</option>`));
  sel.innerHTML = opts.join("");
  sel.value = "";
}

function attachBulkBar() {
  const sel = document.getElementById("bulk-topic");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const t = sel.value;
    if (!t) return;
    bulkApplyTopic(t);
  });
  document.querySelectorAll("#bulk-lic .bulk-lic").forEach(b => {
    b.onclick = () => bulkApplyLicense(b.dataset.l);
  });
  document.getElementById("bulk-export").onclick = () => bulkExport();
  document.getElementById("bulk-delete").onclick = () => bulkDelete();
  document.getElementById("bulk-clear").onclick = () => { state.selected.clear(); renderList(); renderBulkBar(); };
}

async function bulkApplyTopic(newSlug) {
  const ids = [...state.selected];
  let ok = 0, bad = 0;
  for (const id of ids) {
    try {
      const saved = await updateQuestion(id, { topic: newSlug });
      const idx = state.questions.findIndex(q => q.id === id);
      if (idx >= 0) state.questions[idx] = saved;
      if (state.currentId === id) state.current = deepClone(saved);
      state.historyCounts.set(id, (state.historyCounts.get(id) || 0) + 1);
      ok++;
    } catch { bad++; }
  }
  toast(bad ? "warn" : "ok", `Topic → ${newSlug}`, `${ok} updated${bad ? `, ${bad} failed` : ""}`);
  render();
}

async function bulkApplyLicense(code) {
  const map = { "C": ["C"], "D": ["D"], "C+D": ["C", "D"] };
  const lic = map[code];
  if (!lic) return;
  const ids = [...state.selected];
  let ok = 0, bad = 0;
  for (const id of ids) {
    try {
      const saved = await updateQuestion(id, { license: lic });
      const idx = state.questions.findIndex(q => q.id === id);
      if (idx >= 0) state.questions[idx] = saved;
      if (state.currentId === id) state.current = deepClone(saved);
      state.historyCounts.set(id, (state.historyCounts.get(id) || 0) + 1);
      ok++;
    } catch { bad++; }
  }
  toast(bad ? "warn" : "ok", `License → ${lic.join("+")}`, `${ok} updated${bad ? `, ${bad} failed` : ""}`);
  render();
}

async function bulkDelete() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const includesCurrent = state.current && ids.includes(state.current.id);
  const body = includesCurrent
    ? `${ids.length} questions will be deleted, including the one you're editing. The deletions stay in history.`
    : `${ids.length} questions will be deleted. The deletions stay in history.`;
  const ok = await confirmModal({ title: "Delete selected questions?", body, confirmText: "Delete" });
  if (!ok) return;
  let okN = 0, badN = 0;
  for (const id of ids) {
    try {
      await deleteQuestion(id);
      state.questions = state.questions.filter(q => q.id !== id);
      state.historyCounts.set(id, (state.historyCounts.get(id) || 0) + 1);
      okN++;
    } catch { badN++; }
  }
  state.selected.clear();
  if (includesCurrent) { state.current = null; state.currentId = null; state.dirty = false; }
  toast(badN ? "warn" : "ok", `Deleted ${okN}`, badN ? `${badN} failed` : "");
  render();
}

function bulkExport() {
  const ids = state.selected;
  const rows = state.questions.filter(q => ids.has(q.id)).map(q => ({
    id: q.id, question: q.question, options: q.options, correct: q.correct,
    topic: q.topic, license: q.license || [], image_path: q.image_path || null,
  }));
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  downloadBlob(blob, `questions-selection-${rows.length}-${ts}.json`);
  toast("ok", `Exported ${rows.length}`, "Downloaded as JSON");
}

async function flushSave() {
  if (!state.dirty || !state.current) return;
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  const snapshot = deepClone(state.current);
  try {
    const saved = await updateQuestion(snapshot.id, {
      question: snapshot.question,
      options: snapshot.options,
      correct: snapshot.correct,
      topic: snapshot.topic,
      topics: topicsOf(snapshot),
      license: snapshot.license,
      image_path: snapshot.image_path || null,
    });
    state.dirty = false;
    // Replace local copy with what server returned
    const idx = state.questions.findIndex(q => q.id === saved.id);
    if (idx >= 0) state.questions[idx] = saved;
    if (state.currentId === saved.id) state.current = deepClone(saved);
    state.historyCounts.set(saved.id, (state.historyCounts.get(saved.id) || 0) + 1);
    render();
  } catch (e) {
    toast("bad", "Couldn't save", e.message || String(e));
  }
}

async function duplicateCurrent() {
  if (state.dirty) await flushSave();
  if (!state.current) return;
  try {
    const copy = await createQuestion({
      question: state.current.question,
      options: state.current.options,
      correct: state.current.correct,
      topic: state.current.topic,
      topics: topicsOf(state.current),
      license: state.current.license,
      image_path: state.current.image_path || null,
    });
    state.questions.push(copy);
    state.historyCounts.set(copy.id, 1);
    selectQuestion(copy.id);
    toast("ok", "Duplicated");
  } catch (e) {
    toast("bad", "Couldn't duplicate", e.message || String(e));
  }
}

async function createNew() {
  if (state.dirty) await flushSave();
  try {
    const created = await createQuestion({
      question: "Întrebare nouă",
      options: ["", "", ""],
      correct: 0,
      topic: "seamanship",
      license: ["C"],
    });
    state.questions.push(created);
    state.historyCounts.set(created.id, 1);
    selectQuestion(created.id);
    setTimeout(() => {
      const ta = document.getElementById("f-question");
      if (ta) { ta.focus(); ta.select(); }
    }, 50);
  } catch (e) {
    toast("bad", "Couldn't create", e.message || String(e));
  }
}

async function deleteCurrent() {
  if (!state.current) return;
  const preview = state.current.question.slice(0, 100);
  const ok = await confirmModal({
    title: "Delete this question?",
    body: `"${preview}${state.current.question.length > 100 ? "…" : ""}"\n\nThe deletion stays in history — you can revert it.`,
    confirmText: "Delete",
  });
  if (!ok) return;
  const id = state.current.id;
  try {
    await deleteQuestion(id);
    state.questions = state.questions.filter(q => q.id !== id);
    state.historyCounts.set(id, (state.historyCounts.get(id) || 0) + 1);
    state.dirty = false;
    if (state.questions.length) {
      const next = state.questions.find(q => q.id > id) || state.questions[state.questions.length - 1];
      selectQuestion(next.id);
    } else {
      state.current = null; state.currentId = null;
      render();
    }
    toast("ok", "Deleted");
  } catch (e) {
    toast("bad", "Couldn't delete", e.message || String(e));
  }
}

// ─────────────── deploy (Storage) ───────────────
const PREVIEW_POINTER = "current-preview.json";
const PROD_POINTER = "current.json";

async function readPointer(path) {
  try {
    const { data: ptr } = await supabase.storage.from("questions").download(path);
    if (!ptr) return null;
    const txt = await ptr.text();
    return JSON.parse(txt);
  } catch { return null; }
}

/** Publish to the preview channel: writes a new v{N}.json blob and updates
 * current-preview.json. Production (current.json) is untouched until the
 * user explicitly promotes. */
async function publishToPreview() {
  if (state.dirty) await flushSave();
  const ok = await confirmModal({
    title: "Publish to preview?",
    body: `Snapshots all ${state.questions.length} questions and points the preview pointer at it. Production (Play Store builds) keeps serving the current prod bundle.`,
    confirmText: "Publish preview",
  });
  if (!ok) return;
  const btn = document.getElementById("deploy-btn");
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:currentColor;animation:pulse 1s infinite alternate"></span>Publishing…`;
  try {
    const payload = [...state.questions]
      .sort((a, b) => a.id - b.id)
      .map((q) => ({
        id: q.id,
        question: q.question,
        options: q.options,
        correct: q.correct,
        // Keep `topic` (legacy single-value) populated with the primary
        // for back-compat with the currently-shipped mobile builds.
        topic: primaryTopic(q),
        topics: topicsOf(q),
        license: q.license || [],
        image_path: q.image_path || null,
      }));

    // Version comes from the highest of (preview, prod) so blobs don't
    // collide and so a promote never overwrites an older v{N}.json.
    const [prev, prod] = await Promise.all([readPointer(PREVIEW_POINTER), readPointer(PROD_POINTER)]);
    const version = Math.max(prev?.version || 0, prod?.version || 0) + 1;

    const blobName = `v${version}.json`;
    const body = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const sha = await sha256Hex(await body.arrayBuffer());

    const { error: e1 } = await supabase.storage.from("questions").upload(blobName, body, { upsert: true, contentType: "application/json" });
    if (e1) throw e1;

    const pointer = {
      version,
      uploaded_at: new Date().toISOString(),
      count: payload.length,
      sha256: sha,
      blob: blobName,
      channel: "preview",
    };
    const ptrBody = new Blob([JSON.stringify(pointer, null, 2)], { type: "application/json" });
    const { error: e2 } = await supabase.storage.from("questions").upload(PREVIEW_POINTER, ptrBody, { upsert: true, contentType: "application/json" });
    if (e2) throw e2;

    toast("ok", `Preview v${version}`, `${payload.length} questions · sha ${sha.slice(0, 12)}…`);
    await refreshChannelPills();
  } catch (e) {
    toast("bad", "Publish failed", e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/** Promote: copy the preview pointer's blob reference into current.json.
 * No re-upload, no re-snapshot — production starts serving whatever
 * preview was serving. */
async function promoteToProduction() {
  const prev = await readPointer(PREVIEW_POINTER);
  if (!prev || !prev.blob) {
    toast("bad", "Nothing to promote", "Publish to preview first.");
    return;
  }
  const ok = await confirmModal({
    title: "Promote preview to production?",
    body: `Production will start serving preview v${prev.version} (${prev.count} questions, sha ${prev.sha256?.slice(0, 12)}…). The Play Store build picks this up on next launch.`,
    confirmText: `Promote v${prev.version}`,
  });
  if (!ok) return;
  const btn = document.getElementById("promote-btn");
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:currentColor;animation:pulse 1s infinite alternate"></span>Promoting…`;
  try {
    const prodPointer = { ...prev, uploaded_at: new Date().toISOString(), channel: "production" };
    const ptrBody = new Blob([JSON.stringify(prodPointer, null, 2)], { type: "application/json" });
    const { error } = await supabase.storage.from("questions").upload(PROD_POINTER, ptrBody, { upsert: true, contentType: "application/json" });
    if (error) throw error;
    toast("ok", `Promoted v${prev.version}`, "Production now serves the preview bundle.");
    await refreshChannelPills();
  } catch (e) {
    toast("bad", "Promote failed", e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/** Render small `preview vN · prod vM` indicator pills in the header so the
 * difference between the two channels is always visible. */
async function refreshChannelPills() {
  const host = document.getElementById("channel-pills");
  if (!host) return;
  const [prev, prod] = await Promise.all([readPointer(PREVIEW_POINTER), readPointer(PROD_POINTER)]);
  const pv = prev?.version ? `v${prev.version}` : "—";
  const pp = prod?.version ? `v${prod.version}` : "—";
  const drift = prev?.version && prod?.version && prev.version !== prod.version;
  host.innerHTML = `
    <span class="channel-pill ${drift ? "ahead" : ""}" title="Preview pointer (internal builds)">preview ${pv}</span>
    <span class="channel-pill" title="Production pointer (Play Store)">prod ${pp}</span>
  `;
  try { syncOverviewChannels(); } catch {}
}

// ─────────────── shell wiring ───────────────
function attachShell() {
  // Topbar
  document.getElementById("deploy-btn").onclick = () => publishToPreview();
  document.getElementById("promote-btn").onclick = () => promoteToProduction();
  refreshChannelPills();
  document.getElementById("logout-btn").onclick = () => onLogout();
  document.getElementById("cmdk-btn").onclick = () => openCmdK();
  document.getElementById("integrity-btn").onclick = () => toggleIntegrityDrawer();
  document.getElementById("theme-toggle-btn").onclick = () => toggleTheme();
  applyThemeLabel();
  document.querySelectorAll("[data-focus-toggle]").forEach(b => { b.onclick = () => toggleFocusMode(); });

  // User-chip dropdown
  const userBtn = document.getElementById("user-chip-btn");
  const userMenu = document.getElementById("user-chip-menu");
  userBtn.onclick = (e) => { e.stopPropagation(); userMenu.classList.toggle("hidden"); };
  document.addEventListener("click", e => {
    if (!userMenu.classList.contains("hidden") && !userMenu.contains(e.target) && e.target !== userBtn) {
      userMenu.classList.add("hidden");
    }
  });

  // Rail
  document.getElementById("rail-toggle").onclick = () => toggleRail();
  document.querySelectorAll(".rail-item[data-page]").forEach(b => {
    b.onclick = () => goPage(b.dataset.page);
  });
  document.getElementById("rail-reports").onclick = () => openReports();

  // Questions sidebar (existing 3-pane)
  document.getElementById("new-btn").onclick = () => createNew();
  const ft = document.getElementById("filters-toggle");
  if (ft) ft.onclick = () => toggleFiltersCollapse();
  applyFiltersCollapsedFromStorage();

  // Course page toolbar
  const cBack = document.getElementById("course-back-btn");
  const cJsonInp = document.getElementById("course-json-input");
  const cImgBtn = document.getElementById("course-imgs-btn");
  const cImgInp = document.getElementById("course-img-input");
  const cEdit = document.getElementById("course-edit-btn");
  const cPub = document.getElementById("course-publish-btn");
  const cDl = document.getElementById("course-download-btn");
  if (cBack) cBack.onclick = () => backToModulesList();
  if (cJsonInp) cJsonInp.onchange = (e) => loadCourseModuleFile(e.target.files?.[0]);
  const cZipInp = document.getElementById("course-zip-input");
  if (cZipInp) cZipInp.onchange = (e) => loadCourseModuleZip(e.target.files?.[0]);
  const cImgBulk = document.getElementById("course-img-bulk-input");
  if (cImgBulk) cImgBulk.onchange = (e) => bulkUploadCourseImages([...e.target.files]);
  const cImgRepl = document.getElementById("course-img-replace-input");
  if (cImgRepl) cImgRepl.onchange = (e) => {
    const f = e.target.files?.[0];
    const target = e.target.dataset.targetName;
    if (f && target) replaceCourseImage(target, f);
  };
  if (cImgBtn) cImgBtn.onclick = () => cImgInp.click();
  if (cImgInp) cImgInp.onchange = async (e) => {
    const files = [...e.target.files];
    if (!_course.mod) { toast("warn", "Open a module first"); return; }
    let okN = 0;
    for (const f of files) {
      if (await uploadCourseImageToBucket(f, _course.mod.id)) okN++;
    }
    toast("ok", `${okN}/${files.length} uploaded`, `to course-images/${_course.mod.id}/`);
    if (_course.editMode) renderCoursePage();
  };
  if (cEdit) cEdit.onclick = () => toggleCourseEditMode();
  if (cPub) cPub.onclick = () => publishActiveCourseModule();
  if (cDl) cDl.onclick = () => {
    if (!_course.mod) return;
    if (_course.mod._virtual) { toast("warn", "Read-only", "Virtual modules can't be downloaded."); return; }
    downloadCourseModuleZip(_course.mod.id);
  };

  // Images page (now routed)
  document.getElementById("images-search").addEventListener("input", () => renderImagesPage());
  document.getElementById("images-usage").addEventListener("change", () => renderImagesPage());
  document.getElementById("images-upload-btn").onclick = () => openUploadModal({ mode: "new" });
  // Paste from clipboard while on the Images page.
  document.addEventListener("paste", e => {
    if (state.page !== "images") return;
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) {
          e.preventDefault();
          openUploadModal({ mode: "new", blob });
          break;
        }
      }
    }
  });
  attachUploadModalHandlers();

  // Reports drawer
  document.getElementById("reports-close").onclick = () => { closeReports(); renderRail(); };

  // Admins drawer (now opened from Settings → Access; close + add still wired)
  document.getElementById("admins-close").onclick = () => closeAdmins();
  document.getElementById("admins-add").onclick = () => addAdminEmail();
  document.getElementById("admins-new-email").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addAdminEmail(); }
  });
  document.getElementById("admins-modal").addEventListener("click", e => {
    if (e.target.id === "admins-modal") closeAdmins();
  });

  // Image picker drawer
  document.getElementById("image-picker-close").onclick = () => closeImagePicker();
  document.getElementById("image-picker-clear").onclick = () => pickImage(null);
  document.getElementById("image-picker-search").addEventListener("input", e => {
    renderImagePicker(e.target.value);
  });
  document.getElementById("image-picker").addEventListener("click", e => {
    if (e.target.id === "image-picker") closeImagePicker();
  });

  // Import page (now routed)
  const importToggle = document.getElementById("import-filters-toggle");
  if (importToggle) importToggle.onclick = () => toggleImportFiltersCollapse();
  document.getElementById("import-topic").onchange = (e) => {
    state.candidateTopic = e.target.value;
    refreshCandidates();
  };
  document.querySelectorAll("#page-import [data-status]").forEach(b => {
    b.onclick = () => {
      state.candidateStatus = b.dataset.status;
      document.querySelectorAll("#page-import [data-status]").forEach(x => x.classList.toggle("active", x === b));
      refreshCandidates();
    };
  });
  document.getElementById("recompute-similars-btn").onclick = async (e) => {
    const btn = e.currentTarget;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 0.7s linear infinite"></span> Recomputing…`;
    try {
      const { data, error } = await supabase.rpc("recompute_pending_similars", { p_threshold: 0.3, p_limit: 5 });
      if (error) throw error;
      const row = (data && data[0]) || { changed: 0, gained: 0, lost: 0 };
      toast("ok", "Similars recomputed", `${row.changed} changed · ${row.gained} gained · ${row.lost} lost`);
      await refreshCandidates();
    } catch (err) {
      toast("bad", "Recompute failed", err?.message || String(err));
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  };
  document.querySelectorAll("#reports-modal [data-filter]").forEach(b => {
    b.onclick = () => {
      state.reportsFilter = b.dataset.filter;
      document.querySelectorAll("#reports-modal [data-filter]").forEach(x => x.classList.toggle("active", x === b));
      refreshReports();
    };
  });
  document.getElementById("reports-modal").addEventListener("click", e => {
    if (e.target.id === "reports-modal") closeReports();
  });
  document.querySelectorAll("#tabs .tab").forEach(t => {
    t.onclick = () => {
      state.tab = t.dataset.tab;
      document.querySelectorAll("#tabs .tab").forEach(x => x.classList.toggle("active", x === t));
      renderTabContent();
    };
  });

  // Sidebar interactions
  const searchEl = document.getElementById("search");
  searchEl.addEventListener("input", () => {
    state.searchTerm = searchEl.value;
    document.getElementById("search-clear").style.display = state.searchTerm ? "" : "none";
    state.selected.clear();
    renderList(); renderBulkBar();
  });
  document.getElementById("search-clear").onclick = () => {
    searchEl.value = ""; state.searchTerm = "";
    document.getElementById("search-clear").style.display = "none";
    state.selected.clear();
    renderList(); renderBulkBar(); searchEl.focus();
  };
  document.getElementById("lic-filter").querySelectorAll(".lic-pill").forEach(b => {
    b.onclick = () => {
      state.filterLic = b.dataset.l;
      document.querySelectorAll("#lic-filter .lic-pill").forEach(x => x.classList.toggle("active", x === b));
      state.selected.clear();
      renderList(); renderBulkBar();
    };
  });

  attachBulkBar();
  const sn = document.getElementById("save-next-btn");
  if (sn) sn.onclick = () => saveAndNext();

  // Global shortcuts
  document.addEventListener("keydown", e => {
    const inField = e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT";
    const cmd = e.metaKey || e.ctrlKey;
    // ⌘K opens the command palette anywhere
    if (cmd && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      openCmdK();
      return;
    }
    // "/" opens cmdk when not in a field; otherwise yields to input focus
    if (e.key === "/" && !inField) { e.preventDefault(); openCmdK(); return; }
    // Question-manager shortcuts only on the Questions page
    if (state.page !== "questions") return;
    if (cmd && (e.key === "s" || e.key === "S")) { e.preventDefault(); flushSave(); return; }
    if (cmd && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateCurrent(); return; }
    if (cmd && e.key === "Backspace") { e.preventDefault(); deleteCurrent(); return; }
    if (inField) return;
    const focusedLi = e.target?.closest?.("#qlist li");
    if (e.key === " " && focusedLi) {
      e.preventDefault();
      const id = parseInt(focusedLi.dataset.id, 10);
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      const cb = focusedLi.querySelector("input[type=checkbox]");
      if (cb) cb.checked = state.selected.has(id);
      renderBulkBar();
      return;
    }
    const list = visibleQuestions();
    const idx = list.findIndex(q => q.id === state.currentId);
    if (e.key === "ArrowDown" || e.key === "j") {
      if (idx < list.length - 1) selectQuestion(list[idx + 1].id);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      if (idx > 0) selectQuestion(list[idx - 1].id);
    } else if (e.key === "n" || e.key === "N") createNew();
    else if (e.key === "Escape") document.activeElement?.blur();
  });

  // Flush save on tab close
  window.addEventListener("beforeunload", () => { if (state.dirty) flushSave(); });
}

// ─────────────── modal / toast / utils ───────────────
function confirmModal({ title, body, confirmText = "Confirm" }) {
  return new Promise(resolve => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" role="dialog">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
        <div class="actions">
          <button class="btn ghost" data-act="cancel">Cancel</button>
          <button class="btn primary" data-act="ok">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    function close(v) { document.body.removeChild(backdrop); resolve(v); }
    backdrop.onclick = e => { if (e.target === backdrop) close(false); };
    backdrop.querySelector('[data-act="cancel"]').onclick = () => close(false);
    backdrop.querySelector('[data-act="ok"]').onclick = () => close(true);
    backdrop.querySelector('[data-act="ok"]').focus();
  });
}

function toast(kind, title, body) {
  const host = document.getElementById("toast-host");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${escapeHtml(title)}</b>${body ? `<pre>${escapeHtml(body)}</pre>` : ""}`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.animation = "slideIn .25s ease-out reverse";
    setTimeout(() => el.remove(), 240);
  }, kind === "bad" ? 8000 : 4000);
}

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

/** In-memory version history per loaded question. Each version stores a
 * snapshot of {question, options, correct}. The "Original" entry is the
 * pristine load from the DB; "My edit" is auto-captured before an AI fix
 * if the live state has diverged from the latest version; "AI fix" is the
 * model output. Lost on reload — this is a session helper, not persisted. */
function seedVersions(obj) {
  if (obj._versions && obj._versions.length) return;
  obj._versions = [{
    label: "Original",
    question: obj.question,
    options: [...obj.options],
    correct: obj.correct,
  }];
  obj._versionIdx = 0;
}
function currentSnapshotMatches(obj, v) {
  if (!v) return false;
  if (obj.question !== v.question) return false;
  if ((obj.options || []).length !== (v.options || []).length) return false;
  for (let i = 0; i < obj.options.length; i++) {
    if (obj.options[i] !== v.options[i]) return false;
  }
  if (obj.correct !== v.correct) return false;
  return true;
}
function pushVersion(obj, label) {
  obj._versions.push({
    label,
    question: obj.question,
    options: [...obj.options],
    correct: obj.correct,
  });
  obj._versionIdx = obj._versions.length - 1;
}
function loadVersion(obj, idx) {
  const v = obj._versions[idx];
  if (!v) return false;
  obj.question = v.question;
  obj.options = [...v.options];
  obj.correct = v.correct;
  obj._versionIdx = idx;
  return true;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function stringify(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(" / ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
/** Render a candidate's question + options in a compact text format
 * suitable for pasting into a chat-style AI to double-check the marked
 * answer. Kept short so it fits in a single message and stays readable. */
function formatForAi(c) {
  const lines = [];
  lines.push("Verifica daca raspunsul marcat este corect pentru aceasta intrebare din examenul de conducator ambarcatiune (CAA, Romania):");
  lines.push("");
  lines.push(`Intrebare: ${c.question}`);
  lines.push("Variante:");
  (c.options || []).forEach((opt, i) => {
    const letter = String.fromCharCode(65 + i);
    const marker = i === c.correct ? "  ← MARCAT CA CORECT" : "";
    lines.push(`  ${letter}) ${opt}${marker}`);
  });
  if (c.image_path) lines.push(`(Intrebarea are imagine atasata: ${c.image_path})`);
  lines.push("");
  lines.push(`Topic: ${topicsOf(c).join(", ")}`);
  lines.push("");
  lines.push("Confirma daca raspunsul marcat este cel corect, sau spune-mi care ar trebui sa fie.");
  return lines.join("\n");
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch { return iso; }
}
async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────── admins management ───────────────
async function openAdmins() {
  if (!state.isOwner) { toast("bad", "Forbidden", "Only owners can manage the admin list."); return; }
  document.getElementById("admins-modal").classList.remove("hidden");
  await refreshAdmins();
}
function closeAdmins() {
  document.getElementById("admins-modal").classList.add("hidden");
}
async function refreshAdmins() {
  const body = document.getElementById("admins-body");
  body.innerHTML = `<div class="placeholder">Loading…</div>`;
  const { data, error } = await supabase
    .from("admins")
    .select("email, added_at, added_by")
    .order("added_at", { ascending: true });
  if (error) { toast("bad", "Couldn't load admins", error.message); return; }
  const me = state.user?.email;
  if (!data || data.length === 0) {
    body.innerHTML = `<div class="report-empty">No admins yet — that shouldn't happen.</div>`;
    return;
  }
  body.innerHTML = data.map(a => `
    <div class="report-card" style="display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-family:ui-monospace,monospace;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.email)}${a.email === me ? `<span class="cand-tag" style="margin-left:8px">you</span>` : ""}</div>
        <div class="muted small" style="margin-top:4px">added ${formatDate(a.added_at)} by ${escapeHtml(a.added_by || "—")}</div>
      </div>
      ${a.email === me
        ? `<button class="btn ghost" disabled title="Can't remove yourself — ask another admin">Remove</button>`
        : `<button class="btn ghost" data-remove-admin="${escapeHtml(a.email)}">Remove</button>`}
    </div>`).join("");
  body.querySelectorAll("[data-remove-admin]").forEach(b => {
    b.onclick = async () => {
      const email = b.dataset.removeAdmin;
      if (!confirm(`Remove ${email} from admins? They'll be signed out on next refresh.`)) return;
      b.disabled = true;
      const { error } = await supabase.from("admins").delete().eq("email", email);
      if (error) { toast("bad", "Couldn't remove", error.message); b.disabled = false; return; }
      toast("ok", "Removed", email);
      await refreshAdmins();
    };
  });
}
async function addAdminEmail() {
  const input = document.getElementById("admins-new-email");
  const email = input.value.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    toast("bad", "Invalid email", "Type a valid email first.");
    return;
  }
  const btn = document.getElementById("admins-add");
  btn.disabled = true;
  const { error } = await supabase
    .from("admins")
    .insert({ email, added_by: state.user?.email ?? null });
  btn.disabled = false;
  if (error) { toast("bad", "Couldn't add", error.message); return; }
  input.value = "";
  toast("ok", "Added", `${email} can sign in now (after creating an Auth account in Supabase).`);
  await refreshAdmins();
}

// ─────────────── image picker ───────────────
let _imageList = null;
async function listBucketImages(force = false) {
  if (_imageList && !force) return _imageList;
  // List the question-images bucket via the Storage API
  const { data, error } = await supabase.storage.from("question-images").list("", { limit: 1000 });
  if (error) { toast("bad", "Couldn't list images", error.message); return []; }
  _imageList = (data || []).filter(o => !o.name.startsWith(".")).map(o => o.name).sort();
  return _imageList;
}
// What the image picker writes back to when a tile is clicked.
//   { kind: "candidate", id }  → write to state.candidates[*].image_path
//   { kind: "question" }       → write to state.current.image_path + mark dirty
let _imagePickerTarget = null;
async function openImagePicker(target) {
  // Back-compat: callers that used to pass a bare candidate id still work.
  _imagePickerTarget = typeof target === "number"
    ? { kind: "candidate", id: target }
    : target;
  document.getElementById("image-picker").classList.remove("hidden");
  document.getElementById("image-picker-search").value = "";
  await renderImagePicker("");
}
function closeImagePicker() {
  document.getElementById("image-picker").classList.add("hidden");
  _imagePickerTarget = null;
}
async function renderImagePicker(filter) {
  const body = document.getElementById("image-picker-body");
  body.innerHTML = `<div class="placeholder" style="grid-column:1/-1">Loading…</div>`;
  const all = await listBucketImages();
  const f = (filter || "").toLowerCase();
  const filtered = f ? all.filter(n => n.toLowerCase().includes(f)) : all;
  body.innerHTML = filtered.map(name =>
    `<div class="image-tile" data-pick="${escapeHtml(name)}">
       <img src="${imageUrl(name)}" alt="${escapeHtml(name)}" loading="lazy" />
       <div class="name">${escapeHtml(name)}</div>
     </div>`
  ).join("");
  body.querySelectorAll("[data-pick]").forEach(el => {
    el.onclick = () => pickImage(el.dataset.pick);
  });
}
function pickImage(name) {
  const target = _imagePickerTarget;
  if (!target) { closeImagePicker(); return; }
  closeImagePicker();
  if (target.kind === "question") {
    if (!state.current) return;
    state.current.image_path = name || null;
    markDirty();
    renderEditor();
  } else if (target.kind === "candidate") {
    const c = state.candidates.find(x => x.id === target.id);
    if (c) c.image_path = name || null;
    renderCandidates();
  }
}

// ─────────────── image gallery (full-screen manager) ───────────────
let _imagesUsage = null;  // { filename: { questions: n, candidates: n } }
let _imagesPageOpen = false;

async function openImagesPage() { goPage("images"); }
function closeImagesPage() { goPage("questions"); }
async function onImagesPageOpen() {
  _imagesPageOpen = true;
  await refreshImageUsage();
  await renderImagesPage();
}

/** Build {filename → {questions, candidates}} so each tile can show how
 * many published questions and pending candidates reference it. */
async function refreshImageUsage() {
  _imagesUsage = {};
  const [{ data: qs }, { data: cs }] = await Promise.all([
    supabase.from("questions").select("image_path").not("image_path", "is", null),
    supabase.from("question_candidates").select("image_path").not("image_path", "is", null),
  ]);
  for (const r of qs || []) {
    const k = r.image_path;
    _imagesUsage[k] = _imagesUsage[k] || { questions: 0, candidates: 0 };
    _imagesUsage[k].questions++;
  }
  for (const r of cs || []) {
    const k = r.image_path;
    _imagesUsage[k] = _imagesUsage[k] || { questions: 0, candidates: 0 };
    _imagesUsage[k].candidates++;
  }
}

async function renderImagesPage() {
  const body = document.getElementById("images-body");
  const summary = document.getElementById("images-summary");
  const all = await listBucketImages(true);
  const filter = (document.getElementById("images-search")?.value || "").toLowerCase();
  const usage = document.getElementById("images-usage")?.value || "all";
  const rows = all.filter(name => {
    if (filter && !name.toLowerCase().includes(filter)) return false;
    const u = _imagesUsage[name];
    const totalRefs = (u?.questions || 0) + (u?.candidates || 0);
    if (usage === "used"   && totalRefs === 0) return false;
    if (usage === "unused" && totalRefs > 0)   return false;
    return true;
  });

  const orphans = all.filter(n => !((_imagesUsage[n]?.questions || 0) + (_imagesUsage[n]?.candidates || 0))).length;
  summary.textContent = `${rows.length} of ${all.length} images${filter || usage !== "all" ? ` (filtered)` : ""} · ${orphans} orphan${orphans === 1 ? "" : "s"}`;

  if (!rows.length) {
    body.innerHTML = `<div class="placeholder" style="padding:32px;color:var(--muted)">No images match.</div>`;
    return;
  }
  body.innerHTML = `<div class="images-grid">${rows.map(name => {
    const u = _imagesUsage[name] || { questions: 0, candidates: 0 };
    const refs = u.questions + u.candidates;
    const refBadge = refs === 0
      ? `<span class="img-badge orphan" title="No questions or candidates reference this image">orphan</span>`
      : `<span class="img-badge used" title="${u.questions} published question${u.questions === 1 ? "" : "s"} + ${u.candidates} pending candidate${u.candidates === 1 ? "" : "s"} — renaming will update them all automatically">
           <span class="img-badge-num">${u.questions}</span> q
           ${u.candidates ? `· <span class="img-badge-num">${u.candidates}</span> cand` : ""}
         </span>`;
    return `
      <div class="image-card" data-name="${escapeHtml(name)}">
        <div class="image-card-thumb">
          <img src="${imageUrl(name)}" alt="${escapeHtml(name)}" loading="lazy" />
          <div class="image-card-overlay">
            <button class="img-action" data-replace="${escapeHtml(name)}" title="Upload a new file under this same name">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Replace
            </button>
            <button class="img-action" data-rename="${escapeHtml(name)}" title="Rename — all references will be updated">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              Rename
            </button>
          </div>
        </div>
        <div class="image-card-body">
          <div class="image-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="image-card-meta">${refBadge}</div>
        </div>
      </div>`;
  }).join("")}</div>`;

  body.querySelectorAll("[data-rename]").forEach(b => {
    b.onclick = () => promptRenameImage(b.dataset.rename);
  });
  body.querySelectorAll("[data-replace]").forEach(b => {
    b.onclick = () => promptReplaceImage(b.dataset.replace);
  });
}

/** Open the hidden file input but route the resulting blob through the
 * uploader as a *replace* of the given existing name (upsert keeps the
 * filename so every DB reference automatically points at the new bytes). */
function promptReplaceImage(targetName) {
  openUploadModal({ mode: "replace", targetName });
}

// ─────────────── upload modal (drop / paste / pick) ───────────────
const _upload = {
  open: false,
  mode: "new",          // "new" | "replace"
  targetName: null,     // when mode === "replace"
  blob: null,           // currently chosen blob/file
  previewUrl: null,
};

function openUploadModal({ mode, targetName = null, blob = null }) {
  _upload.open = true;
  _upload.mode = mode;
  _upload.targetName = targetName;
  setUploadBlob(blob);
  const title = mode === "replace"
    ? `Replace ${targetName}`
    : "Upload new image";
  document.getElementById("upload-modal-title").textContent = title;
  // When replacing, lock the filename to the existing name.
  const filenameInput = document.getElementById("upload-filename");
  const filenameLabel = filenameInput.parentElement;
  if (mode === "replace") {
    filenameInput.value = targetName;
    filenameInput.disabled = true;
    filenameLabel.style.display = "none";
  } else {
    filenameInput.disabled = false;
    filenameLabel.style.display = "";
    filenameInput.value = blob ? (blob.name || guessFilename(blob)) : "";
  }
  document.getElementById("upload-modal").classList.remove("hidden");
  if (mode === "new" && !blob) setTimeout(() => filenameInput.focus(), 50);
}

function closeUploadModal() {
  _upload.open = false;
  if (_upload.previewUrl) { URL.revokeObjectURL(_upload.previewUrl); _upload.previewUrl = null; }
  _upload.blob = null;
  document.getElementById("upload-modal").classList.add("hidden");
}

function setUploadBlob(blob) {
  if (_upload.previewUrl) URL.revokeObjectURL(_upload.previewUrl);
  _upload.blob = blob || null;
  _upload.previewUrl = blob ? URL.createObjectURL(blob) : null;
  const empty   = document.getElementById("upload-dz-empty");
  const preview = document.getElementById("upload-dz-preview");
  const confirm = document.getElementById("upload-confirm-btn");
  if (blob) {
    empty.classList.add("hidden");
    preview.classList.remove("hidden");
    document.getElementById("upload-preview-img").src = _upload.previewUrl;
    const kb = (blob.size / 1024).toFixed(1);
    document.getElementById("upload-preview-meta").textContent =
      `${blob.name || "(pasted)"} · ${blob.type || "image"} · ${kb} KB`;
    confirm.disabled = false;
    if (_upload.mode === "new") {
      const inp = document.getElementById("upload-filename");
      if (!inp.value) inp.value = blob.name || guessFilename(blob);
    }
  } else {
    empty.classList.remove("hidden");
    preview.classList.add("hidden");
    confirm.disabled = true;
  }
}

function attachUploadModalHandlers() {
  const modal   = document.getElementById("upload-modal");
  const dz      = document.getElementById("upload-dropzone");
  const fileIn  = document.getElementById("upload-file-input");

  document.getElementById("upload-modal-close").onclick = closeUploadModal;
  document.getElementById("upload-cancel-btn").onclick = closeUploadModal;
  document.getElementById("upload-pick-btn").onclick = () => fileIn.click();
  document.getElementById("upload-clear-btn").onclick = () => setUploadBlob(null);
  fileIn.addEventListener("change", e => {
    const files = [...(e.target.files || [])].filter(x => x.type?.startsWith("image/"));
    e.target.value = "";
    if (files.length > 1 && _upload.mode === "new") {
      batchUploadImages(files);
    } else if (files[0]) {
      setUploadBlob(files[0]);
    }
  });

  // Click backdrop to close
  modal.addEventListener("click", e => { if (e.target === modal) closeUploadModal(); });

  // Drag & drop on the dropzone
  ["dragenter", "dragover"].forEach(t => dz.addEventListener(t, e => {
    e.preventDefault(); dz.classList.add("dragover");
  }));
  ["dragleave", "dragend", "drop"].forEach(t => dz.addEventListener(t, e => {
    e.preventDefault(); dz.classList.remove("dragover");
  }));
  dz.addEventListener("drop", e => {
    const files = [...(e.dataTransfer?.files || [])].filter(x => x.type?.startsWith("image/"));
    if (files.length > 1 && _upload.mode === "new") {
      batchUploadImages(files);
    } else if (files[0]) {
      setUploadBlob(files[0]);
    }
  });

  // Paste anywhere in the modal
  modal.addEventListener("paste", e => {
    if (!_upload.open) return;
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type?.startsWith("image/")) {
        const blob = it.getAsFile();
        if (blob) { e.preventDefault(); setUploadBlob(blob); break; }
      }
    }
  });

  document.getElementById("upload-confirm-btn").onclick = doUpload;

  // ⎋ closes
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && _upload.open) closeUploadModal();
  });
}

async function doUpload() {
  if (!_upload.blob) return;
  const isReplace = _upload.mode === "replace";
  const name = isReplace
    ? _upload.targetName
    : document.getElementById("upload-filename").value.trim();
  if (!isReplace) {
    if (!/^[A-Za-z0-9._\-]+$/.test(name)) {
      toast("bad", "Bad filename", "Use only letters, digits, dot, dash, underscore.");
      return;
    }
    const all = await listBucketImages();
    if (all.includes(name)) {
      const ok = confirm(`"${name}" already exists. Overwrite it?`);
      if (!ok) return;
    }
  }
  const btn = document.getElementById("upload-confirm-btn");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Uploading…";
  const { error } = await supabase.storage
    .from("question-images")
    .upload(name, _upload.blob, { upsert: true, contentType: _upload.blob.type || "image/jpeg", cacheControl: "0" });
  btn.disabled = false;
  btn.textContent = orig;
  if (error) { toast("bad", "Upload failed", error.message); return; }
  bumpImageVersion(name);
  toast("ok", isReplace ? "Replaced" : "Uploaded", name);
  closeUploadModal();
  _imageList = null;
  await refreshImageUsage();
  if (_imagesPageOpen) renderImagesPage();
}

async function batchUploadImages(files) {
  // Bulk-upload to question-images using each file's own name. No naming UI;
  // the user has signaled batch intent by picking/dropping multiple files.
  if (!files?.length) return;
  const bad = files.filter(f => !/^[A-Za-z0-9._\-]+$/.test(f.name));
  if (bad.length) {
    toast("bad", `${bad.length} file(s) have invalid names`, "Allowed: letters, digits, dot, dash, underscore.");
    return;
  }
  const btn = document.getElementById("upload-confirm-btn");
  const orig = btn.textContent;
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    btn.textContent = `Uploading ${i + 1}/${files.length}…`;
    const { error } = await supabase.storage
      .from("question-images")
      .upload(f.name, f, { upsert: true, contentType: f.type || "image/jpeg", cacheControl: "0" });
    if (error) { fail++; console.warn("upload failed", f.name, error); }
    else { ok++; bumpImageVersion(f.name); }
  }
  btn.textContent = orig;
  btn.disabled = false;
  closeUploadModal();
  _imageList = null;
  await refreshImageUsage();
  if (_imagesPageOpen) renderImagesPage();
  toast(fail ? "warn" : "ok", `${ok}/${files.length} uploaded`, fail ? `${fail} failed` : "question-images bucket");
}

function guessFilename(blob) {
  const ext = (blob.type || "image/png").split("/")[1]?.split("+")[0] || "png";
  const ts = new Date().toISOString().replace(/[:T.]/g, "-").slice(0, 19);
  return `pasted-${ts}.${ext}`;
}

async function promptRenameImage(oldName) {
  const u = _imagesUsage[oldName] || { questions: 0, candidates: 0 };
  const refs = u.questions + u.candidates;
  const msg = refs === 0
    ? `Rename "${oldName}" → ?\n\nNo questions or candidates reference this image.`
    : `Rename "${oldName}" → ?\n\nLinked to ${u.questions} published question${u.questions === 1 ? "" : "s"}`
      + (u.candidates ? ` and ${u.candidates} pending candidate${u.candidates === 1 ? "" : "s"}` : "")
      + `. Every reference will be updated to the new filename in the same operation, so nothing breaks.`;
  const proposed = prompt(msg, oldName);
  if (!proposed || proposed === oldName) return;
  const newName = proposed.trim();
  if (!/^[A-Za-z0-9._\-]+$/.test(newName)) {
    toast("bad", "Bad filename", "Use only letters, digits, dot, dash, underscore.");
    return;
  }
  const all = await listBucketImages();
  if (all.includes(newName)) {
    toast("bad", "Already exists", `"${newName}" is already in the bucket.`);
    return;
  }
  await renameImage(oldName, newName);
}

/** Storage move + DB reference updates. The storage move is the only
 * destructive step — if it succeeds, follow with DB updates; the worst
 * case is a moved file with stale DB references, which the user can fix
 * by re-running the rename (no-op on the now-missing source filename). */
async function renameImage(oldName, newName) {
  // 1) Storage move
  const { error: mvErr } = await supabase.storage.from("question-images").move(oldName, newName);
  if (mvErr) { toast("bad", "Storage move failed", mvErr.message); return; }
  // 2) Update DB references (best-effort — surfaced as a separate toast if it fails)
  const [{ error: qErr, count: qCount }, { error: cErr, count: cCount }] = await Promise.all([
    supabase.from("questions").update({ image_path: newName }, { count: "exact" }).eq("image_path", oldName),
    supabase.from("question_candidates").update({ image_path: newName }, { count: "exact" }).eq("image_path", oldName),
  ]);
  if (qErr || cErr) {
    toast("bad", "Renamed in storage but DB update failed", (qErr || cErr).message);
  } else {
    toast("ok", "Renamed", `${qCount || 0} question${qCount === 1 ? "" : "s"} + ${cCount || 0} candidate${cCount === 1 ? "" : "s"} updated`);
  }
  // 3) Refresh local state
  _imageList = null;        // bust image-picker cache
  await refreshImageUsage();
  if (_imagesPageOpen) renderImagesPage();
}

// ─────────────── candidate import ───────────────
async function openImport() { goPage("import"); }
function closeImport() { goPage("questions"); }
async function onImportPageOpen() {
  applyImportFiltersCollapsedFromStorage();
  await refreshCandidates();
  renderImportFiltersSummary();
  broadcastFocus();
}

function toggleImportFiltersCollapse() {
  const box = document.getElementById("import-filters-collapse");
  if (!box) return;
  box.classList.toggle("hidden");
  try { localStorage.setItem("caahq-import-filters-open", box.classList.contains("hidden") ? "0" : "1"); } catch {}
}
function applyImportFiltersCollapsedFromStorage() {
  try {
    const open = localStorage.getItem("caahq-import-filters-open") === "1";
    document.getElementById("import-filters-collapse")?.classList.toggle("hidden", !open);
  } catch {}
}

function renderImportFiltersSummary() {
  const countEl = document.getElementById("import-filters-count");
  const sumEl = document.getElementById("import-filters-summary");
  if (!countEl || !sumEl) return;
  const chips = [];
  if (state.candidateTopic) chips.push({ k: "topic", label: labelFor(state.candidateTopic) });
  if (state.candidateStatus && state.candidateStatus !== "pending") chips.push({ k: "status", label: state.candidateStatus });
  if (state.candidateSearch) chips.push({ k: "search", label: `"${state.candidateSearch.slice(0, 16)}${state.candidateSearch.length > 16 ? "…" : ""}"` });
  if (state.candidateSource) chips.push({ k: "source", label: state.candidateSource });
  if (state.candidateLicense) chips.push({ k: "lic", label: state.candidateLicense });
  if (state.candidateSim) chips.push({ k: "sim", label: `sim:${state.candidateSim}` });

  countEl.hidden = chips.length === 0;
  countEl.textContent = String(chips.length);
  sumEl.innerHTML = chips.map(c =>
    `<span class="chip" data-clear="${escapeHtml(c.k)}">${escapeHtml(c.label)}<span class="x" title="Clear">×</span></span>`
  ).join("");
  sumEl.querySelectorAll(".chip").forEach(c => {
    c.querySelector(".x").onclick = () => {
      const k = c.dataset.clear;
      if (k === "topic")   { state.candidateTopic = ""; const sel = document.getElementById("import-topic"); if (sel) sel.value = ""; }
      else if (k === "status") {
        state.candidateStatus = "pending";
        document.querySelectorAll("#page-import [data-status]").forEach(x => x.classList.toggle("active", x.dataset.status === "pending"));
      }
      else if (k === "search") state.candidateSearch = "";
      else if (k === "source") state.candidateSource = "";
      else if (k === "lic") state.candidateLicense = "";
      else if (k === "sim") state.candidateSim = "";
      refreshCandidates();
    };
  });
}
async function refreshCandidates() {
  document.getElementById("cand-list").innerHTML = `<li class="placeholder">Loading…</li>`;
  document.getElementById("cand-workspace").innerHTML = `<div class="placeholder">Loading…</div>`;
  state.candidates = await loadCandidates({ status: state.candidateStatus, topic: state.candidateTopic });
  // Keep selection if still in list, else pick first pending.
  const stillThere = state.candidates.some(c => c.id === state.currentCandidateId);
  if (!stillThere) {
    const first = state.candidates.find(c => c.status === "pending") || state.candidates[0];
    state.currentCandidateId = first ? first.id : null;
  }
  renderCandidates();
  renderImportFiltersSummary();
  await refreshImportCountBadge();
}

function selectCandidate(id) {
  state.currentCandidateId = id;
  const c = state.candidates.find(x => x.id === id);
  if (c) seedVersions(c);
  renderCandidateList();
  renderCandidateWorkspace();
  broadcastFocus();
  // Kick off a live similarity lookup. The precomputed similar_ids were
  // snapshotted at ingest time and miss anything published since (notably,
  // sibling pending candidates that just got accepted). We don't await it
  // here — render again once it arrives.
  if (c && c.status === "pending") refreshLiveSimilars(c);
}

async function refreshLiveSimilars(c) {
  try {
    const { data, error } = await supabase.rpc("find_similar_questions", {
      p_question: c.question,
      p_limit: 5,
      p_threshold: 0.3,
    });
    if (error) throw error;
    c._liveSimilars = data || [];
    if (state.currentCandidateId === c.id) renderCandidateWorkspace();
  } catch (e) {
    // Non-fatal; precomputed similars still show.
    console.warn("live similar lookup failed:", e?.message || e);
  }
}

/** Pick the next candidate after a decision so the reviewer doesn't have to
 * click back into the list every time. Prefers the next item after the one
 * being decided; falls back to the previous one when at end-of-list. */
function advanceToNextCandidate(decidedId) {
  const idx = state.candidates.findIndex(c => c.id === decidedId);
  const next = state.candidates[idx + 1] || state.candidates[idx - 1] || null;
  state.currentCandidateId = next ? next.id : null;
}

/** Locally remove a just-decided candidate from the working list and advance
 * the selection. Avoids the full refreshCandidates() round-trip (which
 * blanks the screen and re-fetches everything). The realtime UPDATE event
 * will still arrive shortly; applyCandidateEvent is idempotent. */
function decideLocally(decidedId) {
  // For "pending"-style filters, the row no longer belongs in the working
  // list; drop it. For the "all" filter we leave it visible.
  const filterIsPending = state.candidateStatus !== "all";
  const idx = state.candidates.findIndex(c => c.id === decidedId);
  let nextId = null;
  if (idx >= 0) {
    const next = state.candidates[idx + 1] || state.candidates[idx - 1];
    nextId = next ? next.id : null;
    if (filterIsPending) state.candidates.splice(idx, 1);
  }
  const wasCurrent = state.currentCandidateId === decidedId;
  if (wasCurrent && nextId != null) {
    // Route through selectCandidate so the new candidate gets a live
    // similarity refresh + versions seeded + presence broadcast — same
    // behavior as clicking the row in the sidebar.
    selectCandidate(nextId);
  } else {
    if (wasCurrent) state.currentCandidateId = null;
    renderCandidates();
  }
  refreshImportCountBadge();
}

function renderCandidates() {
  renderCandidateList();
  renderCandidateWorkspace();
}

/** Render the secondary filter row (search box + source / license / sim
 * dropdowns). Lives below the existing topic+status filter row so it
 * doesn't crowd the header. Built once per refresh from current state. */
function renderCandidateExtraFilters() {
  const host = document.getElementById("import-extra-filters");
  if (!host) return;
  const sources = uniqueSourceFiles();
  const sourceOpts = ['<option value="">All sources</option>']
    .concat(sources.map(s => `<option value="${escapeHtml(s)}" ${state.candidateSource === s ? "selected" : ""}>${escapeHtml(s)}</option>`))
    .join("");
  const licenseOpts = [
    ["", "All licenses"], ["C", "Class C"], ["D", "Class D"], ["C+D", "C ∩ D"],
  ].map(([v, l]) => `<option value="${v}" ${state.candidateLicense === v ? "selected" : ""}>${l}</option>`).join("");
  const simOpts = [
    ["", "Any similarity"],
    ["high", "High match (≥70%)"],
    ["mid",  "Medium (40–70%)"],
    ["low",  "Low (<40%)"],
    ["none", "No matches at all"],
  ].map(([v, l]) => `<option value="${v}" ${state.candidateSim === v ? "selected" : ""}>${l}</option>`).join("");

  host.innerHTML = `
    <input type="text" id="cand-search" class="lic-pill" style="flex:1;min-width:160px;text-align:left;padding:0 12px" placeholder="Search candidates… (diacritics ignored)" value="${escapeHtml(state.candidateSearch)}" />
    <select id="cand-source" class="lic-pill" style="padding:0 24px 0 12px">${sourceOpts}</select>
    <select id="cand-license" class="lic-pill" style="padding:0 24px 0 12px">${licenseOpts}</select>
    <select id="cand-sim" class="lic-pill" style="padding:0 24px 0 12px">${simOpts}</select>
    ${(state.candidateSearch || state.candidateSource || state.candidateLicense || state.candidateSim)
      ? `<button class="lic-pill" id="cand-clear-filters" title="Clear text + source + license + similarity filters">Clear filters</button>` : ""}
  `;
  document.getElementById("cand-search").addEventListener("input", e => {
    state.candidateSearch = e.target.value;
    renderCandidateList();
  });
  document.getElementById("cand-source").onchange = e => {
    state.candidateSource = e.target.value;
    renderCandidateList();
  };
  document.getElementById("cand-license").onchange = e => {
    state.candidateLicense = e.target.value;
    renderCandidateList();
  };
  document.getElementById("cand-sim").onchange = e => {
    state.candidateSim = e.target.value;
    renderCandidateList();
  };
  const clr = document.getElementById("cand-clear-filters");
  if (clr) clr.onclick = () => {
    state.candidateSearch = state.candidateSource = state.candidateLicense = state.candidateSim = "";
    renderCandidateList();
  };
}
async function refreshImportCountBadge() {
  const badge = document.getElementById("rail-import-count");
  const n = await loadPendingCandidatesCount();
  if (badge) {
    if (n > 0) { badge.textContent = String(n); badge.style.display = ""; }
    else { badge.style.display = "none"; }
  }
  updateSkippedCountBadge();
}

function updateSkippedCountBadge() {
  const badge = document.getElementById("skipped-count");
  if (!badge) return;
  const n = state.skippedIds.size;
  if (n > 0) { badge.textContent = String(n); badge.style.display = ""; }
  else { badge.style.display = "none"; }
}

/** Apply the in-memory import filters (search text, source file, license,
 * similarity-score band) on top of the server-fetched candidate list. */
function filteredCandidates() {
  const needle = norm(state.candidateSearch);
  const src = state.candidateSource;
  const lic = state.candidateLicense;
  const simBand = state.candidateSim;
  return state.candidates.filter(c => {
    if (needle) {
      const hay = norm(c.question + " " + (c.options || []).join(" "));
      if (!hay.includes(needle)) return false;
    }
    if (src && c.source_file !== src) return false;
    if (lic) {
      const licArr = c.license || [];
      if (lic === "C" && !licArr.includes("C")) return false;
      if (lic === "D" && !licArr.includes("D")) return false;
      if (lic === "C+D" && !(licArr.includes("C") && licArr.includes("D"))) return false;
    }
    if (simBand) {
      const top = (c.similar_scores || [])[0] ?? 0;
      if (simBand === "high" && top < 0.7) return false;
      if (simBand === "mid"  && (top < 0.4 || top >= 0.7)) return false;
      if (simBand === "low"  && top >= 0.4) return false;
      if (simBand === "none" && (c.similar_ids || []).length > 0) return false;
    }
    return true;
  });
}

function uniqueSourceFiles() {
  return [...new Set(state.candidates.map(c => c.source_file).filter(Boolean))].sort();
}

function renderCandidateList() {
  const summary = document.getElementById("import-summary");
  const fetched = state.candidates.length;
  const shown = filteredCandidates();
  const total = shown.length;
  const withSim = shown.filter(c => (c.similar_ids || []).length > 0).length;
  const filteredOut = fetched - total;
  summary.textContent = fetched === 0
    ? "Nothing to review."
    : `${total} of ${fetched} candidate${fetched === 1 ? "" : "s"}${filteredOut ? ` · ${filteredOut} hidden by filters` : ""} · ${withSim} with a possible existing match`;

  renderCandidateExtraFilters();

  const list = document.getElementById("cand-list");
  if (!total) {
    list.innerHTML = `<div class="empty" style="padding:14px;color:var(--muted);font-size:12px">No candidates match the current filters.</div>`;
    return;
  }
  list.innerHTML = shown.map(c => {
    const topSim = (c.similar_scores || [])[0];
    const simBadge = topSim != null
      ? `<span class="sim-badge" style="color:${topSim >= 0.7 ? "var(--bad)" : topSim >= 0.4 ? "var(--warn)" : "var(--ok)"}">sim ${(topSim * 100).toFixed(0)}%</span>` : "";
    const imgFlag = c.image_path ? `<span title="has image">🖼</span>` : "";
    const cTopics = topicsOf(c);
    const cPrimary = cTopics[0] || "";
    const cExtraStr = cTopics.length > 1 ? `<span class="topic-extra">+${cTopics.length - 1}</span>` : "";
    return `
      <li class="${c.id === state.currentCandidateId ? "active" : ""} ${c.image_path ? "has-image" : ""}" data-cand-id="${c.id}">
        <div class="topic-bar" style="background:${TOPIC_COLOR(cPrimary)}"></div>
        <div class="body">
          <div class="qtext">${escapeHtml(c.question)}</div>
          <div class="meta">
            <span style="color:${TOPIC_COLOR(cPrimary)}" title="${escapeHtml(cPrimary)}">${escapeHtml(labelFor(cPrimary))}</span>${cExtraStr}
            <span>·</span>
            <span>${c.status}</span>
            ${simBadge ? `<span>·</span>${simBadge}` : ""}
            ${imgFlag}
          </div>
        </div>
      </li>`;
  }).join("");
  list.querySelectorAll("li[data-cand-id]").forEach(li => {
    li.onclick = () => selectCandidate(parseInt(li.dataset.candId, 10));
  });
  list.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
  renderPresenceMarkers();
}

function renderCandidateWorkspace() {
  const host = document.getElementById("cand-workspace");
  const c = state.candidates.find(x => x.id === state.currentCandidateId);
  if (!c) {
    host.innerHTML = `<div class="placeholder">Select a candidate from the list to review.</div>`;
    return;
  }

  const qById = new Map(state.questions.map(q => [q.id, q]));

  host.innerHTML = (function renderOne() {
    return [c].map(c => {
    const isPending = c.status === "pending";
    const lic = state.candidateLicenses.get(c.id) || ["C","D"];
    const licBtns = ["C","D"].map(l =>
      `<button data-lic-toggle="${c.id}:${l}" class="${lic.includes(l) ? "on" : ""}">${l}</button>`
    ).join("");
    const cTopicSet = new Set(topicsOf(c));
    const topicBtns = TOPICS.map(t =>
      `<button data-topic-set="${c.id}:${t}" class="topic-chip ${cTopicSet.has(t) ? "active" : ""}" title="${escapeHtml(t)}">
         <span class="dot" style="background:${TOPIC_COLOR(t)}"></span>${escapeHtml(labelFor(t))}
       </button>`
    ).join("");
    const candOpts = isPending
      ? c.options.map((opt, i) => `
          <div class="opt-row ${i === c.correct ? "correct" : ""}" data-cand-opt="${c.id}:${i}">
            <button class="mark" data-mark="${c.id}:${i}" title="Mark as correct"><span class="circle">${i === c.correct ? "✓" : ""}</span></button>
            <textarea data-opt-text="${c.id}:${i}" placeholder="Răspuns…">${escapeHtml(opt)}</textarea>
            <button class="del" data-opt-del="${c.id}:${i}" title="Remove option" ${c.options.length <= 2 ? "disabled" : ""}>✕</button>
          </div>`).join("")
      : c.options.map((opt, i) =>
          `<div class="cand-opt-line ${i === c.correct ? "correct" : ""}">${escapeHtml(opt)}</div>`
        ).join("");

    const imgBar = isPending ? `
      <div class="cand-image-bar">
        <div class="cand-image-thumb">
          ${c.image_path ? `<img src="${imageUrl(c.image_path)}" alt="" />` : `<span>no image</span>`}
        </div>
        <div class="cand-image-actions">
          <button class="btn ghost" data-pick-image="${c.id}">${c.image_path ? "Change image" : "Add image"}</button>
          ${c.image_path ? `<button class="btn ghost" data-clear-image="${c.id}">Remove</button>` : ""}
          ${c.image_path ? `<span class="cand-image-name">${escapeHtml(c.image_path)}</span>` : ""}
        </div>
      </div>` : (c.image_path ? `<img src="${imageUrl(c.image_path)}" alt="" style="max-width:100%;max-height:220px;border-radius:8px;border:1px solid var(--line);align-self:flex-start" />` : "");

    // Merge precomputed similar_ids (against qById) with the live RPC
    // results, deduping by question id. Live results provide the question
    // object directly, so they work even for questions not in state.questions.
    const matchById = new Map();
    (c.similar_ids || []).forEach((qid, i) => {
      const q = qById.get(qid);
      if (!q) return;
      matchById.set(qid, { q, score: (c.similar_scores || [])[i] ?? 0 });
    });
    (c._liveSimilars || []).forEach(row => {
      if (!matchById.has(row.id)) {
        matchById.set(row.id, {
          q: { id: row.id, question: row.question, options: row.options, correct: row.correct, topic: row.topic, license: row.license, image_path: row.image_path },
          score: row.score,
        });
      }
    });
    const matches = [...matchById.values()].sort((a, b) => b.score - a.score);
    const sims = matches.map(({ q, score }) => {
      const qid = q.id;
      const scoreClass = score >= 0.7 ? "high" : score >= 0.4 ? "" : "low";
      const lics = (q.license || []).map(l => `<span class="cand-tag lic">${l}</span>`).join("");
      const sameAsBtn = isPending
        ? `<button class="btn ghost" data-same-as="${c.id}:${qid}" title="Mark candidate as duplicate of this">Same as this</button>`
        : "";
      const replaceBtn = isPending
        ? `<button class="btn ghost" data-replace="${c.id}:${qid}" title="Overwrite this published question with the candidate's text">Replace #${qid}</button>`
        : "";
      const jumpBtn = `<button class="btn ghost" data-jump="${qid}">Open #${qid}</button>`;
      const qOptions = (q.options || []).map((opt, oi) =>
        `<div class="cand-opt-line ${oi === q.correct ? "correct" : ""}">${escapeHtml(opt)}</div>`
      ).join("");
      return `
        <div class="similar-item">
          <div class="cand-tag-row" style="margin-bottom:6px">
            <span class="cand-tag" title="${escapeHtml(q.topic || "")}">${escapeHtml(labelFor(q.topic) || "")}</span>
            ${lics}
            <span class="cand-tag score ${scoreClass}">sim ${(score * 100).toFixed(0)}%</span>
            <span class="muted small">#${qid}</span>
          </div>
          <div class="similar-item-q">${escapeHtml(q.question)}</div>
          ${q.image_path ? `<img src="${imageUrl(q.image_path)}" alt="" style="max-width:100%;max-height:160px;border-radius:6px;border:1px solid var(--line);margin-bottom:6px" />` : ""}
          <div class="cand-opts-vert" style="margin-bottom:8px">${qOptions}</div>
          <div class="similar-item-actions">${jumpBtn}${replaceBtn}${sameAsBtn}</div>
        </div>`;
    }).join("");

    const hasSims = matches.length > 0;
    const dupNote = c.duplicate_of
      ? `<span class="cand-tag status rejected">auto-dup of #${c.duplicate_of}</span>` : "";
    const acceptedLink = c.imported_question_id
      ? `<button class="btn ghost" data-jump="${c.imported_question_id}">Open imported #${c.imported_question_id}</button>` : "";

    const toolsSidebar = `
      <aside class="cand-tools-card">
        <div class="cand-tools-actions">
          <button class="btn ghost" data-copy-ai="${c.id}" title="Copy question + options to ask an AI">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            Copy for AI
          </button>
          ${isPending ? `
          <textarea class="fix-notes" data-fix-notes="${c.id}" rows="2" placeholder="Optional hint for the AI (e.g. 'this is about COLREG lights')">${escapeHtml(c._fixNotes || "")}</textarea>
          <button class="btn ghost ${(c._versions || []).some(v => v.label === "AI fix") ? "ai-fixed" : ""}" data-fix-ai="${c.id}" title="Auto-fix diacritics, grammar &amp; translate to Romanian using Claude Haiku">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.39 7.36H22l-6.19 4.5L18.2 22 12 17.5 5.8 22l2.39-8.14L2 9.36h7.61z"/></svg>
            Fix with AI
          </button>` : ""}
        </div>
        ${isPending ? `
        <div class="cand-tools-note">
          ${hasSims
            ? `<span class="cand-tools-note-ok">${matches.length} possible match${matches.length === 1 ? "" : "es"} found</span>`
            : `<span class="cand-tools-note-muted">No matches found</span>`}
        </div>
        <details class="cand-tools-section cand-tools-collapsible">
          <summary class="cand-tools-head">
            <span class="cand-tools-summary-label">
              <svg class="caret" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 3l4 3-4 3"/></svg>
              History
              <span class="cand-tools-count">${(c._versions || []).length || 1}</span>
            </span>
            <button class="ver-snap" data-cv-snap="${c.id}" title="Save current text as a new version">+ Snapshot</button>
          </summary>
          <div class="version-list" data-cand-versions="${c.id}"></div>
        </details>
        <div class="cand-tools-section">
          <div class="cand-tools-head"><span>Assign</span></div>
          <div class="cand-assign-row vertical"><span class="cand-assign-label">Topic</span><div class="topic-chip-row">${topicBtns}</div></div>
          <div class="cand-assign-row vertical"><span class="cand-assign-label">Licenses</span><div class="lic-toggle">${licBtns}</div></div>
        </div>
        <div class="cand-tools-section">
          <div class="cand-action-buttons stacked">
            <button class="btn primary" data-accept="${c.id}">Accept as new</button>
            ${state.skippedIds.has(c.id)
              ? `<button class="btn ghost" data-unskip="${c.id}" title="Remove from your skip list">Unskip</button>`
              : `<button class="btn ghost" data-skip="${c.id}" title="Hide for now — revisit from the Skipped tab">Skip for now</button>`}
            <button class="btn ghost" data-reject="${c.id}">Reject</button>
          </div>
        </div>` : `
        <div class="cand-tools-section">
          ${acceptedLink}
        </div>`}
      </aside>`;

    return `
      <div class="cand-workspace-grid ${hasSims ? "with-similar" : "no-similar"}">
        ${hasSims ? `
          <div class="similar-card">
            <div class="cand-col-head"><span>Possible existing matches (${matches.length})</span></div>
            <div class="similar-stack">${sims}</div>
          </div>` : ""}
        <div class="editor-card">
          <div class="cand-col-head">
            <span>Candidate</span>
            <span class="cand-tag status ${c.status}">${c.status}</span>
            ${dupNote}
            <span class="muted small" style="margin-left:auto">${escapeHtml(c.source_file || "")} · #${escapeHtml(c.source_nr || "")}</span>
          </div>
          ${!isPending ? `
            <div class="cand-tag-row">
              <span class="cand-tag" title="${escapeHtml(c.topic || "")}">${escapeHtml(labelFor(c.topic) || "")}</span>
              ${(c.license || []).map(l => `<span class="cand-tag lic">${l}</span>`).join("")}
            </div>` : ""}
          ${isPending
            ? `<textarea class="cand-q-edit" data-q-edit="${c.id}" placeholder="Întrebarea…">${escapeHtml(c.question)}</textarea>`
            : `<div class="cand-q">${escapeHtml(c.question)}</div>`}
          ${imgBar}
          ${isPending
            ? `<div class="opt-list">${candOpts}</div>
               <button class="add-opt" data-opt-add="${c.id}">+ Add option</button>`
            : `<div class="cand-opts-vert">${candOpts}</div>`}
        </div>
        ${toolsSidebar}
      </div>`;
  }).join("");
  })();

  const body = host;  // alias so existing handler bindings continue to work
  body.querySelectorAll("[data-q-edit]").forEach(ta => {
    ta.addEventListener("input", e => {
      const id = parseInt(ta.dataset.qEdit, 10);
      const c = state.candidates.find(x => x.id === id);
      if (c) c.question = e.target.value;
    });
  });
  body.querySelectorAll("[data-copy-ai]").forEach(b => {
    b.onclick = async () => {
      const id = parseInt(b.dataset.copyAi, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      const text = formatForAi(c);
      try {
        await navigator.clipboard.writeText(text);
        toast("ok", "Copied", "Paste it into your AI assistant.");
      } catch {
        toast("bad", "Copy failed", "Browser denied clipboard access.");
      }
    };
  });
  body.querySelectorAll("[data-fix-ai]").forEach(b => {
    b.onclick = async () => {
      const id = parseInt(b.dataset.fixAi, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      const originalLabel = b.innerHTML;
      b.disabled = true;
      b.innerHTML = `<span class="spinner" style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 0.7s linear infinite"></span> Fixing…`;
      try {
        const { data, error } = await supabase.functions.invoke("fix-text", {
          body: { question: c.question, options: c.options, correct: c.correct, topic: primaryTopic(c), notes: c._fixNotes || "" },
        });
        if (error) throw error;
        if (!data || data.error) throw new Error(data?.error || "unknown error");
        seedVersions(c);
        const latest = c._versions[c._versions.length - 1];
        if (!currentSnapshotMatches(c, latest)) pushVersion(c, "My edit");
        c.question = data.question;
        c.options = data.options;
        pushVersion(c, "AI fix");
        renderCandidateWorkspace();
        toast("ok", "Fixed", data.changes_made || "Text updated.");
      } catch (e) {
        toast("bad", "Fix failed", e?.message || String(e));
      } finally {
        b.disabled = false;
        b.innerHTML = originalLabel;
      }
    };
  });
  body.querySelectorAll("[data-fix-notes]").forEach(ta => {
    ta.addEventListener("input", e => {
      const id = parseInt(ta.dataset.fixNotes, 10);
      const c = state.candidates.find(x => x.id === id);
      if (c) c._fixNotes = e.target.value;
    });
  });
  body.querySelectorAll("[data-cand-versions]").forEach(host => {
    const id = parseInt(host.dataset.candVersions, 10);
    renderCandidateVersionsList(host, id);
  });
  body.querySelectorAll("[data-cv-snap]").forEach(b => {
    b.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = parseInt(b.dataset.cvSnap, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      seedVersions(c);
      const latest = c._versions[c._versions.length - 1];
      if (currentSnapshotMatches(c, latest)) {
        toast("ok", "No changes", "Current text already matches the latest version.");
        return;
      }
      pushVersion(c, "My edit");
      renderCandidateWorkspace();
      toast("ok", "Snapshot saved", "Added a new version you can cycle back to.");
    };
  });
  body.querySelectorAll("[data-opt-text]").forEach(ta => {
    ta.addEventListener("input", e => {
      const [idStr, iStr] = ta.dataset.optText.split(":");
      const id = parseInt(idStr, 10);
      const i = parseInt(iStr, 10);
      const c = state.candidates.find(x => x.id === id);
      if (c) c.options[i] = e.target.value;
    });
  });
  body.querySelectorAll("[data-mark]").forEach(b => {
    b.onclick = () => {
      const [idStr, iStr] = b.dataset.mark.split(":");
      const id = parseInt(idStr, 10);
      const i = parseInt(iStr, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      c.correct = i;
      renderCandidates();
    };
  });
  body.querySelectorAll("[data-opt-del]").forEach(b => {
    b.onclick = () => {
      const [idStr, iStr] = b.dataset.optDel.split(":");
      const id = parseInt(idStr, 10);
      const i = parseInt(iStr, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c || c.options.length <= 2) return;
      c.options.splice(i, 1);
      if (c.correct >= c.options.length) c.correct = c.options.length - 1;
      else if (c.correct > i) c.correct--;
      renderCandidates();
    };
  });
  body.querySelectorAll("[data-opt-add]").forEach(b => {
    b.onclick = () => {
      const id = parseInt(b.dataset.optAdd, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      c.options.push("");
      renderCandidates();
    };
  });
  body.querySelectorAll("[data-pick-image]").forEach(b => {
    b.onclick = () => openImagePicker({ kind: "candidate", id: parseInt(b.dataset.pickImage, 10) });
  });
  body.querySelectorAll("[data-clear-image]").forEach(b => {
    b.onclick = () => {
      const id = parseInt(b.dataset.clearImage, 10);
      const c = state.candidates.find(x => x.id === id);
      if (c) c.image_path = null;
      renderCandidates();
    };
  });
  body.querySelectorAll("[data-topic-set]").forEach(b => {
    b.onclick = () => {
      const [idStr, topic] = b.dataset.topicSet.split(":");
      const id = parseInt(idStr, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      const set = new Set(topicsOf(c));
      if (set.has(topic)) {
        if (set.size <= 1) return;
        set.delete(topic);
      } else {
        set.add(topic);
      }
      c.topics = Array.from(set);
      c.topic = c.topics[0];
      renderCandidates();
    };
  });
  body.querySelectorAll("[data-lic-toggle]").forEach(b => {
    b.onclick = () => {
      const [idStr, l] = b.dataset.licToggle.split(":");
      const id = parseInt(idStr, 10);
      const cur = state.candidateLicenses.get(id) || ["C","D"];
      const next = cur.includes(l) ? cur.filter(x => x !== l) : [...cur, l];
      state.candidateLicenses.set(id, next);
      b.classList.toggle("on");
    };
  });
  body.querySelectorAll("[data-accept]").forEach(b => {
    b.onclick = async () => {
      const id = parseInt(b.dataset.accept, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      const lic = state.candidateLicenses.get(id) || ["C","D"];
      b.disabled = true;
      const ok = await acceptCandidate(c, lic);
      if (ok) decideLocally(id);
      else b.disabled = false;
    };
  });
  body.querySelectorAll("[data-reject]").forEach(b => {
    b.onclick = async () => {
      const id = parseInt(b.dataset.reject, 10);
      const c = state.candidates.find(x => x.id === id);
      if (!c) return;
      b.disabled = true;
      const ok = await rejectCandidate(c);
      if (ok) decideLocally(id);
      else b.disabled = false;
    };
  });
  body.querySelectorAll("[data-skip]").forEach(b => {
    b.onclick = () => {
      const id = parseInt(b.dataset.skip, 10);
      state.skippedIds.add(id);
      saveSkippedIds();
      updateSkippedCountBadge();
      toast("ok", "Skipped", `Find it later in the Skipped tab (${state.skippedIds.size} total).`);
      // In any pending* view this row should drop out; decideLocally already
      // splices it from state.candidates and advances selection.
      if (state.candidateStatus.startsWith("pending")) decideLocally(id);
      else renderCandidateWorkspace();
    };
  });
  body.querySelectorAll("[data-unskip]").forEach(b => {
    b.onclick = () => {
      const id = parseInt(b.dataset.unskip, 10);
      state.skippedIds.delete(id);
      saveSkippedIds();
      updateSkippedCountBadge();
      toast("ok", "Unskipped", "Back in the regular pending queue.");
      if (state.candidateStatus === "skipped") decideLocally(id);
      else renderCandidateWorkspace();
    };
  });
  body.querySelectorAll("[data-same-as]").forEach(b => {
    b.onclick = async () => {
      const [candIdStr, qidStr] = b.dataset.sameAs.split(":");
      const candId = parseInt(candIdStr, 10);
      const qid = parseInt(qidStr, 10);
      b.disabled = true;
      const { error } = await supabase
        .from("question_candidates")
        .update({
          status: "rejected",
          duplicate_of: qid,
          decided_at: new Date().toISOString(),
          decided_by: state.user?.email ?? null,
        })
        .eq("id", candId);
      if (error) { toast("bad", "Couldn't mark dup", error.message); b.disabled = false; return; }
      decideLocally(candId);
    };
  });
  body.querySelectorAll("[data-replace]").forEach(b => {
    b.onclick = async () => {
      const [candIdStr, qidStr] = b.dataset.replace.split(":");
      const candId = parseInt(candIdStr, 10);
      const qid = parseInt(qidStr, 10);
      const c = state.candidates.find(x => x.id === candId);
      if (!c) return;
      const ok = await confirmModal({
        title: `Overwrite question #${qid}?`,
        body: `The published question will be replaced with the candidate's text, options, topic, license, and image. The previous version stays in the audit history and can be reverted.`,
        confirmText: `Replace #${qid}`,
      });
      if (!ok) return;
      const lic = state.candidateLicenses.get(candId) || c.license || ["C","D"];
      b.disabled = true;
      const done = await replaceQuestionWithCandidate(c, qid, lic);
      if (done) {
        toast("ok", "Replaced", `Question #${qid} updated from this candidate.`);
        decideLocally(candId);
      } else {
        b.disabled = false;
      }
    };
  });
  body.querySelectorAll("[data-jump]").forEach(b => {
    b.onclick = () => {
      goPage("questions");
      selectQuestion(parseInt(b.dataset.jump, 10));
    };
  });
}

// ─────────────── reports ───────────────
async function openReports() {
  document.getElementById("reports-modal").classList.remove("hidden");
  if (typeof renderRail === "function") renderRail();
  await refreshReports();
}

function closeReports() {
  document.getElementById("reports-modal").classList.add("hidden");
  if (typeof renderRail === "function") renderRail();
}

async function refreshReports() {
  const body = document.getElementById("reports-body");
  body.innerHTML = `<div class="placeholder">Loading…</div>`;
  state.reports = await loadReports({ openOnly: state.reportsFilter === "open" });
  renderReports();
  await refreshReportsCountBadge();
}

async function refreshReportsCountBadge() {
  const badge = document.getElementById("rail-reports-count");
  const n = await loadOpenReportsCount();
  if (badge) {
    if (n > 0) { badge.textContent = String(n); badge.style.display = ""; }
    else { badge.style.display = "none"; }
  }
}

function renderReports() {
  const body = document.getElementById("reports-body");
  if (!state.reports.length) {
    body.innerHTML = `<div class="report-empty">${state.reportsFilter === "open" ? "No open reports." : "No reports yet."}</div>`;
    return;
  }
  const qById = new Map(state.questions.map(q => [q.id, q]));
  body.innerHTML = state.reports.map(r => {
    const ref = r.kind === "main"
      ? `#${r.question_id}`
      : escapeHtml(r.external_ref ?? "");
    const qText = r.kind === "main"
      ? escapeHtml(qById.get(r.question_id)?.question ?? "(question deleted)")
      : escapeHtml(r.question_text ?? "");
    const meta = [
      `<span class="report-time">${formatDate(r.created_at)}</span>`,
      `<span class="report-kind ${r.kind}">${r.kind}</span>`,
      `<span>${ref}</span>`,
      r.questions_version ? `<span>v${r.questions_version}</span>` : "",
      r.app_version ? `<span>app ${escapeHtml(r.app_version)}</span>` : "",
      r.resolved_at ? `<span style="color:var(--ok)">resolved ${formatDate(r.resolved_at)}</span>` : "",
    ].filter(Boolean).join("");
    const msg = r.message
      ? `<div class="report-message">${escapeHtml(r.message)}</div>`
      : `<div class="report-message" style="font-style:italic;color:var(--muted)">No message</div>`;
    const actions = r.resolved_at
      ? ""
      : `<div class="report-actions">
           ${r.kind === "main" ? `<button class="btn ghost" data-jump="${r.question_id}">Open question</button>` : ""}
           <button class="btn primary" data-resolve="${r.id}">Mark resolved</button>
         </div>`;
    return `
      <div class="report-card ${r.resolved_at ? "resolved" : ""}">
        <div class="report-head">${meta}</div>
        <div class="report-qtext">${qText}</div>
        ${msg}
        ${actions}
      </div>`;
  }).join("");

  body.querySelectorAll("[data-resolve]").forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      const ok = await markReportResolved(parseInt(b.dataset.resolve, 10));
      if (ok) await refreshReports();
      else b.disabled = false;
    };
  });
  body.querySelectorAll("[data-jump]").forEach(b => {
    b.onclick = () => {
      closeReports();
      goPage("questions");
      selectQuestion(parseInt(b.dataset.jump, 10));
    };
  });
}

// ─────────────── realtime + presence ───────────────
let _rtChannel = null;
function startRealtime() {
  if (_rtChannel) return;
  const me = state.user?.email || "anon";
  _rtChannel = supabase.channel("caahq-live", {
    config: { presence: { key: me } },
  });

  _rtChannel.on("postgres_changes", { event: "*", schema: "public", table: "questions" }, (p) => {
    applyQuestionEvent(p);
  });
  _rtChannel.on("postgres_changes", { event: "*", schema: "public", table: "question_candidates" }, (p) => {
    applyCandidateEvent(p);
  });
  _rtChannel.on("postgres_changes", { event: "*", schema: "public", table: "question_reports" }, () => {
    refreshReportsCountBadge();
    if (!document.getElementById("reports-modal").classList.contains("hidden")) refreshReports();
  });

  _rtChannel.on("presence", { event: "sync" }, () => syncPresenceFromChannel());
  _rtChannel.on("presence", { event: "join"  }, () => syncPresenceFromChannel());
  _rtChannel.on("presence", { event: "leave" }, () => syncPresenceFromChannel());

  _rtChannel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await _rtChannel.track({ email: me, focus: currentFocus() });
    }
  });
}

/** Apply a postgres_changes event for `public.questions` to local state. */
function applyQuestionEvent(payload) {
  const evt = payload.eventType;
  if (evt === "INSERT") {
    const row = payload.new;
    if (!state.questions.find(q => q.id === row.id)) state.questions.push(row);
  } else if (evt === "UPDATE") {
    const row = payload.new;
    const idx = state.questions.findIndex(q => q.id === row.id);
    if (idx >= 0) state.questions[idx] = row;
    // If the user is editing this question right now and has unsaved
    // changes, don't clobber their textarea. Otherwise refresh the editor.
    if (state.currentId === row.id && !state.dirty) state.current = deepClone(row);
  } else if (evt === "DELETE") {
    const id = payload.old.id;
    state.questions = state.questions.filter(q => q.id !== id);
    if (state.currentId === id) { state.currentId = null; state.current = null; }
  }
  render();
}

/** Apply a postgres_changes event for `public.question_candidates` to local state. */
function applyCandidateEvent(payload) {
  const evt = payload.eventType;
  let affectedIsCurrent = false;
  if (evt === "INSERT") {
    if (!state.candidates.find(c => c.id === payload.new.id)) state.candidates.push(payload.new);
  } else if (evt === "UPDATE") {
    const row = payload.new;
    const idx = state.candidates.findIndex(c => c.id === row.id);
    if (idx >= 0) {
      // If the user is currently editing this candidate, preserve their
      // in-progress edits — only patch status/decided/imported fields from
      // the server so we still see the row leaving "pending".
      const local = state.candidates[idx];
      if (state.currentCandidateId === row.id) {
        affectedIsCurrent = true;
        state.candidates[idx] = {
          ...local,
          status: row.status,
          decided_at: row.decided_at,
          decided_by: row.decided_by,
          imported_question_id: row.imported_question_id,
          duplicate_of: row.duplicate_of,
        };
      } else {
        state.candidates[idx] = row;
      }
    }
  } else if (evt === "DELETE") {
    state.candidates = state.candidates.filter(c => c.id !== payload.old.id);
    if (state.currentCandidateId === payload.old.id) state.currentCandidateId = null;
  }
  // Redraw only if the import view is visible. Skip the workspace redraw if
  // the affected row is the one the user is editing — list still refreshes.
  if (state.page === "import") {
    if (affectedIsCurrent) renderCandidateList();
    else renderCandidates();
  }
  refreshImportCountBadge();
}

/** Build a {kind,id} object describing what the user is currently looking at. */
function currentFocus() {
  const onImport = window.location.hash === "#import";
  if (onImport && state.currentCandidateId) return { kind: "candidate", id: state.currentCandidateId };
  if (!onImport && state.currentId)        return { kind: "question",  id: state.currentId };
  return null;
}

/** Re-publish our focus to others. Called when selection changes. */
async function broadcastFocus() {
  if (!_rtChannel) return;
  try { await _rtChannel.track({ email: state.user?.email || "anon", focus: currentFocus() }); } catch {}
}

function syncPresenceFromChannel() {
  if (!_rtChannel) return;
  const raw = _rtChannel.presenceState();
  const next = new Map();
  for (const [email, entries] of Object.entries(raw)) {
    // Presence may have multiple entries per key (same user, multiple tabs);
    // collapse to the most recent.
    const last = entries[entries.length - 1];
    next.set(email, last);
  }
  state.presence = next;
  renderPresenceMarkers();
}

/** Add a tiny dot to sidebar rows where another reviewer is currently focused.
 * Light-weight DOM patch so we don't have to rerender the full list on every
 * presence change. */
function renderPresenceMarkers() {
  // Clear old markers
  document.querySelectorAll(".presence-dot").forEach(n => n.remove());
  const me = state.user?.email;
  const byKind = { question: new Map(), candidate: new Map() };
  for (const [email, entry] of state.presence.entries()) {
    if (email === me) continue;
    const f = entry?.focus;
    if (!f || !f.kind || !f.id) continue;
    const m = byKind[f.kind];
    if (!m) continue;
    if (!m.has(f.id)) m.set(f.id, []);
    m.get(f.id).push(email);
  }
  // Questions sidebar
  for (const [qid, emails] of byKind.question.entries()) {
    const li = document.querySelector(`#qlist li[data-id="${qid}"]`);
    if (li) li.appendChild(presenceDotEl(emails));
  }
  // Candidates sidebar
  for (const [cid, emails] of byKind.candidate.entries()) {
    const li = document.querySelector(`#cand-list li[data-cand-id="${cid}"]`);
    if (li) li.appendChild(presenceDotEl(emails));
  }
}

function presenceDotEl(emails) {
  const el = document.createElement("span");
  el.className = "presence-dot";
  el.title = `Being reviewed by: ${emails.join(", ")}`;
  el.textContent = emails.length > 1 ? `●${emails.length}` : "●";
  return el;
}

// ─────────────── new pages (design adoption) ───────────────

// Topic colour token lookup. Falls back to --muted when a slug isn't styled.
function topicColor(slug) {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--" + slug).trim();
  return v || "var(--muted)";
}

function loadLabels() {
  if (state.labels) return state.labels;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem("caahq-topic-labels") || "{}"); } catch {}
  state.labels = stored;
  return stored;
}
const DEFAULT_TOPIC_LABELS = {
  colreg:      "Colreg",
  navigation:  "Navigație",
  seamanship:  "Marinărie",
  maneuvering: "Conducere & manevră",
  first_aid:   "Prim ajutor",
  rnd:         "RND (Dunăre)",
  weather:     "Meteo",
  signs:       "Semne",
};
function labelFor(slug) {
  if (!slug) return "";
  const labels = loadLabels();
  return labels[slug] || DEFAULT_TOPIC_LABELS[slug] || slug;
}

// ─── textarea auto-grow ───
function autoSize(ta) {
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = (ta.scrollHeight + 2) + "px";
}
function autoSizeAll(root) {
  (root || document).querySelectorAll("textarea").forEach(autoSize);
}
// Delegated input listener — sizes any textarea anywhere on the page.
document.addEventListener("input", e => {
  if (e.target && e.target.tagName === "TEXTAREA") autoSize(e.target);
});
// Size any textarea that appears in the DOM after render.
const _autoSizeObserver = new MutationObserver(muts => {
  for (const m of muts) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === "TEXTAREA") autoSize(node);
      else node.querySelectorAll && node.querySelectorAll("textarea").forEach(autoSize);
    }
  }
});
_autoSizeObserver.observe(document.body, { childList: true, subtree: true });

function refreshTopicLabelsEverywhere() {
  // Re-paint any static topic-slug references with their current display label.
  const sel = document.getElementById("import-topic");
  if (sel) {
    for (const opt of sel.querySelectorAll("option")) {
      if (!opt.value) continue;
      opt.textContent = labelFor(opt.value);
      opt.title = opt.value;
    }
  }
}

// ─── Overview ───
async function renderOverviewPage() {
  const host = document.getElementById("overview-body");
  const qs = state.questions || [];
  const total = qs.length;
  const withImage = qs.filter(q => q.image_path).length;
  const multi = qs.filter(q => Array.isArray(q.correct) && q.correct.length > 1).length;

  // license breakdown
  let cOnly = 0, dOnly = 0, both = 0, neither = 0;
  for (const q of qs) {
    const lic = Array.isArray(q.license) ? q.license : (q.license ? [q.license] : []);
    const hasC = lic.includes("C"); const hasD = lic.includes("D");
    if (hasC && hasD) both++;
    else if (hasC) cOnly++;
    else if (hasD) dOnly++;
    else neither++;
  }
  const pct = (n) => total ? ((n / total) * 100).toFixed(1) + "%" : "—";

  // topic counts
  const tc = topicCounts();
  const topicRows = Object.entries(tc)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, n]) => {
      const p = total ? (n / total) * 100 : 0;
      return `
        <div class="topic-bar-row">
          <span class="name"><span class="dot" style="background:${topicColor(slug)}"></span>${escapeHtml(labelFor(slug))}</span>
          <div class="bar"><div class="fill" style="width:${p.toFixed(1)}%;background:${topicColor(slug)};opacity:.7"></div></div>
          <span class="num">${n}</span>
          <span class="pct">${p.toFixed(1)}%</span>
        </div>`;
    }).join("");

  // recent edits — last 10 from question_versions
  let recent = [];
  try {
    const { data } = await supabase
      .from("question_versions")
      .select("id, question_id, kind, actor, created_at, snapshot")
      .order("created_at", { ascending: false })
      .limit(10);
    recent = data || [];
  } catch {}
  const recentRows = recent.length ? recent.map(v => {
    const time = formatDate(v.created_at);
    const preview = v.snapshot?.question ? String(v.snapshot.question).slice(0, 90) : "";
    return `
      <div class="feed-item">
        <span class="time">${escapeHtml(time)}</span>
        <span class="kind ${escapeHtml(v.kind || "edit")}">${escapeHtml(v.kind || "edit")}</span>
        <div class="body">
          <span class="qid">Q-${escapeHtml(String(v.question_id))}</span>
          <span style="margin-left:6px">${escapeHtml((v.actor || "").split("@")[0])}</span>
          <div class="preview">${escapeHtml(preview)}</div>
        </div>
        <div class="actions"></div>
      </div>`;
  }).join("") : `<div class="placeholder" style="padding:20px;color:var(--muted);font-size:12px">No edits yet.</div>`;

  // integrity (rerun if stale)
  const integ = await ensureIntegrity();
  const issues = integ.brokenImages + integ.zeroCorrect + integ.duplicates;

  host.innerHTML = `
    <div class="overview">
      <div class="stats-grid">
        <div class="stat-card">
          <span class="label">Total questions</span>
          <span class="value">${total.toLocaleString()}</span>
          <span class="delta">${withImage} with image · ${multi} multi-correct</span>
        </div>
        <div class="stat-card">
          <span class="label">With image</span>
          <span class="value">${withImage}<span style="font-size:13px;color:var(--muted);margin-left:6px">/ ${total}</span></span>
          <span class="delta">${pct(withImage)}</span>
        </div>
        <div class="stat-card ${multi ? "alert" : "ok"}">
          <span class="label">Multi-correct</span>
          <span class="value">${multi}</span>
          <span class="delta">${multi ? "review correct_alt" : "all single-correct"}</span>
        </div>
        <div class="stat-card ${issues ? "bad" : "ok"}">
          <span class="label">Integrity issues</span>
          <span class="value">${issues}</span>
          <span class="delta">${integ.brokenImages} broken img · ${integ.zeroCorrect} zero-correct · ${integ.duplicates} dup</span>
        </div>
      </div>

      <div class="overview-grid">
        <div class="overview-col">
          <div class="card">
            <h3>Topic distribution
              <span class="count">${total.toLocaleString()}</span>
              <button class="sub-link" id="ov-browse">Browse →</button>
            </h3>
            <div class="topic-bar-list">${topicRows || `<div class="placeholder" style="padding:20px">No topics yet.</div>`}</div>
          </div>

          <div class="card">
            <h3>License coverage <span class="count">C · D</span></h3>
            <div class="license-split">
              <div class="seg"><div class="k">Class C only</div><div class="v">${cOnly}</div><div class="pct">${pct(cOnly)}</div></div>
              <div class="seg"><div class="k">Class D only</div><div class="v">${dOnly}</div><div class="pct">${pct(dOnly)}</div></div>
              <div class="seg both"><div class="k">C ∩ D (both)</div><div class="v">${both}</div><div class="pct">${pct(both)}</div></div>
              ${neither ? `<div class="seg"><div class="k">No license</div><div class="v">${neither}</div><div class="pct">${pct(neither)}</div></div>` : ""}
            </div>
          </div>

          <div class="card">
            <h3>Recent edits
              <span class="count">last 10</span>
              <button class="sub-link" id="ov-audit">Full audit log →</button>
            </h3>
            <div class="feed">${recentRows}</div>
          </div>
        </div>

        <div class="overview-col">
          <div class="card">
            <h3>Quick actions</h3>
            <div class="quick-links">
              <button class="quick-link" id="ov-qa-new">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                <div class="text-col"><span class="lbl">New question</span><span class="sub">Blank editor draft</span></div>
              </button>
              <button class="quick-link" id="ov-qa-import">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <div class="text-col"><span class="lbl">Import candidates</span><span class="sub">Review the upstream queue</span></div>
              </button>
              <button class="quick-link" id="ov-qa-images">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                <div class="text-col"><span class="lbl">Images</span><span class="sub">Gallery · upload · replace</span></div>
              </button>
              <button class="quick-link" id="ov-qa-labels">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41L13.42 20.58a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                <div class="text-col"><span class="lbl">Labels</span><span class="sub">Topic display names</span></div>
              </button>
              <button class="quick-link" id="ov-qa-export">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3" transform="rotate(180 12 9)"/></svg>
                <div class="text-col"><span class="lbl">Export files</span><span class="sub">questions.json · snapshots</span></div>
              </button>
            </div>
          </div>

          <div class="card">
            <h3>Publish channels</h3>
            <div class="channel-card" id="ov-channels">
              <div class="ch-row">
                <div class="ch-head"><span class="k">Draft</span><span class="v" id="ch-draft">—</span></div>
                <div class="ch-sub">uncommitted (current questions table)</div>
              </div>
              <div class="ch-row preview">
                <div class="ch-head"><span class="k">Preview</span><span class="v" id="ch-preview">—</span></div>
                <div class="ch-sub">latest snapshot</div>
              </div>
              <div class="ch-row prod">
                <div class="ch-head"><span class="k">Production · live</span><span class="v" id="ch-prod">—</span></div>
                <div class="ch-sub">live in mobile app</div>
              </div>
            </div>
            <div style="display:flex;gap:6px;margin-top:12px">
              <button class="btn" style="flex:1;justify-content:center" id="ov-publish">Publish preview</button>
              <button class="btn primary" style="flex:1;justify-content:center" id="ov-promote">Promote</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  // wire actions
  document.getElementById("ov-browse").onclick = () => goPage("questions");
  document.getElementById("ov-audit").onclick = () => goPage("audit");
  document.getElementById("ov-qa-new").onclick = () => { goPage("questions"); createNew(); };
  document.getElementById("ov-qa-import").onclick = () => goPage("import");
  document.getElementById("ov-qa-images").onclick = () => goPage("images");
  document.getElementById("ov-qa-labels").onclick = () => goPage("labels");
  document.getElementById("ov-qa-export").onclick = () => goPage("export");
  document.getElementById("ov-publish").onclick = () => publishToPreview();
  document.getElementById("ov-promote").onclick = () => promoteToProduction();

  // mirror channel pills into the overview card
  syncOverviewChannels();
}

function syncOverviewChannels() {
  const pills = document.getElementById("channel-pills");
  const setIf = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  let prev = "—", prod = "—";
  if (pills) {
    for (const p of pills.querySelectorAll(".channel-pill")) {
      const t = p.textContent.trim();
      const m = t.match(/^(preview|prod)\s+(\S+)/i);
      if (!m) continue;
      if (m[1].toLowerCase() === "preview") prev = m[2];
      else prod = m[2];
    }
  }
  setIf("ch-preview", prev);
  setIf("ch-prod", prod);
  setIf("foot-preview", prev);
  setIf("foot-prod", prod);
  const draft = state.dirty ? "uncommitted" : "current";
  setIf("ch-draft", draft);
  setIf("foot-draft", draft);
}

// ─── Labels (minimal) ───
function renderLabelsPage() {
  const host = document.getElementById("labels-body");
  const tc = topicCounts();
  const slugs = Object.keys(tc).sort();
  const labels = loadLabels();
  const initial = { ...labels };
  const dirty = new Set();
  const setDirty = (slug, val) => {
    if (val === (initial[slug] || "")) dirty.delete(slug); else dirty.add(slug);
    updateButtons();
  };
  const updateButtons = () => {
    document.getElementById("labels-save-btn").disabled = dirty.size === 0;
    document.getElementById("labels-discard-btn").disabled = dirty.size === 0;
    const status = document.getElementById("labels-status");
    status.textContent = dirty.size ? `${dirty.size} unsaved change${dirty.size > 1 ? "s" : ""}` : "";
    status.className = "save-status" + (dirty.size ? " dirty" : "");
    document.querySelectorAll("#labels-body .label-row").forEach(row => {
      row.classList.toggle("dirty", dirty.has(row.dataset.slug));
    });
  };

  const customTopics = new Set(loadCustomTopics());
  const rowHtml = (slug, isCustom) => `
    <div class="label-row" data-slug="${escapeHtml(slug)}">
      <span class="slug">
        <span class="dot" style="background:${topicColor(slug)}"></span>
        ${escapeHtml(slug)}
        ${isCustom ? `<span class="custom-tag" title="Added by you">custom</span>` : ""}
      </span>
      <input type="text" data-slug="${escapeHtml(slug)}" value="${escapeHtml(labels[slug] || "")}" placeholder="${escapeHtml(DEFAULT_TOPIC_LABELS[slug] || slug)}" />
      <span class="usage">${tc[slug] || 0}</span>
      ${isCustom && (tc[slug] || 0) === 0
        ? `<button class="icon-btn label-remove" data-slug="${escapeHtml(slug)}" title="Delete this custom topic">×</button>`
        : `<span></span>`}
    </div>`;

  host.innerHTML = `
    <div class="labels-grid">
      <div class="labels-banner">
        <b>Display-only.</b> Slugs (the keys on the left) stay attached to every question.
        Renaming a label changes how the slug appears in this admin only · stored in your browser.
        New topics you create here also live in your browser until questions are assigned to them.
      </div>
      <div class="label-table-card">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41L13.42 20.58a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
          Topic slugs
          <span class="count">${slugs.length}</span>
        </h3>
        ${slugs.map(slug => rowHtml(slug, customTopics.has(slug))).join("")}

        <div class="label-add" id="label-add">
          <span class="slug">
            <span class="dot" style="background:var(--muted-bright);opacity:.4"></span>
            <input type="text" id="label-add-slug" placeholder="new-slug" autocomplete="off" />
          </span>
          <input type="text" id="label-add-label" placeholder="Display label (optional)" autocomplete="off" />
          <button class="btn primary" id="label-add-btn">+ Add</button>
        </div>
      </div>
    </div>`;

  host.querySelectorAll("input[data-slug]").forEach(inp => {
    inp.addEventListener("input", () => setDirty(inp.dataset.slug, inp.value));
  });
  host.querySelectorAll(".label-remove").forEach(b => {
    b.onclick = async () => {
      const slug = b.dataset.slug;
      const ok = await confirmModal({
        title: "Delete this custom topic?",
        body: `"${slug}" will be removed. It has no questions assigned, so nothing else is affected. You can re-add it later.`,
        confirmText: "Delete",
      });
      if (!ok) return;
      const list = loadCustomTopics().filter(t => t !== slug);
      saveCustomTopics(list);
      refreshTOPICSBinding();
      // Drop the label too if present.
      const nextLabels = { ...(state.labels || labels) };
      delete nextLabels[slug];
      try { localStorage.setItem("caahq-topic-labels", JSON.stringify(nextLabels)); } catch {}
      state.labels = nextLabels;
      toast("ok", "Topic deleted", slug);
      renderLabelsPage();
      renderTopicFilter();
      refreshTopicLabelsEverywhere();
    };
  });
  document.getElementById("labels-save-btn").onclick = () => {
    const next = { ...initial };
    host.querySelectorAll("input[data-slug]").forEach(inp => {
      if (inp.value.trim()) next[inp.dataset.slug] = inp.value.trim();
      else delete next[inp.dataset.slug];
    });
    try { localStorage.setItem("caahq-topic-labels", JSON.stringify(next)); } catch {}
    state.labels = next;
    Object.assign(initial, next);
    dirty.clear();
    updateButtons();
    toast("ok", "Labels saved", `${Object.keys(next).length} label${Object.keys(next).length === 1 ? "" : "s"} in localStorage.`);
    renderTopicFilter();
    refreshTopicLabelsEverywhere();
    if (state.current) renderBreadcrumbs();
    renderList();
  };
  document.getElementById("labels-discard-btn").onclick = () => {
    host.querySelectorAll("input[data-slug]").forEach(inp => {
      inp.value = initial[inp.dataset.slug] || "";
    });
    dirty.clear();
    updateButtons();
  };

  // Add-topic row
  const slugInp = document.getElementById("label-add-slug");
  const labelInp = document.getElementById("label-add-label");
  const addBtn = document.getElementById("label-add-btn");
  const normalizeSlug = (s) => norm(String(s || "")).replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const onAdd = () => {
    const raw = slugInp.value.trim();
    if (!raw) { slugInp.focus(); return; }
    const slug = normalizeSlug(raw);
    if (!slug) { toast("bad", "Invalid slug", "Use letters, digits, underscore."); return; }
    if (allTopicSlugs().includes(slug)) { toast("bad", "Already exists", `${slug} is already a topic.`); return; }
    const list = loadCustomTopics();
    list.push(slug);
    saveCustomTopics(list);
    refreshTOPICSBinding();
    if (labelInp.value.trim()) {
      const next = { ...(state.labels || loadLabels()), [slug]: labelInp.value.trim() };
      try { localStorage.setItem("caahq-topic-labels", JSON.stringify(next)); } catch {}
      state.labels = next;
    }
    toast("ok", "Topic added", slug + (labelInp.value.trim() ? ` · ${labelInp.value.trim()}` : ""));
    renderLabelsPage();
    renderTopicFilter();
    refreshTopicLabelsEverywhere();
    if (state.current) renderTabContent();
  };
  addBtn.onclick = onAdd;
  slugInp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); labelInp.focus(); } });
  labelInp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); onAdd(); } });

  updateButtons();
}

// ─── Export ───
async function renderExportPage() {
  const host = document.getElementById("export-body");
  host.innerHTML = `<div class="placeholder">Loading snapshots…</div>`;

  let snaps = [];
  try {
    const { data, error } = await supabase.storage.from("question-bundles").list("", { limit: 200, sortBy: { column: "name", order: "desc" } });
    if (!error) snaps = (data || []).filter(o => /\.json$/.test(o.name));
  } catch {}

  // try to read which is "current prod"
  let prodVersion = null;
  try {
    const { data } = await supabase.storage.from("question-bundles").download("prod.json");
    if (data) {
      const txt = await data.text();
      const pj = JSON.parse(txt);
      prodVersion = pj.version || pj.v || null;
    }
  } catch {}

  const total = (state.questions || []).length;
  const snapsHtml = snaps.length
    ? snaps.map(s => {
        const isCurrent = prodVersion && s.name.includes(String(prodVersion));
        const size = s.metadata?.size ? humanSize(s.metadata.size) : "—";
        return `
          <div class="snap-row ${isCurrent ? "current" : ""}" data-name="${escapeHtml(s.name)}">
            <span class="time">${escapeHtml(formatDate(s.updated_at || s.created_at || ""))}</span>
            <span class="v">${escapeHtml(s.name)}${isCurrent ? `<span class="pin">live</span>` : ""}</span>
            <span class="summary">snapshot bundle</span>
            <span class="size">${size}</span>
            <div class="actions">
              <button class="icon-btn snap-dl" title="Download" data-name="${escapeHtml(s.name)}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="icon-btn snap-restore" title="Restore as new version" data-name="${escapeHtml(s.name)}" ${isCurrent ? "disabled" : ""}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/></svg>
              </button>
            </div>
          </div>`;
      }).join("")
    : `<div class="snap-empty">No snapshots yet. Use Publish preview · Promote in the topbar to create one.</div>`;

  host.innerHTML = `
    <div class="export-actions">
      <div class="export-tile primary" id="exp-questions">
        <div class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
        <h4>questions.json</h4>
        <div class="desc">Current normalized dataset · ${total.toLocaleString()} rows.</div>
      </div>
      <div class="export-tile" id="exp-labels">
        <div class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
        <h4>labels.json</h4>
        <div class="desc">Topic display labels from this browser.</div>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h3 style="margin:0;font-size:13px;font-weight:500;display:flex;align-items:center;gap:10px">
        Snapshot history
        <span style="font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);padding:1px 6px;background:var(--panel);border-radius:4px">${snaps.length} stored</span>
      </h3>
    </div>

    <div class="snapshot-list">${snapsHtml}</div>

    <div style="margin-top:18px;padding:10px 14px;background:rgba(34,211,238,.04);border:1px solid rgba(34,211,238,.2);border-radius:8px;font-size:11.5px;color:var(--muted-bright);line-height:1.6">
      <b style="color:var(--accent)">Publish flow:</b> Use Publish preview / Promote in the topbar to push a snapshot to a channel.
      Restore here re-publishes an older snapshot as a new version (it never overwrites in place).
    </div>`;

  // wire downloads
  document.getElementById("exp-questions").onclick = () => {
    const json = JSON.stringify(state.questions || [], null, 2);
    downloadBlob(new Blob([json], { type: "application/json" }), "questions.json");
  };
  document.getElementById("exp-labels").onclick = () => {
    const json = JSON.stringify(loadLabels(), null, 2);
    downloadBlob(new Blob([json], { type: "application/json" }), "labels.json");
  };
  host.querySelectorAll(".snap-dl").forEach(b => {
    b.onclick = async () => {
      const name = b.dataset.name;
      const { data, error } = await supabase.storage.from("question-bundles").download(name);
      if (error || !data) { toast("bad", "Download failed", error?.message || "Storage error."); return; }
      downloadBlob(data, name);
    };
  });
  host.querySelectorAll(".snap-restore").forEach(b => {
    b.onclick = async () => {
      if (!state.isOwner) { toast("bad", "Owner only", "Restoring a snapshot requires the workspace owner."); return; }
      const name = b.dataset.name;
      const ok = await confirmModal({ title: "Restore snapshot?", body: `Re-publish ${name} as a new version and update the prod pointer.`, confirmText: "Restore" });
      if (!ok) return;
      try {
        const { data, error } = await supabase.storage.from("question-bundles").download(name);
        if (error || !data) throw error || new Error("Empty download");
        await republishSnapshot(data);
        toast("ok", "Snapshot restored", `${name} re-published as a new version.`);
        renderExportPage();
        refreshChannelPills();
      } catch (e) { toast("bad", "Restore failed", e?.message || String(e)); }
    };
  });
}

async function republishSnapshot(blob) {
  // Best-effort: re-upload the snapshot bytes as a new versioned file using
  // the existing publish path's naming convention. We bump by timestamp so
  // the new file always sorts after the latest version.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `restored-${ts}.json`;
  const { error } = await supabase.storage.from("question-bundles")
    .upload(name, blob, { upsert: false, contentType: "application/json", cacheControl: "0" });
  if (error) throw error;
  // Update prod pointer if the existing publish path uses prod.json
  await supabase.storage.from("question-bundles")
    .upload("prod.json", blob, { upsert: true, contentType: "application/json", cacheControl: "0" });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}
function humanSize(n) {
  if (!Number.isFinite(n)) return "—";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ─── Course preview ───
// Loaded module + image URL map (object URLs from File objects, or absolute URLs).
const _course = {
  mod: null,                   // parsed JSON of the active module
  modules: [],                 // session-loaded modules: [{ id, title, mod }]
  images: new Map(),           // filename → blob URL or absolute URL
  activeSectionIdx: 0,
  activeCardIdx: 0,
  editMode: false,             // edit vs. preview toggle
  // Editor state (used when editMode is true)
  selection: { kind: "module" },  // {kind:"module"} | {kind:"section", sectionIdx} | {kind:"card", sectionIdx, cardIdx}
  activeTab: "meta",           // depends on selection
  dirty: false,
  savedAt: null,
  saveTimer: null,
  previewSlideIdx: 0,          // slide-based phone preview (content + quiz)
  globalGlossary: new Map(),   // Map<normTerm, {term, definition, image, source_module, source_title, source_section}>
  imageUsage: new Map(),       // Map<filename, [{moduleId, moduleTitle, sectionIdx, sectionTitle, kind, term?}]>
  libraryTab: "modules",       // "modules" | "library" — toggle on the course landing page
  libraryFilter: { q: "", usage: "all" }, // search + usage filter for the Library tab
  glossLetter: "ALL",          // alphabet filter on the Glossary virtual module
};

function escapeMd(s) { return escapeHtml(s); }

/** Convert markdown to HTML. Handles ### headers, block/inline images,
 *  bullet lists, **bold**, and :term: glossary refs. */
function renderCardMarkdown(text) {
  const lines = text.split(/\r?\n/);
  let html = "";
  let i = 0;
  const isBlockImage = (ln) => /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(ln);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // ### card heading → <h3>
    const hm = line.match(/^###\s+(.*)$/);
    if (hm) { html += `<h3>${renderInline(hm[1])}</h3>`; i++; continue; }
    // block-level image on its own line → <figure>
    if (isBlockImage(line)) {
      const m = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/);
      html += renderFigure(m[1], m[2].trim());
      i++; continue;
    }
    // bullet list
    if (/^[•·\-\*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[•·\-\*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[•·\-\*]\s+/, ""));
        i++;
      }
      html += "<ul>" + items.map(it => `<li>${renderInline(it)}</li>`).join("") + "</ul>";
      continue;
    }
    // GFM table: header row | separator (---|---) | body rows.
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i+1])) {
      const splitRow = (s) => s.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
      const headers = splitRow(line);
      const aligns = splitRow(lines[i+1]).map(c => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : (r ? "right" : (l ? "left" : ""));
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      const ta = (k) => aligns[k] ? ` style="text-align:${aligns[k]}"` : "";
      const thead = `<thead><tr>${headers.map((h, k) => `<th${ta(k)}>${renderInline(h)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${rows.map(r => `<tr>${r.map((c, k) => `<td${ta(k)}>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      html += `<table class="course-table">${thead}${tbody}</table>`;
      continue;
    }
    // paragraph
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^###\s/.test(lines[i]) && !/^[•·\-\*]\s/.test(lines[i]) && !isBlockImage(lines[i]) && !/^\s*\|/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    html += `<p>${renderInline(para.join(" "))}</p>`;
  }
  return html;
}

function renderFigure(alt, src) {
  return `<figure class="course-figure">
    ${courseImg(src, { alt })}
    ${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ""}
  </figure>`;
}

function renderInline(s) {
  // Escape HTML first, then apply markdown (none of !, [, ], (, ), : are escaped).
  let out = escapeHtml(s);
  // inline images: ![alt](src) — lazy-hydrated via data-course-img.
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    return courseImg(src.trim(), { cls: "course-inline-img", alt });
  });
  // glossary term refs: :term: (Romanian letters allowed)
  out = out.replace(/:([^:\s][^:]{0,80}[^:\s]):/g, (m, term) => {
    const found = lookupGlossaryTerm(term);
    if (!found) return m; // not in glossary, leave literal
    return `<span class="course-term" data-term="${escapeHtml(term)}" tabindex="0">${escapeHtml(term)}</span>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out;
}

/** Slide-based preview that mimics the mobile app: one card per screen,
 *  swipe / arrow / dot navigation. Quiz items appear after the content
 *  cards as their own slides. */
function renderPhoneDeck(sec) {
  const cards = splitIntoCards(sec.content || "");
  const slides = [];
  // Empty section → single empty placeholder slide
  if (!cards.length) cards.push({ title: null, body: [] });
  for (const c of cards) {
    const body = Array.isArray(c.body) ? c.body.join("\n") : (c.body || "");
    const inner = (c.title ? `### ${c.title}\n` : "") + body;
    slides.push({ kind: "content", html: renderCardMarkdown(inner) });
  }
  for (const q of (sec.quiz || [])) {
    slides.push({ kind: "quiz", html: renderQuizSlide(q) });
  }
  const total = slides.length;
  if (_course.previewSlideIdx >= total) _course.previewSlideIdx = total - 1;
  if (_course.previewSlideIdx < 0) _course.previewSlideIdx = 0;
  const idx = _course.previewSlideIdx;
  const trackStyle = `transform: translateX(${-idx * 100}%)`;
  return `
    <div class="ce-phone-deck-wrap">
      <div class="ce-phone-deck" style="${trackStyle}">
        ${slides.map((s, i) => `
          <div class="ce-phone-slide ${s.kind === "quiz" ? "is-quiz" : ""}" data-slide-idx="${i}">
            ${s.html}
          </div>`).join("")}
      </div>
      <div class="ce-phone-pager">
        <button class="ce-phone-arrow" data-slide-dir="prev" ${idx === 0 ? "disabled" : ""} aria-label="Previous">‹</button>
        <div class="ce-phone-dots">
          ${slides.map((s, i) => `<span class="ce-phone-dot ${i === idx ? "active" : ""} ${s.kind === "quiz" ? "is-quiz" : ""}" data-slide-jump="${i}"></span>`).join("")}
        </div>
        <button class="ce-phone-arrow" data-slide-dir="next" ${idx >= total - 1 ? "disabled" : ""} aria-label="Next">›</button>
      </div>
    </div>`;
}

function attachDeckSwipe(el, onSwipe) {
  let startX = null, startY = null, locked = false;
  const reset = () => { startX = null; startY = null; locked = false; };
  el.addEventListener("touchstart", e => {
    const t = e.touches[0]; startX = t.clientX; startY = t.clientY; locked = false;
  }, { passive: true });
  el.addEventListener("touchmove", e => {
    if (startX == null) return;
    const t = e.touches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if (!locked && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) locked = true;
  }, { passive: true });
  el.addEventListener("touchend", e => {
    if (startX == null) { reset(); return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    if (locked && Math.abs(dx) > 40) onSwipe(dx < 0 ? 1 : -1);
    reset();
  });
  // Mouse drag fallback (useful on the desk preview)
  let mDown = false, mStart = 0;
  el.addEventListener("mousedown", e => { mDown = true; mStart = e.clientX; });
  el.addEventListener("mouseup", e => {
    if (!mDown) return;
    mDown = false;
    const dx = e.clientX - mStart;
    if (Math.abs(dx) > 40) onSwipe(dx < 0 ? 1 : -1);
  });
  el.addEventListener("mouseleave", () => { mDown = false; });
}

function renderQuizSlide(q) {
  const opts = (q.options || []).map((opt, i) =>
    `<button class="ce-phone-quiz-opt" data-correct="${i === q.correct ? 1 : 0}">${escapeHtml(opt)}</button>`
  ).join("");
  return `
    <div class="ce-phone-quiz-label">Verificare</div>
    <div class="ce-phone-quiz-q">${escapeHtml(q.question || "")}</div>
    <div class="ce-phone-quiz-opts">${opts}</div>`;
}

function normTerm(s) {
  return String(s || "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[șş]/g, "s").replace(/[țţ]/g, "t");
}

/** Resolve a :term: reference. Glossary is course-wide:
 *  1. Current section (closest scope, may override).
 *  2. Any other section in the active module.
 *  3. The cross-module index `_course.globalGlossary` (built from all modules).
 *  When the hit comes from outside the current module the image is still
 *  shown — images live in the course-wide bucket, no folder prefix. */
function lookupGlossaryTerm(term) {
  const want = normTerm(term);
  const mod = _course.mod;
  const activeIdx = _course.editMode
    ? (_course.selection?.kind === "section" ? _course.selection.sectionIdx : 0)
    : _course.activeSectionIdx;
  const sec = (mod?.sections || [])[activeIdx];
  for (const g of sec?.glossary || []) {
    if (normTerm(g.term) === want) return g;
  }
  for (const s of mod?.sections || []) {
    if (s === sec) continue;
    for (const g of s.glossary || []) {
      if (normTerm(g.term) === want) return g;
    }
  }
  return _course.globalGlossary?.get(want) || null;
}

/** Rebuild the cross-module glossary cache from every saved module. */
async function refreshGlobalGlossary() {
  try {
    const { data, error } = await supabase
      .from("course_modules")
      .select("id, title, data");
    if (error) { console.warn("globalGlossary load failed", error); return; }
    const map = new Map();
    for (const row of data || []) {
      const mod = row.data || {};
      for (const sec of mod.sections || []) {
        for (const g of sec.glossary || []) {
          if (!g.term) continue;
          const key = normTerm(g.term);
          if (!map.has(key)) {
            map.set(key, {
              term: g.term,
              definition: g.definition || "",
              image: g.image || null,
              source_module: row.id,
              source_title: row.title,
              source_section: sec.title || "",
            });
          }
        }
      }
    }
    _course.globalGlossary = map;
  } catch (e) { console.warn("globalGlossary refresh", e); }
}

/** Build a Map<filename, [usages]> from every module's content + glossary +
 *  section.images list. Used by the Images tab to show where each file is
 *  referenced (which module + section). The currently-open module is read
 *  from in-memory state so unsaved edits still count. */
async function computeCourseImageUsage() {
  const map = new Map();
  const add = (name, info) => {
    if (!name) return;
    const key = String(name).trim();
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(info);
  };
  const rxImg = /!\[[^\]]*\]\(([^)]+)\)/g;
  const walkMod = (mod, idForRow, titleForRow) => {
    for (let si = 0; si < (mod.sections || []).length; si++) {
      const sec = mod.sections[si];
      const text = sec.content || "";
      let m;
      rxImg.lastIndex = 0;
      while ((m = rxImg.exec(text)) !== null) {
        add(m[1].trim(), { moduleId: idForRow, moduleTitle: titleForRow, sectionIdx: si, sectionTitle: sec.title, kind: "content" });
      }
      for (const g of sec.glossary || []) {
        if (g.image) add(g.image, { moduleId: idForRow, moduleTitle: titleForRow, sectionIdx: si, sectionTitle: sec.title, kind: "glossary", term: g.term });
      }
      for (const img of sec.images || []) {
        add(img, { moduleId: idForRow, moduleTitle: titleForRow, sectionIdx: si, sectionTitle: sec.title, kind: "images-list" });
      }
    }
  };
  try {
    const { data, error } = await supabase
      .from("course_modules")
      .select("id, title, data");
    if (error) { console.warn("image usage load failed", error); return map; }
    const openId = _course.mod && !_course.mod._virtual ? _course.mod.id : null;
    for (const row of data || []) {
      if (row.id === openId) continue; // prefer in-memory copy below
      walkMod(row.data || {}, row.id, row.title);
    }
    // Add the currently-edited module from memory so unsaved refs count.
    if (openId) walkMod(_course.mod, openId, _course.mod.title);
  } catch (e) { console.warn("image usage", e); }
  return map;
}

/** Split a section's content into cards by `### header`. */
function splitIntoCards(content) {
  const lines = content.split(/\r?\n/);
  const cards = [];
  let cur = { title: null, body: [] };
  for (const ln of lines) {
    const m = ln.match(/^###\s+(.*)$/);
    if (m) {
      if (cur.title || cur.body.length) cards.push(cur);
      cur = { title: m[1].trim(), body: [] };
    } else {
      cur.body.push(ln);
    }
  }
  if (cur.title || cur.body.length) cards.push(cur);
  // If only one card and it has no title, leave title null (intro).
  return cards.map(c => ({ ...c, body: c.body.join("\n").trim() }));
}

/** Direct public URL into the course-images bucket — same trick the
 *  question-images gallery uses. No signing, no listing, no DB round-trip;
 *  the browser fetches the file when the <img> is actually rendered. */
function courseImageUrl(name) {
  if (!name) return "";
  const base = `${SUPABASE_URL}/storage/v1/object/public/course-images/${encodeURIComponent(name)}`;
  const v = _imageVersions.get(name);
  return v ? `${base}?v=${v}` : base;
}

function imageUrlFor(name) {
  // Kept for callers that still want a URL string. Always points at the
  // public endpoint; the browser will 404 (and CSS shows .img-missing) if
  // the file isn't in the bucket.
  return courseImageUrl(name);
}

function courseImg(name, opts = {}) {
  const cls = opts.cls ? ` class="${opts.cls}"` : "";
  const style = opts.style ? ` style="${opts.style}"` : "";
  const alt = opts.alt != null ? opts.alt : name;
  return `<img${cls}${style} src="${courseImageUrl(name)}" alt="${escapeHtml(alt)}" loading="lazy" onerror="this.classList.add('img-missing')" />`;
}

function renderCoursePage() {
  const body = document.getElementById("course-body");
  const crumb = document.getElementById("course-crumb");
  const mod = _course.mod;
  syncCourseModuleSelector();

  // Toolbar: enabled whenever a module is loaded; virtual modules (Glossary)
  // are read-only so edit/publish/upload are blocked.
  const hasMod = !!mod;
  const isVirtual = !!mod?._virtual;
  document.getElementById("course-back-btn").disabled = !hasMod;
  document.getElementById("course-imgs-btn").disabled = !hasMod || isVirtual;
  document.getElementById("course-edit-btn").disabled = !hasMod || isVirtual;
  document.getElementById("course-publish-btn").disabled = !hasMod || isVirtual;
  document.getElementById("course-download-btn").disabled = !hasMod || isVirtual;

  if (!mod) {
    crumb.textContent = "pick a module to edit, or import one";
    body.innerHTML = `<div class="placeholder">Loading modules…</div>`;
    renderCourseModulesList(body);
    return;
  }

  // GLOSSARY virtual module — custom A-Z + word-list layout.
  if (mod._virtual && mod._kind === "glossary") {
    crumb.textContent = `${mod.id} · ${mod.description || ""}`;
    body.innerHTML = renderGlossaryView();
    attachGlossaryHandlers(body);
    lazyHydrateCourseImages(body);
    return;
  }

  // EDIT MODE — new editor v1 (tree + tabs)
  if (_course.editMode) {
    body.innerHTML = renderCourseEditorV1();
    attachCourseEditorV1Handlers();
    lazyHydrateCourseImages(body);
    return;
  }

  // sidebar (section list) + main (cards for active section)
  const sections = mod.sections || [];
  const sec = sections[_course.activeSectionIdx] || sections[0];
  if (!sec) { body.innerHTML = `<div class="placeholder">Module has no sections.</div>`; return; }

  const cards = splitIntoCards(sec.content || "");
  // Build card list: content cards then quiz cards (one per question, like the app).
  const allCards = cards.map(c => ({ kind: "content", ...c }))
    .concat((sec.quiz || []).map((q, idx) => ({ kind: "quiz", q, idx })));

  // Active card clamp
  if (_course.activeCardIdx >= allCards.length) _course.activeCardIdx = 0;
  const activeCard = allCards[_course.activeCardIdx];

  const sectionItems = sections.map((s, i) => `
    <li class="${i === _course.activeSectionIdx ? "active" : ""}" data-sec-idx="${i}">
      <div class="topic-bar" style="background:${TOPIC_COLOR(mod.topic || 'navigation')}"></div>
      <div class="body">
        <div class="qtext">${escapeHtml(s.title || `Section ${i+1}`)}</div>
        <div class="meta">
          <span>${splitIntoCards(s.content || "").length} card${splitIntoCards(s.content || "").length === 1 ? "" : "s"}</span>
          <span>·</span>
          <span>${(s.quiz || []).length} quiz</span>
          <span>·</span>
          <span>${(s.images || []).length} img</span>
        </div>
      </div>
    </li>`).join("");

  crumb.textContent = `${mod.id || "—"} · ${(mod.description || "")}`;

  body.innerHTML = `
    <div class="course-layout">
      <aside class="course-sidebar">
        <div class="course-mod-head">
          <div class="course-mod-title">${escapeHtml(mod.title || mod.id || "Module")}</div>
          <div class="course-mod-desc">${escapeHtml(mod.description || "")}</div>
        </div>
        <ul class="qlist course-section-list">${sectionItems}</ul>
      </aside>

      <main class="course-workspace">
        ${_course.editMode ? renderCourseEditor(sec) : renderCourseReadMode(sec, allCards, activeCard)}
      </main>
    </div>`;

  // Wire interactions
  body.querySelectorAll(".course-section-list li").forEach(li => {
    li.onclick = () => {
      _course.activeSectionIdx = parseInt(li.dataset.secIdx, 10);
      _course.activeCardIdx = 0;
      renderCoursePage();
    };
  });
  body.querySelectorAll(".course-card-tab").forEach(t => {
    t.onclick = () => {
      _course.activeCardIdx = parseInt(t.dataset.cardIdx, 10);
      renderCoursePage();
    };
  });
  const prev = document.getElementById("course-prev-btn");
  const next = document.getElementById("course-next-btn");
  if (prev) prev.onclick = () => { _course.activeCardIdx = Math.max(0, _course.activeCardIdx - 1); renderCoursePage(); };
  if (next) next.onclick = () => { _course.activeCardIdx = Math.min(allCards.length - 1, _course.activeCardIdx + 1); renderCoursePage(); };
  if (_course.editMode) attachCourseEditorHandlers(sec);

  // Glossary term popovers
  body.querySelectorAll(".course-term").forEach(t => {
    t.addEventListener("click", e => { e.stopPropagation(); showTermPopover(t); });
    t.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showTermPopover(t); } });
  });

  // Wire quiz interactions (just visual reveal of correct)
  body.querySelectorAll(".course-quiz-opt").forEach(b => {
    b.onclick = () => {
      const picked = parseInt(b.dataset.pick, 10);
      const correct = parseInt(b.dataset.correct, 10);
      body.querySelectorAll(".course-quiz-opt").forEach(x => {
        x.classList.toggle("correct", parseInt(x.dataset.pick, 10) === correct);
        x.classList.toggle("wrong", parseInt(x.dataset.pick, 10) === picked && picked !== correct);
      });
    };
  });

  lazyHydrateCourseImages(body);
}

// ─── Course module list (no module loaded state) ───
async function renderCourseModulesList(body) {
  const list = await loadCourseModulesList();
  // Refresh cross-module index used by the Glossary virtual module + library usage.
  refreshGlobalGlossary();
  // Single .list("") call so the Library tab count is accurate even before
  // the user clicks into it. Cheap — no per-image work.
  if (!_course.imagePaths) {
    listCourseImagesFlat().then(names => {
      _course.imagePaths = new Map(names.map(n => [n, n]));
      renderCoursePage();
    });
  }
  // Compute usage once per Library entry, not on every re-render. An empty
  // result (no modules yet) is still a valid load — gated on a boolean,
  // not on map size, so we don't refetch forever.
  if (_course.libraryTab === "library" && !_course.imageUsageLoaded && !_course.imageUsageLoading) {
    _course.imageUsageLoading = true;
    computeCourseImageUsage().then(m => {
      _course.imageUsage = m;
      _course.imageUsageLoaded = true;
      _course.imageUsageLoading = false;
      if (_course.libraryTab === "library") renderCoursePage();
    });
  }

  const tab = _course.libraryTab;
  body.innerHTML = `
    <div class="course-list-pane">
      <div class="course-list-tabs" role="tablist">
        <button class="course-list-tab ${tab === "modules" ? "active" : ""}" data-clt="modules">Modules <span class="muted small">${list.length}</span></button>
        <button class="course-list-tab ${tab === "library" ? "active" : ""}" data-clt="library">Library <span class="muted small">${_course.imagePaths?.size ?? "—"}</span></button>
      </div>
      ${tab === "library" ? renderCourseLibraryPane() : renderCourseModulesPane(list)}
    </div>`;

  body.querySelectorAll(".course-list-tab").forEach(t => {
    t.onclick = () => { _course.libraryTab = t.dataset.clt; renderCoursePage(); };
  });

  if (tab === "library") {
    attachCourseLibraryHandlers(body);
    lazyHydrateCourseImages(body);
    return;
  }

  attachCourseModulesHandlers(body, list);
}

function renderCourseModulesPane(list) {
  const glossOn = isGlossaryEnabled();
  return `
      <div class="course-list-head">
        <h2>Modules <span class="muted small">${list.length} stored</span></h2>
        <div class="course-list-actions">
          <label class="cm-toggle" title="Show the auto-aggregated Glossary card">
            <input type="checkbox" id="cm-glossary-toggle" ${glossOn ? "checked" : ""} />
            Glossary
          </label>
          <button class="btn ghost" id="cm-new-btn">+ New empty module</button>
          <button class="btn ghost" id="cm-import-zip-btn" title="Import a module from a .zip with module.json and images/">Import .zip…</button>
          <button class="btn primary" id="cm-import-btn">Import .json…</button>
        </div>
      </div>
      <div class="course-list-grid">
        ${glossOn ? `
        <div class="cm-card cm-card-virtual" data-cm-virtual="glossary">
          <div class="cm-card-head">
            <div class="cm-card-title">📖 Glossary</div>
            <span class="cm-badge virtual">virtual</span>
          </div>
          <div class="cm-card-id">_glossary</div>
          <div class="cm-card-desc">All glossary terms aggregated from every module — auto-generated, read-only.</div>
          <div class="cm-card-meta"><span class="muted small">live</span></div>
          <div class="cm-card-footer">
            <div class="cm-card-actions">
              <button class="btn ghost cm-open-glossary">Open</button>
            </div>
          </div>
        </div>` : ""}
        ${list.length ? list.map((m, i) => {
            const lastEdit = m.updated_at ? formatDate(m.updated_at) : "—";
            const pub = m.published_at
              ? `<span class="cm-badge published" title="${escapeHtml(m.published_at)}">published</span>`
              : `<span class="cm-badge draft">draft</span>`;
            const upDisabled = i === 0 ? "disabled" : "";
            const downDisabled = i === list.length - 1 ? "disabled" : "";
            return `
              <div class="cm-card" data-cm-id="${escapeHtml(m.id)}" data-cm-order="${m.sort_order ?? ""}" data-cm-idx="${i}">
                <div class="cm-card-head">
                  <div class="cm-card-title">${escapeHtml(m.title || m.id)}</div>
                  ${pub}
                </div>
                <div class="cm-card-id">${escapeHtml(m.id)}</div>
                <div class="cm-card-desc">${escapeHtml(m.description || "")}</div>
                <div class="cm-card-meta"><span class="muted small">edited ${escapeHtml(lastEdit)}</span></div>
                <div class="cm-card-footer">
                  <div class="cm-card-actions">
                    <button class="btn ghost cm-up" data-idx="${i}" title="Move up" ${upDisabled}>↑</button>
                    <button class="btn ghost cm-down" data-idx="${i}" title="Move down" ${downDisabled}>↓</button>
                    <button class="btn ghost cm-open" data-id="${escapeHtml(m.id)}">Open</button>
                    <button class="btn ghost cm-zip" data-id="${escapeHtml(m.id)}" title="Download .zip (module + images)">⤓ zip</button>
                    <button class="btn ghost cm-publish" data-id="${escapeHtml(m.id)}" title="Publish to mobile app">Publish</button>
                    <button class="btn ghost cm-delete" data-id="${escapeHtml(m.id)}" title="Delete module">×</button>
                  </div>
                </div>
              </div>`;
          }).join("") : ""}
      </div>
      ${list.length ? "" : `<div class="course-list-empty">No modules yet. Use <b>Import .json</b> to add Marinărie, or <b>+ New empty module</b> to start from scratch.</div>`}`;
}

function attachCourseModulesHandlers(body, list) {
  const glossaryBtn = body.querySelector(".cm-open-glossary");
  if (glossaryBtn) glossaryBtn.onclick = (e) => { e.stopPropagation(); openGlossaryVirtualModule(); };
  const glossaryCard = body.querySelector(".cm-card-virtual");
  if (glossaryCard) glossaryCard.onclick = () => openGlossaryVirtualModule();
  const glossToggle = body.querySelector("#cm-glossary-toggle");
  if (glossToggle) glossToggle.onchange = () => { setGlossaryEnabled(glossToggle.checked); renderCoursePage(); };
  document.getElementById("cm-new-btn").onclick = () => createNewCourseModule();
  document.getElementById("cm-import-btn").onclick = () => {
    document.getElementById("course-json-input").click();
  };
  document.getElementById("cm-import-zip-btn").onclick = () => {
    const zipInput = document.getElementById("course-zip-input");
    if (zipInput) zipInput.click();
  };
  body.querySelectorAll(".cm-open").forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); openCourseModuleById(b.dataset.id); };
  });
  body.querySelectorAll(".cm-zip").forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const orig = b.innerHTML;
      b.disabled = true; b.innerHTML = "⤓ …";
      try { await downloadCourseModuleZip(id); }
      finally { b.disabled = false; b.innerHTML = orig; }
    };
  });
  body.querySelectorAll(".cm-publish").forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const ok = await confirmModal({
        title: "Publish module?",
        body: `The current draft of ${id} will be published. The mobile app will fetch the new content on next launch.`,
        confirmText: "Publish",
      });
      if (!ok) return;
      if (await publishCourseModuleRpc(id)) {
        toast("ok", "Published", id);
        renderCoursePage();
      }
    };
  });
  body.querySelectorAll(".cm-delete").forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const ok = await confirmModal({
        title: "Delete module?",
        body: `${id} will be removed permanently. Images in storage are NOT deleted.`,
        confirmText: "Delete",
      });
      if (!ok) return;
      if (await deleteCourseModuleFromDb(id)) {
        toast("ok", "Deleted", id);
        renderCoursePage();
      }
    };
  });
  // Reorder via up/down buttons. We swap sort_order with the neighbour and
  // re-render the list; if a neighbour's sort_order is NULL we fall back to
  // the index×10 sequence so the swap still has stable values.
  const moveBy = async (idx, delta) => {
    const target = idx + delta;
    if (target < 0 || target >= list.length) return;
    const a = list[idx], b = list[target];
    const orderA = a.sort_order ?? (idx + 1) * 10;
    const orderB = b.sort_order ?? (target + 1) * 10;
    if (await swapCourseModuleOrder(a.id, orderA, b.id, orderB)) {
      renderCoursePage();
    }
  };
  body.querySelectorAll(".cm-up").forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); moveBy(parseInt(b.dataset.idx, 10), -1); };
  });
  body.querySelectorAll(".cm-down").forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); moveBy(parseInt(b.dataset.idx, 10), +1); };
  });
  body.querySelectorAll(".cm-card").forEach(c => {
    c.onclick = () => openCourseModuleById(c.dataset.cmId);
  });
}

// ─── Course Library tab — gallery of every file in course-images bucket ───
function renderCourseLibraryPane() {
  const usage = _course.imageUsage || new Map();
  const usageCI = new Map();
  for (const [k, v] of usage) usageCI.set(String(k).toLowerCase(), v);
  const useCount = (n) => (usage.get(n) || usageCI.get(String(n).toLowerCase()) || []).length;
  const all = _course.imagePaths
    ? [..._course.imagePaths.keys()].sort()
    : [..._course.images.keys()].sort();
  const filt = _course.libraryFilter;
  const rows = all.filter(name => {
    if (filt.q && !name.toLowerCase().includes(filt.q.toLowerCase())) return false;
    const used = useCount(name) > 0;
    if (filt.usage === "used"   && !used) return false;
    if (filt.usage === "unused" && used)  return false;
    return true;
  });
  const orphans = all.filter(n => !useCount(n)).length;

  const tiles = rows.map(name => {
    const uses = usage.get(name) || usageCI.get(String(name).toLowerCase()) || [];
    const mods = [...new Set(uses.map(u => u.moduleTitle || u.moduleId))];
    const refBadge = uses.length
      ? `<span class="img-badge used" title="${escapeHtml(uses.map(u => `${u.moduleTitle || u.moduleId} · ${u.sectionTitle || u.sectionIdx} · ${u.kind}${u.term ? ` (${u.term})` : ""}`).join("\n"))}"><span class="img-badge-num">${uses.length}</span>× · ${mods.length} mod</span>`
      : `<span class="img-badge orphan" title="No module references this image">orphan</span>`;
    return `
      <div class="image-card" data-cl-name="${escapeHtml(name)}">
        <div class="image-card-thumb">
          ${courseImg(name, { alt: name })}
          <div class="image-card-overlay">
            <button class="img-action" data-cl-replace="${escapeHtml(name)}" title="Upload new bytes under this name">Replace</button>
            <button class="img-action" data-cl-rename="${escapeHtml(name)}" title="Rename — all module refs will be updated">Rename</button>
          </div>
        </div>
        <div class="image-card-body">
          <div class="image-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="image-card-meta">
            ${refBadge}
            <button class="icon-btn cl-delete" data-cl-delete="${escapeHtml(name)}" title="${uses.length ? "Cannot delete — image is in use" : "Delete from bucket"}" ${uses.length ? "disabled" : ""}>×</button>
          </div>
        </div>
      </div>`;
  }).join("");

  return `
      <div class="course-list-head">
        <h2>Library <span class="muted small">${rows.length} of ${all.length}${filt.q || filt.usage !== "all" ? " (filtered)" : ""} · ${orphans} orphan${orphans === 1 ? "" : "s"}</span></h2>
        <div class="course-list-actions">
          <input type="text" id="cl-search" placeholder="Filter by name…" value="${escapeHtml(filt.q || "")}" />
          <select id="cl-usage">
            <option value="all"    ${filt.usage === "all"    ? "selected" : ""}>All</option>
            <option value="used"   ${filt.usage === "used"   ? "selected" : ""}>Used</option>
            <option value="unused" ${filt.usage === "unused" ? "selected" : ""}>Orphans</option>
          </select>
          <button class="btn primary" id="cl-upload-btn">+ Upload images…</button>
        </div>
      </div>
      ${rows.length
        ? `<div class="images-grid">${tiles}</div>`
        : `<div class="course-list-empty">No images match.${_course.images.size === 0 ? " Bucket may still be loading." : ""}</div>`}`;
}

function attachCourseLibraryHandlers(body) {
  const search = body.querySelector("#cl-search");
  if (search) {
    let t;
    search.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => { _course.libraryFilter.q = search.value; renderCoursePage(); }, 150);
    };
  }
  const usage = body.querySelector("#cl-usage");
  if (usage) usage.onchange = () => { _course.libraryFilter.usage = usage.value; renderCoursePage(); };

  body.querySelector("#cl-upload-btn")?.addEventListener("click", () => {
    const inp = document.getElementById("course-img-bulk-input");
    if (inp) inp.click();
  });

  body.querySelectorAll("[data-cl-replace]").forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); promptReplaceCourseImage(b.dataset.clReplace); };
  });
  body.querySelectorAll("[data-cl-rename]").forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); promptRenameCourseImage(b.dataset.clRename); };
  });
  body.querySelectorAll("[data-cl-delete]").forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); promptDeleteCourseImage(b.dataset.clDelete); };
  });
}

async function findCourseImagePath(name) {
  // Root copy wins; fall back to any subfolder.
  const root = await supabase.storage.from("course-images").list("", { limit: 1000 });
  if (root.data?.some(o => o.name === name && o.id != null)) return name;
  for (const obj of root.data || []) {
    if (obj.id != null) continue;
    const sub = await supabase.storage.from("course-images").list(obj.name, { limit: 1000 });
    if (sub.data?.some(o => o.name === name && o.id != null)) return `${obj.name}/${name}`;
  }
  return null;
}

async function promptRenameCourseImage(oldName) {
  const newName = prompt("Rename to:", oldName);
  if (!newName || newName === oldName) return;
  if (_course.images.has(newName)) {
    toast("bad", "Already exists", `"${newName}" is already in the bucket.`);
    return;
  }
  await renameCourseImage(oldName, newName);
}

/** Storage move + rewrite every reference inside `course_modules.data`. */
async function renameCourseImage(oldName, newName) {
  const fullPath = await findCourseImagePath(oldName);
  if (!fullPath) { toast("bad", "Not found", oldName); return; }
  const { error: mvErr } = await supabase.storage.from("course-images").move(fullPath, newName);
  if (mvErr) { toast("bad", "Storage move failed", mvErr.message); return; }

  // Rewrite refs across every module row that mentions the old name.
  const { data: rows, error: selErr } = await supabase.from("course_modules").select("id, data");
  if (selErr) { toast("bad", "Renamed in storage but DB load failed", selErr.message); return; }
  let modsTouched = 0, refsTouched = 0;
  for (const row of rows || []) {
    const before = JSON.stringify(row.data || {});
    if (!before.includes(oldName)) continue;
    // Targeted rewrite: content markdown, section.images[], glossary[].image.
    const mod = row.data || {};
    for (const sec of mod.sections || []) {
      if (typeof sec.content === "string") {
        const next = sec.content.split(oldName).join(newName);
        if (next !== sec.content) { sec.content = next; refsTouched++; }
      }
      if (Array.isArray(sec.images)) {
        sec.images = sec.images.map(n => { if (n === oldName) { refsTouched++; return newName; } return n; });
      }
      for (const g of sec.glossary || []) {
        if (g.image === oldName) { g.image = newName; refsTouched++; }
      }
    }
    const { error: upErr } = await supabase.from("course_modules").update({ data: mod }).eq("id", row.id);
    if (upErr) { toast("bad", `Renamed but ${row.id} update failed`, upErr.message); continue; }
    modsTouched++;
  }

  _course.imagePaths = null;
  _course.imageUsage = new Map(); _course.imageUsageLoaded = false;
  toast("ok", "Renamed", `${refsTouched} ref${refsTouched === 1 ? "" : "s"} across ${modsTouched} module${modsTouched === 1 ? "" : "s"} updated`);
  renderCoursePage();
}

function promptReplaceCourseImage(targetName) {
  const inp = document.getElementById("course-img-replace-input");
  if (!inp) return;
  inp.dataset.targetName = targetName;
  inp.value = "";
  inp.click();
}

async function replaceCourseImage(targetName, file) {
  try {
    const fullPath = (await findCourseImagePath(targetName)) || targetName;
    const { error } = await supabase.storage.from("course-images").upload(fullPath, file, { upsert: true, contentType: file.type || "image/png" });
    if (error) { toast("bad", "Replace failed", error.message); return; }
    // Force browser to refetch — same URL would otherwise serve the old bytes.
    bumpImageVersion(targetName);
    toast("ok", "Replaced", targetName);
    renderCoursePage();
  } catch (e) { toast("bad", "Replace failed", String(e)); }
}

async function promptDeleteCourseImage(name) {
  const uses = (_course.imageUsage?.get(name) || []).length;
  if (uses) { toast("bad", "Cannot delete", `${uses} reference${uses === 1 ? "" : "s"} still use this image.`); return; }
  const ok = await confirmModal({
    title: "Delete image?",
    body: `${name} will be removed from the course-images bucket. No module references this file.`,
    confirmText: "Delete",
  });
  if (!ok) return;
  const fullPath = (await findCourseImagePath(name)) || name;
  const { error } = await supabase.storage.from("course-images").remove([fullPath]);
  if (error) { toast("bad", "Delete failed", error.message); return; }
  _course.imagePaths = null;
  _course.imageUsage = new Map(); _course.imageUsageLoaded = false;
  toast("ok", "Deleted", name);
  renderCoursePage();
}

async function bulkUploadCourseImages(files) {
  let ok = 0, fail = 0;
  for (const f of files || []) {
    if (await uploadCourseImageToBucket(f, _course.mod?.id || "library")) ok++;
    else fail++;
  }
  _course.imagePaths = null;
  _course.imageUsage = new Map(); _course.imageUsageLoaded = false;
  toast(fail ? "warn" : "ok", `${ok}/${(files || []).length} uploaded`, fail ? `${fail} failed` : "course-images bucket");
  renderCoursePage();
}

async function openCourseModuleById(id) {
  const row = await loadCourseModuleFromDb(id);
  if (!row) return;
  const mod = row.data || { id };
  // ensure id round-trips
  if (!mod.id) mod.id = id;
  if (!mod.title && row.title) mod.title = row.title;
  if (!mod.description && row.description) mod.description = row.description;
  _course.mod = mod;
  _course.savedAt = row.updated_at;
  _course.dirty = false;
  _course.editMode = true;
  _course.selection = { kind: "module" };
  _course.activeTab = "meta";
  document.getElementById("course-edit-btn").textContent = "Done editing";
  // Public-URL <img>s — no signing, no preload. Browser fetches each file
  // when it's actually rendered (loading="lazy" defers off-screen ones).
  renderCoursePage();
}

/** Build and open a synthesized "Glossary" module made of every term across
 *  the saved modules. Opens in read-only preview (no edit, no save). */
async function openGlossaryVirtualModule() {
  await refreshGlobalGlossary();
  const entries = [..._course.globalGlossary.values()]
    .sort((a, b) => normTerm(a.term).localeCompare(normTerm(b.term)));

  if (!entries.length) {
    toast("warn", "Glossary is empty", "No terms found across modules.");
    return;
  }

  // One section per term so the existing sidebar nav still works, even
  // though renderCoursePage routes virtual+glossary to a custom layout.
  const sections = entries.map(e => {
    const imgLine = e.image ? `![${e.term}](${e.image})\n\n` : "";
    const def = e.definition ? `${e.definition}\n\n` : "";
    const src = `*sursă: ${e.source_title || e.source_module} → ${e.source_section || "—"}*`;
    const first = (normTerm(e.term)[0] || "").toUpperCase();
    const letter = /^[A-Z]$/.test(first) ? first : "#";
    return {
      id: `_glossary_${normTerm(e.term)}`,
      title: e.term,
      content: `${imgLine}${def}${src}`,
      images: e.image ? [e.image] : [],
      glossary: [],
      quiz: [],
      _letter: letter,
    };
  });

  _course.mod = {
    id: "_glossary",
    title: "Glossary",
    description: `${entries.length} termeni · agregat din toate modulele`,
    sections,
    _virtual: true,
    _kind: "glossary",
  };
  _course.savedAt = null;
  _course.dirty = false;
  _course.editMode = false;
  _course.selection = { kind: "module" };
  _course.activeTab = "meta";
  _course.activeSectionIdx = 0;
  _course.activeCardIdx = 0;
  _course.glossLetter = "ALL";
  renderCoursePage();
}

function isGlossaryEnabled() {
  try { return localStorage.getItem("caahq-glossary-enabled") !== "0"; } catch { return true; }
}
function setGlossaryEnabled(on) {
  try { localStorage.setItem("caahq-glossary-enabled", on ? "1" : "0"); } catch {}
}

/** Render the Glossary virtual module: alphabet bar on top of sidebar,
 *  word list below (filtered by the active letter), term detail on the right.
 *  Active letter lives on `_course.glossLetter` — "ALL" shows every term;
 *  "#" buckets non-letter starts (digits, symbols). */
function renderGlossaryView() {
  const mod = _course.mod;
  const sections = mod.sections || [];
  const presentLetters = new Set(sections.map(s => s._letter));
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter(L => presentLetters.has(L));
  const hasHash = presentLetters.has("#");
  const filter = _course.glossLetter || "ALL";

  const buttons = [
    { key: "ALL", label: "ALL" },
    ...(hasHash ? [{ key: "#", label: "#" }] : []),
    ...letters.map(L => ({ key: L, label: L })),
  ];
  const alphabetBar = buttons.map(b => `
    <button class="gloss-letter ${b.key === filter ? "active" : ""}" data-gloss-letter="${b.key}">${b.label}</button>
  `).join("");

  const visible = filter === "ALL"
    ? sections.map((s, i) => ({ s, i }))
    : sections.map((s, i) => ({ s, i })).filter(x => x.s._letter === filter);

  const activeIdx = visible.some(x => x.i === _course.activeSectionIdx)
    ? _course.activeSectionIdx
    : (visible[0]?.i ?? 0);
  const active = sections[activeIdx];

  const wordItems = visible.map(({ s, i }) => `
    <li class="${i === activeIdx ? "active" : ""}" data-sec-idx="${i}">
      <span class="gloss-word-letter">${s._letter}</span>
      <span class="gloss-word-term">${escapeHtml(s.title)}</span>
    </li>`).join("") || `<li class="gloss-empty">No terms.</li>`;

  const detail = active ? renderGlossaryDetail(active) : `<div class="placeholder">No term selected.</div>`;

  return `
    <div class="course-layout gloss-layout">
      <aside class="course-sidebar gloss-sidebar">
        <div class="course-mod-head">
          <div class="course-mod-title">${escapeHtml(mod.title)}</div>
          <div class="course-mod-desc">${escapeHtml(mod.description || "")} · ${visible.length} of ${sections.length}</div>
        </div>
        <div class="gloss-alphabet">${alphabetBar}</div>
        <ul class="gloss-word-list">${wordItems}</ul>
      </aside>
      <main class="course-workspace gloss-detail">${detail}</main>
    </div>`;
}

function renderGlossaryDetail(sec) {
  return `
    <div class="gloss-card">
      <h2 class="gloss-term">${escapeHtml(sec.title)}</h2>
      <div class="gloss-body">${renderCardMarkdown(sec.content || "")}</div>
    </div>`;
}

function attachGlossaryHandlers(body) {
  body.querySelectorAll("[data-gloss-letter]").forEach(b => {
    b.onclick = () => {
      const L = b.dataset.glossLetter;
      _course.glossLetter = L;
      // Snap selection to the first term in the new filter so the detail
      // pane shows something matching.
      const sections = _course.mod.sections || [];
      const firstIdx = L === "ALL"
        ? 0
        : sections.findIndex(s => s._letter === L);
      if (firstIdx >= 0) _course.activeSectionIdx = firstIdx;
      renderCoursePage();
    };
  });
  body.querySelectorAll(".gloss-word-list li[data-sec-idx]").forEach(li => {
    li.onclick = () => {
      _course.activeSectionIdx = parseInt(li.dataset.secIdx, 10);
      renderCoursePage();
    };
  });
}

async function createNewCourseModule() {
  const id = prompt("Module id (e.g. m9, m10):", "");
  if (!id) return;
  const slug = id.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!slug) { toast("bad", "Invalid id", "Use letters, digits, underscore."); return; }
  const mod = {
    id: slug, title: "New module", description: "",
    sections: [{ id: `${slug}_s1`, title: "Section 1", content: "Start here…", images: [], glossary: [], quiz: [] }],
  };
  if (!await saveCourseModuleToDb(mod)) return;
  await openCourseModuleById(slug);
}

// ─── Course persistence layer ───
async function loadCourseModulesList() {
  const { data, error } = await supabase
    .from("course_modules")
    .select("id, title, description, updated_at, published_at, sort_order")
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("id", { ascending: true });
  if (error) { toast("bad", "Couldn't load modules", error.message); return []; }
  return data || [];
}

/** Swap the sort_order of two modules so the user-visible order shifts by 1. */
async function swapCourseModuleOrder(idA, orderA, idB, orderB) {
  // Atomic-ish: update both rows with the swapped values.
  const { error: eA } = await supabase.from("course_modules")
    .update({ sort_order: orderB }).eq("id", idA);
  if (eA) { toast("bad", "Reorder failed", eA.message); return false; }
  const { error: eB } = await supabase.from("course_modules")
    .update({ sort_order: orderA }).eq("id", idB);
  if (eB) { toast("bad", "Reorder failed", eB.message); return false; }
  return true;
}

async function loadCourseModuleFromDb(id) {
  const { data, error } = await supabase
    .from("course_modules")
    .select("id, title, description, data, published_data, updated_at, published_at")
    .eq("id", id).maybeSingle();
  if (error) { toast("bad", "Couldn't load module", error.message); return null; }
  return data;
}

async function saveCourseModuleToDb(mod) {
  const row = {
    id: mod.id,
    title: mod.title || "",
    description: mod.description || "",
    data: mod,
  };
  const { error } = await supabase.from("course_modules").upsert(row, { onConflict: "id" });
  if (error) { toast("bad", "Couldn't save module", error.message); return false; }
  return true;
}

async function deleteCourseModuleFromDb(id) {
  const { error } = await supabase.from("course_modules").delete().eq("id", id);
  if (error) { toast("bad", "Couldn't delete", error.message); return false; }
  return true;
}

async function publishCourseModuleRpc(id) {
  const { error } = await supabase.rpc("publish_course_module", { p_module_id: id });
  if (error) { toast("bad", "Publish failed", error.message); return false; }
  return true;
}

/** Images are now stored FLAT at the course bucket root — no per-module folder.
 *  The filename is the only identifier; `![](filename.png)` resolves the same
 *  way from any module. moduleId is accepted for back-compat but ignored. */
async function uploadCourseImageToBucket(file, _moduleId) {
  const path = file.name;
  const { error } = await supabase.storage.from("course-images")
    .upload(path, file, { upsert: true, contentType: file.type || "image/png", cacheControl: "3600" });
  if (error) { toast("bad", "Upload failed", error.message); return null; }
  return path;
}

/** Load every image in the course-images bucket into the in-memory cache.
 *  Walks the bucket root AND any per-module subfolders left over from the
 *  earlier nested layout, so legacy uploads keep resolving by filename. */
// No-op shims kept so the older call sites stay valid. Real loading happens
// via direct public URLs (`courseImageUrl`); browser's native `loading="lazy"`
// handles deferral when imgs are off-screen.
function collectModuleImageNames() { return []; }
async function signCourseImagesByName() {}
async function fetchCourseImages() {}
function lazyHydrateCourseImages() {}
async function ensureCourseImagePathIndex() { return new Map(); }

/** Single `.list("")` call against the bucket root. New uploads land at root,
 *  so this is what Library needs. Returns just the filenames. */
async function listCourseImagesFlat() {
  const { data, error } = await supabase.storage.from("course-images")
    .list("", { limit: 1000 });
  if (error) { console.warn("list course-images", error); return []; }
  return (data || []).filter(o => o.id != null).map(o => o.name);
}

// Back-compat shim — older callers still pass a moduleId arg.
async function fetchCourseImagesForModule(_moduleId) {
  return fetchCourseImages();
}

// ─── Course editor v1 (tree + tabs) ───
function selKey(sel) {
  if (sel.kind === "module") return "module";
  if (sel.kind === "section") return `s:${sel.sectionIdx}`;
  if (sel.kind === "card") return `c:${sel.sectionIdx}:${sel.cardIdx}`;
  return "";
}

function tabsForSelection(sel) {
  if (sel.kind === "module") return ["meta"];
  if (sel.kind === "section") return ["content", "images", "glossary", "quiz", "meta"];
  return ["meta"];
}

function ensureValidTab() {
  const tabs = tabsForSelection(_course.selection);
  if (!tabs.includes(_course.activeTab)) _course.activeTab = tabs[0];
}

// Split a section's content into card descriptors by `### title`.
function sectionCards(sec) {
  const lines = (sec.content || "").split(/\r?\n/);
  const cards = [];
  let cur = { title: null, body: [] };
  for (const ln of lines) {
    const m = ln.match(/^###\s+(.*)$/);
    if (m) {
      if (cur.title || cur.body.length) cards.push({ ...cur, body: cur.body.join("\n").replace(/^\n+|\n+$/g, "") });
      cur = { title: m[1].trim(), body: [] };
    } else {
      cur.body.push(ln);
    }
  }
  if (cur.title || cur.body.length) cards.push({ ...cur, body: cur.body.join("\n").replace(/^\n+|\n+$/g, "") });
  return cards;
}

// Re-emit a section's content from edited card descriptors.
function rebuildSectionContent(cards) {
  return cards.map((c, i) => {
    const head = c.title ? `### ${c.title}` : "";
    const body = (c.body || "").trim();
    return [head, body].filter(Boolean).join("\n\n");
  }).join("\n\n");
}

function renderCourseEditorV1() {
  ensureValidTab();
  const mod = _course.mod;
  const sel = _course.selection;
  const tabs = tabsForSelection(sel);

  return `
    <div class="ce-shell">
      <aside class="ce-tree" id="ce-tree">
        ${renderCETree()}
      </aside>
      <main class="ce-center">
        <div class="ce-tabs">
          ${tabs.map(t => `<button class="ce-tab ${t === _course.activeTab ? "active" : ""}" data-tab="${t}">${tabLabel(t)}</button>`).join("")}
        </div>
        <div class="ce-tab-body${_course.activeTab === "content" ? " is-content" : ""}" id="ce-tab-body">
          ${renderCETabBody()}
        </div>
        <div class="ce-status">
          <span class="ce-status-dirty ${_course.dirty ? "dirty" : "saved"}">
            <span class="dot"></span>
            <span>${_course.dirty ? "Unsaved changes" : (_course.savedAt ? `Saved · ${formatDate(_course.savedAt)}` : "All saved")}</span>
          </span>
          <span class="muted small">drafts kept in this browser · use Download for a file copy</span>
        </div>
      </main>
    </div>`;
}

function tabLabel(t) {
  return { meta: "Meta", content: "Content", images: "Images", glossary: "Glossary", quiz: "Quiz" }[t] || t;
}

function renderCETree() {
  const mod = _course.mod;
  const sel = _course.selection;
  const modActive = sel.kind === "module" ? " active" : "";
  return `
    <div class="ce-tree-head">
      <div class="ce-tree-mod-title ${modActive}" data-select="module">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
        <span>${escapeHtml(mod.title || mod.id || "Untitled module")}</span>
      </div>
    </div>
    <ul class="ce-tree-list">
      ${(mod.sections || []).map((s, si) => {
        const sActive = sel.kind === "section" && sel.sectionIdx === si ? " active" : "";
        const cards = sectionCards(s);
        return `
        <li class="ce-tree-section">
          <div class="ce-tree-row${sActive}" data-select="section" data-si="${si}">
            <button class="ce-tree-caret" data-toggle-sec="${si}" title="Expand">▾</button>
            <span class="ce-tree-label">${escapeHtml(s.title || `Section ${si+1}`)}</span>
            <button class="ce-tree-add" data-add-card="${si}" title="Add card">+</button>
          </div>
          <ul class="ce-tree-cards">
            ${cards.map((c, ci) => {
              const cActive = sel.kind === "card" && sel.sectionIdx === si && sel.cardIdx === ci ? " active" : "";
              return `<li class="ce-tree-card${cActive}" data-select="card" data-si="${si}" data-ci="${ci}">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
                <span>${escapeHtml(c.title || "(intro)")}</span>
              </li>`;
            }).join("")}
          </ul>
        </li>`;
      }).join("")}
    </ul>
    <div class="ce-tree-add-section">
      <button class="btn ghost" id="ce-add-section">+ Add section</button>
    </div>`;
}

function renderCETabBody() {
  const sel = _course.selection;
  if (_course.activeTab === "meta") return renderCEMetaTab();
  if (_course.activeTab === "content") return renderCEContentTab();
  if (_course.activeTab === "images") return renderCEImagesTab();
  if (_course.activeTab === "glossary") return renderCEGlossaryTab();
  if (_course.activeTab === "quiz") return renderCEQuizTab();
  return `<div class="placeholder">Pick a tab.</div>`;
}

function renderCEMetaTab() {
  const sel = _course.selection;
  const mod = _course.mod;
  if (sel.kind === "module") {
    return `
      <div class="ce-form">
        <label>Module ID <span class="muted small">(immutable)</span>
          <input type="text" id="ce-mod-id" value="${escapeHtml(mod.id || "")}" disabled />
        </label>
        <label>Module title
          <input type="text" id="ce-mod-title" value="${escapeHtml(mod.title || "")}" />
        </label>
        <label>Description
          <textarea id="ce-mod-desc" rows="2">${escapeHtml(mod.description || "")}</textarea>
        </label>
        <div class="ce-form-stats">
          ${(mod.sections || []).length} section${(mod.sections || []).length === 1 ? "" : "s"} ·
          ${(mod.sections || []).reduce((a, s) => a + sectionCards(s).length, 0)} cards ·
          ${(mod.sections || []).reduce((a, s) => a + (s.quiz || []).length, 0)} quiz questions ·
          ${(mod.sections || []).reduce((a, s) => a + (s.glossary || []).length, 0)} glossary terms
        </div>
      </div>`;
  }
  if (sel.kind === "section") {
    const sec = mod.sections[sel.sectionIdx];
    return `
      <div class="ce-form">
        <label>Section ID <span class="muted small">(immutable)</span>
          <input type="text" value="${escapeHtml(sec.id || "")}" disabled />
        </label>
        <label>Section title
          <input type="text" id="ce-sec-title" value="${escapeHtml(sec.title || "")}" />
        </label>
        <div class="ce-form-stats">
          ${sectionCards(sec).length} cards · ${(sec.quiz || []).length} quiz · ${(sec.glossary || []).length} terms · ${(sec.images || []).length} images
        </div>
        <div class="ce-danger">
          <button class="btn bad-ghost" id="ce-sec-delete">Delete section</button>
        </div>
      </div>`;
  }
  return "";
}

function renderCEContentTab() {
  const sel = _course.selection;
  const mod = _course.mod;
  if (sel.kind === "section") {
    const sec = mod.sections[sel.sectionIdx];
    return `
      <div class="ce-content-pane">
        <div class="ce-content-split">
          <div class="ce-editor-col">
            <div class="ce-toolbar">
              <button type="button" class="ce-tool" data-md="**" title="Bold">B</button>
              <button type="button" class="ce-tool" data-md="### " data-md-block title="Card header">H</button>
              <button type="button" class="ce-tool" data-md="• " data-md-line title="Bullet">•</button>
              <button type="button" class="ce-tool" data-md-image title="Insert image">img</button>
              <button type="button" class="ce-tool" data-md-term title="Insert glossary term">:term:</button>
              <span class="ce-toolbar-hint">preview syncs to caret</span>
            </div>
            <textarea id="ce-content" spellcheck="true">${escapeHtml(sec.content || "")}</textarea>
          </div>
          <div class="ce-phone-wrap">
            <div class="ce-phone-frame">
              <div class="ce-phone-notch"></div>
              <div class="ce-phone-screen">
                <div class="ce-phone-statusbar">
                  <span>9:41</span>
                  <span class="ce-phone-statusbar-icons">●●●●</span>
                </div>
                <div class="ce-phone-nav">
                  <span class="ce-phone-nav-back">←</span>
                  <span class="ce-phone-nav-title">${escapeHtml(sec.title || "")}</span>
                </div>
                <div class="ce-phone-content" id="ce-content-preview">${renderPhoneDeck(sec)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }
  return `<div class="placeholder">Select a section to edit content.</div>`;
}

function renderCEImagesTab() {
  const sel = _course.selection;
  if (sel.kind !== "section") return `<div class="placeholder">Pick a section to manage its images.</div>`;
  const sec = _course.mod.sections[sel.sectionIdx];
  const imgs = sec.images || [];
  const usage = _course.imageUsage || new Map();
  const usageCI = new Map();
  for (const [k, v] of usage) usageCI.set(String(k).toLowerCase(), v);
  const renderUsage = (name) => {
    const uses = usage.get(name) || usageCI.get(String(name).toLowerCase()) || [];
    if (!uses.length) return `<span class="ce-img-uses none">unused</span>`;
    // Collapse to "N module(s)" with hover title listing them.
    const mods = [...new Set(uses.map(u => u.moduleTitle || u.moduleId))];
    const title = uses.map(u => `${u.moduleTitle || u.moduleId} · ${u.sectionTitle || u.sectionIdx} · ${u.kind}${u.term ? ` (${u.term})` : ""}`).join("\n");
    return `<span class="ce-img-uses" title="${escapeHtml(title)}">${uses.length}× · ${mods.length} mod</span>`;
  };
  return `
    <div class="ce-images-pane">
      <div class="ce-images-toolbar">
        <button class="btn ghost" id="ce-img-pick">Pick from loaded…</button>
        <input type="text" id="ce-img-add-name" placeholder="filename.png" />
        <button class="btn ghost" id="ce-img-add">+ Add by name</button>
        <span class="ce-toolbar-hint" style="margin-left:auto">${usage.size} files indexed</span>
      </div>
      <div class="ce-images-grid">
        ${imgs.map((name, i) => {
          return `
            <div class="ce-img-tile" data-img-idx="${i}" draggable="true">
              <div class="ce-img-thumb">
                ${courseImg(name, { alt: name })}
              </div>
              <div class="ce-img-name">${escapeHtml(name)}</div>
              <div class="ce-img-meta">${renderUsage(name)}</div>
              <div class="ce-img-actions">
                <button class="icon-btn" data-img-copy="${escapeHtml(name)}" title="Copy ![](filename) markdown">md</button>
                <button class="icon-btn" data-img-remove="${i}" title="Remove from section">×</button>
              </div>
            </div>`;
        }).join("") || `<div class="placeholder" style="grid-column:1/-1">No images yet. Pick from loaded set or add by name.</div>`}
      </div>
    </div>`;
}

function renderCEGlossaryTab() {
  const sel = _course.selection;
  if (sel.kind !== "section") return `<div class="placeholder">Pick a section to manage its glossary.</div>`;
  const sec = _course.mod.sections[sel.sectionIdx];
  const rows = (sec.glossary || []).map((g, i) => `
    <tr data-gloss-idx="${i}">
      <td><input type="text" data-g-term value="${escapeHtml(g.term || "")}" placeholder="term" /></td>
      <td>
        <select data-g-image>
          <option value="">(no image)</option>
          ${(sec.images || []).map(name =>
            `<option value="${escapeHtml(name)}" ${name === g.image ? "selected" : ""}>${escapeHtml(name)}</option>`
          ).join("")}
        </select>
      </td>
      <td><input type="text" data-g-def value="${escapeHtml(g.definition || "")}" placeholder="definition" /></td>
      <td><button class="icon-btn" data-g-del title="Delete term">×</button></td>
    </tr>`).join("");
  return `
    <div class="ce-glossary-pane">
      <table class="course-glossary-table">
        <thead><tr><th>Term</th><th>Image</th><th>Definition</th><th></th></tr></thead>
        <tbody id="ce-glossary">${rows || `<tr><td colspan="4" class="placeholder" style="padding:16px">No terms yet.</td></tr>`}</tbody>
      </table>
      <button class="btn ghost" id="ce-gloss-add">+ Add term</button>
    </div>`;
}

function renderCEQuizTab() {
  const sel = _course.selection;
  if (sel.kind !== "section") return `<div class="placeholder">Pick a section to manage its quiz.</div>`;
  const sec = _course.mod.sections[sel.sectionIdx];
  const items = (sec.quiz || []).map((q, qi) => `
    <div class="ce-quiz-item" data-q-idx="${qi}">
      <div class="ce-quiz-head">
        <span class="muted small">Q${qi + 1}</span>
        <button class="icon-btn" data-q-del="${qi}" title="Delete question">×</button>
      </div>
      <label class="ce-quiz-q-label">
        <span class="muted small">Question</span>
        <textarea data-q-text rows="2">${escapeHtml(q.question || "")}</textarea>
      </label>
      <div class="ce-quiz-options">
        ${(q.options || []).map((o, oi) => `
          <div class="ce-quiz-opt-row ${oi === q.correct ? "correct" : ""}">
            <label class="ce-quiz-correct" title="Mark correct">
              <input type="radio" name="ce-correct-${qi}" data-q-correct="${oi}" ${oi === q.correct ? "checked" : ""} />
              <span></span>
            </label>
            <input type="text" data-q-opt="${oi}" value="${escapeHtml(o)}" placeholder="option ${oi + 1}" />
            <button class="icon-btn" data-q-opt-del="${oi}" title="Remove option">×</button>
          </div>`).join("")}
      </div>
      <button class="btn ghost ce-quiz-add-opt" data-q-add-opt="${qi}">+ Option</button>
    </div>`).join("");
  return `
    <div class="ce-quiz-pane">
      ${items || `<div class="placeholder">No quiz questions yet.</div>`}
      <button class="btn primary ce-quiz-add" id="ce-quiz-add">+ Add question</button>
    </div>`;
}

function attachCourseEditorV1Handlers() {
  // Tree selection
  document.querySelectorAll("[data-select]").forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const kind = el.dataset.select;
      const prevSec = _course.selection?.sectionIdx;
      if (kind === "module") _course.selection = { kind: "module" };
      else if (kind === "section") _course.selection = { kind: "section", sectionIdx: parseInt(el.dataset.si, 10) };
      else if (kind === "card") {
        // Card click navigates to its section's Content tab and scrolls there.
        _course.selection = { kind: "section", sectionIdx: parseInt(el.dataset.si, 10) };
        _course.activeTab = "content";
        _course.scrollToCardIdx = parseInt(el.dataset.ci, 10);
      }
      // Reset preview slide when switching sections (different slide deck)
      if (_course.selection?.sectionIdx !== prevSec) _course.previewSlideIdx = 0;
      ensureValidTab();
      renderCoursePage();
    };
  });

  // Tab switch
  document.querySelectorAll(".ce-tab").forEach(b => {
    b.onclick = () => { _course.activeTab = b.dataset.tab; renderCoursePage(); };
  });

  // Add section
  const addSec = document.getElementById("ce-add-section");
  if (addSec) addSec.onclick = () => {
    const mod = _course.mod;
    mod.sections = mod.sections || [];
    const nextNum = mod.sections.length + 1;
    const id = `${mod.id || "m"}_s${nextNum}`;
    mod.sections.push({ id, title: "New section", content: "", images: [], glossary: [], quiz: [] });
    _course.selection = { kind: "section", sectionIdx: mod.sections.length - 1 };
    _course.activeTab = "meta";
    markCourseDirty();
    renderCoursePage();
  };

  // Add card
  document.querySelectorAll("[data-add-card]").forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const si = parseInt(b.dataset.addCard, 10);
      const sec = _course.mod.sections[si];
      const newCardTitle = "New card";
      const sep = (sec.content && sec.content.trim()) ? "\n\n" : "";
      sec.content = (sec.content || "") + `${sep}### ${newCardTitle}\n\nContent…`;
      const cards = sectionCards(sec);
      _course.selection = { kind: "card", sectionIdx: si, cardIdx: cards.length - 1 };
      _course.activeTab = "content";
      markCourseDirty();
      renderCoursePage();
    };
  });

  attachCETabHandlers();
}

function attachCETabHandlers() {
  const tab = _course.activeTab;
  const sel = _course.selection;
  const mod = _course.mod;

  if (tab === "meta") {
    const modT = document.getElementById("ce-mod-title");
    const modD = document.getElementById("ce-mod-desc");
    const secT = document.getElementById("ce-sec-title");
    const cardT = document.getElementById("ce-card-title");
    if (modT) modT.oninput = () => { mod.title = modT.value; markCourseDirty(); };
    if (modD) modD.oninput = () => { mod.description = modD.value; markCourseDirty(); };
    if (secT) secT.oninput = () => {
      mod.sections[sel.sectionIdx].title = secT.value;
      markCourseDirty();
      // reflect in tree without full re-render
      const lbl = document.querySelector(`.ce-tree-row[data-si="${sel.sectionIdx}"] .ce-tree-label`);
      if (lbl) lbl.textContent = secT.value || `Section ${sel.sectionIdx + 1}`;
    };
    const secDel = document.getElementById("ce-sec-delete");
    if (secDel) secDel.onclick = async () => {
      const ok = await confirmModal({ title: "Delete section?", body: "All cards, glossary, images and quiz in this section will be removed.", confirmText: "Delete" });
      if (!ok) return;
      mod.sections.splice(sel.sectionIdx, 1);
      _course.selection = { kind: "module" };
      _course.activeTab = "meta";
      markCourseDirty();
      renderCoursePage();
    };
  }

  if (tab === "content") {
    const sec = () => mod.sections[sel.sectionIdx];
    const totalSlides = () => splitIntoCards(sec().content || "").length + (sec().quiz?.length || 0);
    fitPhoneToTabBody();
    const repaintPreview = () => {
      const prev = document.getElementById("ce-content-preview");
      if (!prev) return;
      const max = Math.max(0, totalSlides() - 1);
      if (_course.previewSlideIdx > max) _course.previewSlideIdx = max;
      prev.innerHTML = renderPhoneDeck(sec());
      wirePhoneDeck();
    };
    const wirePhoneDeck = () => {
      const prev = document.getElementById("ce-content-preview");
      if (!prev) return;
      prev.querySelectorAll(".course-term").forEach(t => {
        t.addEventListener("click", e => { e.stopPropagation(); showTermPopover(t); });
      });
      prev.querySelectorAll("[data-slide-dir]").forEach(b => {
        b.onclick = () => {
          const dir = b.dataset.slideDir === "next" ? 1 : -1;
          const max = totalSlides() - 1;
          _course.previewSlideIdx = Math.max(0, Math.min(max, _course.previewSlideIdx + dir));
          repaintPreview();
        };
      });
      prev.querySelectorAll("[data-slide-jump]").forEach(d => {
        d.onclick = () => {
          _course.previewSlideIdx = parseInt(d.dataset.slideJump, 10) || 0;
          repaintPreview();
        };
      });
      prev.querySelectorAll(".ce-phone-quiz-opt").forEach(b => {
        b.onclick = () => {
          const correct = b.dataset.correct === "1";
          prev.querySelectorAll(".ce-phone-quiz-opt").forEach(x => {
            const isPick = x === b;
            const isRight = x.dataset.correct === "1";
            x.classList.toggle("correct", isRight);
            x.classList.toggle("wrong", isPick && !correct);
          });
        };
      });
      // Touch / mouse swipe
      const deck = prev.querySelector(".ce-phone-deck");
      if (deck) attachDeckSwipe(deck, (dir) => {
        const max = totalSlides() - 1;
        const next = Math.max(0, Math.min(max, _course.previewSlideIdx + dir));
        if (next !== _course.previewSlideIdx) { _course.previewSlideIdx = next; repaintPreview(); }
      });
    };
    wirePhoneDeck();
    const ta = document.getElementById("ce-content");
    if (ta) {
      const syncSlideToCaret = () => {
        const idx = cardIndexAtCaret(ta.value, ta.selectionStart);
        if (idx !== _course.previewSlideIdx) {
          _course.previewSlideIdx = idx;
          repaintPreview();
        }
      };
      ta.oninput = () => {
        sec().content = ta.value;
        markCourseDirty();
        // Keep the textarea anchored where the user is typing — don't repaint
        // anything that could trigger a scroll-into-view. Refresh the preview
        // *content* on the same slide; don't auto-jump slides on keystrokes
        // (caret-movement keys + clicks still sync via syncSlideToCaret).
        const top = ta.scrollTop;
        repaintPreview();
        ta.scrollTop = top;
      };
      ta.addEventListener("click", syncSlideToCaret);
      ta.addEventListener("keyup", (e) => {
        // Only resync for caret-movement keys (avoid double work on every keystroke; oninput handles those).
        if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"].includes(e.key)) {
          syncSlideToCaret();
        }
      });
      attachCETools(ta, sec, (newText) => { sec().content = newText; });
      // Scroll to a particular card's ### header if a tree click requested it
      if (_course.scrollToCardIdx != null) {
        scrollTextareaToCard(ta, sec(), _course.scrollToCardIdx);
        // Also jump the phone preview to that slide.
        _course.previewSlideIdx = _course.scrollToCardIdx;
        _course.scrollToCardIdx = null;
        repaintPreview();
      }
    }
  }

  if (tab === "images") {
    // Lazy-load the usage map once. Cached afterward so the tab doesn't
    // refetch on every render — even when the table is empty.
    if (!_course.imageUsageLoaded && !_course.imageUsageLoading) {
      _course.imageUsageLoading = true;
      computeCourseImageUsage().then(m => {
        _course.imageUsage = m;
        _course.imageUsageLoaded = true;
        _course.imageUsageLoading = false;
        if (_course.activeTab === "images") renderCoursePage();
      });
    }
    document.querySelectorAll("[data-img-copy]").forEach(b => {
      b.onclick = () => {
        const md = `![](${b.dataset.imgCopy})`;
        navigator.clipboard?.writeText(md);
        toast("ok", "Copied", md);
      };
    });
    document.querySelectorAll("[data-img-remove]").forEach(b => {
      b.onclick = () => {
        const i = parseInt(b.dataset.imgRemove, 10);
        const sec = mod.sections[sel.sectionIdx];
        sec.images.splice(i, 1);
        markCourseDirty();
        renderCoursePage();
      };
    });
    document.getElementById("ce-img-pick").onclick = () => {
      const loaded = [..._course.images.keys()].sort();
      if (!loaded.length) { toast("warn", "No images loaded", "Drop PNGs first"); return; }
      pickImageForSection(mod.sections[sel.sectionIdx], loaded);
      markCourseDirty();
    };
    document.getElementById("ce-img-add").onclick = () => {
      const inp = document.getElementById("ce-img-add-name");
      const name = inp.value.trim();
      if (!name) return;
      const sec = mod.sections[sel.sectionIdx];
      sec.images = sec.images || [];
      if (!sec.images.includes(name)) sec.images.push(name);
      inp.value = "";
      markCourseDirty();
      renderCoursePage();
    };
  }

  if (tab === "glossary") {
    const tbody = document.getElementById("ce-glossary");
    const sec = mod.sections[sel.sectionIdx];
    tbody.addEventListener("input", e => {
      const tr = e.target.closest("tr[data-gloss-idx]"); if (!tr) return;
      const i = parseInt(tr.dataset.glossIdx, 10);
      sec.glossary = sec.glossary || [];
      const g = sec.glossary[i] = sec.glossary[i] || { term: "", definition: "", image: "" };
      if (e.target.matches("[data-g-term]"))  g.term = e.target.value;
      if (e.target.matches("[data-g-image]")) g.image = e.target.value || undefined;
      if (e.target.matches("[data-g-def]"))   g.definition = e.target.value;
      markCourseDirty();
    });
    tbody.addEventListener("click", e => {
      if (!e.target.closest("[data-g-del]")) return;
      const tr = e.target.closest("tr[data-gloss-idx]");
      const i = parseInt(tr.dataset.glossIdx, 10);
      sec.glossary.splice(i, 1);
      markCourseDirty();
      renderCoursePage();
    });
    document.getElementById("ce-gloss-add").onclick = () => {
      sec.glossary = sec.glossary || [];
      sec.glossary.push({ term: "", definition: "", image: "" });
      markCourseDirty();
      renderCoursePage();
    };
  }

  if (tab === "quiz") {
    const sec = mod.sections[sel.sectionIdx];
    sec.quiz = sec.quiz || [];
    document.querySelectorAll(".ce-quiz-item").forEach(card => {
      const qi = parseInt(card.dataset.qIdx, 10);
      const q = sec.quiz[qi];
      card.querySelector("[data-q-text]").oninput = (e) => { q.question = e.target.value; markCourseDirty(); };
      card.querySelectorAll("[data-q-opt]").forEach(inp => {
        const oi = parseInt(inp.dataset.qOpt, 10);
        inp.oninput = (e) => { q.options[oi] = e.target.value; markCourseDirty(); };
      });
      card.querySelectorAll("[data-q-correct]").forEach(r => {
        r.onchange = () => { q.correct = parseInt(r.dataset.qCorrect, 10); markCourseDirty(); renderCoursePage(); };
      });
      card.querySelector("[data-q-del]").onclick = async () => {
        const ok = await confirmModal({ title: "Delete question?", body: "Q" + (qi + 1) + " will be removed.", confirmText: "Delete" });
        if (!ok) return;
        sec.quiz.splice(qi, 1); markCourseDirty(); renderCoursePage();
      };
      card.querySelectorAll("[data-q-opt-del]").forEach(b => {
        b.onclick = () => {
          const oi = parseInt(b.dataset.qOptDel, 10);
          q.options.splice(oi, 1);
          if (q.correct === oi) q.correct = 0;
          else if (q.correct > oi) q.correct--;
          markCourseDirty(); renderCoursePage();
        };
      });
      card.querySelector("[data-q-add-opt]").onclick = () => {
        q.options.push(""); markCourseDirty(); renderCoursePage();
      };
    });
    document.getElementById("ce-quiz-add").onclick = () => {
      sec.quiz.push({ question: "", options: ["", "", ""], correct: 0 });
      markCourseDirty(); renderCoursePage();
    };
  }
}

function scrollTextareaToCard(ta, sec, cardIdx) {
  const lines = (sec.content || "").split(/\r?\n/);
  let seen = 0;
  let targetLineIdx = 0;
  // First card (cardIdx 0) might be the intro before any ### — point at top.
  if (cardIdx === 0 && !/^###\s/.test(lines[0] || "")) {
    targetLineIdx = 0;
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (/^###\s/.test(lines[i])) {
        if (seen === cardIdx - (/^###\s/.test(lines[0] || "") ? 0 : 1)) { targetLineIdx = i; break; }
        seen++;
      }
    }
  }
  // Convert line index to char offset
  const charOffset = lines.slice(0, targetLineIdx).reduce((a, l) => a + l.length + 1, 0);
  ta.focus();
  ta.setSelectionRange(charOffset, charOffset);
  // Scroll the textarea so the line is near the top
  const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 22;
  ta.scrollTop = Math.max(0, targetLineIdx * lineHeight - lineHeight);
}

function attachCETools(ta, getSec, setBody) {
  document.querySelectorAll(".ce-tool").forEach(btn => {
    // Keep textarea focus on mousedown so caret + scroll position are preserved.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.onclick = () => {
      const start = ta.selectionStart, end = ta.selectionEnd;
      const before = ta.value.slice(0, start), selected = ta.value.slice(start, end), after = ta.value.slice(end);
      let insert = "";
      if (btn.dataset.mdImage) {
        const fn = prompt("Image filename:", "filename.png");
        if (!fn) return;
        insert = `![](${fn})`;
      } else if (btn.dataset.mdTerm) {
        const term = prompt("Glossary term:");
        if (!term) return;
        insert = `:${term}:`;
      } else if (btn.dataset.mdBlock) {
        insert = `\n\n${btn.dataset.md}${selected || "Card title"}\n\n`;
      } else if (btn.dataset.mdLine) {
        insert = `\n${btn.dataset.md}${selected || "item"}`;
      } else {
        insert = `${btn.dataset.md}${selected || "text"}${btn.dataset.md}`;
      }
      const scrollTop = ta.scrollTop;
      ta.value = before + insert + after;
      ta.focus({ preventScroll: true });
      ta.selectionStart = ta.selectionEnd = before.length + insert.length;
      ta.scrollTop = scrollTop;
      ta.dispatchEvent(new Event("input"));
    };
  });
}

/** Count how many `### ` headers precede `offset` in `text`.
 *  Returns the 0-based card index the caret sits in. When the section has
 *  no intro (starts with `### `), the first heading is card 0, not card 1. */
function cardIndexAtCaret(text, offset) {
  const upto = text.slice(0, offset);
  const m = upto.match(/(^|\n)###\s/g);
  let idx = m ? m.length : 0;
  // No-intro section: drop the implicit "intro card" so indexes line up with
  // splitIntoCards, which only emits the intro when it has content.
  if (/^###\s/.test(text) && idx > 0) idx -= 1;
  return idx;
}

// Measure the editor's tab-body and shrink the phone frame so it always
// fits. Natural phone height = 660px (10px padding on each side included).
// Falls back to scale 1 when the body is tall enough.
let _phoneFitObserver = null;
function fitPhoneToTabBody() {
  const phone = document.querySelector(".ce-phone-frame");
  const wrap = phone?.parentElement;
  if (!phone || !wrap) return;
  const apply = () => {
    const cs = getComputedStyle(wrap);
    const availH = wrap.clientHeight
      - parseFloat(cs.paddingTop || 0)
      - parseFloat(cs.paddingBottom || 0);
    const availW = wrap.clientWidth
      - parseFloat(cs.paddingLeft || 0)
      - parseFloat(cs.paddingRight || 0);
    if (availH <= 0 || availW <= 0) return;
    // Uniform scale — whichever axis runs out first wins, so the 360:660
    // aspect ratio is preserved.
    const scale = Math.min(1, Math.max(0.4, Math.min(availH / 660, availW / 360)));
    phone.style.setProperty("--phone-scale", scale.toFixed(3));
  };
  apply();
  if (_phoneFitObserver) _phoneFitObserver.disconnect();
  _phoneFitObserver = new ResizeObserver(apply);
  _phoneFitObserver.observe(wrap);
}

function markCourseDirty() {
  if (_course.mod?._virtual) return; // virtual modules (Glossary) are read-only
  _course.dirty = true;
  updateCourseStatusStrip();
  scheduleCourseAutosave();
}

function updateCourseStatusStrip() {
  const el = document.querySelector(".ce-status-dirty");
  if (!el) return;
  el.classList.toggle("dirty", _course.dirty);
  el.classList.toggle("saved", !_course.dirty);
  el.querySelector("span:last-child").textContent =
    _course.dirty ? "Unsaved changes…" : (_course.savedAt ? `Saved · ${formatDate(_course.savedAt)}` : "All saved");
}

function scheduleCourseAutosave() {
  if (_course.saveTimer) clearTimeout(_course.saveTimer);
  _course.saveTimer = setTimeout(async () => {
    if (!_course.mod) return;
    const ok = await saveCourseModuleToDb(_course.mod);
    if (ok) {
      _course.dirty = false;
      _course.savedAt = new Date().toISOString();
      updateCourseStatusStrip();
    }
  }, 1200);
}

function syncCourseModuleSelector() {
  const sel = document.getElementById("course-module-select");
  if (!sel) return;
  if (_course.modules.length <= 1) { sel.hidden = true; return; }
  sel.hidden = false;
  sel.innerHTML = _course.modules.map(m =>
    `<option value="${escapeHtml(m.id)}" ${m.id === _course.mod?.id ? "selected" : ""}>${escapeHtml(m.title || m.id)}</option>`
  ).join("");
  sel.onchange = () => {
    const next = _course.modules.find(m => m.id === sel.value);
    if (next) { _course.mod = next.mod; _course.selection = { kind: "module" }; _course.activeTab = "meta"; renderCoursePage(); }
  };
}

function renderCourseReadMode(sec, allCards, activeCard) {
  return `
    <div class="course-section-head">
      <h2>${escapeHtml(sec.title || "")}</h2>
      <div class="course-card-tabs">
        ${allCards.map((c, i) => `
          <button class="course-card-tab ${i === _course.activeCardIdx ? "active" : ""}" data-card-idx="${i}">
            ${c.kind === "content"
              ? (c.title ? escapeHtml(c.title) : "Intro")
              : `Quiz ${c.idx + 1}`}
          </button>`).join("")}
      </div>
    </div>
    <div class="course-card" id="course-card">
      ${renderCardInner(activeCard, sec)}
    </div>
    <div class="course-card-nav">
      <button class="btn ghost" id="course-prev-btn" ${_course.activeCardIdx === 0 ? "disabled" : ""}>← Previous</button>
      <span class="muted small">card ${_course.activeCardIdx + 1} / ${allCards.length}</span>
      <button class="btn primary" id="course-next-btn" ${_course.activeCardIdx >= allCards.length - 1 ? "disabled" : ""}>Next →</button>
    </div>`;
}

function renderCourseEditor(sec) {
  const imagesList = (sec.images || []).map(name =>
    `<span class="course-img-chip ${imageUrlFor(name) ? "" : "missing"}" data-img="${escapeHtml(name)}">
      ${escapeHtml(name)}
      <button class="x" data-remove-img="${escapeHtml(name)}" title="Remove from list">×</button>
    </span>`
  ).join("");

  const glossaryRows = (sec.glossary || []).map((g, i) => `
    <tr data-gloss-idx="${i}">
      <td><input type="text" data-g-term value="${escapeHtml(g.term || "")}" placeholder="term" /></td>
      <td>
        <select data-g-image>
          <option value="">(no image)</option>
          ${(sec.images || []).map(name =>
            `<option value="${escapeHtml(name)}" ${name === g.image ? "selected" : ""}>${escapeHtml(name)}</option>`
          ).join("")}
        </select>
      </td>
      <td><input type="text" data-g-def value="${escapeHtml(g.definition || "")}" placeholder="definition" /></td>
      <td><button class="icon-btn" data-g-del title="Delete term">×</button></td>
    </tr>`).join("");

  return `
    <div class="course-editor">
      <div class="course-editor-head">
        <label class="course-editor-label">Section title
          <input type="text" id="ed-title" value="${escapeHtml(sec.title || "")}" />
        </label>
        <label class="course-editor-label">Section id <span class="muted small">(immutable)</span>
          <input type="text" value="${escapeHtml(sec.id || "")}" disabled />
        </label>
      </div>

      <div class="course-editor-split">
        <div class="course-editor-pane">
          <div class="course-editor-pane-label">Content (markdown · use <code>### title</code> for cards, <code>:term:</code> for glossary, <code>![alt](file)</code> for images)</div>
          <textarea id="ed-content" spellcheck="true">${escapeHtml(sec.content || "")}</textarea>
        </div>
        <div class="course-editor-pane">
          <div class="course-editor-pane-label">Live preview</div>
          <div class="course-editor-preview" id="ed-preview">${renderCardMarkdown(sec.content || "")}</div>
        </div>
      </div>

      <div class="course-editor-bottom">
        <div class="course-editor-block">
          <div class="course-editor-pane-label">Images attached to this section</div>
          <div class="course-img-chip-row" id="ed-images">${imagesList || '<span class="muted small">none</span>'}</div>
          <div class="course-editor-img-tools">
            <input type="text" id="ed-img-add" placeholder="filename.png" />
            <button class="btn ghost" id="ed-img-add-btn">+ Add image</button>
            <button class="btn ghost" id="ed-img-pick-btn">Pick from loaded…</button>
          </div>
          <div class="muted small">Tip: drop more PNGs onto the page to make them available, then add by filename here.</div>
        </div>

        <div class="course-editor-block">
          <div class="course-editor-pane-label">Glossary (linked by <code>:term:</code> in the content)</div>
          <table class="course-glossary-table">
            <thead><tr><th>Term</th><th>Image</th><th>Definition</th><th></th></tr></thead>
            <tbody id="ed-glossary">${glossaryRows}</tbody>
          </table>
          <button class="btn ghost" id="ed-gloss-add-btn">+ Add term</button>
        </div>
      </div>
    </div>`;
}

function attachCourseEditorHandlers(sec) {
  const title = document.getElementById("ed-title");
  const content = document.getElementById("ed-content");
  const preview = document.getElementById("ed-preview");

  const repaintPreview = () => {
    preview.innerHTML = renderCardMarkdown(sec.content || "");
    preview.querySelectorAll(".course-term").forEach(t => {
      t.addEventListener("click", e => { e.stopPropagation(); showTermPopover(t); });
    });
  };

  title.addEventListener("input", () => {
    sec.title = title.value;
    // also reflect in sidebar without full re-render
    const sideLi = document.querySelector(`.course-section-list li[data-sec-idx="${_course.activeSectionIdx}"] .qtext`);
    if (sideLi) sideLi.textContent = sec.title || `Section ${_course.activeSectionIdx + 1}`;
  });

  content.addEventListener("input", () => {
    sec.content = content.value;
    repaintPreview();
  });

  // Image chip removal
  document.getElementById("ed-images").addEventListener("click", e => {
    const t = e.target.closest("[data-remove-img]");
    if (!t) return;
    const name = t.dataset.removeImg;
    sec.images = (sec.images || []).filter(n => n !== name);
    renderCoursePage();
  });

  // Add image by filename
  document.getElementById("ed-img-add-btn").onclick = () => {
    const inp = document.getElementById("ed-img-add");
    const name = inp.value.trim();
    if (!name) return;
    sec.images = sec.images || [];
    if (!sec.images.includes(name)) sec.images.push(name);
    inp.value = "";
    renderCoursePage();
  };
  // Pick from already-loaded images
  document.getElementById("ed-img-pick-btn").onclick = () => {
    const loaded = [..._course.images.keys()].sort();
    if (!loaded.length) { toast("warn", "No images loaded", "Use Add images… to drop PNGs first."); return; }
    pickImageForSection(sec, loaded);
  };

  // Glossary CRUD
  const gtbody = document.getElementById("ed-glossary");
  gtbody.addEventListener("input", e => {
    const tr = e.target.closest("tr[data-gloss-idx]");
    if (!tr) return;
    const idx = parseInt(tr.dataset.glossIdx, 10);
    if (!sec.glossary) sec.glossary = [];
    const g = sec.glossary[idx] = sec.glossary[idx] || { term: "", definition: "", image: "" };
    if (e.target.matches("[data-g-term]"))  g.term = e.target.value;
    if (e.target.matches("[data-g-image]")) g.image = e.target.value || undefined;
    if (e.target.matches("[data-g-def]"))   g.definition = e.target.value;
    repaintPreview();
  });
  gtbody.addEventListener("click", e => {
    if (!e.target.closest("[data-g-del]")) return;
    const tr = e.target.closest("tr[data-gloss-idx]");
    const idx = parseInt(tr.dataset.glossIdx, 10);
    sec.glossary.splice(idx, 1);
    renderCoursePage();
  });
  document.getElementById("ed-gloss-add-btn").onclick = () => {
    sec.glossary = sec.glossary || [];
    sec.glossary.push({ term: "", definition: "", image: "" });
    renderCoursePage();
  };
}

function pickImageForSection(sec, loaded) {
  const back = document.createElement("div");
  back.className = "cmdk-back";
  back.innerHTML = `
    <div class="cmdk" onclick="event.stopPropagation()">
      <input id="ed-pick-search" placeholder="Filter image filenames…" autofocus />
      <ul id="ed-pick-list">${loaded.map(n =>
        `<li data-name="${escapeHtml(n)}"><span>${escapeHtml(n)}</span></li>`).join("")}</ul>
    </div>`;
  back.addEventListener("click", e => { if (e.target === back) back.remove(); });
  document.body.appendChild(back);
  document.getElementById("ed-pick-search").addEventListener("input", e => {
    const s = e.target.value.toLowerCase();
    document.querySelectorAll("#ed-pick-list li").forEach(li => {
      li.style.display = li.dataset.name.toLowerCase().includes(s) ? "" : "none";
    });
  });
  document.getElementById("ed-pick-list").addEventListener("click", e => {
    const li = e.target.closest("li[data-name]");
    if (!li) return;
    const name = li.dataset.name;
    sec.images = sec.images || [];
    if (!sec.images.includes(name)) sec.images.push(name);
    back.remove();
    renderCoursePage();
  });
}

function toggleCourseEditMode() {
  if (!_course.mod) return;
  if (_course.mod._virtual) { toast("warn", "Read-only", "The Glossary module is auto-generated."); return; }
  _course.editMode = !_course.editMode;
  document.getElementById("course-edit-btn").textContent = _course.editMode ? "Done editing" : "Edit";
  renderCoursePage();
}

function backToModulesList() {
  // Flush any pending autosave before leaving.
  if (_course.saveTimer) clearTimeout(_course.saveTimer);
  _course.mod = null;
  _course.editMode = false;
  _course.images.forEach(u => URL.revokeObjectURL(u));
  _course.images.clear();
  document.getElementById("course-edit-btn").textContent = "Edit";
  document.getElementById("course-back-btn").disabled = true;
  document.getElementById("course-imgs-btn").disabled = true;
  document.getElementById("course-edit-btn").disabled = true;
  document.getElementById("course-publish-btn").disabled = true;
  document.getElementById("course-download-btn").disabled = true;
  renderCoursePage();
}

async function publishActiveCourseModule() {
  if (!_course.mod) return;
  if (_course.mod._virtual) { toast("warn", "Read-only", "The Glossary module cannot be published — it's a live view."); return; }
  // Flush autosave first
  if (_course.dirty) {
    if (_course.saveTimer) clearTimeout(_course.saveTimer);
    await saveCourseModuleToDb(_course.mod);
    _course.dirty = false;
    _course.savedAt = new Date().toISOString();
    updateCourseStatusStrip();
  }
  const ok = await confirmModal({
    title: "Publish module?",
    body: `The current draft of ${_course.mod.id} will be published. The mobile app fetches the new content on next launch.`,
    confirmText: "Publish",
  });
  if (!ok) return;
  if (await publishCourseModuleRpc(_course.mod.id)) {
    toast("ok", "Published", _course.mod.id);
  }
}

function downloadCourseModule() {
  if (!_course.mod) return;
  const json = JSON.stringify(_course.mod, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  downloadBlob(blob, `${_course.mod.id || "module"}.json`);
}

/** Build and download a zip for one module containing:
 *    <module_id>.json
 *    images/<file>   — every image referenced by content / glossary / images[]
 *  Images are pulled from the course-images bucket (whatever path they live
 *  under). If the module is the active one we can reuse `_course.images`
 *  blob URLs; otherwise we download fresh. */
async function downloadCourseModuleZip(moduleId) {
  try {
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
    let mod;
    if (_course.mod?.id === moduleId) {
      mod = _course.mod;
    } else {
      const row = await loadCourseModuleFromDb(moduleId);
      if (!row) { toast("bad", "Module not found", moduleId); return; }
      mod = row.data || { id: moduleId, title: row.title, description: row.description };
    }
    // Collect referenced images from content + glossary + images[]
    const referenced = new Set();
    const rxImg = /!\[[^\]]*\]\(([^)]+)\)/g;
    for (const sec of mod.sections || []) {
      let m;
      rxImg.lastIndex = 0;
      while ((m = rxImg.exec(sec.content || "")) !== null) referenced.add(m[1].trim());
      for (const g of sec.glossary || []) if (g.image) referenced.add(g.image);
      for (const img of sec.images || []) referenced.add(img);
    }

    const zip = new JSZip();
    zip.file(`${moduleId}.json`, JSON.stringify(mod, null, 2));

    // For each referenced image, find it in the bucket and add to the zip.
    const imgFolder = zip.folder("images");
    let ok = 0, missing = 0;
    for (const name of referenced) {
      const blob = await findImageBlob(name);
      if (blob) { imgFolder.file(name, blob); ok++; }
      else { missing++; }
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    downloadBlob(zipBlob, `${moduleId}.zip`);
    toast(missing ? "warn" : "ok", "Zip ready", `${moduleId}.zip · ${ok} images${missing ? ` (${missing} missing)` : ""}`);
  } catch (e) {
    toast("bad", "Zip failed", e?.message || String(e));
    console.error(e);
  }
}

/** Locate an image file in course-images: try root first, then any subfolder
 *  (legacy nested layout). Returns the blob or null. */
async function findImageBlob(filename) {
  // 1) Root
  const root = await supabase.storage.from("course-images").download(filename);
  if (root.data) return root.data;
  // 2) Look for it in any subfolder by listing the root and recursing
  const { data: top } = await supabase.storage.from("course-images").list("", { limit: 1000 });
  for (const obj of top || []) {
    if (obj.id != null) continue; // skip files
    const sub = await supabase.storage.from("course-images").download(`${obj.name}/${filename}`);
    if (sub.data) return sub.data;
  }
  return null;
}

function renderCardInner(card, sec) {
  if (!card) return `<div class="placeholder">Empty card.</div>`;
  if (card.kind === "content") {
    const html = renderCardMarkdown(card.body || "");
    const titleHtml = card.title ? `<h3 class="course-card-title">${escapeHtml(card.title)}</h3>` : "";
    // Images attached to the section but not referenced inline — show below as a fallback.
    const declared = sec.images || [];
    const used = new Set(Array.from((sec.content || "").matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)).map(m => m[1].trim()));
    const extras = declared.filter(n => !used.has(n));
    const imgStrip = extras.length ? `
      <div class="course-img-strip">
        <div class="course-img-strip-label">other images for this section (not referenced inline)</div>
        ${extras.map(name => `
          <div class="course-img">${courseImg(name, { alt: name })}<div class="course-img-name">${escapeHtml(name)}</div></div>
        `).join("")}
      </div>` : "";
    return `${titleHtml}<div class="course-card-body">${html}</div>${imgStrip}`;
  }
  // quiz card
  const q = card.q;
  const opts = (q.options || []).map((o, i) => `
    <button class="course-quiz-opt" data-pick="${i}" data-correct="${q.correct}">${escapeHtml(o)}</button>`).join("");
  return `
    <h3 class="course-card-title">Quiz</h3>
    <div class="course-quiz">
      <div class="course-quiz-q">${escapeHtml(q.question)}</div>
      <div class="course-quiz-opts">${opts}</div>
    </div>`;
}

async function loadCourseModuleFile(file) {
  if (!file) return;
  try {
    const txt = await file.text();
    const json = JSON.parse(txt);
    if (!json.id) { toast("bad", "Module missing id", "JSON must have an id field."); return; }
    // Check if a row already exists for this id
    const existing = await loadCourseModuleFromDb(json.id);
    if (existing) {
      const ok = await confirmModal({
        title: `Module ${json.id} already exists`,
        body: "Overwrite the saved version with this file? The current draft will be replaced (history is kept).",
        confirmText: "Overwrite",
      });
      if (!ok) return;
    }
    if (!await saveCourseModuleToDb(json)) return;
    await openCourseModuleById(json.id);
    toast("ok", "Imported", `${json.id} saved to course_modules`);
  } catch (e) {
    toast("bad", "Couldn't import module", e?.message || String(e));
  }
}

/** Import a module from a .zip. Expected structure:
 *    m_xxx.json          (or any .json with an `id` field) at the root
 *    images/<file>.png   one or more image files in an /images folder
 *  The module is upserted to course_modules and all images are uploaded
 *  to the course-images bucket under <module_id>/. */
async function loadCourseModuleZip(file) {
  if (!file) return;
  try {
    const JSZip = (await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm")).default;
    const zip = await JSZip.loadAsync(file);

    // Find the module .json — prefer one at root, fall back to anywhere.
    let jsonPath = null;
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      if (!path.toLowerCase().endsWith(".json")) return;
      if (!path.includes("/")) jsonPath = path;
      else if (!jsonPath) jsonPath = path;
    });
    if (!jsonPath) { toast("bad", "No .json found in zip"); return; }

    const txt = await zip.file(jsonPath).async("string");
    const mod = JSON.parse(txt);
    if (!mod.id) { toast("bad", "Module .json missing id field"); return; }

    const existing = await loadCourseModuleFromDb(mod.id);
    if (existing) {
      const ok = await confirmModal({
        title: `Module ${mod.id} already exists`,
        body: "Overwrite with this zip? The current draft will be replaced (history is kept).",
        confirmText: "Overwrite",
      });
      if (!ok) return;
    }
    if (!await saveCourseModuleToDb(mod)) return;

    // Collect all images under any */images/ folder.
    const imageEntries = [];
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      const m = path.match(/(^|\/)images\/([^/]+)$/i);
      if (m && /\.(png|jpe?g|gif|webp|svg)$/i.test(m[2])) {
        imageEntries.push({ name: m[2], entry });
      }
    });

    let okN = 0;
    for (const { name, entry } of imageEntries) {
      const blob = await entry.async("blob");
      const f = new File([blob], name, { type: blob.type || "image/png" });
      if (await uploadCourseImageToBucket(f, mod.id)) okN++;
    }

    await openCourseModuleById(mod.id);
    toast("ok", "Zip imported", `${mod.id} · ${okN}/${imageEntries.length} images`);
  } catch (e) {
    toast("bad", "Couldn't import zip", e?.message || String(e));
    console.error(e);
  }
}

function addCourseImageFiles(files) {
  let added = 0;
  for (const f of files) {
    const url = URL.createObjectURL(f);
    _course.images.set(f.name, url);
    added++;
  }
  toast("ok", `${added} image${added === 1 ? "" : "s"} attached`);
  if (_course.mod) renderCoursePage();
}
function resetCourse() {
  for (const url of _course.images.values()) URL.revokeObjectURL(url);
  _course.mod = null;
  _course.images.clear();
  _course.activeSectionIdx = 0;
  _course.activeCardIdx = 0;
  renderCoursePage();
}
function showTermPopover(anchor) {
  closeTermPopover();
  const term = anchor.dataset.term;
  const g = lookupGlossaryTerm(term);
  if (!g) return;
  const pop = document.createElement("div");
  pop.className = "course-term-popover";
  pop.id = "course-term-popover";
  pop.innerHTML = `
    <div class="ctp-head">${escapeHtml(g.term)}</div>
    ${g.image ? courseImg(g.image, { cls: "ctp-img", alt: g.term }) : ""}
    ${g.definition ? `<div class="ctp-def">${escapeHtml(g.definition)}</div>` : ""}
  `;
  document.body.appendChild(pop);
  lazyHydrateCourseImages(pop);
  const r = anchor.getBoundingClientRect();
  // try to place below; if it'd go off-screen, above
  const popH = 240;
  let top = r.bottom + 6;
  if (top + popH > window.innerHeight) top = r.top - popH - 6;
  let left = r.left;
  const popW = 320;
  if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, left)}px`;
  // Close on outside click / Esc
  setTimeout(() => {
    const onDoc = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) closeTermPopover();
    };
    const onKey = (e) => { if (e.key === "Escape") closeTermPopover(); };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    pop._cleanup = () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, 0);
}
function closeTermPopover() {
  const p = document.getElementById("course-term-popover");
  if (!p) return;
  p._cleanup?.();
  p.remove();
}

function attachCourseDropzone() {
  const dz = document.getElementById("course-dropzone");
  if (!dz) return;
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.classList.remove("dragover");
  }));
  dz.addEventListener("drop", async e => {
    const files = [...(e.dataTransfer?.files || [])];
    const json = files.find(f => f.name.endsWith(".json"));
    if (json) await loadCourseModuleFile(json);
    const imgs = files.filter(f => f.type.startsWith("image/"));
    if (imgs.length) addCourseImageFiles(imgs);
  });
}

// ─── Audit ───
let _auditState = { kind: "all", search: "", page: 0, perPage: 100, total: 0 };
const AUDIT_KIND_INFO = {
  insert: { label: "created",  desc: "new question added" },
  edit:   { label: "edited",   desc: "fields changed" },
  update: { label: "edited",   desc: "fields changed" },
  delete: { label: "deleted",  desc: "question removed" },
  revert: { label: "reverted", desc: "rolled back to an earlier state" },
  import: { label: "imported", desc: "accepted from the candidate queue" },
  label:  { label: "labelled", desc: "topic label changed" },
};

async function renderAuditPage() {
  const host = document.getElementById("audit-body");
  host.innerHTML = `
    <div class="audit-container">
      <div class="audit-banner">
        <b>What you're looking at:</b> every row is one change made to a question — created, edited, deleted, reverted, or imported.
        Click a row to expand a side-by-side diff against the previous version, or use <b>Open question</b> to jump to the question's editor with its full History tab.
      </div>
      <div class="audit-bar">
        <div class="search-box" style="flex:1;max-width:380px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="audit-search" placeholder="Filter by Q-id or text…" value="${escapeHtml(_auditState.search)}" />
        </div>
        ${["all","edit","insert","delete","revert","import","label"].map(k => {
          const lbl = k === "all" ? "all" : (AUDIT_KIND_INFO[k]?.label || k);
          return `<button class="filter-pill ${_auditState.kind === k ? "active" : ""}" data-k="${k}" title="${k === "all" ? "Everything" : (AUDIT_KIND_INFO[k]?.desc || k)}">${escapeHtml(lbl)} <span class="v" id="audit-c-${k}">—</span></button>`;
        }).join("")}
      </div>
      <div id="audit-rows"><div class="placeholder">Loading…</div></div>
      <div class="audit-foot" id="audit-foot"></div>
    </div>`;

  document.getElementById("audit-search").addEventListener("input", e => {
    _auditState.search = e.target.value;
    _auditState.page = 0;
    loadAuditRows();
  });
  document.querySelectorAll("#audit-body .filter-pill").forEach(p => {
    p.onclick = () => {
      _auditState.kind = p.dataset.k;
      _auditState.page = 0;
      document.querySelectorAll("#audit-body .filter-pill").forEach(x => x.classList.toggle("active", x === p));
      loadAuditRows();
    };
  });
  await loadAuditRows();
  // counts (cheap parallel)
  for (const k of ["all","edit","insert","delete","revert","import","label"]) {
    supabase.from("question_versions").select("id", { count: "exact", head: true })
      [k === "all" ? "neq" : "eq"]("kind", k === "all" ? "__never__" : k)
      .then(({ count }) => {
        const el = document.getElementById("audit-c-" + k);
        if (el) el.textContent = (count ?? 0).toLocaleString();
      })
      .catch(() => {});
  }
}

async function loadAuditRows() {
  const rowsEl = document.getElementById("audit-rows");
  const foot = document.getElementById("audit-foot");
  rowsEl.innerHTML = `<div class="placeholder">Loading…</div>`;
  let q = supabase.from("question_versions")
    .select("id, question_id, kind, actor, created_at, snapshot", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(_auditState.page * _auditState.perPage, (_auditState.page + 1) * _auditState.perPage - 1);
  if (_auditState.kind !== "all") q = q.eq("kind", _auditState.kind);
  if (_auditState.search) {
    // simple client-side filter after fetch — small page size
  }
  const { data, error, count } = await q;
  if (error) { rowsEl.innerHTML = `<div class="placeholder" style="color:var(--bad)">Couldn't load audit log: ${escapeHtml(error.message)}</div>`; return; }
  let rows = data || [];
  if (_auditState.search) {
    const s = _auditState.search.toLowerCase();
    rows = rows.filter(r =>
      String(r.question_id).includes(s) ||
      (r.snapshot?.question || "").toLowerCase().includes(s)
    );
  }
  _auditState.total = count || 0;

  rowsEl.innerHTML = rows.length ? rows.map(v => {
    const k = v.kind || "edit";
    const info = AUDIT_KIND_INFO[k] || { label: k, desc: "" };
    const preview = v.snapshot?.question ? String(v.snapshot.question).slice(0, 160) : "";
    const topic = v.snapshot?.topic ? `<span class="audit-topic" title="${escapeHtml(v.snapshot.topic)}">${escapeHtml(labelFor(v.snapshot.topic))}</span>` : "";
    return `
      <div class="audit-row" data-vid="${escapeHtml(String(v.id))}" data-qid="${escapeHtml(String(v.question_id))}">
        <span class="time">${escapeHtml(formatDate(v.created_at))}</span>
        <span class="kind ${escapeHtml(k)}" title="${escapeHtml(info.desc)}">${escapeHtml(info.label)}</span>
        <span class="actor" title="${escapeHtml(v.actor || "")}">${escapeHtml((v.actor || "").split("@")[0] || "—")}</span>
        <div class="body">
          <div class="audit-summary">
            <span class="qid" title="question id">Q-${escapeHtml(String(v.question_id))}</span>
            ${topic}
            <span class="audit-action">${escapeHtml(info.desc)}</span>
          </div>
          <div class="preview" title="${escapeHtml(v.snapshot?.question || "")}">${escapeHtml(preview)}</div>
          <div class="audit-expand hidden" data-expand="${escapeHtml(String(v.id))}"></div>
        </div>
        <div class="actions">
          <button class="icon-btn audit-toggle" title="Show diff vs previous version" data-vid="${escapeHtml(String(v.id))}" data-qid="${escapeHtml(String(v.question_id))}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <button class="icon-btn audit-open" title="Open question in editor" data-qid="${escapeHtml(String(v.question_id))}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><polyline points="12 5 19 12 12 19"/></svg>
          </button>
          ${k !== "delete" ? `<button class="icon-btn audit-restore" title="Restore the question to this exact state (creates a new audit row)" data-id="${escapeHtml(String(v.id))}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/></svg>
          </button>` : ""}
        </div>
      </div>`;
  }).join("") : `<div class="placeholder" style="padding:40px">No entries match.</div>`;

  const pages = Math.max(1, Math.ceil(_auditState.total / _auditState.perPage));
  foot.innerHTML = `
    <button class="btn ghost" id="audit-prev" ${_auditState.page === 0 ? "disabled" : ""}>← Newer</button>
    <span>page ${_auditState.page + 1} / ${pages} · ${_auditState.total.toLocaleString()} entries</span>
    <button class="btn ghost" id="audit-next" ${(_auditState.page + 1) >= pages ? "disabled" : ""}>Older →</button>`;
  document.getElementById("audit-prev").onclick = () => { _auditState.page = Math.max(0, _auditState.page - 1); loadAuditRows(); };
  document.getElementById("audit-next").onclick = () => { _auditState.page++; loadAuditRows(); };
  rowsEl.querySelectorAll(".audit-toggle").forEach(b => {
    b.onclick = async () => {
      const row = b.closest(".audit-row");
      const expand = row.querySelector(".audit-expand");
      const open = !expand.classList.contains("hidden");
      if (open) { expand.classList.add("hidden"); expand.innerHTML = ""; return; }
      expand.classList.remove("hidden");
      expand.innerHTML = `<div class="placeholder" style="padding:16px">Loading diff…</div>`;
      try {
        const vid = parseInt(b.dataset.vid, 10);
        const qid = parseInt(b.dataset.qid, 10);
        const this_v = rows.find(r => r.id === vid);
        // Fetch the immediately-preceding version for this question.
        const { data: prevArr } = await supabase
          .from("question_versions")
          .select("snapshot, kind, created_at")
          .eq("question_id", qid)
          .lt("created_at", this_v.created_at)
          .order("created_at", { ascending: false })
          .limit(1);
        const prev = prevArr?.[0]?.snapshot || null;
        expand.innerHTML = renderDiff(prev, this_v.snapshot, this_v.kind);
      } catch (e) {
        expand.innerHTML = `<div class="placeholder" style="color:var(--bad);padding:16px">Couldn't load previous version: ${escapeHtml(e?.message || String(e))}</div>`;
      }
    };
  });
  rowsEl.querySelectorAll(".audit-open").forEach(b => {
    b.onclick = () => {
      goPage("questions");
      selectQuestion(parseInt(b.dataset.qid, 10));
      state.tab = "history";
      document.querySelectorAll("#tabs .tab").forEach(x => x.classList.toggle("active", x.dataset.tab === "history"));
      renderTabContent();
    };
  });
  rowsEl.querySelectorAll(".audit-restore").forEach(b => {
    b.onclick = async () => {
      const row = b.closest(".audit-row");
      const qid = row?.dataset.qid;
      const ok = await confirmModal({
        title: "Restore this state?",
        body: `The current contents of question Q-${qid} will be replaced by the snapshot captured in this audit row. A new audit row will be appended so the restore itself is reversible.`,
        confirmText: "Restore",
      });
      if (!ok) return;
      try {
        const { error } = await supabase.rpc("revert_question", { p_version_id: parseInt(b.dataset.id), p_note: "audit-page restore" });
        if (error) throw error;
        toast("ok", "Restored", `Q-${qid} rolled back · new audit row appended.`);
        loadAuditRows();
      } catch (e) { toast("bad", "Restore failed", e?.message || String(e)); }
    };
  });
}

// ─── Settings ───
async function renderSettingsPage() {
  const host = document.getElementById("settings-body");
  const buildEl = document.getElementById("settings-build-tag");
  if (buildEl) buildEl.textContent = "build " + (window.__buildDate || "local");

  const integ = state.integrity || await ensureIntegrity();
  const integTxt = (integ.brokenImages + integ.zeroCorrect + integ.duplicates) === 0
    ? `<span class="val ok">All clean</span>`
    : `<span class="val warn">${integ.brokenImages} broken · ${integ.zeroCorrect} zero-correct · ${integ.duplicates} dup · ${integ.multiCorrect} multi-correct</span>`;

  // Access section (owner-only)
  let accessSection = "";
  if (state.isOwner) {
    let admins = [];
    try { const { data } = await supabase.rpc("list_admins"); admins = data || []; } catch {}
    accessSection = `
      <div class="settings-section">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-3-3.87"/><path d="M4 21v-2a4 4 0 014-4h6a4 4 0 014 4v2"/><circle cx="9" cy="7" r="4"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
          Access
          <span style="font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);background:var(--panel2);padding:1px 6px;border-radius:4px;font-weight:400">${admins.length}</span>
        </h3>
        <div class="admins-list">
          ${admins.map(a => `
            <div class="admin-row${a.is_owner ? " owner" : ""}">
              <span class="email">${escapeHtml(a.email)}</span>
              ${a.is_owner ? `<span class="badge">owner</span>` : `<button class="icon-btn settings-admin-remove" data-email="${escapeHtml(a.email)}" title="Remove">×</button>`}
            </div>`).join("") || `<div class="placeholder" style="padding:12px">No allowlisted admins.</div>`}
        </div>
        <div class="settings-add">
          <input type="email" id="settings-admin-email" placeholder="email@example.com" />
          <button class="btn primary" id="settings-admin-add">Add</button>
        </div>
      </div>`;
  }

  host.innerHTML = `
    <div class="settings-container">
      ${accessSection}

      <div class="settings-section">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          Validate dataset
        </h3>
        <div class="settings-row">
          <span class="k">Integrity scan
            <div class="desc">Counts broken images, zero-correct, multi-correct, and duplicate question text.</div>
          </span>
          ${integTxt}
          <button class="btn" id="settings-validate">Validate now</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33"/></svg>
          Behavior
        </h3>
        <div class="settings-row">
          <span class="k">Diacritic normalization
            <div class="desc">Auto-fold ăâîșț to ASCII (not recommended).</div>
          </span>
          <span class="val ok">Off (preserved)</span>
          <span style="font-family:ui-monospace,monospace;font-size:11px;color:var(--muted)">Locked</span>
        </div>
        <div class="settings-row">
          <span class="k">Confirm destructive actions
            <div class="desc">Modal before delete · revert · restore.</div>
          </span>
          <span class="val">Always</span>
          <span style="font-family:ui-monospace,monospace;font-size:11px;color:var(--muted)">Locked</span>
        </div>
      </div>

      <div class="settings-foot">
        <div>
          <div>CAA HQ admin</div>
          <div>Signed in: <span class="mono">${escapeHtml(state.user?.email || "")}</span></div>
        </div>
        <div class="right">
          <button class="btn ghost" id="settings-signout">Sign out</button>
        </div>
      </div>
    </div>`;

  document.getElementById("settings-validate").onclick = async () => {
    state.integrity = null;
    const r = await ensureIntegrity({ force: true });
    toast(r.brokenImages + r.zeroCorrect + r.duplicates ? "warn" : "ok",
      "Integrity scan complete",
      `${r.brokenImages} broken img · ${r.zeroCorrect} zero-correct · ${r.duplicates} duplicates · ${r.multiCorrect} multi-correct.`);
    renderSettingsPage();
  };
  document.getElementById("settings-signout").onclick = () => onLogout();

  if (state.isOwner) {
    document.getElementById("settings-admin-add").onclick = async () => {
      const email = document.getElementById("settings-admin-email").value.trim();
      if (!email) return;
      try {
        const { error } = await supabase.rpc("add_admin", { p_email: email });
        if (error) throw error;
        toast("ok", "Admin added", email);
        renderSettingsPage();
      } catch (e) { toast("bad", "Couldn't add admin", e?.message || String(e)); }
    };
    document.querySelectorAll(".settings-admin-remove").forEach(b => {
      b.onclick = async () => {
        const email = b.dataset.email;
        const ok = await confirmModal({ title: "Remove admin?", body: `${email} will lose access.`, confirmText: "Remove" });
        if (!ok) return;
        try {
          const { error } = await supabase.rpc("remove_admin", { p_email: email });
          if (error) throw error;
          toast("ok", "Admin removed", email);
          renderSettingsPage();
        } catch (e) { toast("bad", "Couldn't remove admin", e?.message || String(e)); }
      };
    });
  }
}

// ─── Integrity scanner ───
async function ensureIntegrity({ force = false } = {}) {
  if (state.integrity && !force) return state.integrity;
  return await runIntegrityScan();
}
async function runIntegrityScan() {
  const qs = state.questions || [];
  let zeroCorrect = 0, multiCorrect = 0;
  const texts = new Map();
  for (const q of qs) {
    const corrects = Array.isArray(q.correct) ? q.correct : (q.correct != null ? [q.correct] : []);
    if (corrects.length === 0) zeroCorrect++;
    if (corrects.length > 1) multiCorrect++;
    const key = norm(String(q.question || "")).slice(0, 200);
    if (!texts.has(key)) texts.set(key, 0);
    texts.set(key, texts.get(key) + 1);
  }
  let duplicates = 0;
  for (const n of texts.values()) if (n > 1) duplicates += (n - 1);

  // broken images: list bucket, then compare each question's image_path
  let brokenImages = 0;
  try {
    const have = new Set((await listBucketImages(true)) || []);
    for (const q of qs) {
      if (q.image_path && !have.has(q.image_path)) brokenImages++;
    }
  } catch { /* network failure → leave 0 */ }

  state.integrity = {
    zeroCorrect, multiCorrect, duplicates, brokenImages,
    scannedAt: new Date().toISOString(),
  };
  updateIntegrityBadge();
  return state.integrity;
}
function updateIntegrityBadge() {
  const btn = document.getElementById("integrity-btn");
  if (!btn || !state.integrity) return;
  const total = state.integrity.brokenImages + state.integrity.zeroCorrect + state.integrity.duplicates;
  btn.hidden = false;
  btn.classList.toggle("has-issues", total > 0);
  btn.querySelector(".integrity-label").textContent = total > 0 ? `${total} issue${total === 1 ? "" : "s"}` : "Integrity OK";
}
function toggleIntegrityDrawer() {
  const d = document.getElementById("integrity-drawer");
  if (d.classList.contains("hidden")) {
    renderIntegrityDrawer().then(() => d.classList.remove("hidden"));
    setTimeout(() => {
      document.addEventListener("click", function closeOnce(e) {
        if (!d.contains(e.target) && e.target.id !== "integrity-btn") {
          d.classList.add("hidden");
          document.removeEventListener("click", closeOnce);
        }
      });
    }, 0);
  } else d.classList.add("hidden");
}
async function renderIntegrityDrawer() {
  const integ = await ensureIntegrity();
  const rows = [
    { name: "Broken image refs", n: integ.brokenImages, cls: "bad" },
    { name: "Questions with 0 correct", n: integ.zeroCorrect, cls: "bad" },
    { name: "Multi-correct (highlight)", n: integ.multiCorrect, cls: "warn" },
    { name: "Duplicate question text", n: integ.duplicates, cls: "warn" },
  ];
  document.getElementById("integrity-rows").innerHTML = rows.map(r => `
    <div class="integrity-row ${r.n ? "has" : ""}">
      <span class="icon ${r.cls}">${r.n ? "!" : "✓"}</span>
      <span class="name">${escapeHtml(r.name)}</span>
      <span class="num">${r.n}</span>
    </div>`).join("");
  document.getElementById("integrity-scanned").textContent = "Last scan: " + (integ.scannedAt ? formatDate(integ.scannedAt) : "never");
  document.getElementById("integrity-rescan").onclick = async (e) => {
    e.preventDefault();
    await runIntegrityScan();
    renderIntegrityDrawer();
  };
}

// ─── Command palette ───
function openCmdK() {
  const back = document.getElementById("cmdk-back");
  back.classList.remove("hidden");
  const inp = document.getElementById("cmdk-input");
  inp.value = "";
  renderCmdK("");
  inp.focus();
  inp.oninput = () => renderCmdK(inp.value);
  inp.onkeydown = (e) => {
    if (e.key === "Escape") closeCmdK();
    else if (e.key === "Enter") {
      const sel = back.querySelector("li.sel");
      if (sel) sel.click();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = Array.from(back.querySelectorAll("li[data-cmd]"));
      const i = all.findIndex(l => l.classList.contains("sel"));
      const next = e.key === "ArrowDown" ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1);
      all.forEach((l, j) => l.classList.toggle("sel", j === next));
      all[next]?.scrollIntoView({ block: "nearest" });
    }
  };
  back.onclick = (e) => { if (e.target === back) closeCmdK(); };
}
function closeCmdK() { document.getElementById("cmdk-back").classList.add("hidden"); }
function renderCmdK(q) {
  const pages = [
    { key: "overview", lbl: "Overview", hint: "g·o" },
    { key: "questions", lbl: "Questions", hint: "g·q" },
    { key: "images", lbl: "Images", hint: "g·i" },
    { key: "import", lbl: "Import" },
    { key: "labels", lbl: "Labels" },
    { key: "export", lbl: "Export" },
    { key: "audit", lbl: "Audit log", hint: "g·a" },
    { key: "settings", lbl: "Settings" },
  ];
  const all = pages.map(p => ({ ...p, type: "page" }));
  // a handful of recent questions
  const recent = (state.questions || []).slice(0, 6).map(qq => ({
    key: qq.id, lbl: `#${qq.id} · ${qq.question?.slice(0, 60) || ""}`, type: "question",
  }));
  let list = [...all, ...recent];
  if (q) {
    const s = q.toLowerCase();
    list = list.filter(i => i.lbl.toLowerCase().includes(s));
  }
  const ul = document.getElementById("cmdk-list");
  ul.innerHTML = list.map((c, i) => `
    <li data-cmd="${escapeHtml(c.type)}:${escapeHtml(String(c.key))}" class="${i === 0 ? "sel" : ""}">
      <span>${escapeHtml(c.lbl)}</span>
      ${c.hint ? `<span class="hint">${escapeHtml(c.hint)}</span>` : ""}
    </li>`).join("") || `<li style="color:var(--muted);padding:18px;justify-content:center">No match.</li>`;
  ul.querySelectorAll("li[data-cmd]").forEach(li => {
    li.onclick = () => {
      const [type, key] = li.dataset.cmd.split(":");
      closeCmdK();
      if (type === "page") goPage(key);
      else if (type === "question") {
        goPage("questions");
        selectQuestion(parseInt(key));
      }
    };
  });
}

boot();
// Refresh the unresolved-count badge on launch and every 60s while the
// dashboard is open. Cheap (count-only HEAD request), keeps the chip honest.
setInterval(() => { if (state.user) refreshReportsCountBadge(); }, 60_000);
window.addEventListener("focus", () => { if (state.user) refreshReportsCountBadge(); });
