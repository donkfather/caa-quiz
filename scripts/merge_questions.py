"""Merge extracted Class C + Class D extracts, dedup, and diff against the
existing questions.json. Surfaces conflicts loudly — never silently merges
contradictions.

Outputs:
  - merged.json   the deduped union, ready for review
  - report.md     human-readable summary: counts, intra-PDF dupes, cross-PDF
                  matches, conflicting answers, and matches against the
                  existing questions.json (so you can see what's new)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path


def norm(s: str) -> str:
    """Normalize for matching: strip accents, lowercase, collapse whitespace,
    remove trailing punctuation. Preserves enough character to keep two
    semantically-different questions distinct."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"\s+", " ", s).strip().lower()
    s = re.sub(r"[\s\.\,\;\:\?\!\"\'\(\)\[\]\-]+$", "", s)
    return s


def fingerprint(question: str, options: list[str]) -> tuple[str, frozenset[str]]:
    """Match key: normalized question + the unordered set of normalized options.
    The option order can differ between the two PDFs but the SAME question
    has the same option *set* — so use a frozenset, then we figure out the
    correct-index in the destination ordering separately."""
    return (norm(question), frozenset(norm(o) for o in options))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--c", required=True, type=Path)
    ap.add_argument("--d", required=True, type=Path)
    ap.add_argument("--existing", type=Path, default=None,
                    help="optional path to assets/questions.json for diff")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--report", required=True, type=Path)
    args = ap.parse_args()

    c = json.loads(args.c.read_text())["questions"]
    d = json.loads(args.d.read_text())["questions"]

    # 1. Intra-PDF duplicates --------------------------------------------------
    intra: dict[str, list[dict]] = {"C": [], "D": []}
    for label, src in (("C", c), ("D", d)):
        seen: dict[tuple, list[int]] = {}
        for q in src:
            fp = fingerprint(q["question"], q["options"])
            seen.setdefault(fp, []).append(q["source_id"])
        for fp, ids in seen.items():
            if len(ids) > 1:
                intra[label].append({"ids": ids, "question": fp[0][:80]})

    # 2. Cross-PDF matches + conflicts ----------------------------------------
    by_fp_c: dict[tuple, dict] = {fingerprint(q["question"], q["options"]): q for q in c}
    cross_matches = []
    cross_conflicts = []
    d_only = []
    for q in d:
        fp = fingerprint(q["question"], q["options"])
        cmatch = by_fp_c.get(fp)
        if cmatch is None:
            # Same question text but different option set?
            qnorm = fp[0]
            same_question_diff_options = next(
                (cq for cq in c if norm(cq["question"]) == qnorm), None)
            if same_question_diff_options:
                cross_conflicts.append({
                    "kind": "different option sets",
                    "c_id": same_question_diff_options["source_id"],
                    "d_id": q["source_id"],
                    "question": q["question"][:100],
                    "c_options": same_question_diff_options["options"],
                    "d_options": q["options"],
                })
            else:
                d_only.append(q)
            continue
        # Same fingerprint → check the marked-correct option matches
        c_correct_text = norm(cmatch["options"][cmatch["correct"]])
        d_correct_text = norm(q["options"][q["correct"]])
        if c_correct_text != d_correct_text:
            cross_conflicts.append({
                "kind": "different correct answer",
                "c_id": cmatch["source_id"], "d_id": q["source_id"],
                "question": q["question"][:100],
                "c_says": cmatch["options"][cmatch["correct"]],
                "d_says": q["options"][q["correct"]],
            })
            # Keep both to surface the conflict; do not silently merge.
            cross_matches.append({
                "c_id": cmatch["source_id"], "d_id": q["source_id"],
                "question": q["question"][:80], "conflict": True,
            })
        else:
            cross_matches.append({
                "c_id": cmatch["source_id"], "d_id": q["source_id"],
                "question": q["question"][:80], "conflict": False,
            })

    # 3. Build merged list -----------------------------------------------------
    # Strategy: every question keeps its source_id from its origin PDF.
    # Cross-matched questions (same fp, no conflict) get licenses=["C","D"]
    # and we use the C version as canonical (option ordering).
    seen_fps: set[tuple] = set()
    merged: list[dict] = []
    for q in c:
        fp = fingerprint(q["question"], q["options"])
        if fp in seen_fps:
            continue
        # Does it also exist in D without conflict?
        d_match = None
        for dq in d:
            if fingerprint(dq["question"], dq["options"]) != fp:
                continue
            if norm(q["options"][q["correct"]]) == norm(dq["options"][dq["correct"]]):
                d_match = dq
            break
        merged.append({
            "id": len(merged),
            "question": q["question"],
            "options": q["options"],
            "correct": q["correct"],
            "licenses": (["C", "D"] if d_match else ["C"]),
            "sources": [
                {"license": "C", "pdf_id": q["source_id"], "page": q["source_page"]},
            ] + ([{"license": "D", "pdf_id": d_match["source_id"],
                   "page": d_match["source_page"]}] if d_match else []),
        })
        seen_fps.add(fp)
    for q in d:
        fp = fingerprint(q["question"], q["options"])
        if fp in seen_fps:
            continue
        merged.append({
            "id": len(merged),
            "question": q["question"],
            "options": q["options"],
            "correct": q["correct"],
            "licenses": ["D"],
            "sources": [{"license": "D", "pdf_id": q["source_id"], "page": q["source_page"]}],
        })
        seen_fps.add(fp)

    # 4. Diff against existing JSON -------------------------------------------
    existing_match_count = 0
    existing_topic_overlap = 0
    new_count = 0
    if args.existing and args.existing.exists():
        existing = json.loads(args.existing.read_text())
        existing_fps = {
            fingerprint(eq["question"], eq["options"]): eq for eq in existing
        }
        for m in merged:
            fp = fingerprint(m["question"], m["options"])
            ex = existing_fps.get(fp)
            if ex:
                existing_match_count += 1
                # Cross-check correct answer
                if norm(ex["options"][ex["correct"]]) != norm(m["options"][m["correct"]]):
                    cross_conflicts.append({
                        "kind": "existing JSON disagrees on correct answer",
                        "existing_id": ex.get("id"),
                        "question": m["question"][:100],
                        "existing_says": ex["options"][ex["correct"]],
                        "pdf_says": m["options"][m["correct"]],
                    })
            else:
                new_count += 1

    # 5. Write output ---------------------------------------------------------
    args.out.write_text(json.dumps(merged, ensure_ascii=False, indent=2))

    lines = [
        "# Question extraction report\n",
        f"- Class C extracted: **{len(c)}**",
        f"- Class D extracted: **{len(d)}**",
        f"- Merged unique:    **{len(merged)}**",
        f"- Cross-PDF identical (same Q + same A + same correct): "
        f"**{sum(1 for m in cross_matches if not m['conflict'])}**",
        f"- Cross-PDF conflicts: **{len(cross_conflicts)}**\n",
    ]
    if args.existing:
        lines += [
            f"## vs existing assets/questions.json",
            f"- already in JSON: **{existing_match_count}**",
            f"- new (would be added): **{new_count}**\n",
        ]

    if intra["C"] or intra["D"]:
        lines.append("## Within-PDF duplicates")
        for label in ("C", "D"):
            for d_ in intra[label]:
                lines.append(f"- {label} ids {d_['ids']}: {d_['question']!r}")
        lines.append("")

    if cross_conflicts:
        lines.append("## ⚠️  Conflicts (manual review required)")
        for cf in cross_conflicts:
            lines.append(f"- [{cf['kind']}] {cf.get('question','')!r}")
            for k, v in cf.items():
                if k in ("kind", "question"):
                    continue
                lines.append(f"    - {k}: {v}")
        lines.append("")

    args.report.write_text("\n".join(lines))

    print(f"merged → {args.out} ({len(merged)} questions)")
    print(f"report → {args.report}")
    print(f"conflicts: {len(cross_conflicts)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
