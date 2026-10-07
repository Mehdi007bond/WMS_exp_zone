# EXP2 Digital Twin v2: real MB51 format, labels, projects, 6-hour alert

Contract for the v2 changes. Everything in [ARCHITECTURE.md](ARCHITECTURE.md) stays true unless this page says otherwise. Every module follows it; when this page and the code disagree, this page wins (or is fixed first).

What drives v2: the user's real MB51 export (`sample-data/mb51-reel/MB51_reel_anonymise.xlsx`, anonymised extract of 04–05.10.2026) and three requests:

1. **Import this exact format** (22 columns, quantities, dates and times as SAP gives them) and adapt the twin to it.
2. **A references → projects panel**: the user pastes part numbers (= `Article`, exact), types or picks a project name, and the project names replace the block labels (B1, B2…) on every screen: each block (zone) of the warehouse belongs to one or more projects.
3. **An alert when a reference stays in PRD2 more than 6 hours** (declared, not yet transferred to EXP2).

The repository and every file in it must never contain the name of the user's company. Test data derived from the user's file is anonymised (operator names, header texts, amounts).

---

## 1. The real export (what the data says)

Analysis of the 23,150-line export (04–05.10.2026, plant TA11). The fixture keeps every line of the 93 finished-goods articles (2,800 lines) plus every 15th other line (1,357 lines).

| Column (exact header) | Example | Meaning for the twin |
|---|---|---|
| `Article` | `LF23855`, `73871645` | Part number (alphanumeric or numeric). Stored as text. |
| `Division` | `TA11` | Plant filter. |
| `Magasin` | `PRD2`, `EXP2`, `EMRT` | Storage location. |
| `Code mouvement` | `131`, `311` | **131** = production declaration (« Entrée marchandises »), **311** = transfer (« TR dans division »). No 601, 132, 312 in this export. |
| `Texte code mouvement` | `Entrée marchandises` | |
| `Stock spécial` | empty | |
| `Document article` | `6184102680` | Material document. Both legs of a 311 share it. No `Poste` column. |
| `Date comptable` | `05.10.2026` (Excel date) | Posting date. Night entries 00:00–01:59 are posted on the previous day. |
| `Qté en unité saisie` | `-104000`, `15` | Signed quantity. |
| `UQ de saisie` | `PCE`, `KG`, `PCD`, `M` | Unit. |
| `Désignation article` | `PRY OEM … TD I` | |
| `Montant DI` | `0` | Not used. |
| `Date de saisie` | `05.10.2026` (Excel date) | Entry date (wall clock). |
| `Heure de saisie` | `10:54:54` (Excel time) | Entry time to the second. **ts = Date de saisie + Heure de saisie.** |
| `Nom de l'utilisateur` | `BARFLOWTA11`, `ADMINJOB`, names | `BARFLOWTA11` = automatic scan. Screens show only Auto / Manuel. |
| `Texte d'en-tête pièce` | `434514671\|20261005010841`, `434523710`, `TA11P101844856`, `Z001:6184…` | On a **131** it carries the **label number** (9 digits, optionally `\|yyyymmddhhmmss` or `_n\|…`). |
| `Motif du mouvement` | `0` | Not used. |
| `Texte` | `434505101` | On a **311** (BARFLOW scan) it carries the **label number** of the container moved. |
| `Référence` | `0700011312`, `300506` | Kept (transfer requests). |
| `Client`, `Fournisseur`, `Commande client` | empty | Kept (`Client`, `Commande client`): they will be filled by 601 deliveries. |

Facts the engine relies on (all verified on the fixture by `tools/mb51_reference.py`):

- **A label is one container (one pallet).** The label of a 131 reappears on the 311 that moves it to EXP2 (99.9 % match, same article and quantity). Median time PRD2 → EXP2 is 30–36 minutes, 90 % within about 1.3–2 hours.
- **Only articles that reach EXP2 matter** (finished goods). In the full export 93 of 780 articles touch EXP2; the other 18,867 declarations are semi-finished parts consumed on the lines, plus raw materials moving between EMRT and PRD2.
- Some labels move EXP2 → PRD2 → EXP2 within seconds (re-scans), some finished goods go EXP2 → EMRT by hand (no label), some 311 legs have their other leg in a storage location outside the export (`PRD5`, …): that is normal, not an error.
- No exits (601) and no opening stock in this export: EXP2 only fills up and some issues have no known stock. The engine must stay calm about it (no wall of critical alerts).

---

## 2. Normaliser (`Normalize.gs`)

### 2.1 Headers

Add synonyms (compared after `normLabel_`, exact match):

- `qty`: `Qté en unité saisie`, `Quantité en unité saisie`, `Qté unité saisie` (keep the existing ones; the unit-of-entry quantity keeps priority over the base-unit one).
- `uqs`: `UQ de saisie`, `UQ saisie`, `Unité saisie`.

New **optional** fields, appended to `FIELDS` after `user` (order matters for nothing else):

| field | French label (`FIELD_LABELS`) | synonyms |
|---|---|---|
| `entryDate` | `Date de saisie` | `Date de saisie`, `Date saisie`, `Saisi le`, `Entry Date`, `Entered on`, `CPUDT` |
| `entryTime` | `Heure de saisie` | `Heure de saisie`, `Heure saisie`, `Heure`, `Time of Entry`, `Entry Time`, `Time`, `CPUTM` |
| `headerText` | `Texte d'en-tête pièce` | `Texte d'en-tête pièce`, `Texte en-tête pièce`, `Texte d'en-tête`, `Texte en-tête`, `Document Header Text`, `Doc. Header Text`, `BKTXT` |
| `itemText` | `Texte` | `Texte`, `Texte poste`, `Texte du poste`, `Item Text`, `Text`, `SGTXT` |
| `reference` | `Référence` | `Référence`, `Reference`, `Réf.`, `XBLNR` |
| `client` | `Client` | `Client`, `Customer`, `KUNNR` |
| `salesOrder` | `Commande client` | `Commande client`, `Cde client`, `Sales Order`, `Sales Document`, `KDAUF` |

Columns the twin does not use (`Montant DI`, `Motif du mouvement`, `Fournisseur`) stay in `mapping.extra` and are **not** a warning.

### 2.2 New line fields

`normalizeRows` lines gain (strings, `''` when unknown):

- `ts`: `'yyyy-mm-dd hh:mm:ss'` = entry date + entry time. Entry date missing but time present → posting date + time. Time missing → `''`. Never a Date object (time zones: the wall-clock time of SAP is kept as is).
- `label`: see 2.3.
- `headerText`, `itemText`, `reference`, `client`, `salesOrder`: trimmed text (codes through `codeText_` without stripping zeros for `reference`; client/salesOrder lose leading zeros only when all digits).

`Norm.parseTime(v)` → `'hh:mm:ss'` or `null`:
- number `0 ≤ v < 1` → fraction of a day (round to the second; `0.999999` → `23:59:59`, never `24:00:00`); number `≥ 1` → its fractional part (an Excel date-time serial);
- `Date` → its local `getHours/getMinutes/getSeconds`;
- text `h:mm`, `hh:mm:ss`, `hh:mm:ss AM/PM` (12 AM = 00), `hhmmss` (6 digits, SAP), with surrounding spaces.

A line whose time is unreadable is **not** rejected: `ts = ''` and the summary counts it.

### 2.3 Label derivation

`Norm.labelOf(line)` (also exported; `CFG.LABEL` holds the patterns, the normaliser has the same defaults when `CFG` is absent):

```
CFG.LABEL = { itemRe: '^\\d{6,12}$', headerRe: '^(\\d{6,12})(?:[_|].*)?$', headerMvts: ['101', '102', '131', '132'] }
label = itemText            when itemText matches itemRe
      = headerRe group 1    when mvt is in headerMvts and headerText matches headerRe
      = ''                  otherwise
```

Examples: 131 header `434514671|20261005010841` → `434514671`; 131 header `434409999_1|202610050101` → `434409999`; 131 header `Z001:618402867320260005` → `''`; 311 item text `434505101` → `434505101`; 311 header `TA11P101844856` → `''` (not a 131).

### 2.4 Finished-goods filter (tracked articles)

`Norm.filterTracked(lines, tracked)` → `{ kept, dropped, keptArticles, droppedArticles, batchTracked }` where:

- `tracked`: known tracked articles (array, Set or `{code: true}`), from the server (`state.articles`, see 5.4);
- `batchTracked`: articles with at least one line in `EXP2` among `lines`;
- a line is **kept** when its article is in `tracked ∪ batchTracked` or its magasin is `EXP2`.

`normalizeBatch(files, opts)` gains `opts.tracked` and `opts.trackedOnly` (default `false` in the function; the import page passes `true` unless the user ticks « Importer aussi les articles hors produits finis »). With `trackedOnly`, the filter runs on the valid lines of all files together, **before** dedupe; dropped lines are counted, never saved. The result gains `untracked: { lines, articles }` and each file summary too.

On the fixture: 4,157 read, 4,157 valid, 2,800 kept, 1,357 dropped (196 articles), 93 tracked articles, 3,543 lines with a label, 4,157 with a time (`sample-data/mb51-reel/expected.json` → `normalize`).

### 2.5 Summary, flags

- `summarize` adds `withTime`, `withLabel`, `untracked`, `untrackedArticles`, and a `format` object per file: `{ columns, hasTime, hasLabels, hasClient, extra: [labels] }`. Rows (French): `Avec heure de saisie`, `Avec étiquette`, `Hors produits finis (ignorées)`; the sentence mentions « n hors produits finis ».
- `flagTransfers`: a **labeled** 311/312 line is never `TRANSFERT_ORPHELIN` (its other leg is in a storage location outside the export). Unlabeled lines keep the v1 rule (the messy fixtures are unchanged).
- Keys are unchanged (no `Poste` in this export → `doc|article|magasin|mvt|qty|date|rank`). `ts` and `label` are not part of the key.

---

## 3. Sheet (`Config.gs`, `Repo.gs`)

New and changed columns are **appended at the end** of existing tabs, so a sheet installed with v1 is migrated by adding headers, never by moving data.

- `MOUVEMENTS`: v1 columns, then `Saisie le`, `Étiquette`, `Texte en-tête`, `Texte`, `Référence`, `Client`, `Commande client`. `Saisie le` is **text** `yyyy-mm-dd hh:mm:ss` (format `@`): no time-zone conversion, no 1899 time bug. `Étiquette` is text.
- `ARTICLES`: v1 columns, then `Projet`.
- **`PROJETS`** (new, after `ARTICLES`): `Projet`, `Blocs`, `Couleur`, `Commentaire`. `Blocs` = block ids separated by commas (`B1, B7`); `Couleur` = `#rrggbb` or empty (automatic).
- `PARAM_SEUILS`: new keys (rows added by the migration when missing):
  - `pendingHoursWarn` = 4 (`Seuil attente PRD2 - pré-alerte`, heures),
  - `pendingHoursCrit` = 6 (`Seuil attente PRD2 - alerte`, heures, « Une référence en PRD2 depuis plus de 6 h est un vrai problème »),
  - `labelIsPallet` = 1 (`1 étiquette = 1 palette`, 1/0),
  - `importTrackedOnly` = 1 (`Import : produits finis seulement`, 1/0),
  - `trackAll` = 0 (`Calcul : tous les articles`, 1/0; the engine switch of 4.2). *Corrected after the code (docs review of 07.10.2026): the migration adds this fifth row too, since `CFG.THRESHOLDS` holds it.*
- `CALC_*`: v1 columns first (unchanged, the oracle still compares them), then:
  - `CALC_STOCK` + `Source qté/pal`, `Projet`
  - `CALC_EN_ATTENTE` + `Étiquette`, `Saisie le`, `Attente (h)`, `Niveau`, `Projet`
  - `CALC_FIFO_EXP2` + `Étiquette`, `Saisie le`, `Âge (h)`, `Projet`
  - `CALC_SORTIES` + `Étiquette`, `Entrée le`, `Sortie le`, `Séjour (h)`
  - `CALC_JOURNALIER` + `Délai PRD2→EXP2 médian (h)`, `Délai PRD2→EXP2 P90 (h)`
  - `CALC_BLOCS` + `Projet(s)`
- `REGLES_PLACEMENT`: setup writes **no** placeholder rows any more (the F1–F5 families were placeholders). Criteria accepted: `ARTICLE`, `PROJET`, `FAMILLE`.
- `CFG.DEFAULT_RULES` becomes `[]`. The engine never falls back to the F1–F5 families.

Migration (`Repo.migrate_()`): idempotent, cheap (reads header rows only), run by `setup`, by `readInput` and before any write to `MOUVEMENTS`, `ARTICLES` or `PROJETS`; Script Property `SCHEMA_VERSION` = 2 once done. It appends missing headers of `MOUVEMENTS`, `ARTICLES`, `CALC_*`, creates `PROJETS` (formatted header, spare rows), adds the missing `PARAM_SEUILS` rows. It never deletes a column or a row.

Simulation ownership: `replaceSimulation` writes `PROJETS` too and sets `PROJECTS_SOURCE = SIMULATION`; `clearSimulation` empties `PROJETS` only when `PROJECTS_SOURCE` is still `SIMULATION`. A save from the projects panel sets `PROJECTS_SOURCE` to empty (the user owns the tab) and removes the saved articles from `SIM_ARTICLES` (the user owns those rows).

---

## 4. Engine v2 (`Engine.gs`)

Backward compatibility is a hard rule: with movements that have no `label` and no `ts` (the v1 oracle `sample-data/csv`), every v1 result is **identical** (all existing engine tests pass unchanged, except where this page explicitly changes a v1 behavior and the test is adapted to it).

### 4.1 Input additions

```
movements[]: + ts ('yyyy-mm-dd hh:mm:ss' | ''), label ('' | digits), client, salesOrder (optional, display only)
articles[]:  + project ('' | name)
projects:    [{ project, blocks: ['B1','B7'], color: '#rrggbb' | '', comment }]
thresholds:  + pendingHoursWarn (4), pendingHoursCrit (6), labelIsPallet (1), trackAll (0)
```

### 4.2 Tracked articles

`tracked = { articles of input.articles } ∪ { articles with a movement or an opening row in EXP2 }`. Movements and opening rows of other articles are skipped (`counts.untracked`, no alert). `thresholds.trackAll = 1` disables the filter. (The v1 oracle has no untracked article.)

### 4.3 Order

Sort key: `date`, then `ts` (string compare; `''` sorts first), then `doc`, then issuing line before receiving line, then file order.

### 4.4 Layers and consumption

Layers per (article, magasin) carry `{ qty (milli), label, ts, date, doc, origin, mvt, seq }`. A positive line pushes a layer. A negative line of `need` units:

1. **With a label**: take from the live layers with the same label (oldest `seq` first); then, if still needed, FIFO from the live **unlabeled** layers. Never from another label. If units are still missing: when this label was never stored in this (article, magasin), count `diag.preData` (stock from before the data, normal); otherwise `diag.negative`.
2. **Without a label**: v1 rule (FIFO, LIFO for `*_REV`) over all live layers, labeled or not; missing units → `diag.negative` (v1).

`NEGATIVE_STOCK` alerts: v1 behavior (one `crit` per line, max 20) when the opening stock is present; **without opening stock** (no `STOCK_INITIAL` row) a single `warn` « n sorties sans stock connu : importez le stock initial (MB52) ». `diag.preData` never raises an alert (count in `counts.preData`).

### 4.5 Quantity per pallet and pallets

- `qpp` = `ARTICLES › Qté par palette` when filled, else **learned** = the most frequent quantity of the labeled positive lines of the article (ties → the larger quantity), else unknown. `stock[].qppSource` = `ARTICLES` | `ÉTIQUETTES` | `''`. `known` = qpp is not unknown.
- With `labelIsPallet` (default 1), pallets of a bucket = number of live labeled layers + `ceil(U / qpp)` where U is the live unlabeled quantity (`U > 0` and qpp unknown → that part unknown, the article is reported as unknown). Per-layer pallets: a labeled layer = 1; the unlabeled layers use the v1 attribution (`layerPallets`) among themselves.
- With `labelIsPallet = 0`, or when a bucket has no labeled layer: v1 (`ceil(total / qpp)`).
- Daily flows: a labeled line counts 1 pallet; an unlabeled line `ceil(|qty| / qpp)` (v1).

### 4.6 Time

- `asOf` (date) as v1. `asOfTs` = the latest `ts` among the processed lines dated ≤ `asOf` (`''` when none): « the time of the data ».
- Pending rows (live PRD2 layers): `hours = (asOfTs − ts) / 3600` rounded to 2 decimals when both are known, else `null`. A row is judged in hours when its `hours` is known **and** the layer is a declared container (it carries a label, or it was pushed by a declaration 101/131): `level` = `crit` when `hours ≥ pendingHoursCrit`, `warn` when `hours ≥ pendingHoursWarn`, else `''`. The other rows keep the day rule (`days ≥ pendingDaysCrit` → `crit`, `≥ pendingDaysWarn` → `warn`; `pendingDaysCrit` = 2 × `pendingDaysWarn` unless set): rows without `ts`, and unlabeled stock moved into PRD2 by a transfer (returns from EMRT or EXP2, legs from a storage location outside the export) or from the opening stock. *Corrected after the code (docs review of 07.10.2026): the first version judged every row with a `ts` in hours.*
- FIFO EXP2 rows: `ageHours`; exits: `tsIn`, `tsOut`, `stayHours` (when both known).
- **Dwell PRD2 → EXP2**: when a PRD2 issuing line whose other leg is in EXP2 consumes a labeled layer (the first one it takes from) and both `ts` are known, `dwellHours = (line.ts − layer.ts) / 3600`, recorded on the line's posting date. Daily `dwellMedianH` (median: mean of the two middle values when even) and `dwellP90H` (nearest rank: sorted[ceil(0.9 n) − 1]), rounded to 2 decimals, `null` when none.

### 4.7 Projects and placement

- An article's project = `ARTICLES › Projet` (exact text, trimmed; compared case-insensitively, displayed as first written in `PROJETS`, else as in `ARTICLES`).
- Effective rules = `input.rules` (criteria `ARTICLE`, `PROJET`, `FAMILLE`) + one generated rule per `PROJETS` row with blocks: `{ priority: 5, criterion: 'PROJET', value: project, blocks }`. Matching: sort by priority, then `ARTICLE` < `PROJET` < `FAMILLE`, then input order; the first matching rule wins (v1 distribution inside a rule: proportional to free capacity, largest remainder, overflow `À PLACER`).
- Articles matching no rule (no project, or a project without blocks): spread over the **free blocks** (blocks targeted by no effective rule), same proportional distribution; when there is no free block they go to `À PLACER` (v1). In the oracle every block is targeted, so nothing changes.
- `input.rules` empty → no rules (no F1–F5 fallback).
- Blocks: `result.blocks[]` gains `projects` (names whose rule targets the block, rule order) and `title` = `projects.join(' / ')`, else `'Famille ' + families` when `FAMILLE` rules target it, else `'Article A1'` / `'Articles A1, A2'` when only `ARTICLE` rules target it, else `'Libre'`. *Corrected after the code (docs review of 07.10.2026): the `ARTICLE` case was missing.* `blockContents[]` entries gain `project`. `toPlace.projects` lists the projects in `À PLACER` (`Sans projet` for none).
- Colors: `result.projects` = `{ name: color }` from `PROJETS › Couleur`, else a fixed palette in sorted name order (12 colors readable on light and dark backgrounds, distinct from the saturation blue/amber/red); `'Sans projet'` = `#c9ced6`. Families keep their v1 colors.

### 4.8 KPIs and alerts

New KPIs: `asOfTs`, `pendingLabels` (pending rows with a label), `pendingWarn` and `pendingCrit` (pallets of pending rows by level), `oldestPendingHours`, `dwellMedianH`, `dwellP90H` (of `asOf`), `trackedArticles`, `noProjectArticles` (tracked articles with EXP2 or PRD2 stock and no project), `projects` (number of projects with at least one article).

New alerts (French, critical first as v1):

- `PRD2_CRIT` (`crit`), when the rows judged in hours (4.6) hold pallets at level `crit`: « n palette(s) en PRD2 depuis plus de 6 h · la plus ancienne : <article> <projet> depuis 8 h 12 (étiquette 434503024) », n = those pallets, the oldest = the row judged in hours with the longest wait. The threshold value comes from `pendingHoursCrit` (`6` in the text).
- `PRD2_WARN` (`warn`), when the rows judged in hours hold pallets at level `warn`: « n palette(s) en PRD2 depuis 4 à 6 h ».
- *Corrected after the code (docs review of 07.10.2026): the first version tied both alerts to the KPIs `pendingCrit` / `pendingWarn`, which also count the rows judged in days (those raise `PENDING_STUCK`). On data where every pending row has an entry time, both give the same number.*
- `NO_PROJECT` (`warn`), when `noProjectArticles > 0`: « n référence(s) suivie(s) sans projet : affectez-les dans la page Projets ».
- `UNPAIRED_TRANSFER`: counts only **unlabeled** unpaired legs (labeled legs are normal, see 1).
- `PENDING_STUCK` (days) stays for rows without `ts`.

### 4.9 State additions (section 8 of ARCHITECTURE)

```
asOfTs,
kpi: + the new KPIs,
blocks[]: + projects, title; layout.blocks[]: + projects, title,
blockContents[][]: + project,
projects: { name: color },
projectsList: [{ project, color, blocks, articles, exp2Pallets, pendingPallets, pendingCrit }]  (sorted by name, 'Sans projet' last),
pending[]: + label, ts, hours, level, project, origin   (max 500 rows, oldest first; kpi carries the totals; pendingTotal = number of rows before the cut),
articles: [{ a: article, d: designation, p: project, e: EXP2 pallets, w: PRD2 pallets, m: EMRT pallets, q: qpp, qs: qppSource, t: last ts or date }]
          every tracked article, sorted by article (feeds the projects page and the import filter),
daily[]: + dwellMedianH, dwellP90H
```

`lookup(article)` gains `project`, `qppSource`, and the label/time fields on its fifo, pending and exits rows.

### 4.10 Oracle for the real format

`tests/engine.test.js` normalises `sample-data/mb51-reel/MB51_reel_anonymise.xlsx` with `Norm` (`trackedOnly`, no known tracked articles), computes with no opening, no ARTICLES, no projects, default thresholds, and must match `expected.json › engine`: `asOf`, `asOfTs`, learned qpp per article, pending (labeled count, unlabeled quantities, pallets, `crit` = 86, `warn` = 11, oldest hours and label), EXP2 and EMRT pallets, dwell of `asOf` (count, median, P90), daily declared / entries / exits, `preData`, `negative`. `tools/mb51_reference.py` is the independent Python implementation that produced it; if the engine and the reference disagree, find which one breaks this page before changing either.

---

## 5. API and server (`Api.gs`, `Main.gs`)

### 5.1 Reads (no key)

`api_getProjects()` → `{ version, projects: [{ project, blocks: [ids], color, comment, listed }], references: [{ article, designation, project }], blocks: [{ id, label, capacity }], settings: { pendingHoursWarn, pendingHoursCrit } }`, read from `ARTICLES`, `PROJETS`, `LAYOUT` and `PARAM_SEUILS` (small tabs). Project names only typed in `ARTICLES › Projet` follow the `PROJETS` rows with `listed: false` and no blocks. Article statistics come from `state.articles` on the client. *Corrected after the code (docs review of 07.10.2026): `PARAM_SEUILS` and `listed` were missing.*

### 5.2 Writes (admin key, script lock, recalculation, version bump, ACCUEIL refresh)

- `api_saveReferences(key, rows)`: `rows = [{ article, project }]` (max 2,000). Article: trimmed, upper-cased, leading zeros removed for all-digit codes, must match `^[0-9A-Za-z._/-]{1,40}$`; project: trimmed, collapsed spaces, max 40 characters, no `,` `;` `|`, `''` = remove the project. Upsert into `ARTICLES` (new rows get the designation from the last state when known). The project name is written with the spelling already used in `PROJETS` when it matches case-insensitively. A new project name is added to `PROJETS` (no blocks yet). → `{ created, updated, unchanged, invalid: [{ article, reason }], newProjects: [names], versions, summary, message }`.
- `api_saveProjects(key, projects)`: replaces `PROJETS` (max 100 rows): names unique case-insensitively, blocks must exist in `LAYOUT`, color `#rrggbb` or `''`. A block may belong to several projects. → `{ saved, versions, summary, message }`.
- `api_renameProject(key, from, to)`: renames in `PROJETS` and in `ARTICLES › Projet` (case-insensitive match of `from`). Merging into an existing project is allowed (blocks are united). → `{ renamed: rows, versions, summary, message }`.

The import (`api_importLines`) stores the v2 fields. Its lines are already filtered by the page; the server validates the new fields like the old ones (`ts` must match `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$` or be empty; `label` digits ≤ 12 or empty; texts ≤ 200 characters).

### 5.3 Sheet

- Menu **EXP2 Jumeau** gains « Projets & références » (opens the sidebar panel `SidebarProjets`), between « Recalculer » and « Panneau de contrôle ».
- `SidebarProjets.html` (new, 300 px): paste box (one reference per line, or two columns copied from Excel: reference ⇥ project), project field with the existing names (`datalist`), « Aperçu » then « Enregistrer », the list of projects with their blocks (edit blocks per project), and a link to the full web page. Server functions `sidebar_getProjects()`, `sidebar_saveReferences(rows)`, `sidebar_saveProjects(projects)` (editors only, no key: `requireSheet_`).
- `WEB_PAGES_` gains `projects`. ACCUEIL status shows « PRD2 > 6 h : n ».

### 5.4 Import page filter

The page reads the tracked articles from `state.articles` (codes) and passes `trackedOnly` from `PARAM_SEUILS › importTrackedOnly` (state `thresholds`) unless the user ticks « Importer aussi les articles hors produits finis ».

---

## 6. Simulation v2 (`Simulation.gs`)

Replaces the v1 generator. Same API names; output in the **real format** (section 1) so the demo looks like the real data and exercises every v2 rule. Deterministic (seeded).

```
Sim.generate({ seed, startDate | endDate, days, palletsPerDay, edgeCases })
  -> { movements, opening, articles, projects, docks, asOf, openingDate, params, facts }
Sim.nextDay({ seed, movements, opening, articles, asOf?, palletsPerDay? })
  -> { movements: lines of the next day only, docks, asOf }
Sim.makeDocks(seed, date), Sim.nextWorkingDay(iso)     (every day is a working day: the plant runs 7 days a week)
Sim.mb51Rows(movements, { noise: true, seed })          -> [header row of the 22 real labels, ...rows] (an MB51 file to test the import;
                                                           noise adds semi-finished 131 lines and EMRT <-> PRD2 raw-material 311 lines
                                                           that the finished-goods filter must drop)
```

Defaults: `days` 7 (1–60), `palletsPerDay` 450 labels (20–1,500), `seed` 2026, `endDate` `2026-10-05` in `Sim` (`Sim.DEFAULTS`), `startDate` = `endDate` − (`days` − 1). The app (menu, ACCUEIL button, control panel, `api_simulate`) passes `endDate` = yesterday. *Corrected after the code (docs review of 07.10.2026).*

Model:
- ~36 fictional finished-goods articles (codes shaped like the real ones: two letters + five digits, or eight digits; never real codes), designations like `PROJECTEUR ATLAS ECO TD G`, unit PCE, quantity per label from {6, 8, 12, 15, 18, 24, 50, 60, 80, 84}. 6 fictional projects `ATLAS`, `BOREAL`, `CORSO`, `DELTA`, `ETNA`, `FJORD` with blocks (`ATLAS` → B1, B7; `BOREAL` → B2, B8; `CORSO` → B3; `DELTA` → B4; `ETNA` → B5; `FJORD` → B6) and colors; 3 articles without a project.
- Declarations: 131 into PRD2 around the clock (hourly profile like the real one), one line per label, user `BARFLOWTA11` (a few `ADMINJOB` and manual `OPERATEUR01..03`), header `label|yyyymmddhhmmss` (80 %) or `label` (20 %), label numbers sequential 9 digits from 434500000. About 7 % of labels are declared directly into EXP2.
- Transfers PRD2 → EXP2: 311 two lines (PRD2 −, EXP2 +), same doc, header `TA11P1` + 8 digits sequential, `Texte` = label, user `BARFLOWTA11`. Lag: median ~35 min, 90 % < 2 h; about 2 % between 4 and 6 h; about 1 % over 6 h; at the end of the period 2–4 labels pending over 6 h and 2–4 between 4 and 6 h (facts list them).
- Re-scans (~1.5 % of labels): EXP2 → PRD2 then PRD2 → EXP2 10–60 s later, same label. Manual EXP2 → EMRT moves (no label, header `Lot ddmmyyyy`) now and then.
- Exits 601 (simulated: the real export does not have them yet), per truck: one line per article (no label, quantity = whole labels of the oldest stock), `Client` `CLIENT A…D`, `Commande client` 10 digits, document = the truck; ~14 trucks a day so EXP2 stays between ~60 % and ~85 %.
- Posting date: entries between 00:00 and 01:59 are posted on the previous day (as in the real file). Document numbers: 10 digits starting `69` (never collide with real ones), increasing with time.
- Opening stock (MB52-like, unlabeled) the day before the first day: EXP2 ~55 % of capacity.
- `nextDay` continues label and document sequences from the data, transfers the labels still pending when due, never issues more than the stock.

---

## 7. Screens

All French, no operator names, same design rules as v1 (TV dark, PC light).

- **New PC page `projects` « Projets »** (nav label « Projets »):
  1. « Coller des références »: textarea (one per line, or two columns copied from Excel: Référence ⇥ Projet), project input with `datalist` of existing projects (a new name creates the project), « Aperçu » → table Référence · Désignation (from `state.articles`, else « jamais vue dans les données ») · Projet actuel · Nouveau projet · Statut (Nouvelle / Changement / Inchangée / Invalide), then « Enregistrer (n) » (admin key).
  2. « Zones par projet »: one row per block (id, sketch label, capacity) with the projects assigned (chips + input with `datalist`), a color per project, a small 2D plan preview with project names on the blocks; « Enregistrer les zones ».
  3. « Projets »: name, color, blocks, references, EXP2 pallets, pending, over 6 h; rename.
  4. « Références sans projet »: tracked articles without a project (designation, EXP2 pallets, pending), checkboxes + « Affecter à » project.
  5. « Toutes les références »: search and project filter, change the project of a row.
- **En attente**: one row per label: Étiquette, Article, Désignation, Projet, Déclarée le (dd/mm hh:mm), Attente (`h h mm`), Auto/Manuel; red from `pendingHoursCrit`, amber from `pendingHoursWarn`; header counts « n en attente · n depuis plus de 6 h · plus ancienne 8 h 12 » « à l'heure des données (05/10 22:09) »; project filter; sorted oldest first.
- **TV**: the pending tile shows « dont > 6 h : n » in red when n > 0 and the oldest wait; the ticker carries `PRD2_CRIT` first; the 3D/iso pending ghost pallets turn red for `crit` rows; block labels show the project names (`title`), the legend lists projects with their colors; header « Données SAP jusqu'au 05/10/2026 22:09 · importées à … ».
- **Plan 2D**: block tags show the project names (`title`) with the block id small; colors per project in the legend; the block panel lists articles with their project.
- **3D / isometric**: pallets colored by project (family color for v1 data, neutral grey when neither).
- **Recherche article**: project, quantity per pallet and its source, EXP2 labels with entry time and age in hours, pending labels with hours, exits with times.
- **Import**: format line « Format MB51 reconnu : 22 colonnes · heure de saisie ✓ · étiquettes ✓ (n) », the filter result « n lignes gardées (produits finis) · n ignorées (n articles hors produits finis) », the checkbox « Importer aussi les articles hors produits finis ».
- **Simulation**: parameters in labels per day; a button « Télécharger un MB51 simulé (.xlsx) » (`Sim.mb51Rows` with noise, SheetJS `writeFile`) to try the import.

---

## 8. Tests

- `npm test` stays green: v1 oracle unchanged; new tests for the real-format fixture (normaliser counts, labels, times, filter; engine vs `expected.json`), `parseTime`, `labelOf`, migration of a v1 sheet (in-memory repo and fake services), projects APIs (validation, upsert, rename, simulation ownership), simulation v2 invariants (format, labels unique, lags, night posting rule, pending > 6 h at the end, no negative stock, `nextDay` continuity, determinism, `mb51Rows` round-trip through `Norm` with the filter dropping the noise).
- `npm run e2e`: new scenarios `pc-projects` (paste, preview, save, zones → block labels change on the plan), `pc-pending-hours` (red rows over 6 h), `tv-prd2-alert` (ticker and tile), `pc-import-real` (the fixture file through the import page: format line and filter counts).
- No file of the repository contains the user's company name (checked before every push).
