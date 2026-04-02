#!/usr/bin/env python3
"""
CAA Quiz Learning Course Builder
Parses the Seanergya Manual CD PDF + RNA official questions
into structured JSON for the app's learning section.
"""
import fitz
import json
import os
import re

BASE = os.path.expanduser("~/projects/caa-quiz/src/data/course")
IMG_BASE = os.path.join(BASE, "images")
MANUAL_PDF = "/tmp/manual_cd.pdf"
QUESTIONS_PDF = "/tmp/questions_c.pdf"

os.makedirs(BASE, exist_ok=True)

# ─── STEP 1: Parse official questions ────────────────────────────

def parse_questions(pdf_path):
    doc = fitz.open(pdf_path)
    full_lines = []
    for i in range(doc.page_count):
        text = doc[i].get_text()
        for line in text.split("\n"):
            s = line.strip()
            if s:
                full_lines.append(s)
    doc.close()

    # Skip header row
    start = 0
    for idx, l in enumerate(full_lines):
        if l == "1" and idx > 3:
            start = idx
            break

    questions = []
    i = start
    while i < len(full_lines):
        line = full_lines[i]

        # Question number: a standalone integer, followed by non-0/1 text
        if re.match(r'^\d+$', line) and int(line) > 0:
            num = int(line)
            # Check if next line is question text (not 0 or 1)
            if i + 1 < len(full_lines) and full_lines[i + 1] not in ("0", "1"):
                # Could be a question number OR part of an option
                # It's a question number if num == len(questions) + 1 (sequential)
                if num == len(questions) + 1:
                    i += 1
                    # Gather question text until we hit an option (line before a 0 or 1)
                    q_lines = []
                    while i < len(full_lines):
                        # Look ahead: if current line is text and next is 0/1, this is first option
                        if i + 1 < len(full_lines) and full_lines[i + 1] in ("0", "1"):
                            # Check if we already have question text
                            if q_lines:
                                # This line starts the first option
                                break
                            else:
                                q_lines.append(full_lines[i])
                                i += 1
                        elif full_lines[i] in ("0", "1"):
                            break
                        else:
                            q_lines.append(full_lines[i])
                            i += 1

                    q_text = " ".join(q_lines)

                    # Now gather options
                    options = []
                    correct = 0
                    opt_lines = []
                    while i < len(full_lines):
                        if full_lines[i] in ("0", "1"):
                            flag = int(full_lines[i])
                            opt_text = " ".join(opt_lines).strip()
                            if opt_text:
                                if flag == 1:
                                    correct = len(options)
                                options.append(opt_text)
                            opt_lines = []
                            i += 1
                            # Check if next is a new question number
                            if i < len(full_lines) and re.match(r'^\d+$', full_lines[i]):
                                peek_num = int(full_lines[i])
                                if peek_num == len(questions) + 2:
                                    break
                        else:
                            opt_lines.append(full_lines[i])
                            i += 1

                    if q_text and len(options) >= 2:
                        questions.append({
                            "id": num,
                            "question": q_text,
                            "options": options,
                            "correct": correct
                        })
                    continue

        i += 1

    return questions

# ─── STEP 2: Extract module content ──────────────────────────────

MODULES_DEF = [
    {
        "id": "m1", "title": "Notiuni introductive",
        "desc": "Introducere in navigatie: istoric si terminologie marinareasca.",
        "pages": (5, 14),
        "sections": [
            {"title": "Istoric", "start_marker": "1. Istoric", "pages": (6, 6)},
            {"title": "Terminologie. Vocabular", "start_marker": "2. Terminologie", "pages": (6, 14)},
        ]
    },
    {
        "id": "m2", "title": "Constructia navei cu motor",
        "desc": "Tipuri de nave, elemente de constructie, calitati nautice si greement.",
        "pages": (15, 24),
        "sections": [
            {"title": "Tipuri de nave. Clasificare", "start_marker": "1. Tipuri", "pages": (16, 16)},
            {"title": "Elemente de constructie a navei", "start_marker": "2. Elemente", "pages": (16, 18)},
            {"title": "Calitatile nautice si manevriere", "start_marker": "3. Calitatile", "pages": (19, 20)},
            {"title": "Greementul navei", "start_marker": "4. Greementul", "pages": (21, 22)},
        ]
    },
    {
        "id": "m3", "title": "Marinarie",
        "desc": "Parame, accesorii de punte, ancore, noduri marinaresti.",
        "pages": (25, 42),
        "sections": [
            {"title": "Parame", "start_marker": "1. Parame", "pages": (26, 28)},
            {"title": "Accesorii de punte", "start_marker": "2. Accesorii", "pages": (29, 30)},
            {"title": "Ancore", "start_marker": "3. Ancore", "pages": (31, 31)},
            {"title": "Instalatia de ancorare", "start_marker": "4. Instalatia de ancorare", "pages": (32, 32)},
            {"title": "Instalatia de carma", "start_marker": "5. Instalatia de carma", "pages": (32, 32)},
            {"title": "Noduri. Matelotaj", "start_marker": "6. Noduri", "pages": (32, 39)},
        ]
    },
    {
        "id": "m4", "title": "Meteorologie",
        "desc": "Temperatura, presiune, vant, fronturi, precipitatii, ceata si nori.",
        "pages": (43, 52),
        "sections": [
            {"title": "Temperatura aerului", "start_marker": "1. Temperatura", "pages": (44, 44)},
            {"title": "Presiunea atmosferica", "start_marker": "2. Presiunea", "pages": (44, 44)},
            {"title": "Vantul", "start_marker": "3. Vantul", "pages": (44, 45)},
            {"title": "Precipitatiile", "start_marker": "4. Precipitatiile", "pages": (46, 46)},
            {"title": "Ceata", "start_marker": "5. Cea", "pages": (46, 46)},
            {"title": "Norii. Semne de vreme", "start_marker": "6. Norii", "pages": (46, 48)},
        ]
    },
    {
        "id": "m5", "title": "Comunicatii",
        "desc": "Apeluri radio, disciplina comunicatiilor, echipamente VHF/AIS, GMDSS.",
        "pages": (53, 62),
        "sections": [
            {"title": "Apeluri", "start_marker": "1. Apeluri", "pages": (54, 55)},
            {"title": "Disciplina comunicatiilor", "start_marker": "2. Disciplina", "pages": (55, 55)},
            {"title": "Echipamente", "start_marker": "3. Echipamente", "pages": (55, 56)},
            {"title": "Sistemul GMDSS", "start_marker": "4. Sistemul", "pages": (56, 57)},
            {"title": "Serviciul RIS", "start_marker": "5. Servicii", "pages": (57, 57)},
        ]
    },
    {
        "id": "m6", "title": "Navigatie si Balizaj IALA",
        "desc": "Coordonate, harti nautice, drumuri, relevmente si sistemul de balizaj.",
        "pages": (63, 82),
        "sections": [
            {"title": "Coordonate geografice", "start_marker": "1. Coordonate", "pages": (64, 64)},
            {"title": "Hartile nautice", "start_marker": "2. Hartile", "pages": (65, 65)},
            {"title": "Orizontul vizibil", "start_marker": "3. Orizontul", "pages": (66, 66)},
            {"title": "Drumuri si relevmente", "start_marker": "4. Drumuri", "pages": (66, 70)},
            {"title": "Sistemul IALA de balizaj maritim", "start_marker": "9. Sistemul", "pages": (73, 75)},
        ]
    },
    {
        "id": "m7", "title": "Manevra navei cu motor",
        "desc": "Efectul carmei si elicei, pregatire voiaj, ancorare, remorcare, om la apa.",
        "pages": (83, 100),
        "sections": [
            {"title": "Efectul carmei", "start_marker": "1. Efectul carmei", "pages": (84, 84)},
            {"title": "Efectul elicei", "start_marker": "2. Efectul elicei", "pages": (84, 85)},
            {"title": "Efectul combinat carma si elicea", "start_marker": "3. Efectul combinat", "pages": (86, 86)},
            {"title": "Pregatirea pentru voiaj", "start_marker": "4. Pregatirea", "pages": (86, 88)},
            {"title": "Manevra de plecare", "start_marker": "5. Manevra de plecare", "pages": (88, 90)},
            {"title": "Ancorarea", "start_marker": "6. Ancorarea", "pages": (90, 91)},
            {"title": "Remorcarea", "start_marker": "7. Remorcarea", "pages": (91, 91)},
            {"title": "Zone inguste si adancimi mici", "start_marker": "8. Principii", "pages": (91, 91)},
            {"title": "Om la apa (MOB)", "start_marker": "9. Manevra de om", "pages": (92, 93)},
            {"title": "Esuarea. Dezesuarea", "start_marker": "10. Esuarea", "pages": (94, 94)},
            {"title": "Rondoul", "start_marker": "11. Rondoul", "pages": (94, 95)},
            {"title": "Acostarea", "start_marker": "12. Acostarea", "pages": (95, 96)},
        ]
    },
    {
        "id": "m8", "title": "Vitalitatea navei. Prim-ajutor si salvare",
        "desc": "Etanseitate, incendii, prim-ajutor, mijloace de salvare.",
        "pages": (101, 122),
        "sections": [
            {"title": "Vitalitatea navei", "start_marker": "1. Vitalitatea", "pages": (102, 103)},
            {"title": "Prim-ajutor", "start_marker": "2. Prim", "pages": (103, 112)},
            {"title": "Mijloace de salvare", "start_marker": "3. Mijloace", "pages": (113, 116)},
        ]
    },
]

def extract_module(doc, mod_def):
    """Extract text and images for a module."""
    mod_start, mod_end = mod_def["pages"]
    mod_id = mod_def["id"]

    # Extract images
    img_dir = os.path.join(IMG_BASE, mod_id)
    os.makedirs(img_dir, exist_ok=True)
    img_map = {}  # page -> [filenames]

    for i in range(mod_start - 1, min(mod_end, doc.page_count)):
        page = doc[i]
        page_imgs = []
        for img_idx, img in enumerate(page.get_images(full=True)):
            xref = img[0]
            try:
                pix = fitz.Pixmap(doc, xref)
                if pix.n >= 5:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                if pix.width < 80 or pix.height < 80:
                    pix = None
                    continue
                fname = f"{mod_id}_p{i+1}_{img_idx}.png"
                pix.save(os.path.join(img_dir, fname))
                page_imgs.append(fname)
                pix = None
            except:
                continue
        img_map[i + 1] = page_imgs

    # Extract text per page
    page_texts = {}
    for i in range(mod_start - 1, min(mod_end, doc.page_count)):
        text = doc[i].get_text()
        lines = []
        for l in text.split("\n"):
            s = l.strip()
            if not s or (s.isdigit() and len(s) < 4):
                continue
            # Skip noise
            if s.startswith("Cursuri de pregatire") or s.startswith("international de cond"):
                continue
            if s.startswith("agrement clasele") or s.startswith("CURSURI DE AGREMENT"):
                continue
            if s.startswith("Manual si note"):
                continue
            if s.startswith("www.") or s.startswith("http"):
                continue
            if "BIBLIOGRAFIE" in s.upper():
                break
            if s.startswith("RYA") or s.startswith("Conducerea Iahtului"):
                continue
            lines.append(s)
        page_texts[i + 1] = lines

    # Build sections
    sections = []
    for s_idx, s_def in enumerate(mod_def["sections"]):
        s_start, s_end = s_def["pages"]

        # Collect text for this section's page range
        content_lines = []
        for p in range(s_start, s_end + 1):
            if p in page_texts:
                content_lines.extend(page_texts[p])

        # Remove module header lines
        content_lines = [l for l in content_lines if not l.startswith(f"M{mod_id[1]} ")]

        # Try to trim to just this section (remove other section headers)
        # Find our section's start
        our_start = 0
        for idx, l in enumerate(content_lines):
            if s_def["start_marker"].lower() in l.lower()[:40]:
                our_start = idx
                break

        # Find next section's start (if not last section)
        our_end = len(content_lines)
        if s_idx + 1 < len(mod_def["sections"]):
            next_marker = mod_def["sections"][s_idx + 1]["start_marker"].lower()
            for idx in range(our_start + 1, len(content_lines)):
                if next_marker in content_lines[idx].lower()[:40]:
                    our_end = idx
                    break

        section_text = content_lines[our_start:our_end]

        # Remove the section header itself from content
        if section_text:
            section_text = section_text[1:]  # skip the "1. Title" line

        # Join lines, fix paragraph breaks
        content = clean_text(section_text)

        # Collect images from section pages
        section_imgs = []
        for p in range(s_start, s_end + 1):
            section_imgs.extend(img_map.get(p, []))

        sections.append({
            "id": f"{mod_id}_s{s_idx + 1}",
            "title": s_def["title"],
            "content": content,
            "images": section_imgs,
            "quiz": []
        })

    return {
        "id": mod_id,
        "title": mod_def["title"],
        "description": mod_def["desc"],
        "sections": sections
    }


def clean_text(lines):
    """Join lines into paragraphs, clean up PDF artifacts."""
    if not lines:
        return ""

    paragraphs = []
    current = []

    for line in lines:
        # If line ends with period, colon, semicolon, or question mark -> end of paragraph
        if current and (line[0].isupper() and current[-1][-1] in ".;:?!"):
            paragraphs.append(" ".join(current))
            current = [line]
        else:
            current.append(line)

    if current:
        paragraphs.append(" ".join(current))

    return "\n\n".join(paragraphs)


# ─── STEP 3: Match questions to modules ──────────────────────────

QUESTION_TOPIC_KEYWORDS = {
    "m1": ["Colreg", "Regulament", "navă", "nava", "vele", "propulsie", "expresia", "definit", "marș", "manevră redusă", "pescaj", "vedere"],
    "m2": ["constructi", "coca", "etrava", "chilă", "punte", "suprastructur", "deplasament"],
    "m3": ["parâm", "ancora", "noduri", "tachet", "cabestan", "marinari", "ancora", "lant"],
    "m4": ["meteo", "vânt", "presiune", "barom", "front", "ceaț", "nori", "Beaufort", "temperatură"],
    "m5": ["VHF", "GMDSS", "MAYDAY", "PAN PAN", "SECURITE", "radio", "comunicat", "canal 16", "DSC", "AIS"],
    "m6": ["balizaj", "IALA", "cardinal", "lateral", "geamandur", "hartă", "coordonat", "navigați", "meridian", "latitudine", "longitudine"],
    "m7": ["cârmă", "elice", "manevr", "acosta", "ancora", "remorca", "MOB", "om la apă", "eșua", "rondou"],
    "m8": ["salvare", "prim-ajutor", "incendiu", "colac", "pluta", "vestă", "vitalitat", "gaura", "etanș"],
}

def assign_questions_to_modules(questions, modules):
    """Assign questions to modules based on keyword matching."""
    assigned = {m["id"]: [] for m in modules}
    unassigned = []

    for q in questions:
        q_text = q["question"].lower()
        best_mod = None
        best_score = 0

        for mod_id, keywords in QUESTION_TOPIC_KEYWORDS.items():
            score = sum(1 for kw in keywords if kw.lower() in q_text)
            # Also check options
            for opt in q["options"]:
                score += sum(0.5 for kw in keywords if kw.lower() in opt.lower())
            if score > best_score:
                best_score = score
                best_mod = mod_id

        if best_mod and best_score > 0:
            assigned[best_mod].append(q)
        else:
            unassigned.append(q)

    # Put unassigned into m1 (general COLREG)
    assigned["m1"].extend(unassigned)

    return assigned


# ─── MAIN ────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Parsing official questions ===")
    questions = parse_questions(QUESTIONS_PDF)
    print(f"  Parsed {len(questions)} questions")

    # Save questions
    q_path = os.path.join(BASE, "questions_c.json")
    with open(q_path, "w", encoding="utf-8") as f:
        json.dump(questions, f, ensure_ascii=False, indent=2)

    print("\n=== Extracting modules from manual ===")
    doc = fitz.open(MANUAL_PDF)
    modules = []

    for mod_def in MODULES_DEF:
        print(f"\n  Processing {mod_def['id']}: {mod_def['title']}...")
        module = extract_module(doc, mod_def)
        modules.append(module)

        total_chars = sum(len(s["content"]) for s in module["sections"])
        total_imgs = sum(len(s["images"]) for s in module["sections"])
        print(f"    {len(module['sections'])} sections, {total_chars} chars, {total_imgs} images")

    doc.close()

    # Assign questions
    print("\n=== Assigning questions to modules ===")
    q_assignments = assign_questions_to_modules(questions, modules)

    for mod in modules:
        mod_qs = q_assignments.get(mod["id"], [])
        # Distribute questions across sections (round-robin)
        for i, q in enumerate(mod_qs):
            s_idx = i % len(mod["sections"])
            quiz_q = {
                "question": q["question"],
                "options": q["options"],
                "correct": q["correct"]
            }
            mod["sections"][s_idx]["quiz"].append(quiz_q)

        total_quiz = sum(len(s["quiz"]) for s in mod["sections"])
        print(f"  {mod['id']}: {len(mod_qs)} questions assigned ({total_quiz} across sections)")

    # Save modules
    print("\n=== Saving module files ===")
    for mod in modules:
        mod_path = os.path.join(BASE, f"{mod['id']}.json")
        with open(mod_path, "w", encoding="utf-8") as f:
            json.dump(mod, f, ensure_ascii=False, indent=2)
        print(f"  Saved {mod_path}")

    # Build course index
    index = {
        "title": "CAA Clasa C — Curs de pregatire",
        "description": "Curs complet pentru obtinerea certificatului de conducator ambarcatiune de agrement clasa C.",
        "source": "Seanergya — Manual si note de curs (Oana Sima, Cosmin Andronic)",
        "totalModules": len(modules),
        "totalSections": sum(len(m["sections"]) for m in modules),
        "totalQuestions": sum(sum(len(s["quiz"]) for s in m["sections"]) for m in modules),
        "modules": [
            {
                "id": m["id"],
                "title": m["title"],
                "description": m["description"],
                "sectionCount": len(m["sections"]),
                "questionCount": sum(len(s["quiz"]) for s in m["sections"])
            }
            for m in modules
        ]
    }

    idx_path = os.path.join(BASE, "index.json")
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"\n=== DONE ===")
    print(f"  Course index: {idx_path}")
    print(f"  Modules: {len(modules)}")
    print(f"  Sections: {index['totalSections']}")
    print(f"  Questions: {index['totalQuestions']}")
    print(f"  Images: {sum(sum(len(s['images']) for s in m['sections']) for m in modules)}")
