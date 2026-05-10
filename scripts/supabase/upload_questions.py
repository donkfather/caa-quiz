"""Upload a versioned questions blob to Supabase Storage.

Reads the SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.local (the service
key is required because the bucket is private; the anon key can only read).

Layout in the bucket:
    questions/v{N}.json   the payload itself
    questions/current.json  pointer: { "version": N, "uploaded_at": iso8601, "count": int, "sha256": "..." }

The mobile app fetches `current.json` first; if its version > the cached
one, it then fetches `v{N}.json` and stores the result. This keeps the
cheap "is there an update?" round-trip tiny.

Usage:
    python3 scripts/supabase/upload_questions.py path/to/questions.json [--version N]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


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


def supabase_request(
    method: str,
    url: str,
    *,
    service_key: str,
    body: bytes | None = None,
    content_type: str = "application/octet-stream",
) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("apikey", service_key)
    req.add_header("Content-Type", content_type)
    req.add_header("x-upsert", "true")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", type=Path, help="JSON file to upload (final_questions.json)")
    ap.add_argument("--version", type=int, default=None,
                    help="Override version number (defaults to current+1 from current.json)")
    ap.add_argument("--bucket", default="questions")
    args = ap.parse_args()

    repo = Path(__file__).resolve().parents[2]
    env = load_env(repo / ".env.local")
    url = env.get("EXPO_PUBLIC_SUPABASE_URL")
    service_key = env.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not service_key:
        print("ERROR: set EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local",
              file=sys.stderr)
        print("(SUPABASE_SERVICE_KEY = the service_role key, NOT the anon key)",
              file=sys.stderr)
        return 1
    url = url.rstrip("/")

    payload = args.path.read_bytes()
    questions = json.loads(payload)
    if not isinstance(questions, list):
        print(f"ERROR: expected a JSON array, got {type(questions).__name__}", file=sys.stderr)
        return 1

    # Schema sanity — refuse to publish anything the app can't render.
    valid_topics = {"colreg", "navigation", "seamanship", "maneuvering", "first_aid", "law"}
    valid_licenses = {"C", "D"}
    problems: list[str] = []
    for i, q in enumerate(questions):
        if not isinstance(q, dict):
            problems.append(f"#{i}: not an object")
            continue
        for k in ("question", "options", "correct"):
            if k not in q:
                problems.append(f"#{i}: missing {k}")
        if not isinstance(q.get("question"), str) or not q["question"].strip():
            problems.append(f"#{i}: empty question")
        opts = q.get("options")
        if not isinstance(opts, list) or len(opts) < 2:
            problems.append(f"#{i}: needs ≥2 options, got {opts!r}")
        elif any(not isinstance(o, str) or not o.strip() for o in opts):
            problems.append(f"#{i}: empty option text")
        c = q.get("correct")
        if not isinstance(c, int) or not (isinstance(opts, list) and 0 <= c < len(opts)):
            problems.append(f"#{i}: correct={c!r} not a valid option index")
        topic = q.get("topic")
        if topic is not None and topic not in valid_topics:
            problems.append(f"#{i}: invalid topic {topic!r}")
        lic = q.get("license") or q.get("licenses") or []
        if not isinstance(lic, list) or any(x not in valid_licenses for x in lic):
            problems.append(f"#{i}: invalid license {lic!r}")
    if problems:
        print(f"ERROR: {len(problems)} schema problem(s); refusing to publish:", file=sys.stderr)
        for p in problems[:20]:
            print(f"  {p}", file=sys.stderr)
        if len(problems) > 20:
            print(f"  … and {len(problems) - 20} more", file=sys.stderr)
        return 1

    digest = hashlib.sha256(payload).hexdigest()

    # Resolve next version
    if args.version is not None:
        version = args.version
    else:
        status, body = supabase_request(
            "GET",
            f"{url}/storage/v1/object/{args.bucket}/current.json",
            service_key=service_key,
        )
        if status == 200:
            try:
                version = json.loads(body).get("version", 0) + 1
            except Exception:
                version = 1
        else:
            version = 1

    blob_name = f"v{version}.json"
    print(f"uploading {len(questions)} questions ({len(payload):,} bytes) → {args.bucket}/{blob_name}")
    status, body = supabase_request(
        "POST",
        f"{url}/storage/v1/object/{args.bucket}/{blob_name}",
        service_key=service_key,
        body=payload,
        content_type="application/json",
    )
    if status not in (200, 201):
        print(f"ERROR: upload failed [{status}]: {body[:200].decode(errors='ignore')}",
              file=sys.stderr)
        return 1

    pointer = {
        "version": version,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "count": len(questions),
        "sha256": digest,
        "blob": blob_name,
    }
    pointer_bytes = json.dumps(pointer, ensure_ascii=False, indent=2).encode("utf-8")
    status, body = supabase_request(
        "POST",
        f"{url}/storage/v1/object/{args.bucket}/current.json",
        service_key=service_key,
        body=pointer_bytes,
        content_type="application/json",
    )
    if status not in (200, 201):
        print(f"ERROR: pointer upload failed [{status}]: {body[:200].decode(errors='ignore')}",
              file=sys.stderr)
        return 1

    print(f"published v{version}  sha256={digest[:12]}…  count={len(questions)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
