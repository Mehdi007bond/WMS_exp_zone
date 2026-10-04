# Messy MB51 exports (importer test set)

**Simulated data.** These files hold the clean lines of `sample-data/csv/SAP_DECLARATIONS.csv` and `SAP_TRANSFERTS.csv` for **02.10.2026 and 03.10.2026**: 130 + 312 = **442 lines**. They are written the way real SAP MB51 ALV exports arrive, with every trap listed below. `SAP_SORTIES_601.csv` is not part of this set.

| File | What it imitates | Content |
|---|---|---|
| `MB51_declarations_messy.xlsx` | ALV export to spreadsheet, MB51 sort (Article) with a subtotal per article | Declarations 02.10 and 03.10, plus 3 trap lines |
| `MB51_transferts_messy.xlsx` | ALV export with another layout, sorted by Magasin, subtotals per Magasin | Transfers posted 02.10, plus 1 lone leg |
| `MB51_transferts_messy.txt` | *Fichier local → Texte avec tabulations*: windows-1252, CRLF, a title line and a blank line before the header, no `\|` | Transfers entered on 03.10, plus 2 overlap documents and 1 backdated document |
| `expected.json` | Expected counts, flagged, rejected and duplicate lines, extra lines, and 52 row-level spot checks | |

## Scenario and rules behind the expected result

- The twin already holds data up to **01.10.2026**. The batch covers **02.10–03.10.2026**. The reference import order is declarations.xlsx, then transferts.xlsx, then the .txt. Totals do not depend on the order, but the per-file duplicate counts do.
- **Reading:** every physical row is kept, blank ones included. With SheetJS, use `sheet_to_json(ws, {header: 1, raw: true, defval: null})`, where blank rows are kept by default. The real Excel dates then arrive as serials: 46297 = 02.10.2026, 46298 = 03.10.2026.
- **Header:** the header row is found by synonyms (case, accents and punctuation ignored). Rows above it are a preamble and are not counted (the 2 title and blank lines of the .txt).
- **Skipped rows**, after the header: an empty row, including one with only tabs (`blank`); a row that repeats the header (`header`); a row with no `Doc.article` but a quantity (`subtotal`, for subtotals and totals).
- **Rejected:** `Division` ≠ `TA11`.
- **Normalised before deduplication:**
  - Text is trimmed.
  - Numeric articles lose their leading zeros. Numbers become integer text.
  - Dates can be an Excel date, `dd.mm.yyyy` or `dd/mm/yyyy` (always day first).
  - A quantity stored as text is in SAP French format: `.` = thousands, `,` = decimals, and the minus sign can trail.
  - Users are compared with spaces, `_` and case ignored.
- **Duplicate key:** `Doc.article|Article|Magasin|MvT|qty|date|rank` across all files and the existing lines (rank = 1 for every line here).
- **Batch checks, after the last file:**
  - A 311/312 document whose lines do not cancel out is flagged `TRANSFERT_ORPHELIN`.
  - A `Date cpt.` before 02.10.2026 is flagged `ANTIDATE`.
  - Flagged lines are accepted.

## Traps

Rows are Excel rows (header = row 1). `.txt` lines are physical lines (title = line 1).

| # | Trap | Where | Expected handling |
|---|---|---|---|
| 1 | Trailing minus `320-` | Every negative in the .txt (also `400,000-`). Text cells: declarations row 135 `200-`; transferts rows 2 `1.440-`, 38 `288-`, 98 `480-`, 132 `120-`; KG negatives in transferts.xlsx (`750,000-`) | Read as negative numbers |
| 2 | Decimal comma and thousands dot as text | `1.234,500` KG: declarations row 149. `729,25` KG: transferts row 75. Every KG cell of both .xlsx and of the .txt (`750,000`, `400,000`). PC `1.440`: declarations row 15 | 1234.5 · 729.25 · 750 · **1440 (not 1.44)** |
| 3 | Mixed date types | declarations.xlsx: real Excel dates. transferts.xlsx: text `02.10.2026`, and `02/10/2026` in rows 20, 93, 111 and 153. .txt: text | All read as 2 Oct 2026 (never 10 Feb). Row 93 is an overlap duplicate, so a wrong date breaks the deduplication |
| 4 | Article spaces and leading zeros | declarations rows 16, 36, 87 (`' 1000216115'`…); transferts rows 6, 12, 99; .txt line 20 `0001000914295` (doc 4901257679, EXP2 leg). Declarations articles are numbers | Same article as the trimmed or unpadded value. If the zeros are kept, doc 4901257679 becomes a false orphan |
| 5 | Doc.article as number or text | declarations.xlsx: numbers in a narrow column (Excel shows scientific notation, e.g. `4.901E+09`). transferts.xlsx and .txt: text | Stored as text `4901257329`, never `4.901257E+09` or `…329.0` |
| 6 | Subtotals, repeated header, empty rows | declarations: a subtotal after each article (23 rows, first at row 8, Article filled), totals rows 159–160, empty row 78. transferts: subtotals rows 9, 94, 95, 173, 174, totals 175–176, header repeated row 96. .txt: header repeated line 80, tabs-only line 157, `*` total lines 158–159 | Skipped (34 subtotal, 2 header, 2 blank), never rejected |
| 7 | Column order and long labels | transferts.xlsx: `Doc.article, Date cpt., Magasin, Type de mouvement, Article, Désignation article, Quantité en unité de saisie, UQS, S, Division, Texte code mvt, Nom utilisateur` | Columns mapped by header synonyms, not by position |
| 8 | ALV sort by Magasin | transferts.xlsx, in Magasin order EMRT, EXP2, PRD2: the + leg comes before the − leg, rows far apart (e.g. doc 4901257446: + row 39, − row 123) | Legs paired by Doc.article, not by adjacency |
| 9 | Same 311 doc in both files | Doc 4901257446: PRD2 leg in declarations row 135, both legs in transferts rows 39 and 123 | 1 duplicate skipped. The doc is complete, not orphan |
| 10 | Lone leg | Doc 4901257604, transferts row 75: EXP2 +729,25 KG of 1000887507, no PRD2 leg | Accepted, flagged `TRANSFERT_ORPHELIN`, origin unknown. The PRD2 pending quantity is not reduced |
| 11 | Backdated posting | Doc 4901257888, .txt lines 101–102: 311 of 320 PC of 1000516512 PRD2 → EXP2 dated **30.09.2026**, entered on 03.10. It is an extra line, not in the clean base | Accepted, flagged `ANTIDATE` (2 lines). Recompute from the last checkpoint on or before 30.09.2026 |
| 12 | `BAR FLOW TA11` | declarations rows 45, 115; transferts rows 17, 45, 104; .txt lines 8, 49, 154 | Same automatic user `BARFLOW_TA11` (Auto) |
| 13 | Other plant | Doc 4901257816, declarations row 103: `TA12`, 480 PC of 1000744039 | Rejected: out of plant |
| 14 | Other number range | Doc **5000014382**, declarations row 149: 101 of 1.234,500 KG of 1000956436 dated 02.10, a higher number than every 03.10 doc. It is an extra line | Accepted, no flag. Sort by `Date cpt.` then Doc.article. Never use the doc number as a clock or import watermark |
| A | Overlap between exports (extra) | .txt lines 4–7: docs 4901257657 and 4901257659 (02.10), already in transferts.xlsx | 4 duplicates skipped |

## Expected result

| | Count |
|---|---:|
| Data rows read (after header, not skipped) | 452 |
| Valid lines kept (442 base + 4 extra: docs 5000014382, 4901257604, 4901257888 ×2) | **446** |
| Duplicates skipped (doc 4901257446 PRD2 leg + 4 overlap lines) | **5** |
| Rejected (doc 4901257816, TA12) | **1** |
| Skipped rows: subtotal / header / blank | **34 / 2 / 2** (38) |
| Lines flagged | **3**: doc 4901257604 `TRANSFERT_ORPHELIN` (1), doc 4901257888 `ANTIDATE` (2) |

The unknown article `1000571497` (in the clean base) and the special stock checks are calculation alerts, not import flags. After normalisation, the 446 lines must equal the clean base plus `extra_lines_vs_base` in all 12 fields. `expected.json` was checked with an independent reference normaliser. It passes, and it fails when any rule above is broken (dot read as a decimal, trailing minus ignored, day/month swapped, zeros kept, no trim, user not merged).
