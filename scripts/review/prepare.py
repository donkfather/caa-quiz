"""Build a conflicts.json that the review UI consumes.

Pulls from the per-PDF extracts + the existing questions.json. Each conflict
gets a stable hash-based id so decisions persist across re-runs.

Conflict shapes:
  - option_set         C and D have same normalized question but different option text
  - correct_answer     C and D have same question + same option set, disagree on correct
  - existing_disagrees the merged PDFs disagree with assets/questions.json on which
                       option is correct

The review UI gets full candidate cards (question, options, correct index, source
label) for each side so the user can compare without flipping back to a PDF.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).parent / "data"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"\s+", " ", s).strip().lower()
    return re.sub(r"[\s\.\,\;\:\?\!\"\'\(\)\[\]\-]+$", "", s)


def fp(question: str, options: list[str]) -> tuple[str, frozenset[str]]:
    return (norm(question), frozenset(norm(o) for o in options))


def cid(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:12]


def card(label: str, source: str, q: dict) -> dict:
    return {
        "label": label,
        "source": source,
        "question": q["question"],
        "options": q["options"],
        "correct": q["correct"],
        "ref": {
            "license": q.get("license"),
            "pdf_id": q.get("source_id"),
            "page": q.get("source_page"),
            "existing_id": q.get("id"),
            "topic": q.get("topic"),
        },
    }


def main() -> int:
    c = json.loads(Path("/tmp/qc.json").read_text())["questions"]
    d = json.loads(Path("/tmp/qd.json").read_text())["questions"]
    existing = json.loads((ROOT / "assets" / "questions.json").read_text())

    by_fp_c = {fp(q["question"], q["options"]): q for q in c}
    by_qnorm_c = {norm(q["question"]): q for q in c}
    by_fp_existing = {fp(q["question"], q["options"]): q for q in existing}
    by_qnorm_existing: dict[str, dict] = {}
    for q in existing:
        by_qnorm_existing.setdefault(norm(q["question"]), q)

    conflicts: list[dict] = []

    # 1. C-vs-D conflicts -----------------------------------------------------
    for q in d:
        f = fp(q["question"], q["options"])
        cmatch_full = by_fp_c.get(f)
        cmatch_qonly = by_qnorm_c.get(f[0])
        if cmatch_full is not None:
            # Same option set — only conflict if correct flag differs
            if norm(cmatch_full["options"][cmatch_full["correct"]]) != norm(
                q["options"][q["correct"]]
            ):
                ex = by_fp_existing.get(f) or by_qnorm_existing.get(f[0])
                conflicts.append({
                    "id": cid("ccorrect", str(cmatch_full["source_id"]), str(q["source_id"])),
                    "kind": "correct_answer",
                    "title": q["question"],
                    "cards": [
                        card("Class C", "pdf", cmatch_full),
                        card("Class D", "pdf", q),
                    ] + ([card("Existing JSON", "existing", ex)] if ex else []),
                })
        elif cmatch_qonly is not None:
            # Same question, different option set
            ex = by_qnorm_existing.get(f[0])
            conflicts.append({
                "id": cid("opts", str(cmatch_qonly["source_id"]), str(q["source_id"])),
                "kind": "option_set",
                "title": q["question"],
                "cards": [
                    card("Class C", "pdf", cmatch_qonly),
                    card("Class D", "pdf", q),
                ] + ([card("Existing JSON", "existing", ex)] if ex else []),
            })

    # 2. Existing-JSON disagreements ------------------------------------------
    # Iterate over the merged set: any question whose fingerprint matches an
    # existing entry but whose correct answer text differs.
    pdf_pool = c + d
    by_fp_pdf: dict[tuple, dict] = {}
    for q in pdf_pool:
        by_fp_pdf.setdefault(fp(q["question"], q["options"]), q)

    seen_existing_ids: set[int] = set()
    for q in pdf_pool:
        f = fp(q["question"], q["options"])
        ex = by_fp_existing.get(f)
        if ex is None or ex.get("id") in seen_existing_ids:
            continue
        if norm(ex["options"][ex["correct"]]) != norm(q["options"][q["correct"]]):
            seen_existing_ids.add(ex["id"])
            other_pdf_card = None
            if q in c:
                # If D also has this question, surface its answer too
                d_match = next((x for x in d if fp(x["question"], x["options"]) == f), None)
                if d_match:
                    other_pdf_card = card("Class D", "pdf", d_match)
            else:
                c_match = next((x for x in c if fp(x["question"], x["options"]) == f), None)
                if c_match:
                    other_pdf_card = card("Class C", "pdf", c_match)
            conflicts.append({
                "id": cid("existing", str(ex["id"])),
                "kind": "existing_disagrees",
                "title": q["question"],
                "cards": [
                    card(f"Class {q.get('license')}", "pdf", q),
                ] + ([other_pdf_card] if other_pdf_card else []) + [
                    card("Existing JSON", "existing", ex),
                ],
            })

    # Stable order: existing-disagrees first (most critical), then correct_answer,
    # then option_set, then alphabetical by title within each group.
    rank = {"existing_disagrees": 0, "correct_answer": 1, "option_set": 2}
    conflicts.sort(key=lambda c: (rank[c["kind"]], c["title"].lower()))

    DATA.mkdir(exist_ok=True, parents=True)
    (DATA / "conflicts.json").write_text(
        json.dumps(conflicts, ensure_ascii=False, indent=2)
    )
    print(f"wrote {len(conflicts)} conflicts → {DATA / 'conflicts.json'}")
    counts: dict[str, int] = {}
    for c_ in conflicts:
        counts[c_["kind"]] = counts.get(c_["kind"], 0) + 1
    for k, v in counts.items():
        print(f"  {k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
