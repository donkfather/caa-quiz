#!/usr/bin/env node
// Google Play Developer API client — zero dependencies, Node >= 22. Used by release-android.sh.
//
// The service-account JSON is read from STDIN, never from a path or an env var,
// so the caller can pipe it straight out of 1Password and it never lands on disk:
//
//   op document get "Play SA claude-499612" --vault Claude | node play-upload.mjs status --package com.bhdit.caaquiz
//
// Commands:
//   status            --package P   tracks + releases + highest uploaded versionCode (read-only)
//   next-version-code --package P   prints max(every uploaded bundle/APK, every track release) + 1
//   upload            --package P --aab FILE --track internal --release-name NAME
//                     [--notes-ro TEXT] [--notes-en TEXT] [--dry-run] [--allow-practice]
//
// Every API session is an "edit" (a draft). Read-only commands open one and
// DELETE it; upload commits only after Google's own validate passes, --dry-run
// validates and then deletes, and any failure deletes the edit, so a half-done
// upload can never sit in the Console waiting to be committed by someone else.
// The access token is never printed.

import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

// ── args ─────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) fail(`unexpected argument: ${a}`);
  const key = a.slice(2);
  if (["dry-run", "allow-practice"].includes(key)) opts[key] = true;
  else if (i + 1 < rest.length) opts[key] = rest[++i];
  else fail(`${a} needs a value`);
}
function fail(msg, code = 2) { console.error(`play-upload: ${msg}`); process.exit(code); }
function usage() {
  console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
if (!["status", "next-version-code", "upload"].includes(cmd)) usage();
const pkg = opts.package || fail("--package is required");
if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(pkg)) fail(`--package does not look like an application id: ${pkg}`);

// ── auth: service-account JWT (RS256) → OAuth access token ───────────────────
// Read stdin as a stream: touching process.stdin switches a pipe to non-blocking,
// after which readFileSync(0) throws EAGAIN — which looks exactly like bad JSON.
async function readServiceAccount() {
  if (process.stdin.isTTY) fail("pipe the service-account JSON on stdin (e.g. op document get … | node play-upload.mjs …)");
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) fail("stdin was empty — did the op command fail?");
  let sa;
  try { sa = JSON.parse(text); } catch { fail("stdin is not valid JSON"); }
  for (const k of ["client_email", "private_key", "token_uri"])
    if (typeof sa[k] !== "string" || !sa[k]) fail(`service-account JSON has no "${k}"`);
  if (sa.type && sa.type !== "service_account") fail(`credential type is "${sa.type}", expected service_account`);
  return sa;
}
const b64url = (b) => Buffer.from(b).toString("base64url");
async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  const jwt = `${head}.${claims}.${signer.sign(sa.private_key).toString("base64url")}`;
  const r = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  // Google's error body names the problem (invalid_grant, unauthorized_client) and never echoes the key.
  if (!r.ok || !j.access_token) fail(`token exchange failed (${r.status}): ${j.error || ""} ${j.error_description || ""}`.trim(), 1);
  return j.access_token;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
let TOKEN;
class ApiError extends Error {}
async function api(method, url, { json, body, headers = {}, timeout = 60_000, raw = false } = {}) {
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(json ? { "content-type": "application/json" } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(timeout),
  });
  if (raw) return r;
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!r.ok) {
    const e = data.error || {};
    throw new ApiError(`${method} ${url.replace(/^https:\/\/[^/]+/, "")} → ${r.status} ${e.status || ""}: ${e.message || data.raw || text.slice(0, 300)}`);
  }
  return data;
}
const app = `${API}/${encodeURIComponent(pkg)}`;

async function withEdit(fn, { commitAfter = false } = {}) {
  const edit = await api("POST", `${app}/edits`, { json: {} });
  let committed = false;
  try {
    const out = await fn(edit.id);
    if (commitAfter) {
      await api("POST", `${app}/edits/${edit.id}:commit`, { timeout: 120_000 });
      committed = true;
    }
    return out;
  } finally {
    if (!committed) await api("DELETE", `${app}/edits/${edit.id}`).catch((e) => console.error(`warning: could not delete edit ${edit.id}: ${e.message}`));
  }
}

async function inventory(editId) {
  const [tracks, bundles, apks] = await Promise.all([
    api("GET", `${app}/edits/${editId}/tracks`),
    api("GET", `${app}/edits/${editId}/bundles`),
    api("GET", `${app}/edits/${editId}/apks`).catch(() => ({ apks: [] })),
  ]);
  const codes = [
    ...(bundles.bundles || []).map((b) => Number(b.versionCode)),
    ...(apks.apks || []).map((a) => Number(a.versionCode)),
    ...(tracks.tracks || []).flatMap((t) => (t.releases || []).flatMap((r) => (r.versionCodes || []).map(Number))),
  ].filter(Number.isFinite);
  return { tracks: tracks.tracks || [], bundles: bundles.bundles || [], apks: apks.apks || [], max: codes.length ? Math.max(...codes) : 0 };
}

// ── commands ─────────────────────────────────────────────────────────────────
async function status() {
  const inv = await withEdit(inventory);
  console.log(`package ${pkg}`);
  for (const t of inv.tracks) {
    const rels = t.releases || [];
    if (!rels.length) { console.log(`  ${t.track.padEnd(12)} (no releases)`); continue; }
    for (const r of rels)
      console.log(`  ${t.track.padEnd(12)} ${String(r.status).padEnd(10)} versionCodes=[${(r.versionCodes || []).join(",")}] ${r.name ? `"${r.name}"` : ""}${r.userFraction ? ` rollout=${r.userFraction}` : ""}`);
  }
  console.log(`  bundles uploaded: ${inv.bundles.length}${inv.bundles.length ? ` (versionCodes ${inv.bundles.map((b) => b.versionCode).sort((a, b) => a - b).join(",")})` : ""}`);
  if (inv.apks.length) console.log(`  apks uploaded: ${inv.apks.length}`);
  console.log(`  highest versionCode: ${inv.max} → next: ${inv.max + 1}`);
}

async function nextVersionCode() {
  const inv = await withEdit(inventory);
  console.log(inv.max + 1);
}

async function upload() {
  const aab = opts.aab || fail("--aab is required");
  const track = opts.track || fail("--track is required (e.g. internal)");
  const releaseName = opts["release-name"] || fail("--release-name is required");
  if (!existsSync(aab)) fail(`no such file: ${aab}`);
  if (!aab.endsWith(".aab")) fail("--aab must be an .aab");

  // Cross-check against the builder's metadata when it is there. A practice
  // bundle is signed with a throwaway key: Play would reject it, but refusing
  // here is clearer than Google's "wrong signing key" error.
  const metaPath = join(dirname(aab), basename(aab, ".aab") + ".metadata.json");
  if (existsSync(metaPath)) {
    const m = JSON.parse(readFileSync(metaPath, "utf8"));
    if (m.practice && !opts["allow-practice"]) fail(`${basename(aab)} is a PRACTICE build (throwaway key) — refusing to upload`);
    if (m.package && m.package !== pkg) fail(`bundle is ${m.package}, not ${pkg}`);
    console.log(`bundle ${m.package} ${m.versionName} (${m.versionCode}), signer SHA-256 ${m.signer?.sha256}`);
  } else {
    console.log(`(no ${basename(metaPath)} next to the bundle — skipping metadata cross-check)`);
  }
  const bytes = readFileSync(aab);
  const notes = [];
  if (opts["notes-ro"]) notes.push({ language: "ro-RO", text: opts["notes-ro"] });
  if (opts["notes-en"]) notes.push({ language: "en-US", text: opts["notes-en"] });
  if (notes.some((n) => n.text.length > 500)) fail("release notes are limited to 500 characters per language");

  await withEdit(async (editId) => {
    const inv = await inventory(editId);
    // resumable upload: open a session, then PUT the bytes
    const start = await api("POST", `${UPLOAD_API}/${encodeURIComponent(pkg)}/edits/${editId}/bundles?uploadType=resumable`, {
      raw: true,
      headers: { "x-upload-content-type": "application/octet-stream", "x-upload-content-length": String(bytes.length), "content-type": "application/json" },
      body: "{}",
    });
    if (!start.ok) throw new ApiError(`opening upload session → ${start.status}: ${(await start.text()).slice(0, 300)}`);
    const session = start.headers.get("location");
    if (!session) throw new ApiError("upload session returned no Location header");
    console.log(`uploading ${(bytes.length / 1048576).toFixed(1)} MB…`);
    const put = await api("PUT", session, { body: bytes, headers: { "content-type": "application/octet-stream" }, timeout: 15 * 60_000 });
    const vc = Number(put.versionCode);
    if (!Number.isFinite(vc)) throw new ApiError(`upload response had no versionCode: ${JSON.stringify(put).slice(0, 200)}`);
    console.log(`uploaded: versionCode ${vc}, sha256 ${put.sha256}`);
    // (an exact duplicate is already refused by Google at the PUT above)
    if (vc <= inv.max) throw new ApiError(`versionCode ${vc} is not above the highest already used (${inv.max})`);

    // R8 deobfuscation map from the builder (<bundle>.mapping.txt). Uploaded into the
    // same edit as the bundle, so a release can never go out without its map.
    const mappingPath = join(dirname(aab), basename(aab, ".aab") + ".mapping.txt");
    if (existsSync(mappingPath)) {
      const map = readFileSync(mappingPath);
      if (map.length < 1024) throw new ApiError(`${basename(mappingPath)} is only ${map.length} bytes — refusing to upload a truncated map`);
      await api("POST", `${UPLOAD_API}/${encodeURIComponent(pkg)}/edits/${editId}/apks/${vc}/deobfuscationFiles/proguard?uploadType=media`, {
        body: map, headers: { "content-type": "application/octet-stream" }, timeout: 5 * 60_000,
      });
      console.log(`deobfuscation map uploaded (${(map.length / 1048576).toFixed(1)} MB)`);
    } else {
      console.log("(no .mapping.txt next to the bundle — app is not minified, nothing to deobfuscate)");
    }

    const release = { name: releaseName, versionCodes: [String(vc)], status: "completed", ...(notes.length ? { releaseNotes: notes } : {}) };
    await api("PUT", `${app}/edits/${editId}/tracks/${encodeURIComponent(track)}`, { json: { track, releases: [release] } });
    console.log(`track ${track}: release "${releaseName}" → [${vc}] completed`);
    await api("POST", `${app}/edits/${editId}:validate`, { timeout: 120_000 });
    console.log("validate: OK");
    if (opts["dry-run"]) console.log("--dry-run: edit will be DELETED, nothing published");
  }, { commitAfter: !opts["dry-run"] });
  if (!opts["dry-run"]) console.log(`committed: ${pkg} → track "${track}"`);
}

// ── main ─────────────────────────────────────────────────────────────────────
try {
  TOKEN = await accessToken(await readServiceAccount());
  if (cmd === "status") await status();
  else if (cmd === "next-version-code") await nextVersionCode();
  else await upload();
} catch (e) {
  fail(e instanceof ApiError ? e.message : `${e.name}: ${e.message}`, 1);
}
