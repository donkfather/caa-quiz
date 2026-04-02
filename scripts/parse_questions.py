#!/usr/bin/env python3
"""Parse official RNA Class C questions into structured JSON."""
import fitz
import json
import re
import os

def parse_questions(pdf_path):
    doc = fitz.open(pdf_path)
    full_text = ""
    for i in range(doc.page_count):
        full_text += doc[i].get_text() + "\n"
    doc.close()

    lines = full_text.split("\n")
    questions = []
    i = 0
    
    # Skip header line
    while i < len(lines) and not lines[i].strip().startswith("1"):
        i += 1

    current_q = None
    current_option = ""
    current_correct = None
    option_count = 0

    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line:
            continue

        # Check if this is a question number (standalone digit line)
        if re.match(r'^\d+$', line):
            num = int(line)
            # Save previous question
            if current_q and current_option:
                current_q["options"].append(current_option.strip())
                current_q["correctFlags"].append(current_correct)
                current_option = ""
            if current_q and len(current_q["options"]) >= 2:
                # Find correct answer index
                correct_idx = None
                for idx, flag in enumerate(current_q["correctFlags"]):
                    if flag == 1:
                        correct_idx = idx
                        break
                current_q["correct"] = correct_idx if correct_idx is not None else 0
                del current_q["correctFlags"]
                questions.append(current_q)

            current_q = {"id": num, "question": "", "options": [], "correctFlags": [], "correct": 0}
            option_count = 0
            # Next line(s) should be question text
            q_text = []
            while i < len(lines):
                l = lines[i].strip()
                if not l:
                    i += 1
                    continue
                # Check if this is an option (followed by 0 or 1)
                if re.match(r'^[01]$', l):
                    break
                q_text.append(l)
                i += 1
            current_q["question"] = " ".join(q_text)
            continue

        # Check if line is 0 or 1 (correct flag)
        if re.match(r'^[01]$', line):
            flag = int(line)
            if current_option:
                current_q["options"].append(current_option.strip())
                current_q["correctFlags"].append(flag)
                current_option = ""
                option_count += 1
            continue

        # Otherwise it's option text
        if current_q:
            if current_option:
                current_option += " " + line
            else:
                current_option = line

    # Save last question
    if current_q and current_option:
        current_q["options"].append(current_option.strip())
        current_q["correctFlags"].append(current_correct or 0)
    if current_q and len(current_q["options"]) >= 2:
        correct_idx = 0
        for idx, flag in enumerate(current_q.get("correctFlags", [])):
            if flag == 1:
                correct_idx = idx
                break
        current_q["correct"] = correct_idx
        if "correctFlags" in current_q:
            del current_q["correctFlags"]
        questions.append(current_q)

    return questions

if __name__ == "__main__":
    qs = parse_questions("/tmp/questions_c.pdf")
    out = os.path.expanduser("~/projects/caa-quiz/src/data/course/questions_c.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(qs, f, ensure_ascii=False, indent=2)
    print(f"Parsed {len(qs)} questions")
    # Show first 3
    for q in qs[:3]:
        print(f"\n  Q{q['id']}: {q['question'][:80]}...")
        for j, opt in enumerate(q['options']):
            marker = ">>>" if j == q['correct'] else "   "
            print(f"    {marker} {opt[:60]}")
