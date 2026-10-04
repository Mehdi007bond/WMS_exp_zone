# EXP2 Digital Twin: application architecture (v1)

This is the technical contract of the Apps Script application in `apps-script/src/`. Every module follows it. It complements [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the why) with the how.

## 1. Principles

1. **Google only.** One Google Sheet (the database) and one container-bound Apps Script project (menu, simulation, web app). The only external code is loaded by the browser from public CDNs: three.js r128 (`cdnjs`) for 3D and SheetJS 0.20.3 (`cdn.sheetjs.com`) to read `.xlsx`, both with Subresource Integrity (the three.js tag carries the cdnjs sha512; SheetJS uses `SHEETJS_SRI` in `PagesPc.html`, to fill in from a PC that can reach the CDN). Both have a fallback (isometric canvas; CSV import).
2. **Pure core, thin shell.** The calculation engine, the simulator and the import normaliser are pure JavaScript with no Google service calls. They are written as module factories (`function EngineModule_() { …; return {…}; }`), so the same source runs:
   - on the server: `var Engine = EngineModule_();`
   - in the browser: the template injects `EngineModule_.toString()` (Apps Script V8 returns the function source), so the client gets the identical code;
   - in Node tests: the `.gs` files are loaded with `vm` and the factories are called.
3. **Calculate on write, read small.** Imports, simulations and corrections recalculate the whole state once and store a compact state JSON and one page per article. Screens and key-less calls only read those (cached), never the raw movements: no read recalculates.
4. **One version stamp.** Every write bumps `DATA_VERSION` (and `DOCKS_VERSION` for dock updates, including a hand edit of `QUAIS_CAMIONS` through the `onEdit` simple trigger). Screens poll `api_getVersion()` every 60 s (a copy of the versions in the script cache, so a poll costs no Properties read) and download the state only when it changed; the client keeps the versions carried by the state itself.
5. **French UI, English code.** Labels on screens and in the sheet are French. Identifiers, comments and docs are English.
6. **No personal data on screens.** `Nom utilisateur` is stored but screens show only `Auto` / `Manuel`.

## 2. Files

All the files below sit directly in `apps-script/src/`, which is the clasp `rootDir` (`apps-script/.clasp.json.example`): clasp names each pushed file by its path relative to `rootDir`, so the Apps Script names are exactly `Index`, `Styles`, `Sidebar`… as `createTemplateFromFile`, `createHtmlOutputFromFile` and `include_` ask for them. No sub-folder.

| File | Role | Google services |
|---|---|---|
| `appsscript.json` | Manifest: V8, time zone, web app settings, scopes | – |
| `Config.gs` | `CFG`: tab names, headers, defaults, movement-type map, thresholds, colors | none |
| `Engine.gs` | `EngineModule_()`: calculation engine | none |
| `Simulation.gs` | `SimulationModule_()`: deterministic data generator | none |
| `Normalize.gs` | `NormalizeModule_()`: header mapping, number/date parsing, line keys | none |
| `Repo.gs` | Sheets persistence, state and article pages, cache, versions, locks | Spreadsheet, Cache, Properties, Lock |
| `Api.gs` | Functions called by the web app with `google.script.run` (`api_*`) | via Repo |
| `Main.gs` | `doGet`, `include_`, `moduleSource_`, `onOpen` menu, `onEdit`, setup, ACCUEIL buttons, sidebar actions | Spreadsheet, Html, Script |
| `Assets.gs` | Base64 PNG images of the ACCUEIL buttons | none |
| `Index.html` | Web app shell (TV and PC) | – |
| `Styles.html` | CSS for TV and PC | – |
| `Client.html` | Data layer: `google.script.run` wrapper, polling, cache, formatting, router | – |
| `Plan2d.html` | 2D plan SVG builder (from `LAYOUT`) | – |
| `Iso.html` | Isometric canvas renderer (2.5D, fallback of 3D) | – |
| `Twin3d.html` | three.js renderer (instanced pallets, trucks, orbit, labels) | – |
| `PageTv.html` | TV page: 3D + KPIs + docks + alerts, rotating scenes, freshness | – |
| `PagesPc.html` | PC pages: Recherche article, En attente, Plan 2D, Quais & camions, Import, Simulation | – |
| `Sidebar.html` | Control panel inside the sheet (simulation parameters, status, links) | – |

Apps Script concatenates all `.gs` files in one global scope: only `CFG`, the `*Module_` factories, the singletons (`Engine`, `Sim`, `Norm`), `Repo`, the `api_*` functions and the menu/button/sidebar entry points are public. Helpers end with `_` (private: not callable with `google.script.run`); the template helpers `include_` and `moduleSource_` are private too (scriptlets run on the server).

## 3. Sheet tabs

| Tab | Written by | Content |
|---|---|---|
| `ACCUEIL` | setup | Title, status, buttons (images with assigned scripts) |
| `MOUVEMENTS` | import, simulation | All MB51 lines, one table, deduplicated |
| `STOCK_INITIAL` | import, simulation | Opening stock (MB52 / MB5B) |
| `ARTICLES` | admin, simulation | Master data per article |
| `LAYOUT` | setup, admin | Warehouse objects in meters |
| `REGLES_PLACEMENT` | admin | Placement rules (placeholder rows at setup) |
| `PARAM_MOUVEMENTS` | setup, admin | Movement type → kind |
| `PARAM_SEUILS` | setup, admin | Thresholds and settings (key / value) |
| `QUAIS_CAMIONS` | docks page, simulation | Current state of the 8 docks |
| `VISITES_CAMIONS` | docks page | One row per change of a dock (history) |
| `CALC_STOCK`, `CALC_EN_ATTENTE`, `CALC_FIFO_EXP2`, `CALC_SORTIES`, `CALC_JOURNALIER`, `CALC_BLOCS`, `CALC_KPI` | engine | Calculated results (same headers as `sample-data/`) |
| `IMPORT_LOG` | import, simulation | One row per import or simulation |
| `_STATE` | engine | Compact state JSON in chunks (hidden) |
| `_LOOKUP` | engine | One row per article: article, designation, the `api_lookup` page as JSON in cells of 45,000 characters; A1 = `{ version, savedAt, n }` (hidden) |

### `MOUVEMENTS` columns

`Clé`, `Article`, `Division`, `Magasin`, `MvT`, `Texte code mvt`, `S`, `Doc.article`, `Poste`, `Date cpt.`, `Qté en UQS`, `UQS`, `Désignation article`, `Nom utilisateur`, `Source`, `Import`, `Ajouté le`

- `Clé` = `Doc.article|Poste` when `Poste` is known, else `Doc.article|Article|Magasin|MvT|qty|date|rank` (rank = n-th identical line inside the same document in the file).
- `Date cpt.` stored as a real date; `Article`, `Doc.article`, `MvT` stored as text (`@` number format).
- `Source` ∈ `SIMULATION`, `IMPORT`.

Other tab headers are exactly those of `sample-data/csv/*.csv`.

## 4. Engine (`Engine.gs`)

```
Engine.compute(input) -> result
Engine.toTables(result) -> { CALC_STOCK: [[headers], ...rows], CALC_EN_ATTENTE: …, … }
Engine.lookup(result, article) -> { article, stock, fifo, pending, exits, locations }
Engine.lookupAll(result) -> { article: lookup(result, article) } for every article, in one pass
```

`input` (dates as `'yyyy-mm-dd'` strings):

```
{
  asOf: 'yyyy-mm-dd' | null,          // null = last movement date
  plant: 'TA11',
  movements: [{ key, article, division, magasin, mvt, text, s, doc, poste, date, qty, uqs, designation, user, source }],
  opening:   [{ article, magasin, qty, uqs, designation, date }],
  articles:  [{ article, designation, uqs, qpp, palletType, heightCm, levels, family }],
  blocks:    [{ id, label, x, y, w, h, cols, rows, levels, color }],
  rules:     [{ priority, criterion: 'FAMILLE'|'ARTICLE', value, blocks: ['B1','B7'] }],
  mvtKinds:  { '101':'DECL', '102':'DECL_REV', '131':'DECL', '132':'DECL_REV', '311':'TRANSFER', '312':'TRANSFER_REV', '601':'ISSUE', '602':'ISSUE_REV', … },
  docks:     [{ quai, status, truck, carrier, color, arrival, departure, planned, loaded, staged, capacity }],
  thresholds:{ satWarn: 0.85, satCrit: 0.95, pendingDaysWarn: 3, freshWarnH: 4, freshCritH: 24 },
  layout:    { … }                    // Repo.readInput() only: the LAYOUT tab, reused for the state (not read twice)
}
```

Rules (identical to the oracle in `sample-data/`):

1. Opening stock first (layers dated with the opening date, origin `Stock initial`), then movements sorted by `date`, then `doc`, then issuing line (negative) before receiving line (positive), then file order.
2. FIFO layers per (article, magasin). Positive line = new layer (origin = the other leg's magasin for a transfer, `PRD2` for a declaration). Negative line consumes the oldest layers. Reversals (`*_REV`) consume the newest layer (LIFO).
3. **Pallets per (article, magasin) bucket** = `ceil(total qty / qpp)`. Attribution to layers: walk the layers oldest first; the first pallet takes `qty mod qpp` units (when > 0), the next ones `qpp` units; each pallet belongs to the layer holding its oldest unit. Unknown article (no `qpp`) → pallets blank, alert.
4. Exits (`CALC_SORTIES`): one row per consumed slice of an EXP2 layer by a non-reversal issue; `Palettes (équiv.)` = slice qty / qpp rounded to 2 decimals; destination `Client (601)` or `EMRT (311)`.
5. Daily flows count `ceil(line qty / qpp)` per SAP line, reversals excluded; daily stock and pending use rule 3 at the end of each day.
6. Placement: rules sorted by priority; an article goes to the blocks of the first matching rule (`ARTICLE` before `FAMILLE` at equal priority); a family's pallets are spread over its blocks in proportion to capacity (largest remainder); overflow → `À PLACER`.
7. KPIs and alerts as in `CALC_KPI`; alerts also cover stuck pending lines, blocks above thresholds, unknown articles, unpaired transfer legs, negative stock clamped to 0.

`result` also holds `blockContents` (per block: articles with pallets and oldest age) and `state` (the compact JSON for screens, below).

The Node test `tests/engine.test.js` loads `sample-data/csv/*` and must reproduce every `CALC_*` tab exactly (counts exact, fractions within 1e-4).

## 5. Simulation (`Simulation.gs`)

```
Sim.generate({ seed, startDate, days, palletsPerDay, articles: 40, edgeCases: true }) -> { movements, opening, articles, docks }
Sim.nextDay({ seed, asOf, movements, opening, articles }) -> { movements: [new lines for asOf + 1 working day], docks }
```

Deterministic (seeded PRNG). Produces realistic MB51 lines with the same rules as `sample-data/`: one-pallet automatic declarations (`BARFLOW_TA11`), transfers with a lag, EXP2 ↔ EMRT flows, 601 shipments never exceeding available stock, a few reversals, one unknown article, special stock `E`, KG articles, partial pallets. Monday to Saturday.

## 6. Import (`Normalize.gs`)

```
Norm.mapHeaders(headerRow) -> { index: { field: col }, missing: [field], extra: [label] }
Norm.parseNumber(v)  // 1.234,500 · 729,25 · 320- · -320 · numbers
Norm.parseDate(v)    // Date · Excel serial · dd.mm.yyyy · dd/mm/yyyy · yyyy-mm-dd -> 'yyyy-mm-dd'
Norm.normalizeRows(rows2d, { plant: 'TA11' }) -> { lines, skipped: { header, subtotal, blank }, rejected: [{ row, reason }], flags: [{ row, code, text }] }
Norm.keyOf(line, rank)
```

Header synonyms cover the French and English MB51 labels (short and long). Users `BAR FLOW TA11` and `BARFLOW_TA11` are the same automatic user. Numeric articles lose leading zeros. The browser runs the same `Norm` code to show a preview before anything is saved; the server re-validates and deduplicates against existing keys. The Node test `tests/normalize.test.js` runs on `sample-data/messy/` and must match `expected.json`.

## 7. API (`Api.gs`)

Read (no key):

| Function | Returns |
|---|---|
| `api_getVersion()` | `{ data, docks }` version stamps (script cache copy, Properties on a miss) |
| `api_getState()` | compact state JSON (section 8), live docks overlaid when the docks version moved. When no state is stored (or its copy is unreadable) it calculates once, but only with `tryLock(0)`: if a write holds the lock it answers « État non calculé » instead of waiting |
| `api_lookup(article)` | `{ article, found, designation, asOf, version, stock, fifo, pending, exits, locations, movements, movementsTotal }` (users as Auto/Manuel, 300 newest SAP lines). Article checked against `^[0-9A-Za-z._/-]{1,40}$`. Never recalculates: cache `lk:<version>:<article>`, else one row of `_LOOKUP` found with a TextFinder; an unknown article answers `found: false`; pages older than the data version answer « lancez Recalculer » |
| `api_searchArticles(text)` | up to 20 `{ article, designation }` (cache, else the first two columns of `_LOOKUP`) |
| `api_checkKey(key, scope)` | `true` or « Clé incorrecte » (asked before a form is filled in; writes nothing) |

Write (need the admin key, or the docks key for docks):

| Function | Does |
|---|---|
| `api_importLines(key, meta, lines)` | Dedupe, append to `MOUVEMENTS`; running totals in a Script Property (`P_IMPORT_<id>`, deleted by the last batch); `meta.final` recalculates, writes the `IMPORT_LOG` row and refreshes ACCUEIL |
| `api_importOpening(key, rows)` | Replace `STOCK_INITIAL` |
| `api_saveDock(key, dock)` | Update one dock (read, checked and written inside the lock), append to `VISITES_CAMIONS`, bump the docks version; the stored state is not patched (`api_getState` overlays the live docks) |
| `api_simulate(key, params)` | New simulation (replaces simulated data) |
| `api_simulateNextDay(key)` | Append one simulated working day |
| `api_recompute(key)` | Recalculate from the sheet |

Keys are random strings created at setup, stored in Script Properties and shown only to the editors of the sheet: the « Ouvrir le jumeau » dialog and the sidebar (both refuse to run outside the spreadsheet). They are never written in a cell (ACCUEIL shows `••••`), since anyone who can view the sheet, a copy or its history would read them. Menu **Régénérer les clés** replaces both after a leak.

Every write takes the **script lock** (dock saves included: a web app execution has no current document, so a document lock would not exist there) and bumps its version. `computeAndSave_` writes `CALC_*`, the article pages (`_LOOKUP`, stamped with the coming version, the 200 heaviest also put in the cache), the state, then bumps `DATA_VERSION`.

## 8. Compact state (served to screens)

```
{
  version, asOf, computedAt, importedAt, source: 'SIMULATION'|'SAP',
  layout: { building, blocks, truckZone, quais, quaiLine, roads, zones },
  kpi: { exp2Pallets, capacity, saturation, pendingPallets, oldestPendingDays, stuckPendingLines,
         entriesToday, exitsToday, emrtPallets, dockSaturation, docksOccupied, docksStaged, docksCapacity,
         oldestExp2Days, unknownArticles, toPlacePallets, daysToSaturation, netPerDay },
  blocks: [{ id, label, families, capacity, pallets, saturation }],
  blockContents: { B1: [{ article, designation, family, pallets, ageMax }], … },
  families: { F1: '#e7ebef', … },
  daily: [{ date, declared, entries, exits, stockEnd, saturation, pendingEnd }],
  pending: [{ article, designation, date, doc, qty, pallets, days }],
  docks: [{ quai, status, truck, carrier, color, arrival, departure, planned, loaded, staged, capacity }],
  alerts: [{ level: 'warn'|'crit', code, text }]
}
```

## 9. Web app

- `doGet(e)`: `?mode=tv` (TV, read only) or `?page=twin|lookup|pending|plan|docks|import|simulation` (PC; `WEB_PAGES_` in `Main.gs` lists exactly the pages of `PagesPc.html`). `Index.html` is a template; the only scriptlets used are `<?!= include_('File') ?>`, `<?!= moduleSource_('Config') ?>` and `<?!= moduleSource_('Normalize') ?>` (the browser needs `CFG` and `Norm`; `Engine` and `Sim` can be injected the same way), and `<?= mode ?>` / `<?= page ?>`. `&rotate=1` is read by the client (`google.script.url`).
- Viewport and title through `HtmlOutput.addMetaTag` and `setTitle`; `setXFrameOptionsMode(ALLOWALL)` so a Google Site can embed the TV view.
- Links (ACCUEIL, sidebar, « Ouvrir le jumeau »): the `/exec` URL saved in the control panel (Script Property `P_WEBAPP_URL`) first, else `ScriptApp.getService().getUrl()`; a `/dev` URL (test deployment: editors only, unpublished code) is never given as a link, the instructions ask for the `/exec` URL instead.
- TV: dark, 1920 × 1080 design read from 5 m (secondary text ≥ 1.25 rem, 3D labels 1.5 rem, static camera, no dock badges in the 3D view), scenes rotate every `tvSceneS` of `PARAM_SEUILS` (45 s by default) when `&rotate=1`; header « Données SAP du … · importées à … » (or « Données simulées au … · générées à … »); freshness badge (a simulation is never shown as old SAP data); short grouped alerts in the ticker; never blank on errors (last good state stays with its age).
- Saturation colors, one code everywhere: blue below `satWarn`, amber from `satWarn`, red from `satCrit` (3D labels, side bars, 2D plan tags); the 2D plan fill is a separate blue ramp, explained in its legend. Pending pallets: one ghost color (light blue).
- PC: light; write actions ask once for the key and keep it in `sessionStorage` (the docks page checks it with `api_checkKey` before the form opens). Dock statuses are stored as `Libre` / `En attente` / `Chargement` / `Chargé` and shown as Libre / Camion arrivé / En chargement / Prêt à partir.

## 10. Sheet

- Menu **EXP2 Jumeau**: Installer / réinitialiser la base · Simulation › Générer (14 jours) / Simuler +1 jour / Effacer · Recalculer · Panneau de contrôle · Ouvrir le jumeau · Régénérer les clés.
- `onEdit(e)` simple trigger: an edit of `QUAIS_CAMIONS` bumps `DOCKS_VERSION` (Properties and Cache only), so the screens show it at their next poll.
- `ACCUEIL`: buttons (images with assigned scripts) for the same actions, the status of the data and the web app links; the keys are masked.
- Sidebar: simulation (days, end date; advanced options: pallets per day, « Variante (n°) » = seed; « Générer N jours » asks for a second click), status, links with the `/exec` URL field, keys.

## 11. Tests and local harness

- `npm test` runs the Node tests, no browser needed: engine vs oracle, normaliser vs messy fixtures, simulation invariants, API on the in-memory repo and on fake Google services, harness build and shim.
- `npm run harness` builds `tests/harness/out/`: `tv.html` and `pc-<page>.html` for every page of `WEB_PAGES_`, rendered by the real `doGet()` (all `.gs` files in one Node vm, `Index.html` scriptlets evaluated like Apps Script), CDN URLs pointed to `tests/harness/vendor/` (served without their integrity attributes, so the pages also open as `file://`; `npm test` checks the three.js hash), plus an in-browser server: `Config`, `Normalize`, `Engine`, `Simulation`, `Api` and `tests/harness/repo-memory.js` loaded as scripts and `tests/harness/shim.js` as `google.script.run` (asynchronous, JSON copies). The first page seeds a simulation; the pages share one store through `localStorage`. Query flags: `?empty=1`, `?none=1`, `?reset=1`, `?poll=S`, `?lat=MS`, `?fresh=warn|crit`, `?no3d=1`, `?offline=1`. Keys: `window.__keys`.
- `npm run e2e` runs `tests/harness/e2e.js` with Playwright (Chromium, WebGL through SwiftShader): every screen, the key flows (lookup, plan, docks key checked before the form, import twice, simulation +1 day seen by the TV), TV readability checks (label and text sizes, nothing cut, short ticker items, tags inside their block) and screenshots in `tests/harness/out/shots/`. Any console error fails the run.

## 12. Limits and growth

- **Executions:** a calculation reads every tab once (`Repo.readInput`, reused by « +1 jour ») and writes `CALC_*`, `_LOOKUP` and `_STATE` once; key-less reads never calculate (except `api_getState` with nothing stored, without waiting for the lock).
- **Quotas:** version polls hit the script cache, not Properties (50,000 reads / writes a day on consumer accounts). The cache holds about 1,000 items: values that fit in one entry are stored inline (one item), and at most 200 article pages are warmed after a calculation.
- **`MOUVEMENTS` grows without limit** (about 1,000 lines a day, 300,000 rows and 5 million cells a year, against the 10-million-cell spreadsheet limit and the 6-minute execution limit). Planned checkpoint, before go-live on real data (not implemented yet):
  1. menu « Clôturer une période »: for a date D, write the calculated stock per (article, magasin) with its FIFO layers (dated) into `STOCK_INITIAL`, as an opening stock at D;
  2. move the `MOUVEMENTS` rows dated before D to an archive spreadsheet (one per year, read-only), keep their `Clé` column in a compact `MOUVEMENTS_CLES` tab for the dedupe of late re-imports, or reject lines dated before D at import (`Norm.dedupe` with a date cutoff);
  3. recalculate: the engine already starts from `STOCK_INITIAL` (opening layers keep their dates, so ages stay right).
