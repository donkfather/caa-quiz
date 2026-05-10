"""Import assets/questions.json into the Supabase `questions` table.

Run ONCE after applying 001_questions_with_history.sql. Idempotent in the
sense that re-running on a non-empty table will refuse — pass --force to
truncate first.

The audit trigger automatically writes a `'insert'` version row for each
imported question. After this runs the database is the source of truth.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_env(p: Path) -> dict:
    env: dict[str, str] = {}
    if not p.exists():
        return env
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def supabase_request(method: str, url: str, *, service_key: str,
                     body: bytes | None = None,
                     extra_headers: dict[str, str] | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("apikey", service_key)
    req.add_header("Content-Type", "application/json")
    for k, v in (extra_headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", type=Path, default=ROOT / "assets" / "questions.json")
    ap.add_argument("--force", action="store_true",
                    help="Truncate the questions table before importing.")
    args = ap.parse_args()

    env = load_env(ROOT / ".env.local")
    base_url = env.get("EXPO_PUBLIC_SUPABASE_URL")
    service_key = env.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
    if not base_url or not service_key:
        print("ERROR: set EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local", file=sys.stderr)
        return 1
    base_url = base_url.rstrip("/")
    rest = f"{base_url}/rest/v1"

    # Check current state
    status, body = supabase_request(
        "GET",
        f"{rest}/questions?select=id&limit=1",
        service_key=service_key,
        extra_headers={"Range": "0-0"},
    )
    if status >= 400:
        print(f"ERROR: cannot read questions table [{status}]: {body[:200].decode()}", file=sys.stderr)
        return 1
    existing = json.loads(body)
    if existing and not args.force:
        print(f"questions table is non-empty ({len(existing)}+ rows). Pass --force to truncate.", file=sys.stderr)
        return 1

    if args.force and existing:
        # truncate via PostgREST (DELETE all)
        status, _ = supabase_request(
            "DELETE",
            f"{rest}/questions?id=gte.0",
            service_key=service_key,
            extra_headers={"Prefer": "return=minimal"},
        )
        if status >= 400:
            print(f"ERROR: truncate failed [{status}]", file=sys.stderr)
            return 1
        print("truncated existing rows")

    raw = json.loads(args.source.read_text())
    rows = []
    for q in raw:
        rows.append({
            "question": q["question"],
            "options": q["options"],
            "correct": q["correct"],
            "topic": q["topic"],
            "license": q.get("license", []),
        })

    # Insert in chunks of 200 (PostgREST default cap is generous but stay polite)
    BATCH = 200
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        body = json.dumps(chunk).encode("utf-8")
        status, resp = supabase_request(
            "POST",
            f"{rest}/questions",
            service_key=service_key,
            body=body,
            extra_headers={"Prefer": "return=minimal"},
        )
        if status >= 400:
            print(f"ERROR: batch {i//BATCH} failed [{status}]: {resp[:200].decode()}", file=sys.stderr)
            return 1
        print(f"  inserted {min(i+BATCH, len(rows))}/{len(rows)}")

    print(f"\ndone: imported {len(rows)} questions. The audit trigger wrote a matching 'insert' version row for each.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
