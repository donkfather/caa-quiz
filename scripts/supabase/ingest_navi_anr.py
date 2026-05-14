"""Ingest ~/projects/navi-anr-extracted/questions.json into question_candidates.

Cleaner source than the xls files (proper JSON, normalized diacritics).
Includes image refs for ~198 of the 1211 questions. The 'rnd' topic is
collapsed into 'law' to match the DB's enum.

Dedup happens against:
  - existing public.questions (exact normalized text match → status='rejected',
    duplicate_of=qid)
  - existing public.question_candidates with the same normalized text → skip
    so we don't queue near-duplicate review work.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path("/Users/donkfather/projects/caa-quiz")
SRC = Path("/Users/donkfather/projects/navi-anr-extracted/questions.json")

TOPIC_MAP = {
    "rnd": "law",  # navi-anr separates RND from legislatie; our schema has just "law"
}


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


def get_json(url: str, headers: dict) -> list:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def main() -> int:
    env = load_env()
    base = env["EXPO_PUBLIC_SUPABASE_URL"].rstrip("/")
    key = env["SUPABASE_SERVICE_KEY"]
    hdrs_read = {"Authorization": f"Bearer {key}", "apikey": key}
    hdrs_write = {**hdrs_read, "Content-Type": "application/json", "Prefer": "return=representation"}

    src = json.loads(SRC.read_text())
    print(f"source: {len(src)} questions")

    # Existing questions (for hard-dup detection)
    existing = get_json(f"{base}/rest/v1/questions?select=id,question", hdrs_read)
    by_norm_q = {normalize(q["question"]): q["id"] for q in existing}

    # Existing candidates' normalized questions (skip queueing duplicates of duplicates)
    cands = []
    offset = 0
    while True:
        page = get_json(
            f"{base}/rest/v1/question_candidates?select=question,source_file,source_nr&limit=1000&offset={offset}",
            hdrs_read,
        )
        if not page: break
        cands.extend(page)
        if len(page) < 1000: break
        offset += 1000
    cand_norms = {normalize(c["question"]) for c in cands}
    cand_keys = {(c["source_file"], c["source_nr"]) for c in cands}

    rows: list[dict] = []
    counters = {"queued": 0, "dup_db": 0, "skip_cand": 0, "skip_seen": 0, "skip_invalid": 0}
    for q in src:
        topic = TOPIC_MAP.get(q["topic"], q["topic"])
        if topic not in ("colreg","navigation","seamanship","maneuvering","first_aid","law"):
            counters["skip_invalid"] += 1
            continue

        src_file = f"navi-anr/{q['source']['file']}"
        src_nr = str(q["id"])
        if (src_file, src_nr) in cand_keys:
            counters["skip_seen"] += 1
            continue

        norm = normalize(q["question"])
        dup_id = by_norm_q.get(norm)
        if dup_id is None and norm in cand_norms:
            counters["skip_cand"] += 1
            continue

        row = {
            "source_file": src_file,
            "source_nr": src_nr,
            "topic": topic,
            "question": q["question"],
            "options": q["options"],
            "correct": q["correct"],
            "license": q.get("license", []),
            "image_path": q.get("image"),
            "status": "rejected" if dup_id is not None else "pending",
            "duplicate_of": dup_id,
        }
        rows.append(row)
        if dup_id is not None: counters["dup_db"] += 1
        else: counters["queued"] += 1

    print(f"plan: {counters}")
    for i in range(0, len(rows), 200):
        chunk = rows[i:i+200]
        req = urllib.request.Request(
            f"{base}/rest/v1/question_candidates",
            data=json.dumps(chunk, ensure_ascii=False).encode("utf-8"),
            method="POST", headers=hdrs_write,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                print(f"  inserted {len(chunk)} ({r.status})")
        except urllib.error.HTTPError as e:
            print(f"  ERROR {e.code}: {e.read().decode()[:400]}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
