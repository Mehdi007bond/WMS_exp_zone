# Simulated database for the EXP2 digital twin

**All data here is invented** (articles, documents, users, trucks). It follows the exact structure of the SAP MB51 extraction described for EXP2, so the app can be designed and tested before real exports are available.

- Period: Monday 21.09.2026 to Saturday 03.10.2026 (no postings on Sunday 27.09). Opening stock on 20.09.2026.
- Plant `TA11`; storage locations `PRD2` (production), `EXP2` (our warehouse, the twin), `EMRT` (external warehouse).
- Dates are `dd.mm.yyyy`; article and document numbers are stored as text; negative quantity = the line leaves that storage location.
- `EXP2_twin_sample_db.xlsx` is the workbook (Google Drive → New → File upload → Open with Google Sheets). `csv/` holds one UTF-8 CSV per tab.

## Tabs

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

## How the expected results (`CALC_*`) are computed

- Opening stock first, then every SAP line sorted by `Date cpt.`, `Doc.article`, issuing line before receiving line.
- Each positive line creates a FIFO layer (entry date = `Date cpt.`); each negative line consumes the oldest layers. Reversals (102 / 312 / 602) consume the newest layer instead.
- Virtual pallets of a layer = ceil(quantity ÷ `Qté par palette`). Unknown articles have no pallets and are reported.
- `CALC_BLOCS` uses a **placeholder** placement (family → block color) until the real placement rules are given.

## Traps included on purpose

- A **102** reversal of a declaration (article `1000614750`, 23.09.2026).
- Two **312** reversals: one cancels a PRD2 → EXP2 transfer (02.10.2026), one an EXP2 → EMRT transfer (29.09.2026).
- Article `1000571497` appears in the SAP files but is missing from `ARTICLES`.
- 5 pending lines declared 3 days or more before 03.10.2026 and never transferred.
- 4 lines with special stock **E**, partial pallets, and 5 articles managed in KG.
- 2 pallets that do not fit their family's blocks (row `À PLACER`).

The phase-1 import and calculation must reproduce every `CALC_*` tab exactly from the `SAP_*` tabs, `ARTICLES` and `LAYOUT`.
