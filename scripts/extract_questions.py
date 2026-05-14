"""Extract Romanian boating-license exam questions from the official PDFs.

The PDFs are clean tables:
  | # | Întrebare | Răspuns 1 | Corect 1 | Răspuns 2 | Corect 2 | Răspuns 3 | Corect 3 |
where Corect N is 0 or 1. The answer→correctness mapping is positional (the
flag sits right next to its answer column), which is what makes this much
safer than scraping bullet points from prose.

Usage:
    python3 scripts/extract_questions.py --pdf <path> --license C --start 1 --end 2 --out -
    python3 scripts/extract_questions.py --pdf <path> --license D --out d.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

import pdfplumber


# Header-cell variants we accept (the first row of each page sometimes
# differs in casing / spacing). Used to detect & skip header rows.
HEADER_HINTS = {"intrebare", "raspuns", "corect", "răspuns", "întrebare"}


def _norm(s: str) -> str:
    """Lowercase + strip accents + collapse whitespace."""
    s = unicodedata.normalize("NFKD", s)
    s = s.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", s).strip().lower()


def _is_header_row(row: list[str | None]) -> bool:
    head = _norm(" ".join(c or "" for c in row))
    return any(h in head for h in HEADER_HINTS) and "1" not in head[-3:]


def _clean_text(s: str | None) -> str:
    if s is None:
        return ""
    # PDFs sometimes split lines mid-word; collapse internal whitespace.
    return re.sub(r"\s+", " ", s).strip()


def _coerce_correct(cell: str | None) -> int | None:
    if cell is None:
        return None
    c = cell.strip()
    if c == "1":
        return 1
    if c == "0":
        return 0
    return None


def extract_pdf(pdf_path: Path, license_code: str) -> tuple[list[dict], list[dict]]:
    """Returns (questions, problems).

    `problems` is a list of {page, row_id, reason, raw_row} for any row
    that fails validation — never silently dropped.
    """
    questions: list[dict] = []
    problems: list[dict] = []

    with pdfplumber.open(pdf_path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables()
            for table in tables:
                for row in table:
                    if not row or all(c is None or not c.strip() for c in row):
                        continue
                    # Expected shape: 8 columns
                    # 0: id, 1: question, 2: ans1, 3: ok1, 4: ans2, 5: ok2, 6: ans3, 7: ok3
                    if len(row) < 8:
                        problems.append({
                            "page": page_no, "reason": "row has <8 columns",
                            "raw_row": row,
                        })
                        continue

                    if _is_header_row(row):
                        continue

                    raw_id, q, a1, c1, a2, c2, a3, c3 = (
                        row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]
                    )

                    rid = _clean_text(raw_id)
                    if not rid.isdigit():
                        # Some pages have an empty first column on continuation rows.
                        problems.append({
                            "page": page_no, "reason": f"non-numeric id {rid!r}",
                            "raw_row": row,
                        })
                        continue

                    question = _clean_text(q)
                    options = [_clean_text(a1), _clean_text(a2), _clean_text(a3)]
                    flags = [_coerce_correct(c1), _coerce_correct(c2), _coerce_correct(c3)]

                    if not question:
                        problems.append({"page": page_no, "row_id": rid,
                                         "reason": "empty question", "raw_row": row})
                        continue
                    if any(not o for o in options):
                        problems.append({"page": page_no, "row_id": rid,
                                         "reason": "empty option(s)", "raw_row": row})
                        continue

                    # Soft auto-fill: if exactly one flag is 1 and the rest are
                    # 0 or empty (None), treat empty as 0. This handles the
                    # very common scribal omission of a "0" in the source PDF.
                    # Anything more ambiguous (multiple 1s, all empty, etc.)
                    # falls through to the strict check below and gets flagged.
                    if flags.count(1) == 1 and all(f in (0, 1, None) for f in flags):
                        flags = [0 if f is None else f for f in flags]

                    if any(f is None for f in flags):
                        problems.append({"page": page_no, "row_id": rid,
                                         "reason": "non-binary correct flag",
                                         "raw_row": row})
                        continue

                    correct_indexes = [i for i, f in enumerate(flags) if f == 1]
                    if len(correct_indexes) != 1:
                        problems.append({"page": page_no, "row_id": rid,
                                         "reason": f"expected 1 correct, got {len(correct_indexes)}",
                                         "raw_row": row})
                        continue
                    # We rejected `f is None` earlier, so if we got here, all
                    # three flags parsed cleanly to 0/1 with exactly one 1.
                    # (The auto-fill case is handled in `_coerce_correct`.)

                    questions.append({
                        "source_id": int(rid),
                        "source_page": page_no,
                        "license": license_code,
                        "question": question,
                        "options": options,
                        "correct": correct_indexes[0],
                    })

    return questions, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, type=Path)
    ap.add_argument("--license", required=True, choices=["C", "D"])
    ap.add_argument("--out", required=True, help="path or '-' for stdout")
    ap.add_argument("--limit", type=int, default=None, help="cap rows for dry run")
    args = ap.parse_args()

    questions, problems = extract_pdf(args.pdf, args.license)
    if args.limit is not None:
        questions = questions[: args.limit]

    payload = {
        "license": args.license,
        "source_pdf": str(args.pdf),
        "extracted": len(questions),
        "problems_count": len(problems),
        "questions": questions,
        "problems": problems,
    }

    if args.out == "-":
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        print(f"wrote {len(questions)} questions, {len(problems)} problems → {args.out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
