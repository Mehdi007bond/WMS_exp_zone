# EXP2 Digital Twin: application architecture (v2)

This is the technical contract of the Apps Script application in `apps-script/src/` (`CFG.VERSION` 2.0.0). Every module follows it. It complements [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the why) with the how. The v2 changes (the real MB51 export, labels and entry times, projects, the PRD2 > 6 h alert) are specified in detail in [SPEC_V2.md](SPEC_V2.md); this page integrates them and points to the SPEC sections where repeating them would only duplicate. When this page, SPEC_V2 and the code disagree, the code is checked against SPEC_V2 first, then both pages are fixed.

## 1. Principles

1. **Google only.** One Google Sheet (the database) and one container-bound Apps Script project (menu, sheet panels, simulation, web app). The only external code is loaded by the browser from public CDNs: three.js r128 (`cdnjs`) for 3D and SheetJS 0.20.3 (`cdn.sheetjs.com`) to read and write `.xlsx`, both with Subresource Integrity (the three.js tag carries the cdnjs sha512; SheetJS uses `SHEETJS_SRI` in `PagesPc.html`, to fill in from a PC that can reach the CDN). Both have a fallback (isometric canvas; CSV import).
2. **Pure core, thin shell.** The calculation engine, the simulator and the import normaliser are pure JavaScript with no Google service calls. They are written as module factories (`function EngineModule_() { …; return {…}; }`), so the same source runs:
   - on the server: `var Engine = EngineModule_();`
   - in the browser: the template injects `EngineModule_.toString()` (Apps Script V8 returns the function source), so the client gets the identical code;
   - in Node tests: the `.gs` files are loaded with `vm` and the factories are called.
3. **Calculate on write, read small.** Imports, simulations, project saves and corrections recalculate the whole state once and store a compact state JSON and one page per article. Screens and key-less calls only read those (cached), never the raw movements: no read recalculates.
4. **One version stamp.** Every write bumps `DATA_VERSION` (and `DOCKS_VERSION` for dock updates, including a hand edit of `QUAIS_CAMIONS` through the `onEdit` simple trigger). Screens poll `api_getVersion()` every 60 s (a copy of the versions in the script cache, so a poll costs no Properties read) and download the state only when it changed; the client keeps the versions carried by the state itself.
5. **French UI, English code.** Labels on screens and in the sheet are French. Identifiers, comments and docs are English.
6. **No personal data on screens.** `Nom utilisateur` is stored but screens show only `Auto` / `Manuel`. The free header and item texts of SAP lines are stored but never shown (they may carry names); only the label and the entry time derived from them are.
7. **SAP wall clock.** Entry date and time are kept as text `yyyy-mm-dd hh:mm:ss`, as SAP gives them: no time-zone conversion. « The time of the data » (`asOfTs`) is the latest entry time of the data, never the server clock: a wait in PRD2 is measured up to that time, not up to now.
8. **Finished goods only.** The twin follows the articles that reach EXP2 or are listed in `ARTICLES`: the import drops the other lines (unless asked), and the engine skips them.
9. **v1 data still gives v1 results.** Movements without entry time and label (the v1 oracle `sample-data/csv`) give exactly the v1 figures.

## 2. Files

All the files below sit directly in `apps-script/src/`, which is the clasp `rootDir` (`apps-script/.clasp.json.example`): clasp names each pushed file by its path relative to `rootDir`, so the Apps Script names are exactly `Index`, `Styles`, `Sidebar`, `SidebarProjets`… as `createTemplateFromFile`, `createHtmlOutputFromFile` and `include_` ask for them. No sub-folder.

| File | Role | Google services |
|---|---|---|
| `appsscript.json` | Manifest: V8, time zone Europe/Paris, web app settings | – |
| `Config.gs` | `CFG`: tab names, headers, defaults, movement-type map, thresholds, label patterns, colors | none |
| `Engine.gs` | `EngineModule_()`: calculation engine | none |
| `Simulation.gs` | `SimulationModule_()`: deterministic data generator in the real MB51 format | none |
| `Normalize.gs` | `NormalizeModule_()`: header mapping, number / date / time parsing, labels, finished-goods filter, line keys | none |
| `Repo.gs` | Sheets persistence, migration, state and article pages, cache, versions, locks | Spreadsheet, Cache, Properties, Lock |
| `Api.gs` | Functions called by the web app with `google.script.run` (`api_*`), and the `run*_` / projects helpers shared with `Main.gs` | via Repo |
| `Main.gs` | `doGet`, `include_`, `moduleSource_`, `onOpen` menu, `onEdit`, setup, ACCUEIL buttons, sidebar functions | Spreadsheet, Html, Script |
| `Assets.gs` | Base64 PNG images of the ACCUEIL buttons | none |
| `Index.html` | Web app shell (TV and PC) | – |
| `Styles.html` | CSS for TV and PC | – |
| `Client.html` | Data layer: `google.script.run` wrapper, polling, cache, formatting, router, project colors, pending helpers | – |
| `Plan2d.html` | 2D plan SVG builder (from `LAYOUT`; block tags show the project names) | – |
| `Iso.html` | Isometric canvas renderer (2.5D, fallback of 3D) | – |
| `Twin3d.html` | three.js renderer (instanced pallets, trucks, orbit, labels) | – |
| `PageTv.html` | TV page: 3D + KPIs + docks + alerts, rotating scenes, freshness | – |
| `PagesPc.html` | PC pages: Jumeau 3D, Plan 2D, Recherche article, En attente, Projets, Quais & camions, Import, Simulation | – |
| `Sidebar.html` | Control panel inside the sheet (status, simulation parameters, projects button, links, keys) | – |
| `SidebarProjets.html` | Projects panel inside the sheet (references → projects, blocks per project) | – |

Apps Script concatenates all `.gs` files in one global scope: only `CFG`, the `*Module_` factories, the singletons (`Engine`, `Sim`, `Norm`), `Repo`, the `api_*` functions and the menu/button/sidebar entry points are public. Helpers end with `_` (private: not callable with `google.script.run`); the template helpers `include_` and `moduleSource_` are private too (scriptlets run on the server).

## 3. Sheet tabs

| Tab | Written by | Content |
|---|---|---|
| `ACCUEIL` | setup | Title, status, buttons (images with assigned scripts), help |
| `MOUVEMENTS` | import, simulation | All MB51 lines, one table, deduplicated |
| `STOCK_INITIAL` | import, simulation | Opening stock (MB52 / MB5B) |
| `ARTICLES` | admin, projects panel / page, simulation | Master data per article, with its project |
| `PROJETS` | admin, projects panel / page, simulation | One row per project: its blocks, color, comment |
| `LAYOUT` | setup, admin | Warehouse objects in meters |
| `REGLES_PLACEMENT` | admin | Extra placement rules (empty at setup) |
| `PARAM_MOUVEMENTS` | setup, admin | Movement type → kind |
| `PARAM_SEUILS` | setup, admin | Thresholds and settings (key / value) |
| `QUAIS_CAMIONS` | docks page, simulation | Current state of the 8 docks |
| `VISITES_CAMIONS` | docks page | One row per change of a dock (history) |
| `CALC_STOCK`, `CALC_EN_ATTENTE`, `CALC_FIFO_EXP2`, `CALC_SORTIES`, `CALC_JOURNALIER`, `CALC_BLOCS`, `CALC_KPI` | engine | Calculated results (v1 columns of `sample-data/`, then the v2 columns) |
| `IMPORT_LOG` | import, simulation | One row per import or simulation |
| `_STATE` | engine | Compact state JSON in chunks (hidden) |
| `_LOOKUP` | engine | One row per article: article, designation, the `api_lookup` page as JSON in cells of 45,000 characters; A1 = `{ version, savedAt, n }` (hidden) |

Headers are those of `CFG.HEADERS`. v2 columns are always **appended at the end** of a v1 tab, and every column is found by its header label, so columns moved or added by hand never receive another column's values.

### `MOUVEMENTS` columns

`Clé`, `Article`, `Division`, `Magasin`, `MvT`, `Texte code mvt`, `S`, `Doc.article`, `Poste`, `Date cpt.`, `Qté en UQS`, `UQS`, `Désignation article`, `Nom utilisateur`, `Source`, `Import`, `Ajouté le`, then (v2) `Saisie le`, `Étiquette`, `Texte en-tête`, `Texte`, `Référence`, `Client`, `Commande client`.

- `Clé` = `Doc.article|Poste` when `Poste` is known, else `Doc.article|Article|Magasin|MvT|qty|date|rank` (rank = n-th identical line inside the same document in the file). The real export has no `Poste`, so its keys are of the second kind. `Saisie le` and `Étiquette` are not part of the key.
- `Date cpt.` stored as a real date; `Article`, `Doc.article`, `MvT` stored as text (`@` number format).
- `Saisie le` = `Date de saisie` + `Heure de saisie` as **text** `yyyy-mm-dd hh:mm:ss` (format `@`: no time-zone conversion, no 1899 time bug); empty when the export has no time. `Étiquette` = the label number (text), derived from the texts at import (section 6). `Texte en-tête` and `Texte` = `Texte d'en-tête pièce` and `Texte` of the export. `Client` and `Commande client` are kept for the 601 deliveries to come.
- `Source` ∈ `SIMULATION`, `IMPORT`.

### `ARTICLES` and `PROJETS`

- `ARTICLES`: `Article`, `Désignation article`, `UQS`, `Qté par palette`, `Type palette`, `Hauteur palette (cm)`, `Niveaux gerbage max`, `Famille`, then (v2) `Projet`. `Qté par palette` may stay empty for a labeled article (the engine learns it, section 4). `Projet` = exact text, compared case-insensitively.
- `PROJETS`: `Projet`, `Blocs`, `Couleur`, `Commentaire`. `Blocs` = block ids of `LAYOUT` separated by commas (`B1, B7`); a block may belong to several projects. `Couleur` = `#rrggbb`, or empty for the automatic palette. A name written twice (any case) is one project (blocks united, first color and comment). Created empty by setup or by the migration, filled by the projects panel / page, the simulation or by hand.

### `PARAM_SEUILS` keys

| Key | Default | Meaning |
|---|---|---|
| `plant` | `TA11` | SAP plant; lines of other plants are rejected |
| `asOf` | empty | Reference date; empty = date of the last movement (recommended) |
| `satWarn`, `satCrit` | 0.85, 0.95 | Block and warehouse saturation, amber / red |
| `pendingDaysWarn` | 3 | Pending lines **without** entry time: days before amber (red from `pendingDaysCrit`, 2 × `pendingDaysWarn` unless a `pendingDaysCrit` row is added) |
| `dockStagingWarn` | 0.85 | Pallets staged in front of a dock / its capacity |
| `freshWarnH`, `freshCritH` | 4, 24 | Hours since the last import before the TV badge turns amber / red |
| `tvRefreshS`, `tvSceneS` | 60, 45 | Version polling period, duration of a TV scene |
| `pendingHoursWarn` | 4 | v2: a declared pallet in PRD2 since this many hours (entry time) is amber |
| `pendingHoursCrit` | 6 | v2: red, alert `PRD2_CRIT` (« plus de 6 h est un vrai problème ») |
| `labelIsPallet` | 1 | v2: 1 label = 1 pallet |
| `importTrackedOnly` | 1 | v2: the Import page keeps finished goods only (box « Importer aussi les articles hors produits finis » unticked) |
| `trackAll` | 0 | v2: 1 = the engine computes every article, not only the tracked ones |

### Calculated tabs

The v1 columns come first, unchanged (the v1 oracle still compares them); the v2 columns follow, as listed in [SPEC_V2 section 3](SPEC_V2.md#3-sheet-configgs-repogs): `CALC_STOCK` + `Source qté/pal` (`ARTICLES` | `ÉTIQUETTES` | empty), `Projet`; `CALC_EN_ATTENTE` + `Étiquette`, `Saisie le`, `Attente (h)`, `Niveau` (`alerte` | `pré-alerte` | empty), `Projet`; `CALC_FIFO_EXP2` + `Étiquette`, `Saisie le`, `Âge (h)`, `Projet`; `CALC_SORTIES` + `Étiquette`, `Entrée le`, `Sortie le`, `Séjour (h)`; `CALC_JOURNALIER` + `Délai PRD2→EXP2 médian (h)`, `Délai PRD2→EXP2 P90 (h)`; `CALC_BLOCS` + `Projet(s)`. `CALC_KPI` gains rows (time of the data, pallets waiting 4–6 h and over 6 h, oldest wait in hours, labels pending, PRD2 → EXP2 delay, tracked articles, references without project, projects). Times are written as text `dd.mm.yyyy hh:mm:ss`.

### Migration of a v1 sheet

`Repo.migrate()` ([SPEC_V2 section 3](SPEC_V2.md#3-sheet-configgs-repogs)): appends the missing headers of `MOUVEMENTS`, `ARTICLES` and `CALC_*`, creates `PROJETS` after `ARTICLES` (formatted header, spare rows), adds the missing `PARAM_SEUILS` rows (`pendingHoursWarn`, `pendingHoursCrit`, `labelIsPallet`, `importTrackedOnly`, `trackAll`). It never deletes or moves a column or a row and is idempotent. It runs in `setup` (forced), in `readInput` and before every write to `MOUVEMENTS`, `ARTICLES` or `PROJETS`; once done, the Script Property `SCHEMA_VERSION` = 2 and the next runs only check the sizes of two tabs.

`REGLES_PLACEMENT`: setup writes no row any more (`CFG.DEFAULT_RULES` = `[]`). The v1 placeholder rows (`FAMILLE` F1–F5, comment `provisoire`) that a v1 sheet keeps are left out of the engine input by `Repo.readInput` while no article carries that family, so they never hold blocks against real data.

### Who owns what (simulation and user)

Script Properties (prefix `P_`) record what the simulation wrote, so that « Effacer la simulation » and a new simulation never remove the user's data: `SIM_ARTICLES` (the `ARTICLES` rows written by the simulation), `SIM_PROJECTS` and `PROJECTS_SOURCE` = `SIMULATION` (the `PROJETS` rows of the simulation), `OPENING_SOURCE`, `DOCKS_SOURCE`, `SIM_PARAMS`. A save from the projects panel or page takes the saved articles out of `SIM_ARTICLES` and clears `PROJECTS_SOURCE`: the user owns those rows from then on. Imported `MOUVEMENTS` lines (`Source` = `IMPORT`) are never touched by the simulation.

## 4. Engine (`Engine.gs`)

```
Engine.compute(input) -> result (result.state = the compact state, section 8)
Engine.toTables(result) -> { CALC_STOCK: [[headers], ...rows], CALC_EN_ATTENTE: …, … }
Engine.lookup(result, article) -> { article, project, stock, fifo, pending, exits, locations }
Engine.lookupAll(result) -> { article: lookup(result, article) } for every article, in one pass
Engine.buildState(result, extras) -> compact state
```

`input` (dates as `'yyyy-mm-dd'` strings, entry times as `'yyyy-mm-dd hh:mm:ss'`):

```
{
  asOf: 'yyyy-mm-dd' | null,          // null = last movement date
  plant: 'TA11',
  movements: [{ key, article, division, magasin, mvt, text, s, doc, poste, date, qty, uqs, designation, user, source,
                ts, label, headerText, itemText, reference, client, salesOrder }],     // ts '' and label '' for v1 data
  opening:   [{ article, magasin, qty, uqs, designation, date }],
  articles:  [{ article, designation, uqs, qpp, palletType, heightCm, levels, family, project }],
  projects:  [{ project, blocks: ['B1','B7'], color: '#rrggbb' | '', comment }],     // PROJETS
  blocks:    [{ id, label, x, y, w, h, cols, rows, levels, color, capacity }],
  rules:     [{ priority, criterion: 'ARTICLE'|'PROJET'|'FAMILLE', value, blocks: ['B1','B7'] }],
  mvtKinds:  { '101':'DECL', '102':'DECL_REV', '131':'DECL', '132':'DECL_REV', '311':'TRANSFER', '312':'TRANSFER_REV', '601':'ISSUE', '602':'ISSUE_REV', … },
  docks:     [{ quai, status, truck, carrier, color, arrival, departure, planned, loaded, staged, capacity }],
  thresholds:{ satWarn, satCrit, pendingDaysWarn, dockStagingWarn, freshWarnH, freshCritH, pendingHoursWarn, pendingHoursCrit, labelIsPallet, trackAll, … },
  layout:    { … }                    // Repo.readInput() only: the LAYOUT tab, reused for the state (not read twice)
}
```

Rules (details and examples: [SPEC_V2 section 4](SPEC_V2.md#4-engine-v2-enginegs)):

1. **Lines kept.** Lines of the plant with article, magasin, date and quantity; then only the **tracked articles** = `ARTICLES` ∪ articles with a movement or an opening row in `EXP2` (`trackAll` = 1 disables the filter; skipped lines are counted, no alert); movement types of `PARAM_MOUVEMENTS` (`IGNORE` skipped, unknown ones reported); lines on or after the opening date; lines up to `asOf`.
2. **Order.** Opening stock first (layers dated with the opening date, origin `Stock initial`), then movements sorted by `date`, then `ts` (`''` first), then `doc`, then issuing line (negative) before receiving line (positive), then file order.
3. **FIFO layers per (article, magasin)**, each with its label and entry time. A positive line pushes a layer (origin = the other leg's magasin for a transfer, `PRD2` for a declaration). A negative line **with a label** takes from the live layers of the same label first, then FIFO from the unlabeled layers, never from another label; units still missing are stock from before the data when this label was never stored here (`preData`, no alert), else negative stock. A negative line **without a label** keeps the v1 rule: oldest layers first, newest first (LIFO) for reversals (`*_REV`).
4. **Quantity per pallet** = `ARTICLES › Qté par palette`, else learned = the most frequent quantity of the article's labeled positive lines (ties → the larger), else unknown (`qppSource` = `ARTICLES` | `ÉTIQUETTES` | `''`).
5. **Pallets per (article, magasin) bucket.** With `labelIsPallet` = 1: one pallet per live labeled layer + `ceil(unlabeled qty / qpp)`; the unlabeled layers share their pallets with the v1 attribution. Without labels (or `labelIsPallet` = 0): v1, `ceil(total qty / qpp)`, attributed to the layers oldest first (the first pallet takes `qty mod qpp` units when > 0, the next ones `qpp` units; each pallet belongs to the layer holding its oldest unit). Unknown qpp → pallets blank, alert.
6. **Time.** `asOfTs` = the latest `ts` of the processed lines (« l'heure des données »). Pending rows (live PRD2 layers) carry `days` and, when both times are known, `hours` = (`asOfTs` − `ts`) / 3600. A declared container (a label, or a layer pushed by a declaration) with known hours is judged in hours: `crit` from `pendingHoursCrit`, `warn` from `pendingHoursWarn`; the other rows (no entry time, unlabeled stock moved into PRD2, opening stock) are judged in days (`pendingDaysWarn`, `pendingDaysCrit`). EXP2 layers carry `ageHours`; exits carry `tsIn`, `tsOut`, `stayHours`. **Delay PRD2 → EXP2**: when a PRD2 line whose other leg is in EXP2 takes a labeled layer first, `ts` of the line − `ts` of the layer, per posting day: median and P90 (nearest rank) in hours.
7. **Exits** (`CALC_SORTIES`): one row per consumed slice of an EXP2 layer by a non-reversal issuing line; `Palettes (équiv.)` = slice qty / qpp rounded to 2 decimals; destination `Client (601)`, `Sortie (<MvT>)` for other issues, `<magasin> (<MvT>)` for a transfer (e.g. `EMRT (311)`).
8. **Daily flows**: a labeled line counts 1 pallet, an unlabeled line `ceil(line qty / qpp)`; reversals excluded from entries and exits, `Déclarations` = declared minus reversed; daily stock and pending use rule 5 at the end of each day; the PRD2 → EXP2 delay of each day.
9. **Projects and placement.** An article's project = `ARTICLES › Projet`. Effective rules = `REGLES_PLACEMENT` (criteria `ARTICLE`, `PROJET`, `FAMILLE`) + one `PROJET` rule (priority 5) per `PROJETS` row whose blocks exist in `LAYOUT`; sorted by priority, then `ARTICLE` < `PROJET` < `FAMILLE`, then input order; the first matching rule wins. A rule's pallets are spread over its blocks in proportion to their free capacity (largest remainder); overflow → `À PLACER`. Articles matching no rule are spread the same way over the **free blocks** (targeted by no rule), else `À PLACER`. No fallback rule. A block's `title` is its projects joined by ` / `, else `Famille …`, else `Article …`, else `Libre`. Project colors: `PROJETS › Couleur`, else a fixed palette of 12 colors in name order (never a color already used); `Sans projet` = `#c9ced6`.
10. **KPIs and alerts** (French texts, critical first). v1 KPIs, plus `asOfTs`, `pendingLabels`, `pendingWarn` / `pendingCrit` (pallets by level), `oldestPendingHours`, `dwellMedianH`, `dwellP90H`, `trackedArticles`, `noProjectArticles`, `projects`. Alert codes: `PRD2_CRIT` (crit: pallets judged in hours at level crit, with the oldest wait and its label), `PRD2_WARN`, `NEGATIVE_STOCK` (v1 per line when there is an opening stock; without one, a single warning « n sorties sans stock connu : importez le stock initial (MB52) »), `EXP2_SAT`, `BLOCK_SAT`, `TO_PLACE`, `NO_PROJECT` (« … sans projet : affectez-les dans la page Projets »), `PENDING_STUCK` (rows judged in days), `DOCK_STAGING`, `NO_QPP` and `UNKNOWN_ARTICLE` (one per article, grouped beyond 5), `UNPAIRED_TRANSFER` (unlabeled legs only: a labeled leg whose other leg is outside the export is normal), `UNKNOWN_MVT`, `OTHER_MAGASIN`, `OTHER_PLANT`, `BEFORE_OPENING`, `NEGATIVE_OPENING`, `INVALID_LINE`.

`result` also holds `blockContents` (per block, and `À PLACER`: articles with pallets, oldest age and project), `projectsList`, `learnedQpp`, `counts` and `state`.

Oracles: `tests/engine.test.js` loads `sample-data/csv/*` and must reproduce the v1 columns of every `CALC_*` tab exactly (counts exact, fractions within 1e-4; placement with the v1 placeholder rules F1–F5, passed by the test); and it normalises `sample-data/mb51-reel/MB51_reel_anonymise.xlsx` and must match `expected.json › engine` ([SPEC_V2 4.10](SPEC_V2.md#410-oracle-for-the-real-format), written by `tools/mb51_reference.py`, an independent Python implementation).

## 5. Simulation (`Simulation.gs`)

```
Sim.generate({ seed, startDate | endDate, days, palletsPerDay, edgeCases, blocks })
  -> { movements, opening, articles, projects, docks, asOf, openingDate, params, facts }
Sim.nextDay({ seed, movements, opening, articles, asOf?, palletsPerDay?, edgeCases? }) -> { movements: lines of the next day only, docks, asOf, facts }
Sim.mb51Rows(movements, { noise: true, seed }) -> [the 22 headers of the real export, ...rows]
Sim.makeDocks(seed, date), Sim.nextWorkingDay(iso), Sim.DEFAULTS, Sim.LIMITS
```

Deterministic (seeded). Output in the **real format** ([SPEC_V2 section 6](SPEC_V2.md#6-simulation-v2-simulationgs)): about 36 fictional finished goods, 6 fictional projects `ATLAS`, `BOREAL`, `CORSO`, `DELTA`, `ETNA`, `FJORD` with their blocks and 3 articles without a project; 131 declarations around the clock with labels and entry times, 311 transfers PRD2 → EXP2 (median about 35 min, a few labels over 4 h and over 6 h, some still waiting at the end), re-scans, manual EXP2 → EMRT moves, 601 exits per truck (simulated: the real export has none yet) keeping EXP2 between about 60 % and 85 %, an unlabeled opening stock, night entries posted on the previous day, every day a working day. Defaults: 7 days, 450 labels a day (20–1,500), seed 2026; the app passes the end date = yesterday. `Sim.mb51Rows` with `noise` adds lines the finished-goods filter must drop (the PC Simulation page offers it as « Télécharger un MB51 simulé (.xlsx) »).

## 6. Import (`Normalize.gs`)

```
Norm.mapHeaders(headerRow) -> { index: { field: col }, labels, missing: [field], extra: [label], … }
Norm.parseNumber(v)  // 1.234,500 · 729,25 · 320- · -320 · numbers
Norm.parseDate(v)    // Date · Excel serial · dd.mm.yyyy · dd/mm/yyyy · yyyy-mm-dd -> 'yyyy-mm-dd'
Norm.parseTime(v)    // Excel fraction or date-time serial · Date · h:mm · hh:mm:ss · hh:mm:ss AM/PM · hhmmss -> 'hh:mm:ss' | null
Norm.labelOf(line)   // label number of a line (CFG.LABEL), '' when none
Norm.normalizeRows(rows2d, { plant: 'TA11' }) -> { lines, skipped: { header, subtotal, blank }, rejected: [{ row, reason }], flags, mapping, … }
Norm.filterTracked(lines, tracked) -> { kept, dropped, keptArticles, droppedArticles, batchTracked }
Norm.normalizeBatch(files, { plant, existingKeys, knownLines, lastImportedDate, tracked, trackedOnly }) -> { lines, duplicates, rejected, flags, untracked, summary, … }
Norm.keyOf(line, rank), Norm.dedupe(lines, existingKeys), Norm.flagTransfers(lines, opts), Norm.summarize(result)
```

- **Headers.** Synonyms cover the French and English MB51 labels (short and long), the SAP field names and the **exact 22 columns of the real export** (`Article`, `Division`, `Magasin`, `Code mouvement`, `Texte code mouvement`, `Stock spécial`, `Document article`, `Date comptable`, `Qté en unité saisie`, `UQ de saisie`, `Désignation article`, `Montant DI`, `Date de saisie`, `Heure de saisie`, `Nom de l'utilisateur`, `Texte d'en-tête pièce`, `Motif du mouvement`, `Texte`, `Référence`, `Client`, `Fournisseur`, `Commande client`); `Montant DI`, `Motif du mouvement` and `Fournisseur` are not used and raise no warning ([SPEC_V2 2.1](SPEC_V2.md#21-headers)).
- **Lines.** Users `BAR FLOW TA11`, `BARFLOWTA11` and `BARFLOW_TA11` are the same automatic user. Numeric articles lose leading zeros. `ts` = entry date + entry time (posting date + time when the entry date is missing; `''` without time, never a rejection).
- **Label** ([SPEC_V2 2.3](SPEC_V2.md#23-label-derivation)): the item text when it is 6 to 12 digits (311 scan, `Texte` = `434505101`), else for a declaration (101, 102, 131, 132) the leading 6 to 12 digits of the header text (`434514671|20261005010841` → `434514671`), else `''`. Patterns in `CFG.LABEL`.
- **Finished-goods filter** ([SPEC_V2 2.4](SPEC_V2.md#24-finished-goods-filter-tracked-articles)): with `trackedOnly`, on the valid lines of all files together and before dedupe, a line is kept when it is in EXP2 or its article is tracked (the codes of `state.articles`, i.e. `ARTICLES` and articles already seen in EXP2) or has a line in EXP2 in the files. Dropped lines are counted, never saved.
- **Checks.** A **labeled** 311/312 line is never `TRANSFERT_ORPHELIN` (its other leg is in a storage location outside the export); unlabeled lines keep the v1 rule. The summary gives per file the format (`columns`, `hasTime`, `hasLabels`, `hasClient`, `extra`), the lines with time and with label, and the lines dropped by the filter.

The browser runs the same `Norm` code to show a preview before anything is saved; the server re-validates every line (`validateLines_`: plant, required fields, numbers, dates, `ts` matching `yyyy-mm-dd hh:mm:ss` or empty, label rebuilt from the texts and only digits up to 12, texts up to 200 characters) and deduplicates against existing keys. The Node test `tests/normalize.test.js` runs on `sample-data/messy/` and on `sample-data/mb51-reel/` and must match their `expected.json`.

## 7. API (`Api.gs`)

Read (no key):

| Function | Returns |
|---|---|
| `api_getVersion()` | `{ data, docks }` version stamps (script cache copy, Properties on a miss) |
| `api_getState()` | compact state JSON (section 8), live docks overlaid when the docks version moved. When no state is stored (or its copy is unreadable) it calculates once, but only with `tryLock(0)`: if a write holds the lock it answers « État non calculé » instead of waiting |
| `api_lookup(article)` | `{ article, found, designation, asOf, asOfTs, project, version, stock, fifo, pending, exits, locations, movements, movementsTotal }`: `stock` with `qpp` and `qppSource`, `fifo` / `pending` / `exits` with label and times, `movements` = the 300 newest SAP lines with `ts`, `label`, `client`, `salesOrder` and users as Auto/Manuel (no header or item text). Article checked against `^[0-9A-Za-z._/-]{1,40}$`. Never recalculates: cache `lk:<version>:<article>`, else one row of `_LOOKUP` found with a TextFinder; an unknown article answers `found: false`; pages older than the data version answer « lancez Recalculer » |
| `api_searchArticles(text)` | up to 20 `{ article, designation }` (cache, else the first two columns of `_LOOKUP`) |
| `api_checkKey(key, scope)` | `true` or « Clé incorrecte » (asked before a form is filled in; writes nothing) |
| `api_getProjects()` | `{ version, projects: [{ project, blocks, color, comment, listed }], references: [{ article, designation, project }], blocks: [{ id, label, capacity }], settings: { pendingHoursWarn, pendingHoursCrit } }` from `PROJETS`, `ARTICLES`, `LAYOUT`, `PARAM_SEUILS`; names only typed in `ARTICLES` follow with `listed: false` |

Write (need the admin key, or the docks key for docks):

| Function | Does |
|---|---|
| `api_importLines(key, meta, lines)` | Re-validate, dedupe, append to `MOUVEMENTS` with the v2 fields; running totals in a Script Property (`P_IMPORT_<id>`, deleted by the last batch); `meta.untracked` = lines dropped by the page (log only); `meta.final` recalculates, writes the `IMPORT_LOG` row (« OK (n lignes hors produits finis ignorées) ») and refreshes ACCUEIL. The page sends batches of 500 lines (5,000 at most per call) |
| `api_importOpening(key, rows)` | Replace `STOCK_INITIAL` (no page reads an MB52 file yet) |
| `api_saveDock(key, dock)` | Update one dock (read, checked and written inside the lock), append to `VISITES_CAMIONS`, bump the docks version; the stored state is not patched (`api_getState` overlays the live docks) |
| `api_simulate(key, params)` | New simulation (replaces simulated data, keeps imported lines and the user's articles and projects). `params`: `days` (7), `endDate` (yesterday) or `startDate`, `palletsPerDay` (labels a day, 20–1,500, default 450), `seed` (2026), `edgeCases` |
| `api_simulateNextDay(key)` | Append one simulated day (labels, documents and pending transfers continued from the stored lines) |
| `api_recompute(key)` | Recalculate from the sheet |
| `api_saveReferences(key, rows)` | `rows = [{ article, project }]` (2,000 at most; `project` `''` removes it). Article trimmed, upper-cased, leading zeros removed when all digits, `^[0-9A-Za-z._/-]{1,40}$`; project trimmed, spaces collapsed, 40 characters at most, no `,` `;` `\|`, not `Sans projet`; a reference given twice with two projects is invalid. Upsert of `ARTICLES › Projet` (new row with the designation of the last state when known), names spelled as in `PROJETS` (case-insensitive), new names added to `PROJETS` without blocks, then recalculation → `{ ok, created, updated, unchanged, invalid: [{ article, reason }], newProjects, versions, summary, message }` |
| `api_saveProjects(key, projects)` | Replaces `PROJETS` (100 rows at most): names unique (any case), blocks of `LAYOUT`, color `#rrggbb` or `''`; nothing written on an error → `{ ok, saved, versions, summary, message }` |
| `api_renameProject(key, from, to)` | Renames in `PROJETS`, `ARTICLES › Projet` and the `PROJET` rules of `REGLES_PLACEMENT` (case-insensitive match of `from`); a name already used merges the two (blocks united) → `{ ok, project, renamed, rules, merged, versions, summary, message }` |

Keys are random strings created at setup, stored in Script Properties and shown only to the editors of the sheet: the « Ouvrir le jumeau » dialog and the control panel (both refuse to run outside the spreadsheet). They are never written in a cell (ACCUEIL shows `••••`), since anyone who can view the sheet, a copy or its history would read them. Menu **Régénérer les clés** replaces both after a leak. The sheet panels call `sidebar_*` functions without a key: they run only from the spreadsheet (`requireSheet_`), so only its editors can use them.

Every write takes the **script lock** (dock saves included: a web app execution has no current document, so a document lock would not exist there) and bumps its version. `computeAndSave_` writes `CALC_*`, the article pages (`_LOOKUP`, stamped with the coming version, the 200 heaviest also put in the cache), the state (with `thresholds`, `stats`, `docksVersion`), then bumps `DATA_VERSION`. Messages and summaries are French (`summary_`: « Au 05.10.2026 22:09 : n palettes en EXP2 (x %), n en attente PRD2 dont n depuis plus de 6 h, n alertes. »).

## 8. Compact state (served to screens)

```
{
  version, asOf, asOfTs, computedAt, importedAt, source: 'SIMULATION'|'SAP', docksVersion,
  thresholds: { … the thresholds used },  stats: { movements, processed, computeMs },
  layout: { building, blocks: [{ id, label, x, y, w, h, cols, rows, levels, color, capacity, families, projects, title }],
            truckZone, quais, quaiLine, roads, zones },
  kpi: { exp2Pallets, capacity, saturation, pendingPallets, oldestPendingDays, stuckPendingLines,
         entriesToday, exitsToday, emrtPallets, dockSaturation, docksOccupied, docksTotal, docksStaged, docksCapacity,
         oldestExp2Days, unknownArticles, toPlacePallets, daysToSaturation, netPerDay,
         asOfTs, pendingTotal, pendingLabels, pendingWarn, pendingCrit, oldestPendingHours,
         dwellMedianH, dwellP90H, dwellCount, trackedArticles, noProjectArticles, projects },
  blocks: [{ id, label, families, capacity, pallets, saturation, projects, title }],
  blockContents: { B1: [{ article, designation, family, project, pallets, ageMax }], …, 'À PLACER': [ … ] },
  families: { F1: '#e7ebef', … },
  projects: { ATLAS: '#7fb3e0', …, 'Sans projet': '#c9ced6' },
  projectsList: [{ project, color, blocks, articles, exp2Pallets, pendingPallets, pendingCrit }],   // by name, 'Sans projet' last
  daily: [{ date, declared, entries, exits, stockEnd, saturation, pendingEnd, dwellMedianH, dwellP90H }],
  pending: [{ article, designation, date, doc, qty, pallets, days, label, ts, hours, level, project, origin, user }],
                                       // 500 rows at most, oldest first; pendingTotal = rows before the cut
  pendingTotal,
  articles: [{ a: article, d: designation, p: project, e: EXP2 pallets, w: PRD2 pallets, m: EMRT pallets,
               q: qpp, qs: qppSource, t: last entry time or date }],   // every tracked article, by article
  docks: [{ quai, status, truck, carrier, color, arrival, departure, planned, loaded, staged, capacity }],
  alerts: [{ level: 'warn'|'crit', code, text }]
}
```

## 9. Web app

- `doGet(e)`: `?mode=tv` (TV, read only) or `?page=twin|lookup|pending|plan|projects|docks|import|simulation` (PC; `WEB_PAGES_` in `Main.gs` lists exactly the pages of `PagesPc.html`). `Index.html` is a template; the only scriptlets used are `<?!= include_('File') ?>`, `<?!= moduleSource_('Config') ?>`, `<?!= moduleSource_('Normalize') ?>` and `<?!= moduleSource_('Simulation') ?>` (the browser needs `CFG`, `Norm` and `Sim`, the last one for the simulated MB51 file; `Engine` can be injected the same way), and `<?= mode ?>` / `<?= page ?>`. `&rotate=1` and `&scene=overview|plan|pending|docks` are read by the client (`google.script.url`).
- Viewport and title through `HtmlOutput.addMetaTag` and `setTitle`; `setXFrameOptionsMode(ALLOWALL)` so a Google Site can embed the TV view.
- Links (ACCUEIL, control panel, projects panel, « Ouvrir le jumeau »): the `/exec` URL saved in the control panel (Script Property `P_WEBAPP_URL`) first, else `ScriptApp.getService().getUrl()`; a `/dev` URL (test deployment: editors only, unpublished code) is never given as a link, the instructions ask for the `/exec` URL instead.
- TV: dark, 1920 × 1080 design read from 5 m (secondary text ≥ 1.25 rem, 3D labels 1.5 rem, static camera, no dock badges in the 3D view), scenes (overview, plan, pending, docks) rotate every `tvSceneS` of `PARAM_SEUILS` (45 s by default) when `&rotate=1`; header « Données SAP jusqu'au 05/10/2026 22:09 · importées à … » (time of the data; « Données SAP du … » without entry times; « Données simulées … · générées à … » for a simulation); freshness badge (a simulation is never shown as old SAP data); « DONNÉES SIMULÉES » strip; the pending tile shows « dont > 6 h : n » in red when n > 0 and the oldest wait; the ticker carries `PRD2_CRIT` first; short grouped alerts; never blank on errors (last good state stays with its age).
- Blocks are named after their projects (`title`, block id small) on the 3D view, the isometric view, the 2D plan and the TV; pallets are colored by project (family colors for v1 data, neutral grey when neither); the legend lists the projects. Saturation colors, one code everywhere: blue below `satWarn`, amber from `satWarn`, red from `satCrit` (3D labels, side bars, 2D plan tags); the 2D plan fill is a separate blue ramp, explained in its legend. Pending pallets: ghost pallets at the conveyor, red for `crit` rows.
- Pending (TV scene and PC page « En attente »): one row per label, oldest first, red from `pendingHoursCrit`, amber from `pendingHoursWarn`, waits written `44 h 02` at the time of the data; rows without entry time are shown in days.
- PC: light; write actions ask once for the key and keep it in `sessionStorage` (the docks page checks it with `api_checkKey` before the form opens). Page « Projets »: [SPEC_V2 section 7](SPEC_V2.md#7-screens) (paste and preview, zones per project with a plan preview, projects with rename, references without project, all references). Dock statuses are stored as `Libre` / `En attente` / `Chargement` / `Chargé` and shown as Libre / Camion arrivé / En chargement / Prêt à partir.

## 10. Sheet

- Menu **EXP2 Jumeau**: Installer / réinitialiser la base · Simulation › Générer 7 jours / Simuler +1 jour / Effacer la simulation · Recalculer · Projets & références · Panneau de contrôle · Ouvrir le jumeau · Régénérer les clés.
- « Installer / réinitialiser la base » on an installed base asks: OUI = default parameters again (`LAYOUT`, `REGLES_PLACEMENT`, `PARAM_MOUVEMENTS`, `PARAM_SEUILS`, `QUAIS_CAMIONS`), NON = repair only (missing tabs, headers, formats, new columns: the migration). Movements, opening stock, articles, projects and the import log are always kept.
- `onEdit(e)` simple trigger: an edit of `QUAIS_CAMIONS` bumps `DOCKS_VERSION` (Properties and Cache only), so the screens show it at their next poll.
- `ACCUEIL`: four image buttons (Générer 7 jours, Simuler +1 jour, Recalculer, Ouvrir le jumeau), the status of the data (the row « En attente PRD2 » reads « n palettes · PRD2 > 6 h : n (plus ancienne : …) ») and the web app links; the keys are masked; eight help lines.
- Control panel (`Sidebar.html`, `sidebar_status`, `sidebar_simulate`, `sidebar_nextDay`, `sidebar_recompute`, `sidebar_links`, `sidebar_setWebAppUrl`): status, simulation (days, end date; advanced options: « Étiquettes / jour », « Variante (n°) » = seed; « Générer N jours » asks for a second click), a button to the projects panel, links with the `/exec` URL field, keys.
- Projects panel (`SidebarProjets.html`, menu « Projets & références »; `sidebar_getProjects`, `sidebar_saveReferences(rows)`, `sidebar_saveProjects(projects)`): paste box (one reference per line, or two columns copied from Excel) with the project field (`datalist` of the existing names), « Aperçu » then « Enregistrer », with the same paste rules as the PC page (tab or `;` between the columns, header line skipped, a reference given twice keeps its last project, a line without reference skipped, a space inside a reference or a line without project invalid); the projects with their blocks (click to add or remove a block, « Ajouter » a project, automatic or chosen color, « Enregistrer les zones »); the link to the PC page « Projets ». Same rules as `api_saveReferences` / `api_saveProjects`, no key.

## 11. Tests and local harness

- `npm test` runs the Node tests, no browser needed: 178 tests in 5 files (`normalize` 42, `engine` 43, `api` 62, `simulation` 22, `harness` 9): engine vs the v1 oracle and vs the real-format fixture, normaliser vs the messy and the real-format files, simulation invariants (format, unique labels, lags, night posting, waits over 6 h at the end, no negative stock, `nextDay`, determinism, `mb51Rows` through `Norm`), API on the in-memory repo and on fake Google services (migration of a v1 sheet, projects, simulation ownership, sheet panels), harness build and shim.
- `npm run harness` builds `tests/harness/out/`: `tv.html` and `pc-<page>.html` for every page of `WEB_PAGES_`, rendered by the real `doGet()`, and the two sheet panels `sidebar.html` and `sidebar-projets.html` (their `google.script.run` calls the real `sidebar_*` functions of `Main.gs`, with `tests/harness/sheet-stub.js` standing in for the sheet services) (all `.gs` files in one Node vm, `Index.html` scriptlets evaluated like Apps Script), CDN URLs pointed to `tests/harness/vendor/` (served without their integrity attributes, so the pages also open as `file://`; `npm test` checks the three.js hash), plus an in-browser server: `Config`, `Normalize`, `Engine`, `Simulation`, `Api` and `tests/harness/repo-memory.js` loaded as scripts and `tests/harness/shim.js` as `google.script.run` (asynchronous, JSON copies). The first page seeds a simulation (5 days, 200 labels a day); the pages share one store through `localStorage`. Query flags: `?empty=1`, `?none=1`, `?reset=1`, `?seed=N`, `?days=N`, `?ppd=N`, `?poll=S`, `?lat=MS`, `?fresh=warn|crit`, `?no3d=1`, `?offline=1`. Keys: `window.__keys`.
- `npm run e2e` runs `tests/harness/e2e.js` with Playwright (Chromium, WebGL through SwiftShader): 21 scenarios covering every screen, the key flows (lookup, plan, docks key checked before the form, import twice, simulation +1 day seen by the TV) and the v2 ones (`pc-projects`: paste, preview, save, zones, rename, the plan shows the project; `pc-pending-hours`; `tv-prd2-alert`; `pc-import-real`: the anonymised real export through the Import page, then En attente, Recherche article and the TV; `pc-simulation-mb51`; `pc-simulation-generate`: generate, then +1 day; `sheet-sidebars`: the two sheet panels at 300 px, paste, preview, save, blocks, then the plan and the control panel), TV readability checks (label and text sizes, nothing cut, short ticker items, tags inside their block) and screenshots in `tests/harness/out/shots/`. Any console error fails the run.

## 12. Limits and growth

- **Executions:** a calculation reads every tab once (`Repo.readInput`, reused by « +1 jour ») and writes `CALC_*`, `_LOOKUP` and `_STATE` once; key-less reads never calculate (except `api_getState` with nothing stored, without waiting for the lock).
- **Quotas:** version polls hit the script cache, not Properties (50,000 reads / writes a day on consumer accounts). The cache holds about 1,000 items: values that fit in one entry are stored inline (one item), and at most 200 article pages are warmed after a calculation.
- **Sizes:** the state carries at most 500 pending rows (the KPIs carry the totals); one save takes at most 2,000 references; `PROJETS` holds at most 100 projects.
- **`MOUVEMENTS` grows without limit.** After the finished-goods filter, the real export gives about 1,700 lines for a full day (05.10.2026 in the fixture; 2,800 for its two days), so about 600,000 rows and 15 million cells a year with the 24 columns, more than the 10-million-cell spreadsheet limit (the 6-minute execution limit is the other bound). A checkpoint is therefore needed before go-live on real data (planned, not implemented yet):
  1. menu « Clôturer une période »: for a date D, write the calculated stock per (article, magasin) with its FIFO layers (dated) into `STOCK_INITIAL`, as an opening stock at D;
  2. move the `MOUVEMENTS` rows dated before D to an archive spreadsheet (one per year, read-only), keep their `Clé` column in a compact `MOUVEMENTS_CLES` tab for the dedupe of late re-imports, or reject lines dated before D at import (`Norm.dedupe` with a date cutoff);
  3. recalculate: the engine already starts from `STOCK_INITIAL` (opening layers keep their dates, so ages stay right).
