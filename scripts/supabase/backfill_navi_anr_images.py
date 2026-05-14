#!/usr/bin/env python3
"""Backfill image_path on candidates and questions by matching normalized text.

The navi-anr ingest stored source_nr from the JSON's global `id`, but many
JSON ids were dropped as in-run duplicates — so source_nr matching misses
most cases. We instead match by normalized question text against the
authoritative {normalized_question: image} map from questions.json.

Only fills image_path where it's currently NULL. Idempotent.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = Path("/Users/donkfather/projects/navi-anr-extracted/questions.json")


def normalize(s: str) -> str:
    s = re.sub(r"\s+", " ", s).strip().lower()
    s = (s.replace("ă", "a").replace("â", "a")
           .replace("î", "i").replace("ş", "s").replace("ș", "s")
           .replace("ţ", "t").replace("ț", "t"))
    s = re.sub(r"[?!.,;:\"'()\-–—]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load_env() -> dict[str, str]:
    env = {}
    for line in (ROOT / ".env.local").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def fetch_all(base: str, key: str, table: str, select: str) -> list:
    rows = []
    page = 0
    page_size = 1000
    while True:
        req = urllib.request.Request(
            f"{base}/rest/v1/{table}?select={urllib.parse.quote(select)}&limit={page_size}&offset={page*page_size}",
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
        )
        with urllib.request.urlopen(req) as r:
            chunk = json.loads(r.read())
        rows.extend(chunk)
        if len(chunk) < page_size:
            break
        page += 1
    return rows


def patch(base: str, key: str, table: str, row_id: int, body: dict) -> bool:
    req = urllib.request.Request(
        f"{base}/rest/v1/{table}?id=eq.{row_id}",
        data=json.dumps(body).encode("utf-8"),
        method="PATCH",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        urllib.request.urlopen(req).read()
        return True
    except urllib.error.HTTPError as e:
        print(f"  PATCH {table} #{row_id} failed: {e.code} {e.read().decode()[:200]}", file=sys.stderr)
        return False


def make_key(question: str, options: list) -> str:
    """Match on (question + sorted options) so identical-text questions with
    different options (e.g. "In figura de mai jos este reprezentat:" repeated
    with different image-specific answer choices) map to distinct keys."""
    parts = [normalize(question)] + sorted(normalize(o) for o in (options or []))
    return "||".join(parts)


def main():
    env = load_env()
    base = env["EXPO_PUBLIC_SUPABASE_URL"]
    key = env["SUPABASE_SERVICE_KEY"]
    dry_run = "--dry-run" in sys.argv
    fix_mismatches = "--fix-mismatches" in sys.argv

    # 1. Build {key: image} from JSON
    data = json.loads(JSON_PATH.read_text())
    img_by_key: dict[str, str] = {}
    collisions = 0
    for q in data:
        img = q.get("image")
        if not img:
            continue
        k = make_key(q["question"], q.get("options", []))
        if k in img_by_key and img_by_key[k] != img:
            collisions += 1
        img_by_key[k] = img
    print(f"loaded {len(img_by_key)} unique (q+options)→image entries (collisions: {collisions})")

    # 2. Fetch candidates + questions
    cands = fetch_all(base, key, "question_candidates",
                      "id,status,question,options,image_path,duplicate_of,imported_question_id")
    print(f"fetched {len(cands)} candidates")
    qs = fetch_all(base, key, "questions", "id,question,options,image_path")
    print(f"fetched {len(qs)} published questions")

    # 3. Plan candidate updates (and detect mismatches to fix)
    cand_updates = []
    cand_fixes = []  # existing image_path that disagrees with the better match
    for c in cands:
        k = make_key(c["question"], c.get("options", []))
        img = img_by_key.get(k)
        if not img:
            continue
        cur = c.get("image_path")
        if not cur:
            cand_updates.append((c["id"], img, c.get("status"), c.get("duplicate_of"), c.get("imported_question_id")))
        elif cur != img:
            cand_fixes.append((c["id"], cur, img, c.get("status"), c.get("duplicate_of"), c.get("imported_question_id")))

    # 4. Plan question updates: from JSON match AND from candidate links
    q_updates: dict[int, str] = {}
    q_fixes: list[tuple[int, str, str]] = []
    q_by_key = {make_key(q["question"], q.get("options", [])): q for q in qs}
    for k, img in img_by_key.items():
        q = q_by_key.get(k)
        if not q:
            continue
        cur = q.get("image_path")
        if not cur:
            q_updates[q["id"]] = img
        elif cur != img:
            q_fixes.append((q["id"], cur, img))
    q_by_id = {q["id"]: q for q in qs}
    for cid, img, status, dup_of, imp_id in cand_updates:
        for qid in (dup_of, imp_id):
            if qid and qid in q_by_id and not q_by_id[qid].get("image_path"):
                q_updates.setdefault(qid, img)

    print(f"plan: {len(cand_updates)} candidates to add image, "
          f"{len(cand_fixes)} candidate mismatches, "
          f"{len(q_updates)} questions to add image, "
          f"{len(q_fixes)} question mismatches")
    if cand_fixes[:3]:
        print("  sample candidate mismatches:")
        for cid, cur, new, *_ in cand_fixes[:5]:
            print(f"    cand #{cid}: {cur!r} → {new!r}")
    if q_fixes[:3]:
        print("  sample question mismatches:")
        for qid, cur, new in q_fixes[:5]:
            print(f"    q #{qid}: {cur!r} → {new!r}")

    if dry_run:
        print("dry-run; no writes")
        return

    # 5. Apply additions
    ok_c = 0
    for cid, img, *_ in cand_updates:
        if patch(base, key, "question_candidates", cid, {"image_path": img}):
            ok_c += 1
    ok_q = 0
    for qid, img in q_updates.items():
        if patch(base, key, "questions", qid, {"image_path": img}):
            ok_q += 1
    print(f"added: {ok_c}/{len(cand_updates)} candidates, {ok_q}/{len(q_updates)} questions")

    # 6. Optionally fix mismatched existing image_paths
    if fix_mismatches:
        fix_c = 0
        for cid, cur, img, *_ in cand_fixes:
            if patch(base, key, "question_candidates", cid, {"image_path": img}):
                fix_c += 1
        fix_q = 0
        for qid, cur, img in q_fixes:
            if patch(base, key, "questions", qid, {"image_path": img}):
                fix_q += 1
        print(f"fixed: {fix_c}/{len(cand_fixes)} candidates, {fix_q}/{len(q_fixes)} questions")
    else:
        print(f"skipped {len(cand_fixes) + len(q_fixes)} mismatches; pass --fix-mismatches to apply")


if __name__ == "__main__":
    main()
