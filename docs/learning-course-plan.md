# CAA Quiz — Learning Course Plan

## Goal
Parse the Seanergya Manual CD (122 pages) into a structured learning course with 8 modules, ~40 sections, subsections, images, and quiz questions per section.

## Source Material
- **Manual**: `https://seanergya.ro/wp-content/uploads/2022/11/Manual_CD.pdf` (local: `/tmp/manual_cd.pdf`)
- **Official questions**: `https://portal.rna.ro/SiteAssets/Pagini/CAA%20Conducator%20ambarcatiune%20agrement/Lista%20intrebari%20clasa%20C.pdf`
- **COLREG bilingual**: `http://scoalanautica.ro/wp-content/uploads/2018/04/COLREG-RO-ENG.pdf`

## Output Structure
```
src/data/course/
├── m1.json          # Module 1 JSON
├── m2.json          # Module 2 JSON
├── ...
├── m8.json          # Module 8 JSON
├── index.json       # Course index (all modules, metadata)
└── images/
    ├── m1/          # Images extracted from M1 pages
    ├── m2/
    └── ...
```

## JSON Schema

### Module (m1.json)
```json
{
  "id": "m1",
  "title": "Notiuni introductive",
  "description": "Short description for course listing",
  "sections": [Section]
}
```

### Section
```json
{
  "id": "m1_s1",
  "title": "Istoric",
  "description": "One-line description",
  "content": "Markdown formatted text",
  "images": ["m1_p6_0.png"],
  "subsections": [Subsection],
  "quiz": [QuizQuestion]
}
```

### Subsection
```json
{
  "id": "m1_s2_1",
  "title": "Definitii generale",
  "content": "Markdown formatted text",
  "images": ["m1_p7_1.png"]
}
```

### QuizQuestion
```json
{
  "question": "Ce inseamna 'babord'?",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correct": 2
}
```

## Module Map (pages are 1-indexed)

### M1 — Notiuni introductive (p.5-14)
- [x] Parsed (proof of concept done)
- [ ] Clean up: filter decorative images (<2KB), fix Dictionar content, fix Unitati de masura leak
- **S1**: Istoric (p.6)
- **S2**: Terminologie. Vocabular (p.6-14)
  - S2.1: Definitii generale (p.6-7)
  - S2.2: Dictionar RO-EN (p.8)
  - S2.3: Zonele principale ale ambarcatiunii (p.8)
  - S2.4: Accesorii ale ambarcatiunii (p.8-9)
  - S2.5: Despre vant (p.9)
  - S2.6: Caracteristicile ambarcatiunii (p.9-10)
  - S2.7: Roluri si responsabilitati (p.10)
  - S2.8: Unitati de masura (p.10)
  - S2.9: Comenzi la bord (p.10-11)

### M2 — Constructia navei cu motor (p.15-24)
- [ ] Not parsed
- **S1**: Tipuri de nave. Clasificare (p.16)
- **S2**: Elemente de constructie a navei (p.16-18)
- **S3**: Calitatile nautice si manevriere ale navei (p.19-20)
- **S4**: Greementul navei (p.21-22)

### M3 — Marinarie (p.25-42)
- [ ] Not parsed
- **S1**: Parame (p.26-28)
  - S1.1: Clasificare dupa material
  - S1.2: Clasificare dupa mod de confectionare
- **S2**: Accesorii de punte (p.29-30)
- **S3**: Ancore (p.31)
- **S4**: Instalatia de ancorare (p.32)
- **S5**: Instalatia de carma (p.32)
- **S6**: Noduri. Matelotaj (p.32-39)

### M4 — Meteorologie (p.43-52)
- [ ] Not parsed
- **S1**: Temperatura aerului (p.44)
- **S2**: Presiunea atmosferica (p.44)
- **S3**: Vantul (p.44-45)
  - S3.1: Scala Beaufort
- **S4**: Fronturi atmosferice (p.45)
  - S4.1: Frontul cald
  - S4.2: Frontul rece
  - S4.3: Frontul oclus
- **S5**: Precipitatiile (p.46)
- **S6**: Ceata (p.46)
- **S7**: Norii. Semne de vreme rea si buna (p.46-48)

### M5 — Comunicatii (p.53-62)
- [ ] Not parsed
- **S1**: Apeluri (p.54-55)
  - S1.1: Apelul de pericol (MAYDAY)
  - S1.2: Apelul de urgenta (PAN PAN)
  - S1.3: Apelul de siguranta (SECURITE)
  - S1.4: Apelul de rutina
- **S2**: Disciplina comunicatiilor (p.55)
- **S3**: Echipamente (p.55-56)
  - S3.1: VHF
  - S3.2: AIS
- **S4**: Sistemul GMDSS (p.56-57)
- **S5**: Serviciul RIS (p.57)

### M6 — Navigatie si Balizaj IALA (p.63-82)
- [ ] Not parsed
- **S1**: Coordonate geografice (p.64)
- **S2**: Hartile nautice (p.65)
- **S3**: Orizontul vizibil (p.66)
- **S4**: Drumuri si relevmente (p.66-70)
- **S5**: Loxodroma si ortodroma (p.70) — doar clasa C
- **S6**: Dunarea. Prezentare generala (p.70) — doar clasa D
- **S7**: Particularitatile navigatiei pe Dunare (p.70-71) — doar clasa D
- **S8**: Caracteristicile hidrologice (p.71-72) — doar clasa D
- **S9**: Sistemul international de balizaj IALA (p.73-75) — doar clasa C
  - S9.1: Semne laterale (babord/tribord)
  - S9.2: Semne cardinale
  - S9.3: Semne de pericol izolat
  - S9.4: Semne de ape sigure
  - S9.5: Semne speciale

### M7 — Manevra navei cu motor (p.83-100)
- [ ] Not parsed
- **S1**: Efectul carmei (p.84)
- **S2**: Efectul elicei (p.84-85)
- **S3**: Efectul combinat carma + elicea (p.86)
- **S4**: Pregatirea pentru voiaj (p.86-88)
  - S4.1: Prognoza meteo
  - S4.2: Verificarea tehnica a ambarcatiunii
  - S4.3: Planificarea voiajului
  - S4.4: Instructaj de siguranta pentru echipaj
- **S5**: Manevra de plecare (p.88-90)
  - S5.1: Legaturile la cheu si efectele lor
  - S5.2: Plecare cu motor de la cheu/ponton
- **S6**: Ancorarea (p.90-91)
- **S7**: Remorcarea (p.91)
- **S8**: Principii de manevra in zone inguste si cu adancimi mici (p.91)
- **S9**: Manevra de om la apa / MOB (p.92-93)
- **S10**: Esuarea. Dezesuarea (p.94)
- **S11**: Rondoul (p.94-95)
- **S12**: Acostarea (p.95-96)

### M8 — Vitalitatea navei; Prim-ajutor si salvare (p.101-122)
- [ ] Not parsed
- **S1**: Vitalitatea navei (p.102-103)
  - S1.1: Etanseitatea
  - S1.2: Incendii la bord
- **S2**: Prim-ajutor (p.103-112)
  - S2.1: Evaluarea primara a pacientului traumatizat
  - S2.2: Evaluarea secundara (Scala Glasgow)
  - S2.3: Situatii posibile. Evaluare si solutii
    - Hipotermia
    - Insolatia
    - Inecul
    - Arsurile
    - Fracturi
    - Hemoragii
- **S3**: Mijloace de salvare si modul lor de folosire (p.113-116)

## Processing Pipeline (per module)

### Step 1: Extract raw content
```python
# For each module:
# 1. Extract text per page using fitz (PyMuPDF)
# 2. Extract images (skip < 2KB decorative)
# 3. Save images to images/{module_id}/
```

### Step 2: Parse into sections
```python
# 1. Detect section headers (numbered: "1. Title")
# 2. Detect subsection headers (numbered: "1.1. Title" or known marker phrases)
# 3. Split content between headers
# 4. Clean text (remove page numbers, repeated headers, bibliography)
# 5. Assign images to sections by page proximity
```

### Step 3: Format content
```python
# 1. Convert to markdown (bold terms, bullet lists for definitions)
# 2. Fix diacritics inconsistencies
# 3. Add image references inline where appropriate
# 4. Remove line breaks within paragraphs (PDF artifact)
```

### Step 4: Add quiz questions
```python
# 1. Parse official RNA question bank PDF
# 2. Match questions to sections by keyword/topic
# 3. Add 1-3 questions per section
# 4. For sections without matching official questions, create custom ones
```

### Step 5: Build course index
```python
# Generate index.json with module list, section counts, progress tracking schema
```

## Known Issues from M1 POC
1. **Decorative images**: Many 1235-byte images are PDF header decorations → filter by size (< 2KB)
2. **Dictionary section**: Content split weirdly across lines → need custom parser for definition lists (term = definition format)
3. **Content leaking between sections**: "Unitati de masura" subsection absorbed unrelated "Istoric" content → improve section boundary detection
4. **Line breaks within paragraphs**: PDF extracts with hard line breaks mid-sentence → join lines that don't end with period/colon
5. **Bibliography/references**: Some "1. www.wikipedia.com" lines detected as sections → filter URLs and known reference patterns before section detection

## Quiz Question Sources
1. **Primary**: Official RNA exam questions PDF (matched to sections by topic)
2. **Secondary**: Custom questions based on key terms and definitions in each section
3. **Format**: 4 options, 1 correct, randomized order in the app

## App Integration
The JSON files will be consumed by the Expo app's learning screen:
- Module list → tap to expand sections
- Section view → scrollable content with inline images
- After each section → mini quiz (1-3 questions)
- Progress tracked in AsyncStorage/MMKV
- Completion percentage per module shown on course list
