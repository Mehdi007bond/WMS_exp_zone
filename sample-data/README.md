# Sample data for the EXP2 digital twin

Three sets, all used by the automatic tests (`npm test`, `npm run e2e`):

| Folder / file | What it is | Real or invented |
|---|---|---|
| `EXP2_twin_sample_db.xlsx`, `csv/` | The v1 **oracle**: two weeks of a fictional EXP2 in the first 12-column MB51 layout, with the expected results (`CALC_*`). This page. | Invented |
| `messy/` | Messy MB51 export files and what the importer must find. See [messy/README.md](messy/README.md). | Invented |
| `mb51-reel/` | **Anonymised extract of the real MB51 export** (22 columns, entry times, label numbers) with its expected results. See [mb51-reel/README.md](mb51-reel/README.md) (French and English). | Real, anonymised |

The demo data of the app (menu **Générer 7 jours**) does not come from these files: it is produced by the v2 simulator (`apps-script/src/Simulation.gs`) in the real 22-column format, with fictional articles and projects.

## The v1 oracle (`EXP2_twin_sample_db.xlsx`, `csv/`)

**All data here is invented** (articles, documents, users, trucks). It follows the structure of the SAP MB51 extraction first described for EXP2 (12 columns, no entry time, no label), so the app could be designed and tested before real exports were available. The v2 engine must still reproduce it exactly: movements without entry time or label give the v1 results.

- Period: Monday 21.09.2026 to Saturday 03.10.2026 (no postings on Sunday 27.09). Opening stock on 20.09.2026.
- Plant `TA11`; storage locations `PRD2` (production), `EXP2` (our warehouse, the twin), `EMRT` (external warehouse).
- Dates are `dd.mm.yyyy`; article and document numbers are stored as text; negative quantity = the line leaves that storage location.
- `EXP2_twin_sample_db.xlsx` is the workbook (Google Drive → New → File upload → Open with Google Sheets). `csv/` holds one UTF-8 CSV per tab.

### Tabs

| Tab | What it is | Rows |
|---|---|---:|
| `LISEZ_MOI` | Read-me in French: purpose, period, assumptions, the deliberate traps. | 47 |
| `SAP_DECLARATIONS` | Your first file: production declarations, the 12 MB51 columns, MvT 101 into PRD2. | 751 |
| `SAP_TRANSFERTS` | Your second file: transfers 311 / 312, two lines per document. | 1,824 |
| `SAP_SORTIES_601` | Proposed third file: shipments 601 out of EXP2. | 239 |
| `SAP_STOCK_INITIAL` | Proposed: opening stock (MB52 style) on 20.09.2026. | 71 |
| `ARTICLES` | To maintain: quantity per pallet, pallet type and height, stacking, family. | 39 |
| `LAYOUT` | The warehouse sketch in meters: blocks, roads, docks, zones. | 38 |
| `QUAIS_CAMIONS` | Proposed manual tab: trucks at the 8 docks and pallets staged. | 8 |
| `REGLES_PLACEMENT` | Empty on purpose: waiting for your placement rules. | 1 |
| `PARAM_MAGASINS` | Role of PRD2, EXP2 and EMRT. | 3 |
| `PARAM_MOUVEMENTS` | What each movement type does to each storage location. | 22 |
| `PARAM_SEUILS` | Capacities and thresholds (to define). | 12 |
| `CALC_STOCK` | Expected result: stock per article in PRD2 / EXP2 / EMRT, quantity and pallets. | 40 |
| `CALC_EN_ATTENTE` | Expected result: pending quantities with declaration date and days waiting. | 25 |
| `CALC_FIFO_EXP2` | Expected result: what is in EXP2, by entry date, with age. | 834 |
| `CALC_SORTIES` | Expected result: every exit with entry date, exit date and dwell time. | 352 |
| `CALC_JOURNALIER` | Expected result: daily entries, exits, stock and saturation. | 13 |
| `CALC_BLOCS` | Expected result: pallets and saturation per block (placeholder placement). | 9 |
| `CALC_KPI` | Expected result: the numbers of the TV screen. | 12 |

### How the expected results (`CALC_*`) are computed

- Opening stock first, then every SAP line sorted by `Date cpt.`, `Doc.article`, issuing line before receiving line.
- Each positive line creates a FIFO layer (entry date = `Date cpt.`); each negative line consumes the oldest layers. Reversals (102 / 312 / 602) consume the newest layer instead.
- Pallets per article and storage location = ceil(total quantity ÷ `Qté par palette`): at most one partial pallet per article, attributed to the oldest layer. Unknown articles have no pallets and are reported.
- Daily flows count ceil(line quantity ÷ `Qté par palette`) per SAP line; `Déclarations` = pallets declared (101) minus pallets reversed (102); entries and exits exclude reversals. `Palettes (équiv.)` of an exit = slice quantity ÷ `Qté par palette`, 2 decimals.
- `CALC_BLOCS` uses a **placeholder** placement (family → block color) until the real placement rules are given.

### Traps included on purpose

- A **102** reversal of a declaration (article `1000614750`, 23.09.2026).
- Two **312** reversals: one cancels a PRD2 → EXP2 transfer (02.10.2026), one an EXP2 → EMRT transfer (29.09.2026).
- Article `1000571497` appears in the SAP files but is missing from `ARTICLES`.
- 5 pending lines declared 3 days or more before 03.10.2026 and never transferred.
- 4 lines with special stock **E**, partial pallets, and 5 articles managed in KG.
- 2 pallets that do not fit their family's blocks (row `À PLACER`).

The engine must reproduce the v1 columns of every `CALC_*` tab exactly from the `SAP_*` tabs, `ARTICLES` and `LAYOUT` (`tests/engine.test.js`; the placement uses the v1 placeholder rules family F1–F5 → blocks, which the test passes itself: the app has no default placement rule any more, placement now comes from the projects).

## Messy export files (`messy/`)

Three files that look like real SAP MB51 exports, built from the clean days 02.10 and 03.10: trailing minus (`320-`), decimal commas, text dates, subtotal and repeated header rows, changed column order and long header labels, the positive leg of a transfer before the negative one, the same document in two files, a lone transfer leg, a back-dated posting, `BAR FLOW TA11` written with spaces, a line from plant TA12, and a document number from another range. `messy/expected.json` gives what the importer must find (446 valid lines, 5 duplicates skipped, 1 rejected, 38 rows skipped, 2 documents flagged). See `messy/README.md`.

## Real export, anonymised (`mb51-reel/`)

`MB51_reel_anonymise.xlsx` is an anonymised extract of the user's real MB51 export (04–05.10.2026): the exact 22 columns, 131 declarations and 311 transfers with entry date and time and label numbers, no 601 exit. It keeps every line of the 93 finished-goods articles (2,800 lines) and one line in 15 of the other articles (1,357 lines). `expected.json` (written by `tools/mb51_reference.py`) gives what the importer and the engine must find: 2,800 lines kept, 1,357 dropped, data time 05.10.2026 22:09, 86 pallets in PRD2 for more than 6 h and 11 between 4 and 6 h. See [mb51-reel/README.md](mb51-reel/README.md).
