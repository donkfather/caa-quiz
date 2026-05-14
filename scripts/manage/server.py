"""Question management dashboard — backend.

Serves a SPA + a tiny JSON CRUD over assets/questions.json.

Endpoints:
  GET    /                       index.html
  GET    /api/questions          full list
  GET    /api/stats              counts per topic + license + exam coverage
  POST   /api/questions          create new (auto-assigns id)
  PUT    /api/questions/:id      replace one
  DELETE /api/questions/:id      remove one
  POST   /api/deploy             validate + upload to Supabase, returns CLI output

Every mutation atomically rewrites assets/questions.json and keeps a
rolling backup at assets/questions.json.bak.

Run:
    python3 scripts/manage/server.py        # or: npm run questions:manage
Open http://localhost:5175
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
QUESTIONS = ROOT / "assets" / "questions.json"
BACKUP = ROOT / "assets" / "questions.json.bak"
UPLOAD_SCRIPT = ROOT / "scripts" / "supabase" / "upload_questions.py"

VALID_TOPICS = ("colreg", "navigation", "seamanship", "maneuvering", "first_aid", "law")
VALID_LICENSES = ("C", "D")

# Required-per-exam (mirrors EXAM_CONFIGS in src/lib/questions.ts).
EXAM_REQUIREMENTS = {
    "cat-c": [("colreg", 8), ("seamanship", 6), ("navigation", 6), ("maneuvering", 6)],
    "cat-d": [("law", 10), ("seamanship", 8), ("maneuvering", 8)],
    "dif-c": [("colreg", 10)],
    "dif-d": [("law", 10)],
}


def load() -> list[dict]:
    return json.loads(QUESTIONS.read_text())


def save(data: list[dict]) -> None:
    if QUESTIONS.exists():
        shutil.copy2(QUESTIONS, BACKUP)
    # Reassign contiguous ids on every save so the wire format never has gaps
    for i, q in enumerate(data):
        q["id"] = i
    QUESTIONS.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def validate(q: dict) -> list[str]:
    errs: list[str] = []
    if not isinstance(q.get("question"), str) or not q["question"].strip():
        errs.append("question is empty")
    opts = q.get("options")
    if not isinstance(opts, list) or len(opts) < 2:
        errs.append("at least 2 options required")
    elif any(not isinstance(o, str) or not o.strip() for o in opts):
        errs.append("option text is empty")
    c = q.get("correct")
    if not isinstance(c, int) or not (isinstance(opts, list) and 0 <= c < len(opts)):
        errs.append("correct must be a valid option index")
    if q.get("topic") not in VALID_TOPICS:
        errs.append(f"topic must be one of {VALID_TOPICS}")
    lic = q.get("license") or []
    if not isinstance(lic, list) or any(x not in VALID_LICENSES for x in lic) or not lic:
        errs.append(f"license must be a non-empty subset of {VALID_LICENSES}")
    return errs


def stats(data: list[dict]) -> dict:
    by_topic = Counter(q.get("topic") for q in data)
    by_license = Counter()
    for q in data:
        for lic in q.get("license", []):
            by_license[lic] += 1
    coverage: dict[str, dict] = {}
    for exam, slots in EXAM_REQUIREMENTS.items():
        rows = []
        ok = True
        for topic, need in slots:
            have = by_topic.get(topic, 0)
            rows.append({"topic": topic, "need": need, "have": have, "ok": have >= need})
            ok = ok and have >= need
        coverage[exam] = {"slots": rows, "ok": ok}
    return {
        "total": len(data),
        "by_topic": {t: by_topic.get(t, 0) for t in VALID_TOPICS},
        "by_license": dict(by_license),
        "coverage": coverage,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send_json(self, code: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, ctype: str) -> None:
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict | list | None:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return None
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return None

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/", "/index.html"):
            return self._send_file(HERE / "index.html", "text/html; charset=utf-8")
        if url.path == "/api/questions":
            return self._send_json(200, load())
        if url.path == "/api/stats":
            return self._send_json(200, stats(load()))
        return self._send_json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/api/questions":
            payload = self._read_json()
            if not isinstance(payload, dict):
                return self._send_json(400, {"error": "expected a question object"})
            errs = validate(payload)
            if errs:
                return self._send_json(400, {"error": "validation", "details": errs})
            data = load()
            payload["id"] = len(data)
            data.append(payload)
            save(data)
            return self._send_json(201, payload)

        if url.path == "/api/deploy":
            try:
                proc = subprocess.run(
                    [sys.executable, str(UPLOAD_SCRIPT), str(QUESTIONS)],
                    capture_output=True, text=True, cwd=str(ROOT), timeout=60,
                )
                return self._send_json(
                    200 if proc.returncode == 0 else 500,
                    {
                        "ok": proc.returncode == 0,
                        "stdout": proc.stdout,
                        "stderr": proc.stderr,
                    },
                )
            except subprocess.TimeoutExpired:
                return self._send_json(504, {"error": "upload timed out"})
            except Exception as e:
                return self._send_json(500, {"error": str(e)})

        return self._send_json(404, {"error": "not found"})

    def do_PUT(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/questions/"):
            try:
                qid = int(url.path.split("/")[-1])
            except ValueError:
                return self._send_json(400, {"error": "bad id"})
            payload = self._read_json()
            if not isinstance(payload, dict):
                return self._send_json(400, {"error": "expected a question object"})
            errs = validate(payload)
            if errs:
                return self._send_json(400, {"error": "validation", "details": errs})
            data = load()
            if not (0 <= qid < len(data)):
                return self._send_json(404, {"error": "not found"})
            payload["id"] = qid
            data[qid] = payload
            save(data)
            return self._send_json(200, payload)
        return self._send_json(404, {"error": "not found"})

    def do_DELETE(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/questions/"):
            try:
                qid = int(url.path.split("/")[-1])
            except ValueError:
                return self._send_json(400, {"error": "bad id"})
            data = load()
            if not (0 <= qid < len(data)):
                return self._send_json(404, {"error": "not found"})
            removed = data.pop(qid)
            save(data)
            return self._send_json(200, {"removed": removed})
        return self._send_json(404, {"error": "not found"})


def main():
    addr = ("127.0.0.1", 5175)
    print(f"manage server on http://{addr[0]}:{addr[1]}  (questions: {QUESTIONS.relative_to(ROOT)})")
    ThreadingHTTPServer(addr, Handler).serve_forever()


if __name__ == "__main__":
    main()
