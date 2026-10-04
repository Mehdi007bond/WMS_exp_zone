# EXP2 Digital Twin · Apps Script app

The application code of the EXP2 digital twin: one container-bound Apps Script project (Google Sheet = database, web app = TV and PC screens). The technical contract is [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md); the why is in [docs/IMPLEMENTATION_PLAN.md](../docs/IMPLEMENTATION_PLAN.md).

## Files (`src/`, the clasp `rootDir`)

Every file sits directly in `src/`, with no sub-folder: clasp names each pushed file by its path relative to `rootDir`, so the project files are named `Index`, `Styles`, `Sidebar`… exactly as the code asks for them.

| File | Role |
|---|---|
| `appsscript.json` | Manifest: V8, time zone Europe/Paris, web app settings |
| `Config.gs` | `CFG`: tab names, headers, movement types, thresholds, colors, default layout and placement rules |
| `Engine.gs` | `Engine`: FIFO stock, pending, exits, daily flows, blocks, KPIs, alerts, compact state, article pages (pure JS) |
| `Normalize.gs` | `Norm`: MB51 header mapping, French numbers and dates, line keys, dedupe, import checks (pure JS, also runs in the browser) |
| `Simulation.gs` | `Sim`: deterministic MB51 generator (14 days, +1 day) (pure JS) |
| `Repo.gs` | `Repo`: the only code that touches Sheets, Cache, Properties and Lock |
| `Api.gs` | `api_*` functions called by the web pages with `google.script.run` |
| `Main.gs` | `doGet`, `include_`, `moduleSource_`, menu **EXP2 Jumeau**, `onEdit`, ACCUEIL buttons, sidebar functions |
| `Assets.gs` | ACCUEIL button images |
| `Index.html` | Web app template: `?mode=tv` or `?page=twin\|plan\|lookup\|pending\|docks\|import\|simulation` |
| `Client.html` | `App`: server calls, polling, freshness, keys, router, formatting |
| `PageTv.html`, `PagesPc.html` | TV screen and PC pages |
| `Twin3d.html`, `Iso.html`, `Plan2d.html` | three.js view, isometric fallback, 2D plan |
| `Styles.html`, `Sidebar.html` | CSS, control panel inside the sheet |

## Install in a Google Sheet

1. Create a Google Sheet, then **Extensions › Apps Script**. Copy the script ID (Project settings).
2. Push the code with [clasp](https://github.com/google/clasp): copy `apps-script/.clasp.json.example` to `.clasp.json` **at the repository root** and paste the script ID. It already says `"rootDir": "apps-script/src"`. Then run `clasp push` from the repository root (clasp sends the `.gs`, `.html` and `appsscript.json` files of `apps-script/src/`). In the Apps Script editor the files must appear as `Index`, `Styles`, `Main`…, never `src/Index`.
   **Without clasp (copy and paste):** in the Apps Script editor, create one file per file of `src/` with exactly the same name (**+ › Script** for each `.gs`, **+ › HTML** for each `.html`, name without the extension), paste its content, and replace the default `Code.gs` content with nothing (or delete it). Then **Project settings › Show "appsscript.json"** and paste `src/appsscript.json` into it. Save.
3. Reload the sheet: menu **EXP2 Jumeau › Installer / réinitialiser la base** creates the tabs and the two access keys (admin, docks).
4. **Générer 14 jours** (ACCUEIL button or menu **Simulation**) fills the base with simulated data.
5. Deploy the web app: **Déployer › Nouveau déploiement › Application Web**, execute as *Me*. Who has access is still an open decision (IT): the manifest keeps `MYSELF`; *Anyone* is needed for a TV without a Google account.
6. Copy the **/exec** URL of that deployment (**Déployer › Gérer les déploiements**) and paste it in **EXP2 Jumeau › Panneau de contrôle › Liens**, then **Enregistrer**. Apps Script often reports the `/dev` test URL instead, which only the script editors can open; the app never gives a `/dev` link to the TV.
7. **EXP2 Jumeau › Ouvrir le jumeau** gives the TV link (`?mode=tv&rotate=1`), the PC links and the two keys.

Write actions on the PC pages (import, simulation, docks) ask once per session for the admin key (or the docks key for docks). The keys are shown only to the editors of the sheet (« Ouvrir le jumeau » and the control panel), never in a cell. After a leak: **EXP2 Jumeau › Régénérer les clés**.

After updating the code with `clasp push`, run **Recalculer** once: it rebuilds the article pages (hidden `_LOOKUP` tab) used by the « Recherche article » page.

## Real SAP data

1. **EXP2 Jumeau › Simulation › Effacer la simulation** (imported lines are kept, simulated ones removed).
2. PC page **Import**: drop the MB51 exports (`.xlsx`, `.xls`, or `.txt` / `.csv`), check the analysis, **Enregistrer dans la base**. Re-importing a file adds 0 lines.
3. Fill `ARTICLES` (quantity per pallet, family) and `LAYOUT` after the site survey, then **Recalculer**.

## Tests and local harness (no Google needed)

```bash
npm install          # SheetJS for the Node tests
npm test             # Node tests only, no browser: engine, normaliser, simulation, API, harness build and shim
npm run harness      # builds tests/harness/out/*.html (open out/index.html, over HTTP or as files)
npm run e2e          # Playwright end-to-end run of every screen, screenshots in tests/harness/out/shots/
```

`npm run harness` renders `Index.html` with the real `doGet()` (scriptlets evaluated like Apps Script) into `tv.html` and `pc-<page>.html`. Each page also loads the server modules and `tests/harness/shim.js`, a `google.script.run` stand-in backed by an in-memory repository: the first page seeds a 14-day simulation, and the pages share their data through `localStorage`, like screens share the sheet. Query flags: `?empty=1` (no data), `?none=1` (not installed), `?reset=1` (new simulation), `?poll=2` (fast version polling), `?no3d=1` (isometric view), `?offline=1`, `?fresh=warn|crit`, `?lat=ms`. The keys are in `window.__keys`.

The harness uses local copies of the CDN libraries in `tests/harness/vendor/` (git-ignored): `xlsx.full.min.js` is copied from `node_modules/xlsx` by the build, `three.min.js` (three.js r128) must be downloaded once from `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js` (without it the pages use the isometric view; `npm test` checks its hash against the integrity attribute of `Twin3d.html`). Google Fonts are optional (`vendor/fonts/`).
