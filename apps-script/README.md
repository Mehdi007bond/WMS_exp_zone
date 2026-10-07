# EXP2 Digital Twin · Apps Script app (v2)

The application code of the EXP2 digital twin: one container-bound Apps Script project (Google Sheet = database, web app = TV and PC screens). The technical contract is [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md), with the v2 details in [docs/SPEC_V2.md](../docs/SPEC_V2.md); the why is in [docs/IMPLEMENTATION_PLAN.md](../docs/IMPLEMENTATION_PLAN.md). A French step-by-step guide is in the [main README](../README.md#premier-usage).

What v2 adds: the real MB51 export as SAP gives it (22 columns, entry date and time, label numbers), finished goods only, a references → projects panel (project names replace B1…B8 on every screen), and the alert when a pallet stays in PRD2 more than 6 hours.

## Files (`src/`, the clasp `rootDir`)

Every file sits directly in `src/`, with no sub-folder: clasp names each pushed file by its path relative to `rootDir`, so the project files are named `Index`, `Styles`, `Sidebar`… exactly as the code asks for them. 19 files: 8 `.gs`, 10 `.html`, the manifest.

| File | Role |
|---|---|
| `appsscript.json` | Manifest: V8, time zone Europe/Paris, web app settings |
| `Config.gs` | `CFG`: tab names, headers (v2 columns appended at the end), movement types, thresholds (PRD2 wait 4 h / 6 h), label patterns, project colors, default layout |
| `Engine.gs` | `Engine`: finished-goods filter, FIFO layers per label, pallets (1 label = 1 pallet), pending in hours, exits, daily flows and PRD2 → EXP2 delay, placement by project, KPIs, alerts, compact state, article pages (pure JS) |
| `Normalize.gs` | `Norm`: MB51 header mapping (the real 22-column export and the older layouts), French numbers, dates and times, labels, finished-goods filter, line keys, dedupe, import checks (pure JS, also runs in the browser) |
| `Simulation.gs` | `Sim`: deterministic generator in the real MB51 format (7 days by default, +1 day, a simulated MB51 file to try the import) (pure JS, also runs in the browser) |
| `Repo.gs` | `Repo`: the only code that touches Sheets, Cache, Properties and Lock; migration of a v1 sheet |
| `Api.gs` | `api_*` functions called by the web pages with `google.script.run`, projects included |
| `Main.gs` | `doGet`, `include_`, `moduleSource_`, menu **EXP2 Jumeau**, `onEdit`, ACCUEIL buttons, sidebar functions (`sidebar_*`) |
| `Assets.gs` | ACCUEIL button images |
| `Index.html` | Web app template: `?mode=tv` or `?page=twin\|plan\|lookup\|pending\|projects\|docks\|import\|simulation` |
| `Client.html` | `App`: server calls, polling, freshness, keys, router, formatting, project colors |
| `PageTv.html`, `PagesPc.html` | TV screen and PC pages (the « Projets » page included) |
| `Twin3d.html`, `Iso.html`, `Plan2d.html` | three.js view, isometric fallback, 2D plan |
| `Styles.html` | CSS |
| `Sidebar.html` | Control panel inside the sheet (menu **EXP2 Jumeau › Panneau de contrôle**) |
| `SidebarProjets.html` | **New in v2.** Projects panel inside the sheet (menu **EXP2 Jumeau › Projets & références**) |

## Install in a new Google Sheet

1. Create a Google Sheet, then **Extensions › Apps Script**. Copy the script ID (Project settings).
2. Push the code with [clasp](https://github.com/google/clasp): copy `apps-script/.clasp.json.example` to `.clasp.json` **at the repository root** and paste the script ID. It already says `"rootDir": "apps-script/src"`. Then run `clasp push` from the repository root (clasp sends the `.gs`, `.html` and `appsscript.json` files of `apps-script/src/`). In the Apps Script editor the files must appear as `Index`, `Styles`, `Main`…, never `src/Index`.
   **Without clasp (copy and paste):** in the Apps Script editor, create one file per file of `src/` with exactly the same name (**+ › Script** for each `.gs`, **+ › HTML** for each `.html`, name without the extension: `SidebarProjets`, not `SidebarProjets.html`), paste its content, and replace the default `Code.gs` content with nothing (or delete it). Then **Project settings › Show "appsscript.json"** and paste `src/appsscript.json` into it. Save.
3. Reload the sheet: menu **EXP2 Jumeau › Installer / réinitialiser la base** creates the tabs (`PROJETS` included) and the two access keys (admin, docks).
4. **Générer 7 jours** (ACCUEIL button or menu **Simulation**) fills the base with simulated data in the real format: fictional articles, labels and entry times, 6 fictional projects (ATLAS, BOREAL, CORSO, DELTA, ETNA, FJORD) with their blocks, a few labels waiting more than 6 h at the end.
5. Deploy the web app: **Déployer › Nouveau déploiement › Application Web**, execute as *Me*. Who has access is still an open decision (IT): the manifest keeps `MYSELF`; *Anyone* is needed for a TV without a Google account.
6. Copy the **/exec** URL of that deployment (**Déployer › Gérer les déploiements**) and paste it in **EXP2 Jumeau › Panneau de contrôle › Liens**, then **Enregistrer**. Apps Script often reports the `/dev` test URL instead, which only the script editors can open; the app never gives a `/dev` link to the TV.
7. **EXP2 Jumeau › Ouvrir le jumeau** gives the TV link (`?mode=tv&rotate=1`), the PC links (Jumeau 3D, Recherche article, En attente, Plan 2D, Projets, Quais & camions, Import SAP, Simulation) and the two keys.

Write actions on the PC pages (import, projects, simulation, docks) ask once per session for the admin key (or the docks key for docks). The keys are shown only to the editors of the sheet (« Ouvrir le jumeau » and the control panel), never in a cell. After a leak: **EXP2 Jumeau › Régénérer les clés**. The sheet panels (control panel, projects panel) need no key: only the editors of the sheet can open them.

After updating the code with `clasp push`, run **Recalculer** once: it rebuilds the article pages (hidden `_LOOKUP` tab) used by the « Recherche article » page.

## Update a v1 sheet to v2

1. **Code.** `clasp push` sends every file, `SidebarProjets.html` included. By hand: paste the new content of every file, and **create the new file** `SidebarProjets` (**+ › HTML**).
2. **Reload the sheet**: the menu **EXP2 Jumeau** now has « Projets & références ».
3. **EXP2 Jumeau › Installer / réinitialiser la base**, answer **NON** (« réparer seulement »): movements, opening stock, articles, projects and the import log are kept; the ACCUEIL tab is rebuilt with its new help lines; the migration below runs; everything is recalculated. (**OUI** also rewrites `LAYOUT`, `REGLES_PLACEMENT`, `PARAM_MOUVEMENTS`, `PARAM_SEUILS` and `QUAIS_CAMIONS` with the defaults.)
4. **Web app.** **Déployer › Gérer les déploiements › Modifier › Version : Nouvelle version › Déployer**. The `/exec` URL does not change; without a new version the `/exec` link keeps serving the v1 pages (no « Projets » page).
5. Old leftovers: the v1 placeholder rules of `REGLES_PLACEMENT` (families F1–F5, comment « provisoire ») are ignored by the calculation while no article carries those families, and can be deleted. A v1 simulation still in the sheet: **Simulation › Effacer la simulation**, or **Générer 7 jours** for a new one in the real format.

**What the migration does** (`Repo.migrate`, [SPEC_V2 section 3](../docs/SPEC_V2.md#3-sheet-configgs-repogs)): it appends the missing headers at the end of `MOUVEMENTS` (`Saisie le`, `Étiquette`, `Texte en-tête`, `Texte`, `Référence`, `Client`, `Commande client`), `ARTICLES` (`Projet`) and the `CALC_*` tabs; it creates `PROJETS` (`Projet`, `Blocs`, `Couleur`, `Commentaire`) after `ARTICLES`; it adds the missing `PARAM_SEUILS` rows (`pendingHoursWarn` 4, `pendingHoursCrit` 6, `labelIsPallet` 1, `importTrackedOnly` 1, `trackAll` 0). It never deletes or moves a column or a row, and it is idempotent. Besides the repair, it also runs by itself before the first recalculation, import or project save, then sets the Script Property `SCHEMA_VERSION` = 2.

## Real SAP data

1. **EXP2 Jumeau › Simulation › Effacer la simulation** (imported lines are kept, simulated ones removed, as well as the simulated articles and projects; references and projects saved from the projects panel or page are kept).
2. PC page **Import**: drop the MB51 export as SAP gives it (`.xlsx`, `.xls`, or `.txt` / `.csv`). The page shows « Format MB51 reconnu : 22 colonnes · heure de saisie ✓ · étiquettes ✓ (n) » and « n lignes gardées (produits finis) · n ignorées (n articles hors produits finis) ». Only finished goods are kept: lines in EXP2, and every line of an article that has a line in EXP2 in the files or is already followed by the twin (`ARTICLES`, or seen in EXP2 before). Tick « Importer aussi les articles hors produits finis » to keep everything (default: `PARAM_SEUILS › importTrackedOnly` = 1, box unticked). Then **Enregistrer dans la base**. Re-importing a file adds 0 lines; `IMPORT_LOG` records the lines ignored.
3. **Projects**: PC page **Projets**, or **EXP2 Jumeau › Projets & références** in the sheet (below).
4. `ARTICLES › Qté par palette` is optional for labeled articles: without it the quantity per pallet is learned from the labels (the most frequent quantity of a label). Fill `LAYOUT` after the site survey and the thresholds of `PARAM_SEUILS` when agreed, then **Recalculer**.
5. Not in the real export yet: the exits (MvT 601), so EXP2 only fills up, and the opening stock (MB52). The server function `api_importOpening` exists, but the Import page does not read an MB52 file yet.

The anonymised real-format test file and its expected figures are in [`sample-data/mb51-reel/`](../sample-data/mb51-reel/README.md).

## Projects (page « Projets » and sheet panel)

- **PC page « Projets »** (admin key for the saves): 1 « Coller des références » (one per line, or two columns copied from Excel: Référence ⇥ Projet; a project field with the existing names; « Aperçu », then « Enregistrer (n) »), 2 « Zones par projet » (blocks of each project, colors, a small plan; « Enregistrer les zones »), 3 « Projets » (counts, « Renommer »), 4 « Références sans projet » (« Affecter à »), 5 « Toutes les références » (search, project filter, change one row).
- **Sheet panel** (`SidebarProjets.html`, menu **EXP2 Jumeau › Projets & références**, editors of the sheet, no key): paste box with « Aperçu » and « Enregistrer » (the same paste rules as the page: tab or `;` between reference and project, header line skipped, a reference given twice keeps its last project, a space inside a reference or a line without project is invalid), the projects with their blocks (click the blocks, « Ajouter » a project, « Enregistrer les zones »), and a link to the full page. Server functions `sidebar_getProjects()`, `sidebar_saveReferences(rows)`, `sidebar_saveProjects(projects)` in `Main.gs`, with the same rules as `api_getProjects`, `api_saveReferences`, `api_saveProjects`.
- **What is written**: `ARTICLES › Projet` (a reference not yet in `ARTICLES` gets a new row) and `PROJETS` (`Blocs` = `B1, B7`; `Couleur` = `#rrggbb` or empty for automatic). Both tabs can also be edited by hand, then **Recalculer**. A project name has at most 40 characters, no `,` `;` `|`; « Sans projet » is reserved.
- **Effect**: the blocks of a project show its name on the 2D plan, the 3D view and the TV (block id small), pallets are colored by project, and the pallets of its references are placed in its blocks. References without a project go to the blocks of no project, else « à placer ».

## Tests and local harness (no Google needed)

```bash
npm install          # SheetJS for the Node tests
npm test             # Node tests only, no browser: 178 tests in 5 files
npm run harness      # builds tests/harness/out/*.html (open out/index.html, over HTTP or as files)
npm run e2e          # Playwright end-to-end run: 21 scenarios, screenshots in tests/harness/out/shots/
```

`npm test` (Node `--test`): `normalize.test.js` 42 (messy files, real-format fixture, times, labels, filter), `engine.test.js` 43 (v1 oracle of `sample-data/csv`, real-format fixture against `expected.json`, v2 rules), `api.test.js` 62 (API on the in-memory repo and on fake Google services: import, migration of a v1 sheet, projects, simulation ownership, sheet panels), `simulation.test.js` 22, `harness.test.js` 9. `npm run e2e` drives every screen, including the v2 scenarios `pc-projects`, `sheet-sidebars` (the two sheet panels at 300 px: paste, preview, save, blocks, then the plan and the control panel), `pc-pending-hours`, `tv-prd2-alert`, `pc-import-real` (the anonymised real export through the Import page), `pc-simulation-mb51` and `pc-simulation-generate`; any console error fails the run.

`npm run harness` renders `Index.html` with the real `doGet()` (scriptlets evaluated like Apps Script) into `tv.html` and `pc-<page>.html`, and the two sheet panels into `sidebar.html` and `sidebar-projets.html` (their buttons call the real `sidebar_*` functions of `Main.gs`; `tests/harness/sheet-stub.js` stands in for the sheet services). Each page also loads the server modules and `tests/harness/shim.js`, a `google.script.run` stand-in backed by an in-memory repository: the first page seeds a simulation (5 days, 200 labels a day, to fit the browser storage), and the pages share their data through `localStorage`, like screens share the sheet. Query flags: `?empty=1` (no data), `?none=1` (not installed), `?reset=1` (new simulation), `?seed=N&days=N&ppd=N` (first simulation), `?poll=2` (fast version polling), `?no3d=1` (isometric view), `?offline=1`, `?fresh=warn|crit`, `?lat=ms`; on the TV, `?scene=overview|plan|pending|docks`. The keys are in `window.__keys`.

The harness uses local copies of the CDN libraries in `tests/harness/vendor/` (git-ignored): `xlsx.full.min.js` is copied from `node_modules/xlsx` by the build, `three.min.js` (three.js r128) must be downloaded once from `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js` (without it the pages use the isometric view; `npm test` checks its hash against the integrity attribute of `Twin3d.html`). Google Fonts are optional (`vendor/fonts/`). Playwright and its Chromium are not in `package.json`: `e2e.js` looks for them through the `PLAYWRIGHT` and `CHROMIUM` variables, then the usual install paths.
