#!/usr/bin/env python3
"""
CAA Quiz Course Builder v2
Improved PDF extraction with better text formatting and section splitting.
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

# ─── Question parser (unchanged) ─────────────────────────────────

def parse_questions(pdf_path):
    doc = fitz.open(pdf_path)
    full_lines = []
    for i in range(doc.page_count):
        for line in doc[i].get_text().split("\n"):
            s = line.strip()
            if s:
                full_lines.append(s)
    doc.close()

    # Find start
    start = 0
    for idx, l in enumerate(full_lines):
        if l == "1" and idx > 3:
            start = idx
            break

    questions = []
    i = start
    while i < len(full_lines):
        line = full_lines[i]
        if re.match(r'^\d+$', line):
            num = int(line)
            if num == len(questions) + 1 and i + 1 < len(full_lines) and full_lines[i + 1] not in ("0", "1"):
                i += 1
                q_lines = []
                while i < len(full_lines) and full_lines[i] not in ("0", "1"):
                    if re.match(r'^\d+$', full_lines[i]) and int(full_lines[i]) == num + 1:
                        break
                    q_lines.append(full_lines[i])
                    i += 1
                    # Check if next line is 0/1 (means current accumulated text is the question + first option starts)
                    if i < len(full_lines) and full_lines[i] in ("0", "1") and len(q_lines) > 1:
                        break

                # Separate question from first option
                # The last chunk before a 0/1 is the first option
                # But we need to figure out where question ends and first option begins
                # Strategy: look backwards from end for where option text starts
                q_text = " ".join(q_lines)

                # Gather options
                options = []
                correct = 0
                opt_lines = []
                while i < len(full_lines):
                    if full_lines[i] in ("0", "1"):
                        flag = int(full_lines[i])
                        if opt_lines:
                            opt_text = " ".join(opt_lines).strip()
                            if flag == 1:
                                correct = len(options)
                            options.append(opt_text)
                            opt_lines = []
                        i += 1
                        if i < len(full_lines) and re.match(r'^\d+$', full_lines[i]):
                            peek = int(full_lines[i])
                            if peek == len(questions) + 2:
                                break
                    else:
                        opt_lines.append(full_lines[i])
                        i += 1

                if q_text and len(options) >= 2:
                    questions.append({"id": num, "question": q_text, "options": options, "correct": correct})
                continue
        i += 1
    return questions

# ─── Text extraction & formatting ────────────────────────────────

NOISE_PATTERNS = [
    "Cursuri de pregatire", "international de cond", "agrement clasele",
    "CURSURI DE AGREMENT", "Manual si note", "BIBLIOGRAFIE",
    "RYA", "Conducerea Iahtului", "Navigatie (Ivan", "Curs prim-ajutor"
]

def extract_pages(doc, start_page, end_page):
    """Extract clean lines from a page range, preserving structure."""
    all_lines = []
    for i in range(start_page - 1, min(end_page, doc.page_count)):
        text = doc[i].get_text()
        for line in text.split("\n"):
            s = line.strip()
            if not s:
                all_lines.append("")
                continue
            if s.isdigit() and len(s) < 4:
                continue
            if any(p in s for p in NOISE_PATTERNS):
                continue
            if s.startswith("www.") or s.startswith("http"):
                continue
            all_lines.append(s)
    return all_lines

def extract_images(doc, start_page, end_page, mod_id):
    """Extract meaningful images from pages."""
    img_dir = os.path.join(IMG_BASE, mod_id)
    os.makedirs(img_dir, exist_ok=True)
    img_map = {}
    for i in range(start_page - 1, min(end_page, doc.page_count)):
        page_imgs = []
        for img_idx, img in enumerate(doc[i].get_images(full=True)):
            try:
                pix = fitz.Pixmap(doc, img[0])
                if pix.n >= 5:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                if pix.width < 80 or pix.height < 80:
                    continue
                fname = f"{mod_id}_p{i+1}_{img_idx}.png"
                pix.save(os.path.join(img_dir, fname))
                page_imgs.append(fname)
            except:
                continue
        img_map[i + 1] = page_imgs
    return img_map

def format_text(lines):
    """Convert raw lines into formatted content with definitions, headers, lists."""
    # Step 1: Join continuation lines
    joined = []
    current = ""
    for line in lines:
        if not line:
            if current:
                joined.append(current)
                current = ""
            joined.append("")
            continue
        
        if current and not re.search(r'[.;:?!]$', current) and \
           (line[0].islower() or line.startswith(("si ", "sau ", "de ", "in ", "la ",
            "pe ", "cu ", "dar ", "care ", "ce ", "cat ", "precum ", "respectiv ",
            "inclusiv ", "pentru ", "care ", "este ", "se ", "datorita ", "astfel ",
            "aceasta ", "aceaste ", "atunci ", "daca ", "fata ", "ori ", "din "))):
            current = current + " " + line
        else:
            if current:
                joined.append(current)
            current = line
    if current:
        joined.append(current)

    # Step 2: Format each line
    formatted = []
    for line in joined:
        if not line:
            formatted.append("")
            continue

        # Definition: "RoTerm - EnTerm = explanation"
        m = re.match(r'^([A-ZĂÂÎȘȚ][a-zăâîșțA-Za-z\s]{1,35})\s*[-–]\s*([A-Z][a-zA-Z]+(?:\s[a-zA-Z]+){0,3})\s*=\s*(.+)$', line)
        if m:
            formatted.append(f"**{m.group(1).strip()}** ({m.group(2).strip()}) — {m.group(3).strip().rstrip(';.')}")
            continue

        # Definition: "Term - explanation" — catches "Nava - Orice mijloc..."
        # Must start with uppercase, have a dash, and explanation starts with lowercase
        m2 = re.match(r'^([A-ZĂÂÎȘȚĂ][a-zăâîșțA-Za-z\s]{1,40}?)\s*[-–]\s*(.+)$', line)
        if m2:
            term = m2.group(1).strip()
            explanation = m2.group(2).strip().rstrip(';.')
            # Validate: term should be short-ish, explanation should be descriptive
            if len(term) < 40 and len(explanation) > 10 and not term.endswith((' si', ' sau', ' cu', ' de', ' la', ' in', ' pe')):
                formatted.append(f"**{term}** — {explanation}")
                continue

        # Section header: short line ending with :
        if len(line) < 65 and line.endswith(':') and not line.startswith(('a)', 'b)', 'c)')):
            header = line.rstrip(':').strip()
            formatted.append(f"\n### {header}\n")
            continue

        # Semicolon-separated lists (common in PDF)
        if ';' in line and line.count(';') >= 2 and len(line) > 60:
            parts = [p.strip() for p in line.split(';') if p.strip()]
            all_short = all(len(p) < 80 for p in parts)
            if all_short:
                for part in parts:
                    if part:
                        dm = re.match(r'^([A-Za-zăâîșț]+(?:\s[a-z]+){0,2})\s*[-–]\s*(.+)', part)
                        if dm:
                            formatted.append(f"**{dm.group(1).strip()}** — {dm.group(2).strip()}")
                        else:
                            formatted.append(f"• {part}")
                continue

        # Regular text
        formatted.append(line)

    # Clean up multiple blank lines
    result = []
    prev_blank = False
    for line in formatted:
        if not line.strip():
            if not prev_blank:
                result.append("")
            prev_blank = True
        else:
            result.append(line)
            prev_blank = False

    return "\n\n".join(block for block in "\n".join(result).split("\n\n") if block.strip())

# ─── Module definitions ──────────────────────────────────────────

MODULES = [
    {
        "id": "m1", "title": "Notiuni introductive",
        "desc": "Introducere in navigatie: istoric si terminologie marinareasca.",
        "pages": (5, 14),
        "section_markers": [
            ("Istoric", "1. Istoric"),
            ("Terminologie. Vocabular", "2. Terminologie"),
        ]
    },
    {
        "id": "m2", "title": "Constructia navei cu motor",
        "desc": "Tipuri de nave, elemente de constructie, calitati nautice si greement.",
        "pages": (15, 24),
        "section_markers": [
            ("Tipuri de nave. Clasificare", "1. Tipuri"),
            ("Elemente de constructie a navei", "2. Elemente"),
            ("Calitatile nautice si manevriere", "3. Calitatile"),
            ("Greementul navei", "4. Greementul"),
        ]
    },
    {
        "id": "m3", "title": "Marinarie",
        "desc": "Parame, accesorii de punte, ancore, noduri marinaresti.",
        "pages": (25, 42),
        "section_markers": [
            ("Parame", "1. Parame"),
            ("Accesorii de punte", "2. Accesorii"),
            ("Ancore", "3. Ancore"),
            ("Instalatia de ancorare", "4. Instalatia de ancorare"),
            ("Instalatia de carma", "5. Instalatia de carma"),
            ("Noduri. Matelotaj", "6. Noduri"),
        ]
    },
    {
        "id": "m4", "title": "Meteorologie",
        "desc": "Temperatura, presiune, vant, fronturi, precipitatii, ceata si nori.",
        "pages": (43, 52),
        "section_markers": [
            ("Temperatura aerului", "1. Temperatura"),
            ("Presiunea atmosferica", "2. Presiunea"),
            ("Vantul", "3. Vantul"),
            ("Precipitatiile", "4. Precipitatiile"),
            ("Ceata", "5. Cea"),
            ("Norii. Semne de vreme", "6. Norii"),
        ]
    },
    {
        "id": "m5", "title": "Comunicatii",
        "desc": "Apeluri radio, disciplina comunicatiilor, echipamente VHF/AIS, GMDSS.",
        "pages": (53, 62),
        "section_markers": [
            ("Apeluri", "1. Apeluri"),
            ("Disciplina comunicatiilor", "2. Disciplina"),
            ("Echipamente", "3. Echipamente"),
            ("Sistemul GMDSS", "4. Sistemul"),
            ("Serviciul RIS", "5. Servicii"),
        ]
    },
    {
        "id": "m6", "title": "Navigatie si Balizaj IALA",
        "desc": "Coordonate, harti nautice, drumuri, relevmente si sistemul de balizaj.",
        "pages": (63, 82),
        "section_markers": [
            ("Coordonate geografice", "1. Coordonate"),
            ("Hartile nautice", "2. Hartile"),
            ("Orizontul vizibil", "3. Orizontul"),
            ("Drumuri si relevmente", "4. Drumuri"),
            ("Sistemul IALA de balizaj maritim", "9. Sistemul"),
        ]
    },
    {
        "id": "m7", "title": "Manevra navei cu motor",
        "desc": "Efectul carmei si elicei, pregatire voiaj, ancorare, remorcare, om la apa.",
        "pages": (83, 100),
        "section_markers": [
            ("Efectul carmei", "1. Efectul carmei"),
            ("Efectul elicei", "2. Efectul elicei"),
            ("Efectul combinat carma si elicea", "3. Efectul combinat"),
            ("Pregatirea pentru voiaj", "4. Pregatirea"),
            ("Manevra de plecare", "5. Manevra de plecare"),
            ("Ancorarea", "6. Ancorarea"),
            ("Remorcarea", "7. Remorcarea"),
            ("Zone inguste si adancimi mici", "8. Principii"),
            ("Om la apa (MOB)", "9. Manevra de om"),
            ("Esuarea. Dezesuarea", "10. Esuarea"),
            ("Rondoul", "11. Rondoul"),
            ("Acostarea", "12. Acostarea"),
        ]
    },
    {
        "id": "m8", "title": "Vitalitatea navei. Prim-ajutor si salvare",
        "desc": "Etanseitate, incendii, prim-ajutor, mijloace de salvare.",
        "pages": (101, 122),
        "section_markers": [
            ("Vitalitatea navei", "1. Vitalitatea"),
            ("Prim-ajutor", "2. Prim"),
            ("Mijloace de salvare", "3. Mijloace"),
        ]
    },
]

def build_module(doc, mod_def):
    """Build a module with properly split and formatted sections."""
    mod_id = mod_def["id"]
    start, end = mod_def["pages"]
    
    # Extract raw lines and images
    all_lines = extract_pages(doc, start, end)
    img_map = extract_images(doc, start, end, mod_id)
    
    # Remove module header line
    all_lines = [l for l in all_lines if not re.match(rf'^M\d\s', l)]
    
    # Find section boundaries in the text
    markers = mod_def["section_markers"]
    section_starts = []
    
    for title, marker in markers:
        marker_lower = marker.lower()
        for idx, line in enumerate(all_lines):
            if marker_lower in line.lower()[:50]:
                section_starts.append((title, idx))
                break
    
    # Build sections
    sections = []
    for i, (title, start_idx) in enumerate(section_starts):
        # End = next section start or end of text
        end_idx = section_starts[i + 1][1] if i + 1 < len(section_starts) else len(all_lines)
        
        # Get raw lines for this section (skip the header line itself)
        raw_lines = all_lines[start_idx + 1:end_idx]
        
        # Format
        content = format_text(raw_lines)
        
        # Collect images from approximate page range
        # Estimate pages from line count ratios
        section_imgs = []
        total_lines = len(all_lines)
        if total_lines > 0:
            ratio_start = start_idx / total_lines
            ratio_end = end_idx / total_lines
            page_range = end - start + 1
            p_start = start + int(ratio_start * page_range)
            p_end = start + int(ratio_end * page_range)
            for p in range(p_start, p_end + 1):
                section_imgs.extend(img_map.get(p, []))
        
        sections.append({
            "id": f"{mod_id}_s{i + 1}",
            "title": title,
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

# ─── Question assignment ─────────────────────────────────────────

TOPIC_KEYWORDS = {
    "m1": ["Colreg", "Regulament", "navă", "nava", "vele", "propulsie", "expresia", "definit", "marș", "manevră redusă", "pescaj", "vedere", "regul"],
    "m2": ["constructi", "coca", "etrava", "chilă", "punte", "suprastructur", "deplasament", "elice", "motor"],
    "m3": ["parâm", "ancoră", "ancora", "noduri", "tachet", "cabestan", "marinari", "lant", "chei"],
    "m4": ["meteo", "vânt", "presiune", "barom", "front", "ceaț", "nori", "Beaufort", "temperatură", "vreme"],
    "m5": ["VHF", "GMDSS", "MAYDAY", "PAN PAN", "SECURITE", "radio", "comunicat", "canal 16", "DSC", "AIS", "apel"],
    "m6": ["balizaj", "IALA", "cardinal", "lateral", "geamandur", "hartă", "coordonat", "navigați", "meridian", "latitudine", "longitudine", "lumini", "semnal"],
    "m7": ["cârmă", "carmă", "elice", "manevr", "acosta", "remorca", "MOB", "om la apă", "eșua", "rondou", "plecare"],
    "m8": ["salvare", "prim-ajutor", "incendiu", "colac", "pluta", "vestă", "vitalitat", "gaura", "etanș", "stingător"],
}

def assign_questions(questions, modules):
    """Improved question-to-module assignment with content matching."""
    assigned = {m["id"]: [] for m in modules}
    
    # Build content index per module for better matching
    content_words = {}
    for mod in modules:
        words = set()
        for s in mod["sections"]:
            for w in s.get("content", "").lower().split():
                if len(w) > 4:
                    words.add(w)
        content_words[mod["id"]] = words
    
    for q in questions:
        q_text = (q["question"] + " " + " ".join(q["options"])).lower()
        
        best_mod = None
        best_score = 0
        
        for mod_id, keywords in TOPIC_KEYWORDS.items():
            # Keyword score
            score = sum(2 for kw in keywords if kw.lower() in q_text)
            # Content word overlap score
            q_words = set(w for w in q_text.split() if len(w) > 4)
            overlap = len(q_words & content_words.get(mod_id, set()))
            score += overlap * 0.3
            
            if score > best_score:
                best_score = score
                best_mod = mod_id
        
        if best_mod and best_score > 0.5:
            assigned[best_mod].append(q)
        else:
            assigned["m1"].append(q)  # Default to COLREG
    
    return assigned

# ─── MAIN ────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Parsing questions ===")
    questions = parse_questions(QUESTIONS_PDF)
    print(f"  {len(questions)} questions parsed")
    
    with open(os.path.join(BASE, "questions_c.json"), "w", encoding="utf-8") as f:
        json.dump(questions, f, ensure_ascii=False, indent=2)
    
    print("\n=== Building modules ===")
    doc = fitz.open(MANUAL_PDF)
    modules = []
    
    for mod_def in MODULES:
        mod = build_module(doc, mod_def)
        modules.append(mod)
        
        chars = sum(len(s["content"]) for s in mod["sections"])
        imgs = sum(len(s["images"]) for s in mod["sections"])
        defs = sum(s["content"].count("**") // 2 for s in mod["sections"])
        headers = sum(s["content"].count("###") for s in mod["sections"])
        bullets = sum(s["content"].count("•") for s in mod["sections"])
        print(f"  {mod['id']}: {len(mod['sections'])} sections, {chars} chars, {imgs} imgs, {defs} defs, {headers} headers, {bullets} bullets")
    
    doc.close()
    
    print("\n=== Assigning questions ===")
    q_map = assign_questions(questions, modules)
    
    for mod in modules:
        mod_qs = q_map.get(mod["id"], [])
        # Distribute across sections round-robin
        for i, q in enumerate(mod_qs):
            s_idx = i % len(mod["sections"])
            mod["sections"][s_idx]["quiz"].append({
                "question": q["question"],
                "options": q["options"],
                "correct": q["correct"]
            })
        total_q = sum(len(s["quiz"]) for s in mod["sections"])
        print(f"  {mod['id']}: {total_q} questions")
    
    print("\n=== Saving ===")
    for mod in modules:
        path = os.path.join(BASE, f"{mod['id']}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(mod, f, ensure_ascii=False, indent=2)
    
    # Index
    index = {
        "title": "CAA Clasa C — Curs de pregatire",
        "description": "Curs complet pentru certificatul de conducator ambarcatiune de agrement clasa C.",
        "source": "Seanergya — Manual si note de curs",
        "totalModules": len(modules),
        "totalSections": sum(len(m["sections"]) for m in modules),
        "totalQuestions": sum(sum(len(s["quiz"]) for s in m["sections"]) for m in modules),
        "modules": [{
            "id": m["id"], "title": m["title"], "description": m["description"],
            "sectionCount": len(m["sections"]),
            "questionCount": sum(len(s["quiz"]) for s in m["sections"])
        } for m in modules]
    }
    
    with open(os.path.join(BASE, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    
    print(f"\n=== DONE: {index['totalModules']} modules, {index['totalSections']} sections, {index['totalQuestions']} questions ===")
