# EXP2 Digital Twin: application architecture (v1)

This is the technical contract of the Apps Script application in `apps-script/src/`. Every module follows it. It complements [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (the why) with the how.

## 1. Principles

1. **Google only.** One Google Sheet (the database) and one container-bound Apps Script project (menu, simulation, web app). The only external code is loaded by the browser from public CDNs: three.js r128 (`cdnjs`) for 3D and SheetJS 0.20.3 (`cdn.sheetjs.com`) to read `.xlsx`. Both have a fallback (isometric canvas; CSV import).
2. **Pure core, thin shell.** The calculation engine, the simulator and the import normaliser are pure JavaScript with no Google service calls. They are written as module factories (`function EngineModule_() { …; return {…}; }`), so the same source runs:
   - on the server: `var Engine = EngineModule_();`
   - in the browser: the template injects `EngineModule_.toString()` (Apps Script V8 returns the function source), so the client gets the identical code;
   - in Node tests: the `.gs` files are loaded with `vm` and the factories are called.
3. **Calculate on write, read small.** Imports, simulations and corrections recalculate the whole state once and store a compact state JSON. Screens only read that JSON (cached), never the raw movements.
4. **One version stamp.** Every write bumps `DATA_VERSION` (and `DOCKS_VERSION` for dock updates). Screens poll `api_getVersion()` every 60 s and download the state only when it changed.
5. **French UI, English code.** Labels on screens and in the sheet are French. Identifiers, comments and docs are English.
6. **No personal data on screens.** `Nom utilisateur` is stored but screens show only `Auto` / `Manuel`.

## 2. Files

| File | Role | Google services |
|---|---|---|
| `appsscript.json` | Manifest: V8, time zone, web app settings, scopes | – |
| `Config.gs` | `CFG`: tab names, headers, defaults, movement-type map, thresholds, colors | none |
| `Engine.gs` | `EngineModule_()`: calculation engine | none |
| `Simulation.gs` | `SimulationModule_()`: deterministic data generator | none |
| `Normalize.gs` | `NormalizeModule_()`: header mapping, number/date parsing, line keys | none |
| `Repo.gs` | Sheets persistence, state storage, cache, versions, locks | Spreadsheet, Cache, Properties, Lock |
| `Api.gs` | Functions called by the web app with `google.script.run` (`api_*`) | via Repo |
| `Main.gs` | `doGet`, `include`, `onOpen` menu, setup, ACCUEIL buttons, sidebar actions | Spreadsheet, Html, Script |
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

Apps Script concatenates all `.gs` files in one global scope: only `CFG`, the `*Module_` factories, the singletons (`Engine`, `Sim`, `Norm`), `Repo`, the `api_*` functions and the menu/button entry points are global. Helpers end with `_` (private: not callable from the client).

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
Engine.lookup(result, article) -> { stock, fifo, pending, exits }
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
  thresholds:{ satWarn: 0.85, satCrit: 0.95, pendingDaysWarn: 3, freshWarnH: 4, freshCritH: 24 }
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
| `api_getVersion()` | `{ data, docks }` version stamps |
| `api_getState()` | compact state JSON (section 8) |
| `api_lookup(article)` | `{ article, stock, fifo, pending, exits, movements }` (users as Auto/Manuel) |
| `api_searchArticles(text)` | up to 20 `{ article, designation }` |

Write (need the admin key, or the docks key for docks):

| Function | Does |
|---|---|
| `api_importLines(key, meta, lines)` | Dedupe, append to `MOUVEMENTS`, log; `meta.final` triggers the recalculation |
| `api_importOpening(key, rows)` | Replace `STOCK_INITIAL` |
| `api_saveDock(key, dock)` | Update one dock, append to `VISITES_CAMIONS` |
| `api_simulate(key, params)` | New simulation (replaces simulated data) |
| `api_simulateNextDay(key)` | Append one simulated working day |
| `api_recompute(key)` | Recalculate from the sheet |

Keys are random strings created at setup and shown only in the sheet (`ACCUEIL` and the sidebar), stored in Script Properties. Every write takes the script lock (docks: the document lock) and bumps its version.

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

- `doGet(e)`: `?mode=tv` (TV, read only) or `?page=lookup|pending|plan|docks|import|simulation` (PC). `Index.html` is a template; the only scriptlets used are `<?!= include('File') ?>`, `<?!= moduleSource('Engine') ?>` (and `Norm`), and `<?= mode ?>` / `<?= page ?>`.
- Viewport and title through `HtmlOutput.addMetaTag` and `setTitle`; `setXFrameOptionsMode(ALLOWALL)` so a Google Site can embed the TV view.
- TV: dark, 1920 × 1080 design, scenes rotate every 45 s (overview, plan saturation, pending, docks) when `&rotate=1`; freshness badge; never blank on errors (last good state stays with its age).
- PC: light; write actions ask once for the key and keep it in `sessionStorage`.

## 10. Sheet

- Menu **EXP2 Jumeau**: Installer / réinitialiser la base · Simulation › Générer (14 jours) / Simuler +1 jour / Effacer · Recalculer · Panneau de contrôle · Ouvrir le jumeau.
- `ACCUEIL`: buttons (images with assigned scripts) for the same actions, the status of the data and the web app links.
- Sidebar: simulation parameters (days, start date, pallets per day, seed), result summary, keys, links.

## 11. Tests and local harness

- `npm test` runs the Node tests (engine vs oracle, normaliser vs messy fixtures, simulation invariants).
- `npm run harness` builds `tests/harness/out/*.html`: the real `Index.html` with includes resolved and a `google.script.run` shim backed by an in-memory repository, so every screen can be opened and screenshot without Google.
