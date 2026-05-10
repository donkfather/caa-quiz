/**
 * CAA HQ — question manager dashboard.
 *
 * Static SPA. All state lives in Supabase: questions table, question_versions
 * table (auto-populated by a Postgres trigger), and a `revert_question` RPC.
 * The dashboard is just a thin client.
 *
 * Auth: Supabase email+password, gated by RLS to ADMIN_EMAIL only. The
 * client uses the anon key + the user's JWT; the database enforces the rule.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.46.1";
import { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL } from "./config.js";

const TOPICS = ["colreg", "navigation", "seamanship", "maneuvering", "first_aid", "law"];
const TOPIC_COLOR = (t) => `var(--${t})`;
const LICENSES = ["C", "D"];
const AUTOSAVE_DELAY = 1500;

// Required slots per exam type — mirrors EXAM_CONFIGS in mobile src/lib/questions.ts.
const EXAM_REQUIREMENTS = {
  "cat-c": [["colreg", 8], ["seamanship", 6], ["navigation", 6], ["maneuvering", 6]],
  "cat-d": [["law", 10], ["seamanship", 8], ["maneuvering", 8]],
  "dif-c": [["colreg", 10]],
  "dif-d": [["law", 10]],
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "caahq-auth" },
});

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
};

// ─────────────── boot / auth gate ───────────────
async function boot() {
  // Wire login form
  document.getElementById("login-form").addEventListener("submit", onLogin);
  document.getElementById("reset-link").addEventListener("click", onResetLink);
  document.getElementById("logout-btn").addEventListener("click", onLogout);

  const { data } = await supabase.auth.getSession();
  if (data?.session?.user) {
    state.user = data.session.user;
    await launchApp();
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

  if (email !== ADMIN_EMAIL) {
    errEl.textContent = "This dashboard is locked to a single admin account.";
    return;
  }
  document.getElementById("login-submit").disabled = true;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  document.getElementById("login-submit").disabled = false;
  if (error) {
    errEl.textContent = error.message || "Sign-in failed.";
    return;
  }
  state.user = data.user;
  await launchApp();
}

async function onResetLink(e) {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim() || ADMIN_EMAIL;
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
  attachShell();
  await loadQuestions();
  await loadHistoryCounts();
  if (state.questions.length) selectQuestion(state.questions[0].id);
  render();
}

// ─────────────── data layer ───────────────
async function loadQuestions() {
  const { data, error } = await supabase
    .from("questions")
    .select("id, question, options, correct, topic, license, updated_at")
    .order("id", { ascending: true });
  if (error) { toast("bad", "Couldn't load questions", error.message); return; }
  state.questions = data || [];
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
function visibleQuestions() {
  const term = state.searchTerm.toLowerCase();
  return state.questions.filter(q => {
    if (state.filterTopic !== "all" && q.topic !== state.filterTopic) return false;
    if (state.filterLic === "C" && !(q.license || []).includes("C")) return false;
    if (state.filterLic === "D" && !(q.license || []).includes("D")) return false;
    if (state.filterLic === "C+D" &&
        !((q.license || []).includes("C") && (q.license || []).includes("D"))) return false;
    if (term) {
      const hay = (q.question + " " + (q.options || []).join(" ")).toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
}

function topicCounts() {
  const c = Object.fromEntries(TOPICS.map(t => [t, 0]));
  for (const q of state.questions) if (c.hasOwnProperty(q.topic)) c[q.topic]++;
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
  renderHistoryCount();
  renderTabContent();
  updateSaveStatus();
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
    return `<button class="topic-pill ${t === state.filterTopic ? "active" : ""}" data-t="${t}">${dot}<span>${t}</span><span class="count">${count}</span></button>`;
  }).join("");
  host.querySelectorAll(".topic-pill").forEach(b => {
    b.onclick = () => { state.filterTopic = b.dataset.t; renderList(); renderTopicFilter(); };
  });
}

function renderCoverage() {
  const host = document.getElementById("coverage");
  const broken = coverageInfo();
  if (!broken.length) { host.innerHTML = `<span class="cov-chip ok">✓ All exams covered</span>`; return; }
  // Group by exam
  const byExam = {};
  for (const b of broken) (byExam[b.exam] ??= []).push(b);
  host.innerHTML = Object.entries(byExam).map(([exam, list]) => {
    const txt = list.map(b => `${b.topic} ${b.have}/${b.need}`).join(", ");
    return `<span class="cov-chip bad" title="${txt}">⚠ ${exam}: ${txt}</span>`;
  }).join("");
}

function renderList() {
  const list = visibleQuestions();
  const ul = document.getElementById("qlist");
  if (!list.length) { ul.innerHTML = `<div class="empty">No questions match the current filters.</div>`; return; }
  ul.innerHTML = list.map(q => {
    const isActive = q.id === state.currentId;
    const licTags = (q.license || []).map(l => `<span class="lic-tag">${l}</span>`).join("");
    return `
      <li class="${isActive ? "active" : ""}" data-id="${q.id}">
        <div class="topic-bar" style="background:${TOPIC_COLOR(q.topic)}"></div>
        <div class="body">
          <div class="qtext">${escapeHtml(q.question)}</div>
          <div class="meta">
            <span style="color:${TOPIC_COLOR(q.topic)};font-weight:500">${q.topic}</span>
            <span>·</span>
            <span>${(q.options || []).length} options</span>
            ${licTags ? `<span>·</span>${licTags}` : ""}
          </div>
        </div>
      </li>`;
  }).join("");
  ul.querySelectorAll("li").forEach(li => {
    li.onclick = () => selectQuestion(parseInt(li.dataset.id, 10));
  });
  ul.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
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
          <div class="topic-grid" id="f-topic">
            ${TOPICS.map(t => `<button class="topic-choice ${t === state.current.topic ? "active" : ""}" data-t="${t}"><span class="dot" style="background:${TOPIC_COLOR(t)}"></span>${t}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <span class="label">Licenses</span>
          <div class="lic-toggle-row">
            ${LICENSES.map(l => `<button class="lic-toggle ${(state.current.license || []).includes(l) ? "active" : ""}" data-lic="${l}">Class ${l}</button>`).join("")}
          </div>
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
      state.current.topic = b.dataset.t;
      markDirty();
      document.querySelectorAll(".topic-choice").forEach(x => x.classList.toggle("active", x === b));
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
}

function renderBreadcrumbs() {
  if (!state.current) { document.getElementById("breadcrumbs").innerHTML = ""; return; }
  document.getElementById("breadcrumbs").innerHTML = `
    <span class="topic-chip"><span class="dot" style="background:${TOPIC_COLOR(state.current.topic)}"></span>${state.current.topic}</span>
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
  state.dirty = false;
  if (state.tab === "history" && state.current) renderTabContent();
  else render();
}

function markDirty() {
  state.dirty = true;
  updateSaveStatus();
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flushSave(), AUTOSAVE_DELAY);
}

function updateSaveStatus() {
  const el = document.getElementById("save-status");
  if (!state.current) {
    el.className = "save-status";
    el.querySelector(".text").textContent = "—";
    return;
  }
  el.className = state.dirty ? "save-status dirty" : "save-status saved";
  el.querySelector(".text").textContent = state.dirty ? "Unsaved changes…" : "Saved";
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
      license: snapshot.license,
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
      license: state.current.license,
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
async function deployFlow() {
  if (state.dirty) await flushSave();
  const ok = await confirmModal({
    title: "Publish to Supabase Storage?",
    body: `Snapshots all ${state.questions.length} questions into a new versioned blob. The mobile app picks it up on next launch.`,
    confirmText: "Publish",
  });
  if (!ok) return;
  const btn = document.getElementById("deploy-btn");
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:currentColor;animation:pulse 1s infinite alternate"></span>Publishing…`;
  try {
    // Compose payload in the mobile bundle's schema
    const payload = state.questions.map((q, i) => ({
      id: i,
      question: q.question,
      options: q.options,
      correct: q.correct,
      topic: q.topic,
      license: q.license || [],
    }));

    // Read current pointer to figure out next version
    let version = 1;
    try {
      const { data: ptr } = await supabase.storage.from("questions").download("current.json");
      if (ptr) {
        const txt = await ptr.text();
        const cur = JSON.parse(txt);
        version = (cur.version || 0) + 1;
      }
    } catch { /* no current.json yet — start at v1 */ }

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
    };
    const ptrBody = new Blob([JSON.stringify(pointer, null, 2)], { type: "application/json" });
    const { error: e2 } = await supabase.storage.from("questions").upload("current.json", ptrBody, { upsert: true, contentType: "application/json" });
    if (e2) throw e2;

    toast("ok", `Published v${version}`, `${payload.length} questions · sha ${sha.slice(0, 12)}…`);
  } catch (e) {
    toast("bad", "Publish failed", e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

// ─────────────── tabs ───────────────
function attachShell() {
  document.getElementById("new-btn").onclick = () => createNew();
  document.getElementById("deploy-btn").onclick = () => deployFlow();
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
    renderList();
  });
  document.getElementById("search-clear").onclick = () => {
    searchEl.value = ""; state.searchTerm = "";
    document.getElementById("search-clear").style.display = "none";
    renderList(); searchEl.focus();
  };
  document.getElementById("lic-filter").querySelectorAll(".lic-pill").forEach(b => {
    b.onclick = () => {
      state.filterLic = b.dataset.l;
      document.querySelectorAll("#lic-filter .lic-pill").forEach(x => x.classList.toggle("active", x === b));
      renderList();
    };
  });

  // Shortcuts
  document.addEventListener("keydown", e => {
    const inField = e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT" || e.target.tagName === "SELECT";
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && (e.key === "s" || e.key === "S")) { e.preventDefault(); flushSave(); return; }
    if (cmd && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateCurrent(); return; }
    if (cmd && e.key === "Backspace") { e.preventDefault(); deleteCurrent(); return; }
    if (cmd && (e.key === "k" || e.key === "K")) { e.preventDefault(); searchEl.focus(); return; }
    if (inField) return;
    const list = visibleQuestions();
    const idx = list.findIndex(q => q.id === state.currentId);
    if (e.key === "ArrowDown" || e.key === "j") {
      if (idx < list.length - 1) selectQuestion(list[idx + 1].id);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      if (idx > 0) selectQuestion(list[idx - 1].id);
    } else if (e.key === "n" || e.key === "N") createNew();
    else if (e.key === "/") { e.preventDefault(); searchEl.focus(); }
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
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function stringify(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(" / ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
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

boot();
