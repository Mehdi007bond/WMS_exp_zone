# EXP2 Digital Twin: implementation plan (draft 1)

A web app built only with **Google Apps Script** and **Google Sheets**. It rebuilds the EXP2 warehouse from SAP extractions and shows, on a TV and on office PCs, what is in the warehouse, where, since when, what is still waiting in production, and how full the racks and the shipping docks are.

The illustrated version of this plan (warehouse sketch to scale, TV and PC mockups, diagrams) is here: https://claude.ai/artifact/43H2yDzvaYKBgpRcck7pvT

Status: for discussion. Every number below comes from the simulated database in `sample-data/`, not from SAP.

## 1. The idea

- There is no live link between SAP and Google. Someone exports the SAP lists and uploads them on the PC page; only files cross that boundary.
- Apps Script reads the files, stores the lines in Google Sheets and recalculates the state of EXP2: pending in production (PRD2), in the warehouse (EXP2) with entry dates, gone (to customers or to the external warehouse EMRT) with exit dates.
- The TV and the PCs only read that calculated state. Every screen shows **"Données SAP du …"** so everyone knows how fresh the twin is.
- Storage locations: **PRD2** = production, **EXP2** = our warehouse (the twin, 1,600 m²), **EMRT** = external warehouse. Plant **TA11**.

## 2. What the SAP extraction contains

The columns are the standard SAP list of material documents, transaction **MB51** ("Liste des documents article"), exported from the French screen.

| Column | Example (simulated) | What it is in SAP | What the twin does with it |
|---|---|---|---|
| **Article** | `1000914295` | Material number (`MATNR`). | The key of everything. Stored as text, so Sheets never turns a long number into 1.0E+9 or drops zeros. Links each line to the `ARTICLES` tab (quantity per pallet, family). |
| **Division** | `TA11` | Plant (`WERKS`). Not the sales division. | Filter: only TA11 lines are accepted, anything else is reported. |
| **Magasin** | `PRD2 · EXP2 · EMRT` | Storage location of this line (`LGORT`). | Where the quantity is: PRD2 = pending, EXP2 = in the twin, EMRT = external. Any other code goes to an "Autre" bucket and is reported, never dropped silently. |
| **MvT** | `101 · 311 · 601` | Movement type (`BWART`). "300" is not a standard SAP code (probably 301, or the 3xx family). | Says what happened, through a settings tab (code → meaning). Nothing is hard-coded: a new code is one new row. |
| **Texte code mvt** | `EM entrée en stock` | Movement type text (`BTEXT`), in the logon language. | Display only. The logic uses MvT, never this text. |
| **S** | `(blank) · E` | Most likely the special stock indicator (`SOBKZ`): blank = own stock, E = sales-order stock, K = consignment. Less likely: debit/credit (S/H). | Blank, E, Q and K are physically in EXP2, so they count (with a badge). W, V and O are not on site, so they stay out of saturation. If it turns out to be S/H, it is only used to check the sign. |
| **Doc.article** | `4901254396` | Material document number (`MBLNR`). Both lines of a transfer share it. | Pairs the two lines of a 311 and removes lines that appear in both files. It is not a clock: numbers can be out of order. |
| **Date cpt.** | `03.10.2026` | Posting date (`BUDAT`): a date with no time, which can be back-dated. | Entry date, exit date, age and dwell time, in days. |
| **Qté en UQS** | `320 · −320` | Quantity in the unit of entry (`ERFMG`). Negative = leaves the storage location. Some exports write `320-`. | Stock per storage location, then pallets. The import reads both `-320` and `320-`. |
| **UQS** | `PC · KG` | Unit of entry (`ERFME`). PC can also appear as ST or PCE. | Must match the unit of the quantity per pallet. A small units table maps the variants. |
| **Désignation article** | `PF CONNECTEUR 4 VOIES REF 04` | Material description (`MAKTX`). | Display and search. |
| **Nom utilisateur** | `BARFLOW_TA11 · OPEXP01` | SAP user ID that posted (`USNAM`). | Automatic or manual posting. Personal data: never shown on the TV; the PC pages show only Auto / Manuel. |

- **Finding 1: MB51 has no pallet number.** SAP lists quantities of an article, not pallets. The twin therefore builds **virtual pallets**: quantity ÷ quantity per pallet, rounded up. It matches entries and exits **oldest first (FIFO)** to give every remaining quantity an entry date. Totals are exact, and the dates are a good estimate. If your finished goods carry a batch (Lot) or an SSCC pallet label in SAP, adding that column turns the estimate into exact pallet tracking.
- **Finding 2: the date has no time.** "Date cpt." gives days, not hours. Adding "Heure de saisie" (time of entry) to the export would give hours on the TV ("en attente depuis 5 h") and the exact order of the postings within a day.
- **Finding 3: filters matter.** A transfer is two lines: one in the storage location it leaves and one in the location it arrives in. If the export is filtered on EXP2 only, half of every transfer is missing. Export all three storage locations, with one saved layout that everyone uses.

## 3. From an SAP line to a status

| Declared (101)? | Transferred into EXP2 (311)? | Out of EXP2 (601 or 311)? | Status in the twin |
|---|---|---|---|
| Yes | No | – | **Pending** (en attente) |
| Yes | Yes | No | **In EXP2**, with entry date and age |
| Yes | Yes | Yes | **Left**, with exit date and dwell time |
| No | Yes | – | **Alert**: transferred but never declared in the period |
| Yes, for too long | No | – | **Alert**: stuck pending (threshold to define) |

- A 311 is **two lines** with the same Doc.article: a negative line in the storage location it leaves and a positive line in the one it enters.
- Reversals (102, 312, 602) cancel the latest posting of the same article and put the quantity back.
- **Virtual pallets** = quantity ÷ quantity per pallet, rounded up, per entry. Entries and exits are matched **oldest first (FIFO)**, which gives every remaining quantity an entry date. A partial pallet still takes a full position.

Example from the sample: article `1000812390` (PF CACHE MOTEUR REF 20), 24 PC per pallet:

| Entry date | Doc.article | Came from | Qty left | Pallets | Age (days) |
|---|---|---|---:|---:|---:|
| 20.09.2026 | `` | Stock initial | 183 | 8 | 13 |
| 21.09.2026 | `4901254537` | EMRT | 72 | 3 | 12 |
| 25.09.2026 | `4901255600` | PRD2 | 24 | 1 | 8 |
| 26.09.2026 | `4901255881` | PRD2 | 24 | 1 | 7 |
| 29.09.2026 | `4901256493` | PRD2 | 24 | 1 | 4 |
| 29.09.2026 | `4901256495` | PRD2 | 24 | 1 | 4 |
| 29.09.2026 | `4901256497` | PRD2 | 24 | 1 | 4 |

## 4. The warehouse, redrawn to scale

Only the surface is known (1,600 m²); the plan assumes **50 × 32 m**, which matches the proportions of the sketch. Every object is a row of the `LAYOUT` tab (meters, origin top-left), so the 2D and 3D views are drawn from data.

| Block | Label on the sketch | Size (m) | Columns × rows | Levels | Capacity (pallets) |
|---|---|---:|---:|---:|---:|
| B1 | Allée 26 (?) | 10.4 × 10.4 | 10 × 13 | 2 | 260 |
| B2 | Allée 72 (?) | 4.1 × 10.1 | 4 × 12 | 2 | 96 |
| B3 | Allée 24 (?) | 4 × 9.9 | 4 × 12 | 2 | 96 |
| B4 | Allée 36 / 72 (?) | 5 × 10 | 5 × 12 | 2 | 120 |
| B5 | Allée 26 (?) | 9.5 × 10.3 | 10 × 13 | 2 | 260 |
| B6 | Allée 50 (?) | 3.9 × 7.7 | 4 × 10 | 2 | 80 |
| B7 | (sans libellé) | 9.7 × 9.5 | 10 × 12 | 2 | 240 |
| B8 | Allée 72 (?) | 13.3 × 9.5 | 13 × 12 | 2 | 312 |
| **Total** | | | | | **1,464** |

Also on the plan: Zone Camion with 8 docks (Q1–Q8) and the 5 trucks of the sketch, forklift roads, G1–G4 and two boxes at the top (meaning unknown), conveyor, AGV stations, empty packaging, carton storage, offices, forklift exchange queue. Names with "(?)" could not be read with certainty. Two levels everywhere is an assumption.

## 5. Screens

- **TV mode** (wall screen, no mouse, dark, refresh every 60 s, rotating scenes): 3D view with pallets in their blocks colored by family, pending pallets as ghosts at the conveyor, saturation per block, trucks at the 8 docks with pallets loaded/planned; key numbers (EXP2 pallets, saturation, pending and oldest pending, entries/exits of the day, dock staging saturation, docks occupied, EMRT); alert ticker; large "Données SAP du …".
- **PC mode · inventory lookup**: one article → quantity and pallets in EXP2 / PRD2 / EMRT, each remaining quantity with entry date and age (FIFO), latest exits with exit date and dwell, raw SAP lines (Auto/Manuel, no names), position on the plan.
- **PC mode · import**: drop the exported files; recognized by column names; preview of lines read / new / already known / rejected and of the checks (reversals, unknown articles, unmatched transfer lines, negative stock) before saving; import log.
- Other PC pages: Plan 2D, En attente (pending list), Quais & camions (truck form), Paramètres.

## 6. Features

| Feature | What you see | Data it needs | Phase |
|---|---|---|---:|
| **3D twin (TV)** | The warehouse in 3D, with pallets in their blocks colored by family, pending pallets at the conveyor, trucks at the docks with their loading, and saturation per block. | Everything below + `LAYOUT` + `ARTICLES` | 3 |
| **2D plan (PC)** | The plan to scale. Blocks are colored by saturation, and clicking a block lists its contents. | `LAYOUT`, calculated stock, placement | 2 |
| **Inventory lookup** | One article: quantity and pallets in PRD2, EXP2 and EMRT, each remaining quantity with its entry date and age, exits with exit date and dwell, the raw SAP lines, and where it is on the plan. | MB51 files, `ARTICLES` | 2 |
| **Entry and exit dates** | For every remaining quantity (oldest first) and every exit, with age and dwell time in days, or in hours if "Heure de saisie" is added. | Date cpt. (+ Heure de saisie) | 1 |
| **Pending tracker** | Declared but not yet in EXP2, oldest first, with days waiting. Shown as ghost pallets on the TV. | Declarations + transfers | 2 |
| **Rack saturation** | Per block and for the whole warehouse, in % and pallets, with example thresholds at 85 % and 95 %. | `LAYOUT` capacities, quantity per pallet, placement | 2 |
| **Quai d'expédition saturation** | Pallets waiting in front of each dock versus its capacity, and docks occupied out of 8. | `QUAIS_CAMIONS` tab (or SAP deliveries) | 4 |
| **Truck view** | The 8 docks: which truck, its color, its status, and pallets loaded out of planned (33 maximum for a 13.6 m trailer). | `QUAIS_CAMIONS` tab (or SAP shipments) | 4 |
| **Freshness stamp** | "Données SAP du …" on every screen. It turns orange, then red, when no upload has happened for too long. | Import log | 1 |
| **Import page and log** | Drop the files and see the checks before saving. Lines already in the database are skipped, so uploading twice is harmless. A log keeps who, when, which file and how many lines. | — | 1 |
| **Alerts** | Pending too long, block too full, article missing from `ARTICLES`, transfer with no declaration, stock that would go negative, data too old. | Thresholds (later) | 1 → 5 |
| **History and replay** | The state of EXP2 at the end of any past day, and daily curves of entries, exits and saturation. | All movements | 5 |
| **Settings (admin)** | Articles, movement types, thresholds, placement rules and layout, all as tabs of the spreadsheet. | — | 1 → 2 |

## 7. Data required

| Data | Source | Status | Why it matters |
|---|---|---|---|
| Production declarations (MB51, MvT 101 or 131 into PRD2) | SAP export, each upload | have: structure | Creates the pending quantities. Confirm 101 or 131. |
| Transfers (MB51, MvT 311 / 312) | SAP export, each upload | have: structure | Moves quantities PRD2 → EXP2 and EXP2 ↔ EMRT. Export all three storage locations. |
| Shipments (MB51, MvT 601 / 602 out of EXP2) | SAP export, same layout | to confirm | Gives the exit date to customers. Without it, EXP2 only empties towards EMRT. |
| Opening stock (MB5B at the go-live date, or MB52 that morning) | SAP export, once at go-live, then MB52 weekly | needed | MB51 only covers its dates. Without a starting stock the twin starts empty and exits go negative. The weekly MB52 also checks that nothing was missed. |
| Quantity per pallet, per article | MM03 (unit PAL), packing instruction, or your list | needed | Turns quantities into pallets, so saturation and the 3D view are possible. |
| Pallet type, height, stacking levels | You, or MM03 | needed | Size of the boxes in 3D, and how many levels a block really holds. |
| Product family (or customer) per article | You, or MM03 | needed | Colors on the screens and, probably, your placement rules. |
| Block details: real names, positions, levels | Your sketch + a walk in the warehouse | to confirm | Capacity of each block, which is the base of rack saturation. Surface 1,600 m² is known. |
| Placement rules | You | later | Which block a pallet goes to. Until then the twin uses a placeholder: product family → block color. |
| Trucks at the docks (truck, dock, status, planned and loaded pallets) | New tab filled from the PC page, or SAP deliveries / shipments (VL06O, VT11) | to confirm | The truck view and dock occupancy. MB51 says nothing about trucks. |
| Staging capacity in front of each dock | You | needed | The denominator of the Quai d'expédition saturation. |
| Thresholds: pallet too old, block too full, pending too long | You | later | When a number turns orange or red. The page uses example thresholds meanwhile. |
| SAP user IDs that are automatic interfaces | You | to confirm | Separates automatic and manual postings (BARFLOW_TA11 is one). |

### Columns worth adding to the MB51 layout

| Column (French label) | SAP field | What it fixes | Priority |
|---|---|---|---|
| Poste + Exercice | `ZEILE`, `MJAHR` | A unique key per line: no duplicates even when the two files overlap, and exact pairing of the two lines of a transfer. | High |
| Date de saisie + Heure de saisie | `CPUDT`, `CPUTM` | Hours instead of days, order of postings within a day, and back-dated postings caught. | High |
| Magasin récepteur / émetteur | `UMLGO` | "From → to" on a single line, even if a filter hid the other line. | High |
| Lot (if finished goods are batch-managed) | `CHARG` | A batch is close to a pallet or a production run: real FIFO and real ages. | High if used |
| Référence / Livraison | `XBLNR`, `VBELN_IM` | Links a 601 to its delivery, then to the truck and the dock. | Medium |
| Quantité + unité de base | `MENGE`, `MEINS` | The same unit on every line of an article, whatever was typed. | Medium |
| Doc. d'annulation | `SMBLN` | Links a reversal (102/312/602) to the exact line it cancels. | Medium |

## 8. Google Sheets structure

**SAP raw · written only by the import**

- `MOUVEMENTS`: all MB51 lines from all files in one table, with the duplicates removed. In the sample they stay in 3 tabs (`SAP_DECLARATIONS`, `SAP_TRANSFERTS`, `SAP_SORTIES_601`) so you recognize your files.
- `SAP_STOCK_INITIAL`: the MB52 snapshot used as the starting point.

_Never edited by hand. Each line keeps the import it came from._

**Masters & settings · edited by the admin**

- `ARTICLES`: quantity per pallet, pallet type and height, stacking, family.
- `LAYOUT`: blocks, roads, docks and zones in meters (the sketch).
- `REGLES_PLACEMENT`: empty until you give the rules.
- `PARAM_MAGASINS`, `PARAM_MOUVEMENTS`, `PARAM_SEUILS`.
- `QUAIS_CAMIONS`: filled by the shipping team from the PC page.

_Protected tabs: only 1–2 admins can change them._

**Calculated · rewritten after each import**

- `CALC_STOCK`: per article, PRD2, EXP2 and EMRT in quantity and pallets.
- `CALC_EN_ATTENTE`, `CALC_FIFO_EXP2`, `CALC_SORTIES`: the dates.
- `CALC_BLOCS`, `CALC_JOURNALIER`, `CALC_KPI`: what the screens show.

_The TV and PCs only read these small tabs, which keeps the screens fast._

**Logs & safety**

- `IMPORT_LOG`: who, when, which file, which days, lines new, already known, rejected.
- `ALERTES`: open alerts, acknowledged or not.
- A copy of the whole spreadsheet every night in a Drive folder (30 daily + 12 monthly kept).
- Every January, the movements older than 13 months move to an archive file.

_A spreadsheet holds at least 10 million cells. About 2 million cells of movements per year fits easily._

## 9. Architecture

**Two Apps Script projects, one spreadsheet**

- **Viewer**: the TV and the stakeholder link. It only reads the calculated tabs, contains no function that writes, and returns no operator names.
- **Admin**: imports, the trucks form and settings. Only you and 1–2 named people can open it.
- Both run as the owner account, so nobody needs access to the spreadsheet itself.
- The code lives in this GitHub repository and is pushed to Apps Script with `clasp`. The links never change when a new version is published.

**How the pieces talk**

- The Excel file is read **in the browser** (Apps Script cannot open .xlsx itself), checked, then sent to the server in batches of about 1,000 lines.
- The server writes the movements, recalculates the state once, and stamps a new **data version**.
- The TV asks every 60 s "is there a new version?" and downloads the state only when there is.
- 3D uses three.js and the Excel reader uses SheetJS, both loaded from public CDNs. If your network blocks them, a copy can be served with the page.
- Apps Script limits that matter: 6 minutes per run and 30 simultaneous calls. One TV plus about 20 PCs is far below that.

**The TV**

- A small PC (or Chromebox) running Chrome in kiosk mode, on a 50–55″ 1080p screen made for 24/7 use. Avoid the TV's built-in browser (3D is not guaranteed) and OLED panels (burn-in).
- Rotating scenes every 30–60 s: overview (the mockup above), docks and trucks, rack saturation, pending list.
- A full reload every 6–12 hours. If a refresh fails, the last good state stays on screen with its age.

**Access and ownership: to decide**

- **Company Google Workspace** (best): the link can be limited to company accounts, and Google shows no warning banner.
- **Personal Gmail**: the viewer link must be "anyone with the link" for the TV, Google shows a "created by another user" banner, and IT should approve storing SAP data there.
- Either way, use a **team account**, not a personal one. If the owner account is lost, the app stops.

## 10. Build plan

### Phase 0: Clarify

- Answer the questions at the end of this page.
- Export one real day of each file (names can be hidden), plus one MB52.
- Confirm the blocks: names, levels, capacity. Start the `ARTICLES` list.
- One test on the TV hardware: the 3D view, the CDN libraries and the link access.

**Done when:** A real export imports into the sample structure with no manual fix, and the 3D test runs on the TV.

### Phase 1: Data foundation

- The spreadsheet and the two Apps Script projects (code in this repo).
- The import page: reading, checks, replacing days, import log.
- The calculations: stock per storage location, pending, FIFO dates, virtual pallets, daily figures.
- Freshness stamp and the first alerts (unknown article, negative stock).

**Done when:** On a given day, EXP2 stock in the twin equals SAP MB52 for EXP2, article by article (every gap explained). Re-uploading a file changes nothing. The sample database gives exactly its `CALC_*` tabs.

### Phase 2: PC: lookup, pending, 2D plan, saturation

- Pages: Recherche article, En attente, Plan 2D.
- Your placement rules replace the placeholder.
- Rack saturation per block and overall.

**Done when:** Any article found in under 10 s with its entry dates. The saturation of 2 blocks matches a physical count within ±5 %.

### Phase 3: 3D and TV mode

- The 3D view from the `LAYOUT` tab, with gentle rotation.
- The TV layout with rotating scenes and auto refresh.
- Kiosk setup on the TV PC.

**Done when:** The TV runs 5 working days unattended and shows a new upload within 1 minute.

### Phase 4: Docks and trucks

- The `QUAIS_CAMIONS` form on the PC, or an SAP deliveries/shipments import if available.
- The truck view and the Quai d'expédition saturation.

**Done when:** The shipping team updates a truck in under 30 s and the TV shows it within 1 minute.

### Phase 5: Alerts, history, automation

- Your thresholds, the alert list and the TV ticker.
- Replay of any past day.
- Automatic upload: a synced Drive folder, or an SAP job that emails the file (needs SAP IT).
- Nightly backup and yearly archive.

**Done when:** One full week without manual upload, with alerts reviewed with the team.

## 11. Risks

| Risk | What we do |
|---|---|
| Exports differ from one person or day to the next (other columns, filters, formats). | One saved global layout and selection variant. The import recognizes columns by name, refuses incomplete files, and checks that both lines of every transfer are there. |
| No pallet ID in MB51, so pallets and dates are estimates. | Virtual pallets and FIFO, labeled as such. Add Lot or SSCC later if SAP has them. |
| No starting stock, so the twin is wrong from day one. | MB52 at go-live, then a weekly comparison report twin vs MB52. |
| Nobody uploads, and the twin silently shows old data. | A large "Données SAP du …" stamp turning orange then red, then automatic upload in phase 5. |
| Operator names and SAP data visible through a shareable link. | No names on the TV, a read-only viewer project, and IT approval of the Google account used. |
| The owner account is lost or its owner leaves. | A team account, the code in GitHub, a written deployment procedure and nightly backups. |
| The placement shown differs from the floor. | Show it as theoretical until your rules are validated, then check 2 blocks physically. A manual correction exists in the admin project. |
| The TV hardware cannot run the 3D view, or the network blocks the CDNs. | Test in phase 0. The 2D plan is the fallback, and the libraries can be served with the page. |
| Google limits (6 min per run, 30 parallel calls, cells per file). | Calculate only on import, keep screen data small, and archive every year. |

## 12. Open questions (most important first)

1. Can you send one real export of each file? One day is enough, and names can be hidden.  
   _Why: Everything else (columns, codes, number and date formats) is a guess until then._
2. Is the production declaration posted with MvT 101 or 131, always into PRD2? And when you said "300", was it 301, or 311?  
   _Why: It decides how pending pallets are created and which codes the import accepts._
3. How do pallets leave EXP2 for customers: a 601 goods issue? Is it posted before or after the truck is loaded?  
   _Why: It gives the exit date. Without it, the truck view and the dwell time have no SAP source._
4. What values appear in column S (always empty? E? K? S/H?), and are negative quantities written -240 or 240-?  
   _Why: Import parsing, and what counts as stock in EXP2._
5. Could the two files become one MB51 selection: plant TA11, storage locations PRD2 + EXP2 + EMRT, all movement types? If not, do you filter the transfers on EXP2 only?  
   _Why: One selection means no overlap between files. A filter on EXP2 removes half of every transfer._
6. Is one declaration line one pallet? Where can I find the quantity per pallet (MM03 unit PAL, packing instruction, your own list)?  
   _Why: No pallets, no saturation._
7. Can a key user add columns to the export layout: Poste, Heure de saisie, Magasin récepteur, Lot, Référence?  
   _Why: Exact pallets, hours, no duplicates._
8. Are finished goods batch-managed or labeled with SSCC/HU in SAP? Is EXP2 managed by bins (WM/EWM)?  
   _Why: If yes, SAP can give real pallet IDs, or even real locations, instead of estimates._
9. For each block: real name, floor stacking or racks, how many levels? What are G1–G4 and the two green boxes at the top?  
   _Why: Block capacity is the base of rack saturation and of the 3D view._
10. Docks: how many pallets can wait in front of each dock? Where does truck information come from today? What exactly should the "truck image" show?  
   _Why: Dock saturation and the truck view._
11. Is the company on Google Workspace, or will this run on a personal Gmail? Can the TV link be "anyone with the link"?  
   _Why: Access, the Google banner, and IT approval._
12. How often can someone export (each shift, every hour)? Can you export MB52 on the go-live day?  
   _Why: Freshness of the twin, and the starting stock._

## 13. Simulated database

`sample-data/EXP2_twin_sample_db.xlsx` (and one CSV per tab in `sample-data/csv/`) simulates two weeks of a fictional EXP2 (21.09 → 03.10.2026, Monday to Saturday) with the exact 12 MB51 columns. See `sample-data/README.md` for the tab list. The `CALC_*` tabs are the expected results: the phase-1 app must reproduce them exactly.

State on 03.10.2026: 997 pallets in EXP2 out of 1,464 places (68.1 %), 25 pallets pending in PRD2 (oldest 9 days), 381 pallets at EMRT, 73 pallets in and 65 out that day, trucks at 5 of 8 docks.

