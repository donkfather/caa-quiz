#!/usr/bin/env python3
"""
Reformats raw PDF text into structured markdown-like content.
Handles: definitions, section headers, continuation lines, narratives.
"""
import re
import json
import os

BASE = os.path.expanduser("~/projects/caa-quiz/src/data/course")

def is_definition(line):
    """Check if line is a Term - English = definition pattern."""
    # Patterns: "Term - English = definition" or "Term = definition" or "Term - definition"
    return bool(re.match(r'^[A-ZĂÂÎȘȚ][a-zăâîșțA-ZĂÂÎȘȚ\s]{1,35}\s*[-–]\s*.+=\s*.+', line)) or \
           bool(re.match(r'^[A-ZĂÂÎȘȚ][a-zăâîșțA-ZĂÂÎȘȚ\s]{1,35}\s*[-–]\s*[A-Z].+', line))

def is_section_header(line):
    """Short line ending with : that introduces a group."""
    return len(line) < 60 and line.endswith(':') and not is_definition(line)

def is_page_number(line):
    """Just a digit."""
    return line.strip().isdigit() and len(line.strip()) < 4

def is_noise(line):
    """Skip known noise patterns."""
    s = line.strip()
    return (
        s.startswith("www.") or s.startswith("http") or
        "BIBLIOGRAFIE" in s.upper() or
        s.startswith("RYA") or
        s.startswith("Conducerea Iahtului") or
        s.startswith("Cursuri de pregatire") or
        s.startswith("international de cond") or
        s.startswith("agrement clasele") or
        s.startswith("CURSURI DE AGREMENT") or
        s.startswith("Manual si note") or
        s.startswith("Navigatie (Ivan") or
        s.startswith("Curs prim-ajutor")
    )

def join_continuation_lines(lines):
    """Join lines that are continuations of previous lines (mid-sentence wraps)."""
    if not lines:
        return []
    
    result = []
    current = lines[0]
    
    for line in lines[1:]:
        stripped = line.strip()
        if not stripped:
            if current:
                result.append(current)
                current = ""
            result.append("")  # blank line = paragraph break
            continue
        
        # If current line doesn't end with sentence-ending punctuation
        # and next line starts with lowercase or continues the thought
        if current and not current.rstrip().endswith(('.', ';', ':', '?', '!')) and \
           (stripped[0].islower() or stripped.startswith("si ") or stripped.startswith("sau ") or
            stripped.startswith("de ") or stripped.startswith("in ") or stripped.startswith("la ") or
            stripped.startswith("pe ") or stripped.startswith("cu ") or stripped.startswith("dar ") or
            stripped.startswith("care ") or stripped.startswith("ce ") or stripped.startswith("cat ") or
            stripped.startswith("precum ") or stripped.startswith("respectiv ") or
            stripped.startswith("inclusiv ") or stripped.startswith("pentru ")):
            current = current.rstrip() + " " + stripped
        else:
            if current:
                result.append(current)
            current = stripped
    
    if current:
        result.append(current)
    
    return result

def format_section_content(raw_text):
    """Transform raw section text into formatted blocks with markdown-like syntax."""
    if not raw_text:
        return ""
    
    lines = raw_text.split("\n")
    
    # Step 1: Clean noise and page numbers
    clean = []
    for line in lines:
        s = line.strip()
        if not s or is_page_number(s) or is_noise(s):
            if not s:
                clean.append("")  # preserve paragraph breaks
            continue
        clean.append(s)
    
    # Step 2: Join continuation lines
    joined = join_continuation_lines(clean)
    
    # Step 3: Format into structured blocks
    formatted = []
    i = 0
    while i < len(joined):
        line = joined[i].strip()
        if not line:
            formatted.append("")
            i += 1
            continue
        
        # Definition: "Term - English = explanation"
        if is_definition(line):
            # Parse the definition
            # Pattern 1: "Pupa - Stern = partea din spate"
            m = re.match(r'^([^-–]+)\s*[-–]\s*([^=]+)=\s*(.+)$', line)
            if m:
                ro_term = m.group(1).strip()
                en_term = m.group(2).strip()
                explanation = m.group(3).strip().rstrip(';.')
                formatted.append(f"**{ro_term}** ({en_term}) — {explanation}")
            else:
                # Pattern 2: "Term - explanation" without English
                m2 = re.match(r'^([^-–]+)\s*[-–]\s*(.+)$', line)
                if m2:
                    term = m2.group(1).strip()
                    desc = m2.group(2).strip().rstrip(';.')
                    formatted.append(f"**{term}** — {desc}")
                else:
                    formatted.append(line)
            i += 1
            continue
        
        # Section header: "Zonele principale ale unei ambarcatiuni sunt:"
        if is_section_header(line):
            header = line.rstrip(':').strip()
            formatted.append(f"\n### {header}\n")
            i += 1
            continue
        
        # Numbered item: "1. something" or "1) something"
        num_match = re.match(r'^\d+[.)\s]+(.+)', line)
        if num_match:
            formatted.append("• " + num_match.group(1))
            i += 1
            continue
        
        # Regular paragraph
        formatted.append(line)
        i += 1
    
    # Step 4: Clean up multiple blank lines
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


def process_all_modules():
    """Reformat content in all module JSON files."""
    for mid in [f"m{i}" for i in range(1, 9)]:
        path = os.path.join(BASE, f"{mid}.json")
        with open(path, "r", encoding="utf-8") as f:
            mod = json.load(f)
        
        changed = False
        for section in mod["sections"]:
            old = section.get("content", "")
            if old:
                new = format_section_content(old)
                if new != old:
                    section["content"] = new
                    changed = True
            
            for sub in section.get("subsections", []):
                old = sub.get("content", "")
                if old:
                    new = format_section_content(old)
                    if new != old:
                        sub["content"] = new
                        changed = True
        
        if changed:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(mod, f, ensure_ascii=False, indent=2)
            
            # Stats
            total_defs = 0
            total_headers = 0
            for s in mod["sections"]:
                c = s.get("content", "")
                total_defs += c.count("**")
                total_headers += c.count("###")
                for sub in s.get("subsections", []):
                    c = sub.get("content", "")
                    total_defs += c.count("**")
                    total_headers += c.count("###")
            
            print(f"  {mid}: reformatted ({total_defs // 2} definitions, {total_headers} headers)")
        else:
            print(f"  {mid}: no changes needed")


if __name__ == "__main__":
    print("=== Reformatting course content ===")
    process_all_modules()
    print("\nDone!")
