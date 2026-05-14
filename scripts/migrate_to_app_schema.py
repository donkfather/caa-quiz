"""Reshape `final_questions.json` into the app's schema (with topics).

Input  : scripts/review/data/final_questions.json
         {id, question, options, correct, licenses[], sources[]}

Output : assets/questions.json
         {id, question, options, correct, topic, license[]}

Topic resolution per question:
  1. Exact match (question + options set) against the previous bundled JSON
     → carry topic over.
  2. Question-text-only match → carry topic.
  3. Keyword classifier on (question + options) text → best-scoring topic.
  4. Tie / no match → fall back to "seamanship" (the most populous bucket)
     and emit a warning so it can be hand-reviewed.

Reports:
  - per-topic counts in the new file
  - per-topic counts of fallback-classified entries
  - count of brand-new questions (not in the prior bundle)
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "scripts" / "review" / "data" / "final_questions.json"
DST = ROOT / "assets" / "questions.json"
PREV = DST  # we read from DST first, then overwrite — cache it

VALID_TOPICS = {"colreg", "navigation", "seamanship", "maneuvering", "first_aid", "law"}

# Romanian-language keyword classifier. Order matters when scores tie:
# topics earlier in the list win, so put the most-specific first.
TOPIC_PATTERNS = [
    # `law` — Romanian Danube Regulation (R.N.D.) and related river-navigation rules
    ("law", [
        r"\bR\.?N\.?D\.?\b", r"\bR\.\s*N\.\s*D\b",
        r"regulamentul\s+navig", r"\bfluvi", r"\bDun[aă]r",
        r"tariful", r"c[aă]pit[aă]nia\s+portului", r"infrac[tț]iun",
        r"amend[aă]", r"sanc[tț]iun", r"contraven[tț]",
        r"navigaț(?:i[ai]?|ie)\s+interioar",
        r"c[aă]i\s+navigabile", r"calea\s+navigabil",
        r"port(?:uar|ului)?", r"\barticolul\s+\d+", r"\bart\.\s*\d+",
        r"convoi(?:ul)?\s+remorca", r"convoi\s+(?:împins|impins)",
        r"convoiului", r"navelor\s+remorcate",
        r"\bamonte\b", r"\baval\b",
        r"\bsta[tț]ionare\b",
        r"școndr", r"scondr", r"\bjalo", r"geamandur", r"aliniament",
        r"trecer(?:i|ile)\s+(?:îngust|ingust)",
        r"unelte\s+de\s+pescuit", r"plase\s+de\s+pescuit",
        r"unităților\s+(?:unui\s+)?convoi",
        r"sunet\s+(?:lung|scurt|foarte\s+scurt)",
        r"serie\s+de\s+sunete", r"b[aă]t[aă]i\s+de\s+clopot",
        r"semnal(?:e|ul)?\s+fonic", r"semnale\s+sonore",
        r"intervalul\s+între\s+sunete",
        r"durata\s+unui\s+sunet",
        r"\bbordul?\s+liber\b", r"sc[aă]ri\s+de\s+pescaj", r"\bpescaj(?:ul)?\b",
    ]),
    # `first_aid` — emergency response, body care
    ("first_aid", [
        r"prim\s+ajutor", r"resuscit", r"hipotermie", r"\bînec\b",
        r"respirați", r"puls(?:ul)?", r"masaj\s+cardi", r"cardio.respit",
        r"fractur", r"hemoragi", r"victim", r"v[aă]rsa\s+sângele",
        r"imobiliz", r"atele", r"clavicul", r"cardio.respirator",
    ]),
    # `colreg` — international collision-avoidance rules + maritime lights/signals
    ("colreg", [
        r"\bColreg\b", r"\b1972\b", r"colizi",
        r"\blumin[aăăi]\b", r"lumin(?:a|i|ile|ilor)\s",
        r"lumin[aă]\s+(?:alb|roșie|verde|galben|fixă|de)",
        r"\blumin[aă]\s+vizibil", r"intensitatea\s+(?:și|si|şi)\s+arcul",
        r"semnal(?:e|ele)?\s+luminoas", r"semn(?:e|ele)\s+aprobate",
        r"radiocomunicaț", r"SART", r"EPIRB",
        r"veghe[a]?", r"viteza?\s+de\s+siguranț", r"vedere\s+recipro",
        r"nav[aă]\s+privilegiat", r"schimbare\s+de\s+drum",
        r"manevra?\s+de\s+evitare", r"drum\s+opus", r"depă[sș]ire",
        r"prevederile\s+regulamentului", r"prevederile\s+Colreg",
        r"schem[aă]\s+de\s+separar", r"benzi(?:le)?\s+de\s+separa[tț]i",
        r"band[aă]\s+de\s+navigaț", r"direcția\s+general[aă]\s+a\s+traficului",
        r"întretai", r"intretai",
        r"orizont(?:ul)?", r"întreg\s+orizontul",
        r"semnal(?:ele|ul)\s+SART",
        r"vizibilitate\s+redus", r"semnal(?:e|ele)?\s+prescris",
        r"semnaliz(?:are|area|ării)", r"semnalizar[ei]\s+prev[aă]zut",
        r"emite\s+semnal", r"sunet[ei]\s+prescris",
        r"nav[aă]?\s+(?:cu\s+vele|cu\s+motor)", r"folosind.*\s+motor",
    ]),
    # `navigation` — charts, position, instruments, water characteristics
    ("navigation", [
        r"poli[ii]?\s+geografic", r"meridian", r"paralel(?:a|ul|ele)",
        r"ecuator", r"\bnord\b", r"\bsud\b",
        r"\bcompas(?:ul)?\b", r"\bhart[aă]", r"latitudine", r"longitud",
        r"drum\s+(?:compas|adev[aă]rat|magnetic)",
        r"cap\s+(?:compas|adev[aă]rat)",
        r"punct\s+nautic", r"poziți[ai]\s+navei",
        r"baliz", r"marcaj(?:e|ul)?", r"IALA",
        r"regiunea\s+[AB]", r"\bfar\b", r"izofaz",
        r"adâncim", r"\bsond[aă]\b", r"sonde\b",
        r"temperatura\s+apei", r"presiunea\s+atmosferic",
        r"vânt(?:ul)?\s+bate", r"\bizobat",
        r"viteza\s+(?:unei\s+)?ambarcați",
        r"m[aă]suratori\s+de", r"m[aă]surare\s+(?:a\s+)?distanței",
        r"indicat(?:or|orul)\s+(?:înclinării|de\s+drum)",
    ]),
    # `maneuvering` — boat handling, propulsion, locks, docking
    ("maneuvering", [
        r"\bcârm[aă]?\b", r"\bcarm[aă]?\b", r"\belic[eaă]?\b", r"propulsi",
        r"acostar", r"\beclu[zs]", r"camer(?:a|ele)\s+ecluz", r"ecluzelor",
        r"ecluzar", r"ordinea\s+ecluz",
        r"barc[ai]?\s+de\s+mare\s+vitez",
        r"\bRPM\b", r"rota[tț]ii?\s+pe\s+minut",
        r"deplasar[ei]\s+(?:înainte|înapoi|inainte|inapoi)",
        r"mar[șs]\s+(?:înainte|înapoi)", r"pupa\s+(?:este|intr[aă])",
        r"prov[aă]\s+(?:este|intr[aă])",
        r"balon(?:ae|e)?\s*(?:de\s*acostare)?",
        r"tranchet", r"fender",
        r"viraj", r"manevr(?:ă|a|are)", r"asiet[ăa]",
        r"v[aâ]nt", r"\bvant",
        r"motor\s+înclinat", r"înclina[tț]i\s+motorul",
        r"motovehicul(?:e|ele)\s+nautic", r"skyjet",
        r"schi(?:ul)?\s+nautic", r"sk[iy]\s+nautic",
        r"vitez[aei]\s+(?:de\s+deplasare|este\s+mai\s+mare)",
        r"cablu\s+împinge.tr[ae]g[ae]", r"cablu\s+impinge",
        r"pas(?:ul)?\s+elicei", r"barc[aă]\s+(?:devine|este)\s+instabil",
        r"hidrofoil", r"plan\s+pe\s+ap[aă]",
        r"depășir(?:i|ile)?", r"întâlnir(?:i|ile)?",
        r"tipul\s+cocii", r"forma\s+cocii", r"\bcoca\b", r"\bcoci",
        r"barc[aă]\s+de\s+mare\s+vitez", r"vitez[aă]\s+a?\s*b[aă]rcii",
        r"emisie.recepți", r"emisie\s*-?\s*recepț",
        r"barc[aă]\s+devine", r"barc[aă]\s+(?:este|nu)\s+stabil",
    ]),
    # `seamanship` — rope work, ship parts, equipment, anchors
    ("seamanship", [
        r"par[âaăa]m[ăa]?", r"\bparame?\b",
        r"\bancor", r"\blanț", r"\blant",
        r"saul[aă]", r"merlin", r"lusin", r"garlin", r"grandee",
        r"sizal", r"câne[p][aă]?", r"canep[aă]?", r"iut[aă]",
        r"vinc(?:i|iul)", r"cabestan",
        r"babal[ae]?", r"tachet", r"turnichet", r"macara(?:le)?",
        r"vest[ae]\s+de\s+salvare", r"colac\s+de\s+salvare",
        r"barc[aă]\s+de\s+salvare", r"mijloac(?:e|ele)\s+de\s+salvare",
        r"echipament", r"inventar(?:ul)?\s+b[aă]rcii",
        r"\barmament\b",
        r"\bchil[aă]\b", r"\bbordaj", r"învelișul", r"învelișului",
        r"\betambou", r"etamb[ou][ru]", r"\betrav[aă]",
        r"\bbabord\b", r"\btribord\b", r"\bprov[aă]\b", r"\bpup[aă]\b",
        r"diamantul", r"furcheț", r"furchet",
        r"osatur[aă]", r"file(?:le)?", r"file\s+(?:l[aă]crimare)?",
        r"file\s+l[aă]crimar", r"tambuchi", r"puntir",
        r"nodul\s+(?:de\s+)?(?:shela|gât|tachelaj)",
        r"observator(?:ul)?\s+care\s+st[aă]\s+pe\s+puntea",
        r"\bdam[aă]\b",
    ]),
]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", s).strip().lower()


def _ascii_fold(s: str) -> str:
    """Strip diacritics so `ț` (comma-below) and `ţ` (cedilla) — visually
    identical but distinct codepoints — match the same patterns."""
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")


def classify_topic(question: str, options: list[str]) -> tuple[str, int]:
    """Score against each topic, return (best_topic, score). 0 score = no signal.

    Patterns are written in ASCII; both the input text and the patterns get
    diacritic-stripped before matching so we don't need `[ațț]` everywhere.
    """
    blob = _ascii_fold(" ".join([question] + options))
    scores: list[tuple[str, int]] = []
    for topic, patterns in TOPIC_PATTERNS:
        score = 0
        for p in patterns:
            folded = _ascii_fold(p)
            score += len(re.findall(folded, blob, re.IGNORECASE))
        scores.append((topic, score))
    scores.sort(key=lambda t: t[1], reverse=True)
    if scores[0][1] == 0:
        return ("seamanship", 0)  # most populous fallback
    return scores[0]


def main() -> int:
    revised = json.loads(SRC.read_text())
    prev = json.loads(PREV.read_text()) if PREV.exists() else []

    # Build lookup tables on the previous bundle
    prev_by_fp: dict[tuple[str, frozenset[str]], dict] = {}
    prev_by_qnorm: dict[str, dict] = {}
    for q in prev:
        fp = (norm(q["question"]), frozenset(norm(o) for o in q["options"]))
        prev_by_fp[fp] = q
        # Keep first match by qnorm
        prev_by_qnorm.setdefault(norm(q["question"]), q)

    out: list[dict] = []
    src_counter = Counter()  # how the topic was resolved
    topic_counter = Counter()  # final topic distribution
    fallback_examples: list[str] = []

    for r in revised:
        fp = (norm(r["question"]), frozenset(norm(o) for o in r["options"]))
        topic = None
        match = prev_by_fp.get(fp)
        if match and match.get("topic") in VALID_TOPICS:
            topic = match["topic"]
            src_counter["fp_match"] += 1
        else:
            match2 = prev_by_qnorm.get(norm(r["question"]))
            if match2 and match2.get("topic") in VALID_TOPICS:
                topic = match2["topic"]
                src_counter["qtext_match"] += 1
            else:
                topic, score = classify_topic(r["question"], r["options"])
                src_counter[f"classifier_{score=}".replace("score=", "s=")] += 1 if score else 0
                src_counter["classifier_fallback"] += 1 if score == 0 else 0
                if score == 0:
                    fallback_examples.append(r["question"])

        # Schema convert
        out.append({
            "id": r["id"],
            "question": r["question"],
            "options": r["options"],
            "correct": r["correct"],
            "topic": topic,
            "license": list(r.get("licenses", r.get("license", []))),
        })
        topic_counter[topic] += 1

    DST.write_text(json.dumps(out, ensure_ascii=False, indent=2))

    print(f"wrote {len(out)} questions → {DST.relative_to(ROOT)}")
    print()
    print("Topic resolution:")
    for k, v in sorted(src_counter.items()):
        print(f"  {k:<26} {v}")
    print()
    print("Topic distribution (final):")
    for t in ["colreg", "navigation", "seamanship", "maneuvering", "law", "first_aid"]:
        print(f"  {t:<14} {topic_counter[t]}")
    if fallback_examples:
        print()
        print(f"Fallback (defaulted to 'seamanship', no keywords matched) — first {min(8, len(fallback_examples))}:")
        for q in fallback_examples[:8]:
            print(f"  - {q[:90]}")
        if len(fallback_examples) > 8:
            print(f"  … and {len(fallback_examples) - 8} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
