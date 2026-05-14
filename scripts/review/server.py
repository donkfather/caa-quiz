"""Tiny stdlib HTTP server for the question-review UI.

Endpoints:
  GET  /                  → index.html
  GET  /api/conflicts     → list of conflicts (read-only)
  GET  /api/decisions     → current decisions
  POST /api/decide        → save a decision
  POST /api/finalize      → write final_questions.json based on decisions

Run:
    python3 scripts/review/server.py
Then open http://localhost:5174
"""

from __future__ import annotations

import json
import re
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
DATA = HERE / "data"
CONFLICTS = DATA / "conflicts.json"
DECISIONS = DATA / "decisions.json"
FINAL = DATA / "final_questions.json"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", s).strip().lower()


def load_decisions() -> dict:
    if DECISIONS.exists():
        return json.loads(DECISIONS.read_text())
    return {}


def save_decisions(d: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    DECISIONS.write_text(json.dumps(d, ensure_ascii=False, indent=2))


def _opt_fp(options: list[str]) -> frozenset[str]:
    return frozenset(norm(o) for o in options)


def finalize() -> dict:
    """Build final_questions.json from the decisions.

    For option_set / correct_answer conflicts, the merged list initially
    contains BOTH versions (different option fingerprints → not deduped at
    merge time). The decision tells us what to do with that pair:

      choice = 0|1|2 → keep only the chosen card; remove the others from
                       the merged list (no orphan duplicates).
      choice = "both" → keep all card versions (different real questions
                        that happened to share the same wording).
      choice = "skip" → leave merged unchanged (treat as undecided).

    For existing_disagrees conflicts, the existing JSON answer is the only
    "loser" candidate — it's not in the merged list anyway — so picking a
    card just overwrites the merged record.
    """
    decisions = load_decisions()
    conflicts = json.loads(CONFLICTS.read_text())
    by_id = {c["id"]: c for c in conflicts}
    merged = json.loads(Path("/tmp/merged.json").read_text())
    existing = json.loads((ROOT / "assets" / "questions.json").read_text())

    # Index the merged list by (qnorm, opts_fp) so we can find the exact
    # record for any given card and delete it cleanly.
    def key_of(q):
        return (norm(q["question"]), _opt_fp(q["options"]))

    applied = 0
    kept_both = 0
    skipped = 0
    deletions: set[tuple] = set()

    for cid, dec in decisions.items():
        cf = by_id.get(cid)
        if cf is None:
            continue
        choice = dec.get("choice")

        if choice == "skip":
            skipped += 1
            continue

        if choice == "both":
            kept_both += 1
            continue

        edited = dec.get("edited")
        if edited:
            chosen = edited
        elif isinstance(choice, int):
            chosen = cf["cards"][choice]
        else:
            continue

        # For each "pdf" card in this conflict that the user did NOT pick,
        # mark its record in `merged` for deletion. The chosen card's record
        # gets overwritten in place (with edits, if any).
        chosen_key = (norm(chosen["question"]), _opt_fp(chosen["options"]))
        for i, c_card in enumerate(cf["cards"]):
            if c_card.get("source") != "pdf":
                continue
            cand_key = (norm(c_card["question"]), _opt_fp(c_card["options"]))
            if cand_key == chosen_key:
                continue
            deletions.add(cand_key)

        # Find target record (chosen card) in merged. If the user edited
        # the question/options, the original key may differ — fall back to
        # the original card's key when looking up.
        lookup_keys = [chosen_key]
        if edited and isinstance(choice, int):
            orig = cf["cards"][choice]
            lookup_keys.append((norm(orig["question"]), _opt_fp(orig["options"])))
        target = None
        for k in lookup_keys:
            for m in merged:
                if key_of(m) == k:
                    target = m
                    break
            if target:
                break
        if target is None:
            # Question wasn't in merged (rare: existing-only). Skip silently.
            continue
        target["question"] = chosen["question"]
        target["options"] = chosen["options"]
        target["correct"] = chosen["correct"]
        applied += 1

    if deletions:
        merged = [m for m in merged if key_of(m) not in deletions]

    for i, m in enumerate(merged):
        m["id"] = i

    DATA.mkdir(parents=True, exist_ok=True)
    FINAL.write_text(json.dumps(merged, ensure_ascii=False, indent=2))
    return {
        "applied": applied,
        "kept_both": kept_both,
        "skipped": skipped,
        "deleted_loser_records": len(deletions),
        "decided": len(decisions),
        "total_conflicts": len(conflicts),
        "final_count": len(merged),
        "existing_count": len(existing),
        "wrote": str(FINAL),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence default request log spam
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

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/" or url.path == "/index.html":
            return self._send_file(HERE / "index.html", "text/html; charset=utf-8")
        if url.path == "/api/conflicts":
            return self._send_json(200, json.loads(CONFLICTS.read_text()))
        if url.path == "/api/decisions":
            return self._send_json(200, load_decisions())
        return self._send_json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "invalid json"})

        if url.path == "/api/decide":
            cid = payload.get("conflict_id")
            if not cid:
                return self._send_json(400, {"error": "missing conflict_id"})
            d = load_decisions()
            if payload.get("choice") is None:
                d.pop(cid, None)
            else:
                d[cid] = payload
            save_decisions(d)
            return self._send_json(200, {"ok": True, "total": len(d)})

        if url.path == "/api/finalize":
            return self._send_json(200, finalize())

        return self._send_json(404, {"error": "not found"})


def main():
    addr = ("127.0.0.1", 5174)
    print(f"review server on http://{addr[0]}:{addr[1]}")
    ThreadingHTTPServer(addr, Handler).serve_forever()


if __name__ == "__main__":
    main()
