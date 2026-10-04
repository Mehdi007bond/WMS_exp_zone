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

- **Finding 1: MB51 has no pallet number.** SAP lists quantities of an article, not pallets. The twin therefore builds **virtual pallets**: for each article in each storage location, total quantity ÷ quantity per pallet, rounded up, so there is at most one partial pallet per article (the oldest one, the one being picked). It matches entries and exits **oldest first (FIFO)** to give every remaining quantity an entry date. Totals are exact, and the dates are a good estimate. If your finished goods carry a batch (Lot) or an SSCC pallet label in SAP, adding that column turns the estimate into exact pallet tracking.
- **Finding 2: your two files contain no exits.** Declarations and transfers say what enters PRD2 and EXP2, and what goes to EMRT. Nothing says what leaves for customers. Without the 601 goods issues (same MB51 layout), EXP2 would only fill up, saturation would drift above 100 % and there would be no exit date. The shipments extraction is required, not optional.
- **Finding 3: the date has no time.** "Date cpt." gives days, not hours. Adding "Heure de saisie" (time of entry) to the export would give hours on the TV ("en attente depuis 5 h") and the exact order of the postings within a day.
- **Finding 4: filters matter.** A transfer is two lines: one in the storage location it leaves and one in the location it arrives in. If the export is filtered on EXP2 only, half of every transfer is missing. Best: **one single MB51 selection** (plant TA11, PRD2 + EXP2 + EMRT, all movement types) with one saved layout that everyone uses.

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
- **Virtual pallets** = total quantity of an article in a storage location ÷ quantity per pallet, rounded up: at most one partial pallet per article, the oldest one (being picked). Entries and exits are matched **oldest first (FIFO)**, which gives every remaining quantity an entry date.

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

**Physical check.** The 8 blocks cover about 586 m²; as drawn they hold 732 floor positions (0.80 m² each), but a EUR pallet alone takes 0.96 m². Realistic capacity is closer to 870–1,000 places on 2 levels. The 8 docks are 1.8 m apart, too close for truck doors (3.5–4.5 m). A site survey must confirm capacity and docks; until then capacity is shown as "à confirmer".

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
| **2D plan (PC)** | The plan to scale. Blocks are colored by saturation, and clicking a block lists its contents. Positions are marked "théorique" until the placement is confirmed. | `LAYOUT`, calculated stock, placement | 2 |
| **Inventory lookup** | One article: quantity and pallets in PRD2, EXP2 and EMRT, each remaining quantity with its entry date and age, exits with exit date and dwell, the raw SAP lines, and where it is on the plan. | MB51 files, `ARTICLES` | 2 |
| **Entry and exit dates** | For every remaining quantity (oldest first) and every exit, with age and dwell time in days, or in hours if "Heure de saisie" is added. | Date cpt. (+ Heure de saisie) | 1 |
| **Pending tracker** | Declared but not yet in EXP2, oldest first, with days waiting. Shown as ghost pallets on the TV. | Declarations + transfers | 2 |
| **Rack saturation** | Per block and for the whole warehouse, in % and pallets, with example thresholds at 85 % and 95 %. | `LAYOUT` capacities, quantity per pallet, placement | 2 |
| **Quai d'expédition saturation** | Pallets prepared in front of each dock versus the space there, and docks occupied. Staged pallets are still EXP2 stock until the 601, so they are shown as a part of EXP2, never counted twice. | Truck visit log (or SAP deliveries) | 3 |
| **Truck view** | The docks: which truck, its color, its status, and pallets loaded out of planned (33 EUR pallets maximum in a 13.6 m trailer). | Truck visit log (or SAP shipments) | 3 |
| **Freshness stamp** | "Données SAP du …" on every screen. It turns orange, then red, when no upload has happened for too long. | Import log | 1 |
| **Import page and log** | Drop the files and see the checks before saving. Lines already in the database are skipped, so uploading twice is harmless. A log keeps who, when, which file and how many lines. | — | 1 |
| **Alerts** | Pending too long, block too full, article missing from `ARTICLES`, transfer with no declaration, stock that would go negative, data too old. | Thresholds (later) | 1 → 5 |
| **History and replay** | The state of EXP2 at the end of any past day, and daily curves of entries, exits and saturation. | All movements | 5 |
| **Manual correction (admin)** | Move, add or remove a virtual pallet when the floor disagrees with the screen. Every correction is logged with who, when and why. | Correction log tab | 4 |
| **Floor occupancy** | Square meters used by pallets versus net storage area, including the exchange and queue zone, next to the pallet-place saturation. | `LAYOUT`, pallet footprints | 2 |
| **Truck visit history** | One row per truck visit: arrival, loading start and end, departure, pallets. Gives time at dock and trucks per day. | Truck visit log | 3 |
| **Settings (admin)** | Articles, movement types, thresholds, placement rules and layout, all as tabs of the spreadsheet. | — | 1 → 2 |

## 7. Data required

| Data | Source | Status | Why it matters |
|---|---|---|---|
| Production declarations (MB51, MvT 101 or 131 into PRD2) | SAP export, each upload | have: structure | Creates the pending quantities. Confirm 101 or 131. |
| Transfers (MB51, MvT 311 / 312) | SAP export, each upload | have: structure | Moves quantities PRD2 → EXP2 and EXP2 ↔ EMRT. Export all three storage locations. |
| Exits (MB51, MvT 601 / 602 and any other issue out of EXP2) | SAP export, same layout, ideally the same selection | needed | Gives the exit date and dwell time. Without it EXP2 only fills up. Required for phase 1. |
| Opening stock (MB5B at the go-live date, or MB52 that morning) | SAP export, once at go-live, then MB52 weekly | needed | MB51 only covers its dates. Without a starting stock the twin starts empty and exits go negative. The weekly MB52 also checks that nothing was missed. |
| 60–90 days of receipts before go-live (MB51) | SAP export, once | needed | Gives the pallets already in EXP2 an estimated entry date, instead of "entered on go-live day". |
| Export date-time and period of each file | A file name rule, or a field on the import page | needed | An MB51 file does not say when it was exported or which days it covers. The freshness stamp and the gap detection need it. |
| Quantity per pallet, per article | MM03 (unit PAL), packing instruction, or your list | needed | Turns quantities into pallets, so saturation and the 3D view are possible. |
| Pallet type, height, stacking levels | You, or MM03 | needed | Size of the boxes in 3D, and how many levels a block really holds. A trailer takes 33 EUR pallets but about 26 ISO ones. |
| Product family (or customer) per article | You, or MM03 | needed | Colors on the screens and, probably, your placement rules. |
| Site survey: real dimensions, block type (floor or rack), lanes × depth × levels, real dock doors | A walk in the warehouse with a tape measure | needed | The sketch does not add up physically (see the warehouse section). Capacity is the base of every saturation figure. |
| Placement rules | You | later | Which block a pallet goes to. Until then the twin uses a placeholder: product family → block color. |
| Trucks at the docks (truck, dock, arrival, departure, planned and loaded pallets) | A visit log filled from a tablet at the docks, or SAP deliveries / shipments (VL06O, VT11) | to confirm | The truck view and dock occupancy. MB51 says nothing about trucks. |
| Staging capacity in front of each dock | You | needed | The denominator of the Quai d'expédition saturation. |
| Thresholds: pallet too old, block too full, pending too long, data too old | You | later | When a number turns orange or red. The page uses example thresholds meanwhile. |
| Site calendar: country and time zone, shifts, working days | You | needed | Defines "today" on the TV, ages in calendar or working days, and the time zone of the app. |
| SAP user IDs that are automatic interfaces | You | to confirm | Separates automatic and manual postings (BARFLOW_TA11 is one). |
| Stakeholders and what each one needs to see | You | needed | Who gets the link, and whether they have a Google account. |

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
- `EMPLACEMENTS`: one row per pallet position, generated from `LAYOUT`, with the label used on the floor.
- `VISITES_CAMIONS`: one row per truck visit, filled by the shipping team; `QUAIS_CAMIONS` is its current state.

_Protected tabs: only 1–2 admins can change them._

**Calculated · rewritten after each import**

- `CALC_STOCK`: per article, PRD2, EXP2 and EMRT in quantity and pallets.
- `CALC_EN_ATTENTE`, `CALC_FIFO_EXP2`, `CALC_SORTIES`: the dates.
- `CALC_BLOCS`, `CALC_JOURNALIER`, `CALC_KPI`: what the screens show.
- `KPI_JOUR` and a monthly `CHECKPOINT`: enough to replay any past day without copying the whole warehouse every day.

_The TV and PCs only read these small tabs, which keeps the screens fast._

**Logs & safety**

- `IMPORT_LOG`: who, when, which file, export time, which days, lines new, already known, rejected.
- `CORRECTIONS`: every manual correction, with who, when and why.
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
- The calculation engine is plain JavaScript with no Google calls inside, so the same code runs in Apps Script and in automatic tests on a PC against the sample database and the messy export files.
- Truck updates have their own lock and version, so a dock update never waits behind an import.
- Apps Script limits that matter: 6 minutes per run and 30 simultaneous calls. One TV plus about 20 PCs is far below that.

**The TV**

- A small PC (or Chromebox) running Chrome in kiosk mode, on a 50–55″ 1080p screen made for 24/7 use. Avoid the TV's built-in browser (3D is not guaranteed) and OLED panels (burn-in).
- Rotating scenes every 30–60 s: overview (the mockup above), docks and trucks, rack saturation, pending list.
- A full reload every 6–12 hours. If a refresh fails, the last good state stays on screen with its age.
- The TV refreshes every 60 s, but SAP figures only change when someone imports (probably 1–3 times a day). Only the docks move in between, and the screen says so.

**Access and ownership: to decide**

- **Company Google Workspace** (best): the link can be limited to company accounts, and Google shows no warning banner.
- **Personal Gmail**: the viewer link must be "anyone with the link" for the TV, Google shows a "created by another user" banner, and IT should approve storing SAP data there.
- Either way, use a **team account**, not a personal one. If the owner account is lost, the app stops.

## 10. Build plan

### Phase 0a: Demo on simulated data

- Load the sample database into a Google Sheet and deploy a read-only viewer: the TV screen and the article lookup, marked "DONNÉES SIMULÉES".
- Run it on the real TV hardware and the plant network: 3D, CDN libraries, link access, Google banner.
- Show it to the stakeholders and collect their reactions.

**Done when:** Stakeholders have seen it on the real TV, and the 3D view and libraries work on the plant network.

### Phase 0b: Clarify and approve

- Answer the questions at the end of this page; send 1–2 weeks of real exports, unmodified.
- Site survey: real dimensions, block types and levels, real dock doors.
- IT approval of the Google account and of the link mode; list of stakeholders.

**Done when:** Written IT approval, a validated capacity per block, and real files that import into the sample structure.

### Phase 1: Data foundation

- One movements table for all files, a global duplicate check, exits and opening stock required.
- The calculation engine (stock per storage location, pending, FIFO dates, pallets per article), tested automatically on the sample database and the messy export files.
- The import page with its checks, the freshness stamp, the import log.
- A one-page procedure in French: who exports and imports, when, and who replaces them.

**Done when:** EXP2 stock in the twin equals MB52, article by article. Re-uploading a file adds 0 lines. The messy files give exactly their expected results.

### Phase 2: PC: lookup, pending, saturation

- Pages: Recherche article, En attente, Plan 2D.
- Saturation per block and overall, positions labeled "théorique" (placeholder by family).
- Floor occupancy in m².

**Done when:** Any article found in under 10 s with its entry dates. Block saturation matches a count of 2 blocks within ±5 %.

### Phase 3: TV, 3D and docks

- The 3D view from the `LAYOUT` tab, rotating TV scenes, automatic refresh, kiosk setup.
- The truck visit log on a tablet at the docks; the truck view and dock saturation.

**Done when:** The TV runs 5 working days unattended; over 90 % of truck visits are logged during a pilot week.

### Phase 4: Placement rules

- Your rules, the position table, and the manual correction tool with its log.
- Weekly physical checks during the pilot.

**Done when:** 2 blocks counted within ±5 %, and at least 90 % of sampled pallets in their predicted block.

### Phase 5: Pilot, alerts, automation

- Two weeks in parallel: the twin compared every day with MB52 and with spot checks before it goes live on the floor.
- Your thresholds, the alert list, replay of past days.
- Automatic upload (a synced Drive folder, or an SAP job that emails the file), only once the export layout has been stable for 4 weeks.
- Nightly backup and yearly archive.

**Done when:** The gap with MB52 stays under the agreed tolerance for 2 weeks, then one full week runs without manual upload.

## 11. Risks

| Risk | What we do |
|---|---|
| The capacity is wrong (the sketch is denser than physically possible, 2 levels assumed, labels misread), so rack saturation, the main TV number, is wrong at the first demo. | Site survey and your validation of every block before phase 2. Show "capacité à confirmer" until then. |
| No exits in the files, so EXP2 only fills up and exit dates are missing. | Exits (601 and other issues out of EXP2) required in phase 1, ideally in one MB51 selection. Weekly comparison with MB52. |
| Pallets and positions on the screen differ from the floor, and people stop trusting it. | Pallets counted per article, positions labeled "théorique", a manual correction tool with a log, and weekly physical checks during the pilot. Ask for Lot or SSCC. |
| Nobody uploads, and the TV shows old data while refreshing every minute. | A large freshness stamp turning orange then red, an e-mail when no import has happened by a set hour, a written procedure with a backup person, then automatic upload. |
| Two overlapping or filtered exports double or halve the stock. | One movements table with a global duplicate check, an alert on transfers with a missing line, and a file refused when a transfer is incomplete. |
| Operator names and SAP data visible through a link that can be forwarded; IT could stop the project after go-live. | IT approval in phase 0b, a read-only viewer project, no names on screens (Auto / Manuel), and a company Google Workspace if available. |
| The dock data depends on people updating it, so the truck view is often wrong or empty. | Agree on what dock saturation means first, a 1-tap form on a tablet at the docks, and the shipped pallets per day from the 601 as a fallback. |
| The TV cannot run the 3D view, or the plant network blocks the libraries. | Test in phase 0a on the real hardware; a mini-PC with Chrome; the libraries served with the page; the 2D plan as fallback. |
| "Location assigned by criteria" grows into a put-away system outside SAP. | Decide descriptive or prescriptive now (see the decisions above). Prescriptive is a separate phase with scanning on the floor. |
| The engine is tuned on clean simulated data and breaks on real exports. | The messy export files and the first real exports become automatic tests before phase 1 ends. |
| The owner account is lost, or Google limits are reached as history grows. | A team account, the code in GitHub, nightly backups, monthly checkpoints and yearly archiving. |

## 12. Decisions to make before building

| Decision | Options | Recommendation |
|---|---|---|
| **Placement** | Descriptive (where pallets probably are) or prescriptive (tell drivers where to put them, with confirmation) | Descriptive first; prescriptive as a separate phase |
| **Quai d'expédition saturation** | Doors occupied · pallets prepared vs space · trucks loaded per day | The first two on the TV, the third in history |
| **Pallets prepared at the docks** | Apart from EXP2 or part of EXP2 | Part of EXP2 (SAP keeps them there until the 601), shown as a sub-total |
| **Pallet counting** | Per article from quantities · one declaration line = one pallet | One line = one pallet if BARFLOW confirms it; otherwise per article |
| **Google account and link** | Workspace with company-only access · Gmail with anyone-with-link | Workspace and a team owner account, with IT approval |
| **"Today" on the TV** | Calendar day · production day (shifts) | Production day if shifts cross midnight |
| **Import** | Manual · synced Drive folder · SAP job emailing the file | Manual first; automatic after 4 stable weeks |

## 13. Open questions (most important first)

1. Can you send 1–2 weeks of both extractions exactly as exported (not re-saved), plus a screenshot of the MB51 selection screen and of the menu you use to export?  
   _Why: Everything depends on these files: column S, the "300" code, 101 or 131, which storage locations are filtered, whether both lines of each transfer are there._
2. How do pallets leave EXP2 (601 deliveries, transfers to EMRT, other)? Can those exits be in the same extraction, ideally one selection: TA11, PRD2 + EXP2 + EMRT, all movement types?  
   _Why: Without exits there is no exit date and EXP2 only fills up._
3. For each block: floor stacking or racks? How many lanes, how deep, how many levels? Are the numbers on your sketch (26, 72, 24, 36, 50) names or capacities? Is the building about 50 × 32 m, and does 1,600 m² include the offices, the AGV strip and the truck zone?  
   _Why: Capacity is the denominator of every saturation figure, and the sketch as drawn is denser than physically possible._
4. What does "Quai d'expédition saturation" mean for you: dock doors occupied, pallets prepared in front of the docks versus the space there, or trucks loaded per day? How many real dock doors are there?  
   _Why: Three different figures with three different sources. The 8 positions of the sketch are 1.8 m apart, too close for truck doors._
5. You wrote "track image" once and "truck image" once. Do you mean trucks or racks? For trucks: an icon per dock, the trailer filling up pallet by pallet, or a photo?  
   _Why: The 3D scene and the docks page depend on it._
6. Should the app only show where pallets probably are, or tell forklift drivers where to put each pallet (with a confirmation)?  
   _Why: The second one is a put-away system with input on the floor: a much bigger project._
7. Where do declared pallets physically wait before the transfer into EXP2: at the line, on the conveyor, or in the exchange zone inside EXP2?  
   _Why: If they wait inside EXP2, they take space and must count in occupancy even though SAP still shows them in PRD2._
8. Is one BARFLOW declaration exactly one physical pallet? Where is the quantity per pallet kept, and which articles are in KG?  
   _Why: If one line is one pallet, pallets can be counted exactly instead of estimated._
9. Can a key user add Poste, Exercice, Date and Heure de saisie, Magasin récepteur, Lot and the reversed document to one saved MB51 layout?  
   _Why: A unique key per line, hours instead of days, and exact reversals. The app will also work without them, with more estimates._
10. Is the company on Google Workspace? Has IT approved SAP stock data in Google? Can the TV link be "anyone with the link"? Who are the stakeholders?  
   _Why: This decides the access setup and is a go/no-go before real data is loaded._
11. Who will export and import, how often, at what time, and who replaces them? Can each export overlap the previous one by a few days?  
   _Why: Freshness of the twin and the catching of back-dated postings._
12. Which country and time zone is the site in, what are the shifts, and are Saturdays worked?  
   _Why: Defines "today", ages in calendar or working days, and which data-protection law applies._
13. What device will drive the TV, and can it reach cdn.jsdelivr.net and cdn.sheetjs.com from the plant network?  
   _Why: Smart-TV browsers often cannot run the 3D view, and a blocked library breaks the import._
14. Can you export an MB52 (or MB5B) for PRD2, EXP2 and EMRT on the go-live day, plus 60–90 days of receipts?  
   _Why: The starting stock, and an estimated age for the pallets already there._

## 14. Simulated database

`sample-data/EXP2_twin_sample_db.xlsx` (and one CSV per tab in `sample-data/csv/`) simulates two weeks of a fictional EXP2 (21.09 → 03.10.2026, Monday to Saturday) with the exact 12 MB51 columns. See `sample-data/README.md` for the tab list. The `CALC_*` tabs are the expected results: the phase-1 app must reproduce them exactly.

State on 03.10.2026: 994 pallets in EXP2 out of 1,464 places (67.9 %), 22 pallets pending in PRD2 (oldest 9 days), 381 pallets at EMRT, 73 pallets in and 65 out that day, trucks at 5 of 8 docks.

