"""Pull the current `questions` table from Supabase into assets/questions.json.

Run before a mobile build so the bundled fallback matches what's online.
The bundled JSON is the offline first-run fallback; the dashboard table
is the source of truth.
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=ROOT / "assets" / "questions.json")
    args = ap.parse_args()

    env = load_env(ROOT / ".env.local")
    url = env.get("EXPO_PUBLIC_SUPABASE_URL")
    key = env.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("ERROR: set EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_KEY in .env.local", file=sys.stderr)
        return 1
    url = url.rstrip("/")

    # Fetch all questions in id order, projecting only the app-bundle shape.
    req = urllib.request.Request(
        f"{url}/rest/v1/questions"
        f"?select=id,question,options,correct,topic,license,image_path"
        f"&order=id.asc",
        method="GET",
    )
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("apikey", key)
    req.add_header("Range-Unit", "items")
    req.add_header("Prefer", "count=exact")

    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()

    rows = json.loads(body)

    # Preserve the DB id verbatim so bundled, blob, and table stay aligned.
    # When ids drift, anything that round-trips an id (reports, RPC lookups)
    # ends up off-by-one.
    cleaned = []
    for q in rows:
        cleaned.append({
            "id": q["id"],
            "question": q["question"],
            "options": q["options"],
            "correct": q["correct"],
            "topic": q["topic"],
            "license": q["license"] or [],
        })

    args.out.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2))
    print(f"wrote {len(cleaned)} questions → {args.out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
