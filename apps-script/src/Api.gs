/**
 * EXP2 Digital Twin - web app API (called with google.script.run).
 *
 * Plain JavaScript: every read and write goes through Repo (Repo.gs in Apps Script, tests/harness/repo-memory.js in
 * Node and in the local harness), the calculation through Engine, the import checks through Norm and the generated
 * data through Sim. Public functions are the api_* below (docs/ARCHITECTURE.md section 7); helpers end with '_'
 * (private: Apps Script does not expose them to the client). Main.gs reuses the run*_ helpers for the menu,
 * the ACCUEIL buttons and the sidebar.
 *
 * Read (no key):  api_getVersion, api_getState, api_lookup, api_searchArticles
 * Key check:      api_checkKey (before a form is filled in)
 * Write (key):    api_importLines, api_importOpening, api_saveDock (docks or admin key), api_simulate,
 *                 api_simulateNextDay, api_recompute
 *
 * Screens never receive user names: SAP users become 'Auto' (interface) or 'Manuel'.
 */

var API_LIMITS_ = {
  linesPerCall: 5000,       // the import page sends batches of 500 lines
  openingRows: 20000,
  lookupMovements: 300,     // SAP lines kept per article page (newest first)
  lookupWarm: 200,          // article pages put in the cache after a calculation (the cache holds about 1,000 items)
  searchResults: 20,
  rejectedListed: 50,
  importFiles: 20,          // file names kept in the running totals of an import
  simDaysMax: 60,
  cacheS: 21600
};

// Article number accepted by api_lookup and the import (SAP material numbers, letters for test articles).
var ARTICLE_RE_ = /^[0-9A-Za-z._\/-]{1,40}$/;

// Fields of a public SAP line in the stored article pages (arrays keep the hidden _LOOKUP tab small).
var LOOKUP_MOVE_FIELDS_ = ['date', 'doc', 'poste', 'magasin', 'mvt', 'text', 's', 'qty', 'uqs', 'user', 'source'];

// ---------------------------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------------------------

/** Version stamps: { data, docks }. Polled by the screens every 60 s. */
function api_getVersion() {
  return Repo.getVersions();
}

/** Compact state (docs/ARCHITECTURE.md section 8), with the live docks. */
function api_getState() {
  requireInstalled_();
  var state = Repo.loadState();
  if (!state) {
    // No stored state (never calculated, or the hidden copy is unreadable): calculate once, but never wait behind
    // another write from a key-less read (the client keeps its last good state on an error).
    try {
      state = Repo.withLock('data', function () {
        return Repo.loadState() || computeAndSave_('RECALCUL').state;
      }, 0);
    } catch (e) {
      if (e && e.busy) throw new Error('État non calculé : un recalcul est en cours, nouvel essai automatique dans une minute.');
      throw e;
    }
  }
  return withLiveDocks_(state);
}

/**
 * One article: { article, found, designation, asOf, version, stock, fifo, pending, exits, locations, movements,
 * movementsTotal }. Never recalculates: the pages are prepared by computeAndSave_ (hidden _LOOKUP tab + cache), so a
 * lookup costs one cache read, or one row of the sheet.
 */
function api_lookup(article) {
  requireInstalled_();
  var art = articleCode_(article);
  if (!art) throw new Error('Saisissez un numéro d\'article.');
  if (!ARTICLE_RE_.test(art)) throw new Error('Numéro d\'article invalide.');
  var version = Repo.getVersions().data;
  var cacheKey = 'lk:' + version + ':' + art;
  var entry = Repo.cacheGet(cacheKey);
  if (!entry) {
    var row = Repo.loadLookup(art);
    // Pages written for an older data version (code updated, failed save): ask for a recalculation.
    if (!row || !(row.version >= version)) {
      throw new Error('Fiches articles pas encore préparées : lancez « Recalculer » (onglet ACCUEIL ou menu EXP2 Jumeau).');
    }
    entry = row.entry || lookupNotFound_(art);
    Repo.cachePut(cacheKey, entry, API_LIMITS_.cacheS);
  }
  return expandLookup_(entry, version);
}

/** Up to 20 { article, designation } whose number or designation matches the text. */
function api_searchArticles(text) {
  requireInstalled_();
  var q = fold_(text);
  if (!q) return [];
  var digits = q.replace(/\s+/g, '');
  var qArticle = /^\d+$/.test(digits) ? digits.replace(/^0+(?=\d)/, '') : digits;
  var tokens = q.split(/\s+/).filter(function (t) { return t; });
  var scored = [];
  articleIndex_().forEach(function (e) {
    var a = e[0], d = fold_(e[1]);
    var score = -1;
    if (a === qArticle) score = 0;
    else if (a.indexOf(qArticle) === 0) score = 1;
    else if (a.indexOf(qArticle) >= 0) score = 2;
    else if (tokens.every(function (t) { return d.indexOf(t) >= 0 || a.indexOf(t) >= 0; })) score = 3;
    if (score >= 0) scored.push({ s: score, article: a, designation: e[1] });
  });
  scored.sort(function (x, y) { return (x.s - y.s) || cmp_(x.article, y.article); });
  return scored.slice(0, API_LIMITS_.searchResults).map(function (x) {
    return { article: x.article, designation: x.designation };
  });
}

/** true when the key opens the scope ('admin', or 'docks': docks or admin key), else 'Clé incorrecte'. Writes nothing. */
function api_checkKey(key, scope) {
  checkKey_(key, scope === 'docks' ? 'docks' : 'admin');
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------------------------------------------

/**
 * Saves one batch of MB51 lines normalised in the browser (Norm.normalizeRows).
 * meta: { importId, fileName, kind, period, final, alerts }. The server re-validates every line (plant, required
 * fields, numbers, dates), rebuilds its key and skips the keys already in MOUVEMENTS. meta.final recalculates once
 * and writes one IMPORT_LOG row for the whole import.
 */
function api_importLines(key, meta, lines) {
  checkKey_(key, 'admin');
  requireInstalled_();
  requireNorm_();
  meta = meta || {};
  if (!Array.isArray(lines)) lines = [];
  if (lines.length > API_LIMITS_.linesPerCall) {
    throw new Error('Trop de lignes dans un seul envoi (' + lines.length + ', maximum ' + API_LIMITS_.linesPerCall + ') : envoyez le fichier par lots.');
  }
  var started = Date.now();
  var importId = cleanId_(meta.importId) || ('IMP-' + compactStamp_(new Date()));
  var fileName = text_(meta.fileName, 200);
  var kind = text_(meta.kind, 40) || 'MB51';
  var checked = validateLines_(lines);

  var res = Repo.withLock('data', function () {
    var d = Norm.dedupe(checked.lines, Repo.existingKeys());
    Repo.appendMovements(d.fresh, { importId: importId, source: 'IMPORT', fileName: fileName });

    // Running totals of the import (Script Property: the cache may evict them between batches).
    var totalsKey = 'IMPORT_' + importId;
    var totals = Repo.getProp(totalsKey) || { read: 0, fresh: 0, known: 0, rejected: 0, dateMin: '', dateMax: '', files: [] };
    totals.read += lines.length;
    totals.fresh += d.fresh.length;
    totals.known += d.duplicates.length;
    totals.rejected += checked.rejected.length;
    checked.lines.forEach(function (l) {
      if (!totals.dateMin || l.date < totals.dateMin) totals.dateMin = l.date;
      if (!totals.dateMax || l.date > totals.dateMax) totals.dateMax = l.date;
    });
    if (fileName && totals.files.indexOf(fileName) < 0 && totals.files.length < API_LIMITS_.importFiles) totals.files.push(fileName);

    var out = {
      ok: true,
      importId: importId,
      received: lines.length,
      accepted: checked.lines.length,
      added: d.fresh.length,
      duplicates: d.duplicates.length,
      rejected: checked.rejected.length,
      rejectedLines: checked.rejected.slice(0, API_LIMITS_.rejectedListed),
      final: !!meta.final,
      versions: Repo.getVersions()
    };

    if (!meta.final) {
      Repo.setProp(totalsKey, totals);
      out.message = plural_(d.fresh.length, 'nouvelle ligne enregistrée', 'nouvelles lignes enregistrées') + ', ' +
        plural_(d.duplicates.length, 'déjà connue', 'déjà connues') + ', ' + plural_(checked.rejected.length, 'rejetée', 'rejetées') + '.';
      return out;
    }
    var at = new Date().toISOString();
    var calc = computeAndSave_('IMPORT', at);
    Repo.logImport({
      at: at,
      kind: kind,
      file: totals.files.join(', ') || fileName,
      period: text_(meta.period, 60) || period_(totals.dateMin, totals.dateMax),
      read: totals.read,
      fresh: totals.fresh,
      known: totals.known,
      rejected: totals.rejected,
      alerts: Number(meta.alerts) >= 0 ? Number(meta.alerts) : null,
      result: 'OK',
      seconds: Math.round((Date.now() - started) / 100) / 10
    });
    Repo.setProp(totalsKey, null);
    out.totals = { read: totals.read, added: totals.fresh, duplicates: totals.known, rejected: totals.rejected };
    out.versions = Repo.getVersions();
    out.summary = summary_(calc.state);
    out.message = 'Import terminé : ' + plural_(totals.fresh, 'nouvelle ligne', 'nouvelles lignes') + ', ' +
      plural_(totals.known, 'déjà connue', 'déjà connues') + ', ' + plural_(totals.rejected, 'rejetée', 'rejetées') +
      '. ' + out.summary.text;
    if (calc.state.source === 'SIMULATION') {
      out.warning = 'Des données simulées sont encore présentes : menu EXP2 Jumeau › Simulation › Effacer la simulation avant de passer aux données réelles.';
    }
    return out;
  });
  // The ACCUEIL status is refreshed once, after the last batch.
  return meta.final ? finishWrite_(res) : res;
}

/** Replaces STOCK_INITIAL (MB52 / MB5B rows { article, division, magasin, designation, qty, uqs, date }) and recalculates. */
function api_importOpening(key, rows) {
  checkKey_(key, 'admin');
  requireInstalled_();
  if (!Array.isArray(rows) || !rows.length) throw new Error('Aucune ligne de stock initial reçue.');
  if (rows.length > API_LIMITS_.openingRows) {
    throw new Error('Trop de lignes de stock initial (' + rows.length + ', maximum ' + API_LIMITS_.openingRows + ').');
  }
  var started = Date.now();
  var checked = validateOpening_(rows);
  if (!checked.rows.length) throw new Error('Aucune ligne de stock initial valide : ' + (checked.rejected[0] ? checked.rejected[0].reason : 'fichier vide') + '.');

  return finishWrite_(Repo.withLock('data', function () {
    Repo.replaceOpening(checked.rows);
    var at = new Date().toISOString();
    var calc = computeAndSave_('IMPORT', at);
    var dates = checked.rows.map(function (r) { return r.date; }).filter(function (d) { return d; }).sort();
    Repo.logImport({
      at: at, kind: 'STOCK INITIAL', file: '', period: dates.length ? period_(dates[0], dates[dates.length - 1]) : '',
      read: rows.length, fresh: checked.rows.length, known: 0, rejected: checked.rejected.length, alerts: null,
      result: 'OK', seconds: Math.round((Date.now() - started) / 100) / 10
    });
    var summary = summary_(calc.state);
    return {
      ok: true,
      received: rows.length,
      saved: checked.rows.length,
      rejected: checked.rejected.length,
      rejectedLines: checked.rejected.slice(0, API_LIMITS_.rejectedListed),
      versions: Repo.getVersions(),
      summary: summary,
      message: 'Stock initial remplacé : ' + plural_(checked.rows.length, 'ligne', 'lignes') + '. ' + summary.text
    };
  }));
}

/**
 * Updates one dock (docks key or admin key) and appends the change to VISITES_CAMIONS. The stored state is not
 * patched: api_getState overlays the live QUAIS_CAMIONS as soon as the docks version moved (withLiveDocks_).
 */
function api_saveDock(key, dock) {
  checkKey_(key, 'docks');
  requireInstalled_();
  return Repo.withLock('docks', function () {
    var clean = cleanDock_(dock, Repo.readDocks());
    var saved = Repo.saveDock(clean, 'Page Quais & camions') || clean;
    Repo.bumpVersion('docks');
    return { ok: true, dock: saved, versions: Repo.getVersions(), message: 'Quai ' + quaiLabel_(saved.quai) + ' enregistré.' };
  });
}

/**
 * New simulation (replaces the simulated data, keeps imported lines).
 * params: { days (working days, default 14), endDate ('yyyy-mm-dd', default last working day before today),
 *           startDate, palletsPerDay, seed (default 2026), articles (default 40), edgeCases (default true) }
 */
function api_simulate(key, params) {
  checkKey_(key, 'admin');
  return runSimulation_(params);
}

/** Appends one simulated working day after the last day of data. */
function api_simulateNextDay(key) {
  checkKey_(key, 'admin');
  return runNextDay_();
}

/** Recalculates everything from the sheet (after a manual change of ARTICLES, LAYOUT, rules, settings). */
function api_recompute(key) {
  checkKey_(key, 'admin');
  return runRecompute_();
}

// ---------------------------------------------------------------------------------------------------------------
// Actions shared with Main.gs (menu, ACCUEIL buttons, sidebar)
// ---------------------------------------------------------------------------------------------------------------
function runSimulation_(params) {
  requireInstalled_();
  requireSim_();
  var p = simParams_(params || {});
  var started = Date.now();
  return finishWrite_(Repo.withLock('data', function () {
    var gen = Sim.generate({ seed: p.seed, startDate: p.startDate, endDate: p.endDate, days: p.days,
      palletsPerDay: p.palletsPerDay, articles: p.articles, edgeCases: p.edgeCases, blocks: Repo.readLayout().blocks }) || {};
    var movements = ensureLineKeys_(gen.movements || [], 'SIMULATION');
    var importId = 'SIM-' + compactStamp_(new Date());
    Repo.replaceSimulation({ movements: movements, opening: gen.opening || [], articles: gen.articles || [],
      docks: gen.docks || [], importId: importId });
    if (gen.docks && gen.docks.length) Repo.bumpVersion('docks');
    var dates = movements.map(function (m) { return m.date; }).filter(function (d) { return d; }).sort();
    p.firstDate = dates[0] || p.startDate;
    p.lastDate = dates.length ? dates[dates.length - 1] : p.endDate;
    Repo.setProp('SIM_PARAMS', p);
    var at = new Date().toISOString();
    var calc = computeAndSave_('SIMULATION', at);
    var summary = summary_(calc.state);
    Repo.logImport({
      at: at, kind: 'SIMULATION', file: 'Simulation (graine ' + p.seed + ')', period: period_(p.firstDate, p.lastDate),
      read: movements.length, fresh: movements.length, known: 0, rejected: 0, alerts: calc.state.alerts.length,
      result: 'OK', seconds: Math.round((Date.now() - started) / 100) / 10
    });
    return {
      ok: true,
      params: p,
      lines: movements.length,
      versions: Repo.getVersions(),
      summary: summary,
      message: 'Simulation générée : ' + plural_(p.days, 'jour ouvré', 'jours ouvrés') + ' ' + period_(p.firstDate, p.lastDate) +
        ', ' + plural_(movements.length, 'ligne MB51', 'lignes MB51') + '. ' + summary.text
    };
  }));
}

function runNextDay_() {
  requireInstalled_();
  requireSim_();
  var started = Date.now();
  return finishWrite_(Repo.withLock('data', function () {
    var input = Repo.readInput();
    var simulated = input.movements.filter(function (m) { return String(m.source).toUpperCase() === 'SIMULATION'; });
    if (!simulated.length) {
      throw new Error('Aucune simulation en cours : lancez d\'abord « Générer 14 jours ».');
    }
    var p = Repo.getProp('SIM_PARAMS') || { seed: 2026 };
    var asOf = '';
    input.movements.forEach(function (m) {
      if (m.date && m.date > asOf) asOf = m.date;
    });
    var r = Sim.nextDay({ seed: p.seed, asOf: asOf, movements: input.movements, opening: input.opening,
      articles: input.articles, palletsPerDay: p.palletsPerDay, blocks: input.blocks, mvtKinds: input.mvtKinds }) || {};
    var lines = ensureLineKeys_(r.movements || [], 'SIMULATION');
    var d = typeof Norm !== 'undefined' && Norm ? Norm.dedupe(lines, Repo.existingKeys()) : { fresh: lines, duplicates: [] };
    var importId = 'SIM-' + compactStamp_(new Date());
    Repo.appendMovements(d.fresh, { importId: importId, source: 'SIMULATION', fileName: 'Simulation +1 jour' });
    // The calculation reuses the input read above (the tabs are not read a second time).
    input.movements = input.movements.concat(d.fresh.map(engineLine_));
    if (r.docks && r.docks.length) {
      Repo.replaceDocks(r.docks, 'SIMULATION');
      Repo.bumpVersion('docks');
      input.docks = Repo.readDocks();
    }
    var dates = d.fresh.map(function (m) { return m.date; }).filter(function (x) { return x; }).sort();
    var day = dates.length ? dates[dates.length - 1] : '';
    if (day) {
      p.lastDate = day;
      Repo.setProp('SIM_PARAMS', p);
    }
    var at = new Date().toISOString();
    var calc = computeAndSave_('SIMULATION', at, input);
    var summary = summary_(calc.state);
    Repo.logImport({
      at: at, kind: 'SIMULATION +1 JOUR', file: 'Simulation (graine ' + p.seed + ')', period: day ? period_(day, day) : '',
      read: lines.length, fresh: d.fresh.length, known: d.duplicates.length, rejected: 0, alerts: calc.state.alerts.length,
      result: 'OK', seconds: Math.round((Date.now() - started) / 100) / 10
    });
    return {
      ok: true,
      day: day,
      lines: d.fresh.length,
      versions: Repo.getVersions(),
      summary: summary,
      message: (day ? 'Journée du ' + frDate_(day) + ' simulée : ' : 'Journée simulée : ') +
        plural_(d.fresh.length, 'ligne MB51', 'lignes MB51') + '. ' + summary.text
    };
  }));
}

function runRecompute_() {
  requireInstalled_();
  return finishWrite_(Repo.withLock('data', function () {
    var calc = computeAndSave_('RECALCUL');
    var summary = summary_(calc.state);
    return { ok: true, versions: Repo.getVersions(), summary: summary, ms: calc.ms,
      message: 'Recalcul terminé en ' + frNum_(calc.ms / 1000, 1) + ' s. ' + summary.text };
  }));
}

function runClearSimulation_() {
  requireInstalled_();
  return finishWrite_(Repo.withLock('data', function () {
    var cleared = Repo.clearSimulation();
    if (cleared.docks) Repo.bumpVersion('docks');
    Repo.setProp('SIM_PARAMS', null);
    var calc = computeAndSave_('RECALCUL');
    Repo.logImport({ kind: 'EFFACEMENT SIMULATION', file: '', period: '', read: null, fresh: null, known: null,
      rejected: null, alerts: calc.state.alerts.length,
      result: 'OK (' + plural_(cleared.removed, 'ligne retirée', 'lignes retirées') + ')', seconds: null });
    var summary = summary_(calc.state);
    return { ok: true, cleared: cleared, versions: Repo.getVersions(), summary: summary,
      message: 'Simulation effacée : ' + plural_(cleared.removed, 'ligne retirée', 'lignes retirées') + '. ' + summary.text };
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------------------------------------------

/**
 * Recalculates from the sheet and stores the result: CALC_* tabs, article pages (_LOOKUP + cache), compact state
 * (cache + _STATE), data version. reason: 'IMPORT' | 'SIMULATION' | 'RECALCUL'; importedAt: ISO time of the import or
 * simulation being saved (default: last IMPORT_LOG entry); input: engine input already read in this execution
 * (Repo.readInput() shape, with .layout), read here when absent. Must run inside Repo.withLock('data', ...).
 */
function computeAndSave_(reason, importedAt, input) {
  requireEngine_();
  var t0 = Date.now();
  var versions = Repo.getVersions();       // read before the docks, see withLiveDocks_
  input = input || Repo.readInput();
  var result = Engine.compute(input);
  Repo.writeCalcTables(Engine.toTables(result));
  var last = importedAt ? null : Repo.lastImport();
  var source = reason === 'SIMULATION' || result.dataSource === 'SIMULATION' ? 'SIMULATION' : 'SAP';
  var state = Engine.buildState(result, {
    layout: input.layout || Repo.readLayout(),
    version: versions.data + 1,
    computedAt: new Date().toISOString(),
    importedAt: importedAt || (last ? last.at : null),
    source: source
  });
  state.docksVersion = versions.docks;
  state.thresholds = result.thresholds;
  state.stats = { movements: result.counts.movements, processed: result.counts.processed, computeMs: result.computeMs };
  // Article pages first, stamped with the coming version: a lookup accepts pages of its version or newer.
  var lookups = buildLookups_(input, result);
  var rows = lookups.map(function (l) { return { article: l.article, designation: l.designation, json: JSON.stringify(l.entry) }; });
  Repo.saveLookups(state.version, rows);
  Repo.saveState(state);
  var v = Repo.bumpVersion('data');
  if (v !== state.version) {
    state.version = v;
    Repo.saveLookups(v, rows);
    Repo.saveState(state);
  }
  Repo.cachePut('articles:' + v, lookups.map(function (l) { return [l.article, l.designation]; }), API_LIMITS_.cacheS);
  var warm = {};
  lookups.slice().sort(function (a, b) { return b.weight - a.weight; }).slice(0, API_LIMITS_.lookupWarm).forEach(function (l) {
    warm['lk:' + v + ':' + l.article] = l.entry;
  });
  Repo.cachePutMany(warm, API_LIMITS_.cacheS);
  return { state: state, result: result, ms: Date.now() - t0 };
}

/**
 * Article pages of every article (stock, ARTICLES rows, SAP lines), sorted by article:
 * [{ article, designation, entry, weight }]. entry is what api_lookup returns, without the version and with the SAP
 * lines as arrays (LOOKUP_MOVE_FIELDS_); weight ranks the pages warmed in the cache (pallets in the twin, then lines).
 */
function buildLookups_(input, result) {
  var all = Engine.lookupAll(result);
  var moves = {}, names = {}, arts = {};
  input.movements.forEach(function (m) {
    var a = articleCode_(m.article);
    if (!a) return;
    (moves[a] = moves[a] || []).push(m);
    arts[a] = true;
  });
  (input.articles || []).forEach(function (a) {
    var c = articleCode_(a.article);
    if (!c) return;
    arts[c] = true;
    if (!names[c] && a.designation) names[c] = String(a.designation);
  });
  Object.keys(all).forEach(function (a) { arts[a] = true; });
  return Object.keys(arts).sort(cmp_).map(function (art) {
    var lk = all[art] || { article: art, stock: null, fifo: [], pending: [], exits: [], locations: [] };
    var mv = (moves[art] || []).slice().sort(function (a, b) {
      return cmp_(b.date, a.date) || cmp_(String(b.doc), String(a.doc)) || cmp_(String(a.poste || ''), String(b.poste || ''));
    });
    var designation = (lk.stock && lk.stock.designation) || names[art] || (mv[0] && mv[0].designation) || '';
    var weight = 0;
    if (lk.stock) ['EXP2', 'PRD2', 'EMRT'].forEach(function (m) { weight += Number(lk.stock[m] && lk.stock[m].pallets) || 0; });
    return {
      article: art,
      designation: designation,
      weight: weight * 1000 + mv.length,
      entry: {
        article: art,
        found: !!lk.stock || mv.length > 0,
        designation: designation,
        asOf: result.asOf,
        stock: lk.stock,
        fifo: lk.fifo,
        pending: lk.pending,
        exits: lk.exits,
        locations: lk.locations,
        m: mv.slice(0, API_LIMITS_.lookupMovements).map(function (x) {
          var p = publicMovement_(x);
          return LOOKUP_MOVE_FIELDS_.map(function (k) { return p[k]; });
        }),
        movementsTotal: mv.length
      }
    };
  });
}

// Stored article page -> api_lookup answer.
function expandLookup_(entry, version) {
  var out = {};
  for (var k in entry) if (Object.prototype.hasOwnProperty.call(entry, k) && k !== 'm') out[k] = entry[k];
  out.version = version;
  out.movements = (entry.m || []).map(function (row) {
    var o = {};
    LOOKUP_MOVE_FIELDS_.forEach(function (f, i) { o[f] = row[i]; });
    return o;
  });
  return out;
}

function lookupNotFound_(art) {
  return { article: art, found: false, designation: '', asOf: null, stock: null, fifo: [], pending: [], exits: [], locations: [],
    m: [], movementsTotal: 0 };
}

// [[article, designation]] for the search: cache, else the first two columns of the hidden _LOOKUP tab.
function articleIndex_() {
  var v = Repo.getVersions().data;
  var index = Repo.cacheGet('articles:' + v);
  if (index) return index;
  index = Repo.readLookupIndex();
  Repo.cachePut('articles:' + v, index, API_LIMITS_.cacheS);
  return index;
}

// The stored state was computed with the docks of state.docksVersion: overlay the current docks when they moved since.
function withLiveDocks_(state) {
  var versions = Repo.getVersions();
  if (state.docksVersion === versions.docks) return state;
  state = applyDocks_(state, Repo.readDocks());
  state.docksVersion = versions.docks;
  return state;
}

// Docks, dock KPIs and dock alerts of a state recomputed for another docks list (same rules as the engine).
function applyDocks_(state, docks) {
  var thr = state.thresholds || (typeof CFG !== 'undefined' && CFG.THRESHOLDS) || {};
  var warn = thr.dockStagingWarn > 0 ? thr.dockStagingWarn : 0.85;
  var staged = 0, cap = 0, occupied = 0;
  docks.forEach(function (d) {
    staged += Number(d.staged) || 0;
    cap += Number(d.capacity) || 0;
    if (String(d.status || '').trim().toLowerCase() !== 'libre') occupied++;
  });
  state.docks = docks;
  state.kpi = state.kpi || {};
  state.kpi.docksStaged = staged;
  state.kpi.docksCapacity = cap;
  state.kpi.docksOccupied = occupied;
  state.kpi.docksTotal = docks.length;
  state.kpi.dockSaturation = cap > 0 ? Math.round(staged / cap * 10000) / 10000 : null;
  var alerts = (state.alerts || []).filter(function (a) { return a.code !== 'DOCK_STAGING'; });
  docks.forEach(function (d) {
    if (!(d.capacity > 0)) return;
    var r = d.staged / d.capacity;
    if (r >= warn) {
      alerts.push({ level: 'warn', code: 'DOCK_STAGING', text: 'Quai ' + quaiLabel_(d.quai) + ' : zone quai remplie à ' + frPct_(r) +
        ' (' + d.staged + ' / ' + d.capacity + ' pal)' });
    }
  });
  state.alerts = alerts.filter(function (a) { return a.level === 'crit'; })
    .concat(alerts.filter(function (a) { return a.level !== 'crit'; }));
  return state;
}

// Short French summary of a state for the action messages and the sidebar.
function summary_(state) {
  var k = state.kpi || {};
  var crit = (state.alerts || []).filter(function (a) { return a.level === 'crit'; }).length;
  var sat = k.saturation === null || k.saturation === undefined ? '' : ' (' + frPct_(k.saturation) + ')';
  return {
    version: state.version,
    asOf: state.asOf,
    source: state.source,
    exp2Pallets: k.exp2Pallets,
    capacity: k.capacity,
    saturation: k.saturation,
    pendingPallets: k.pendingPallets,
    alerts: (state.alerts || []).length,
    critical: crit,
    text: 'Au ' + frDate_(state.asOf) + ' : ' + frNum_(k.exp2Pallets || 0, 0) + ' palettes en EXP2' + sat + ', ' +
      frNum_(k.pendingPallets || 0, 0) + ' en attente PRD2, ' + plural_((state.alerts || []).length, 'alerte', 'alertes') + '.'
  };
}

// Runs after a successful write: refreshes the ACCUEIL status when Main.gs is loaded (sheet only, best effort).
function finishWrite_(out) {
  try {
    if (typeof refreshHome_ === 'function') refreshHome_();
  } catch (e) {
    // The status block is cosmetic; the write itself succeeded.
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------
function checkKey_(key, scope) {
  var keys = Repo.getKeys();
  if (!keys.admin) throw new Error('Base non installée : ouvrez le classeur Google Sheets, menu EXP2 Jumeau › Installer / réinitialiser la base.');
  var k = keyText_(key);
  var ok = safeEqual_(k, keyText_(keys.admin));
  if (scope === 'docks') ok = safeEqual_(k, keyText_(keys.docks)) || ok;
  if (!ok) throw new Error('Clé incorrecte');
  return true;
}

function keyText_(k) {
  return String(k === null || k === undefined ? '' : k).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Compares every character whatever the first difference (no early exit on the secret).
function safeEqual_(a, b) {
  a = String(a);
  b = String(b);
  var n = Math.max(a.length, b.length);
  var diff = a.length === b.length ? 0 : 1;
  for (var i = 0; i < n; i++) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0 && b.length > 0;
}

function requireInstalled_() {
  if (!Repo.isInstalled()) {
    throw new Error('Base non installée : ouvrez le classeur Google Sheets, menu EXP2 Jumeau › Installer / réinitialiser la base.');
  }
}

function requireEngine_() {
  if (typeof Engine === 'undefined' || !Engine || !Engine.compute) throw new Error('Moteur de calcul absent (Engine.gs).');
}

function requireNorm_() {
  if (typeof Norm === 'undefined' || !Norm || !Norm.keyOf) throw new Error('Module d\'import absent (Normalize.gs).');
}

function requireSim_() {
  if (typeof Sim === 'undefined' || !Sim || !Sim.generate) throw new Error('Module de simulation absent (Simulation.gs).');
}

// Server-side check of the lines normalised in the browser: never trust the client (key rebuilt here).
function validateLines_(lines) {
  var plant = currentPlant_();
  var out = { lines: [], rejected: [] };
  var ranks = {};
  lines.forEach(function (raw, i) {
    raw = raw || {};
    var row = Number(raw.row) > 0 ? Math.floor(Number(raw.row)) : i + 1;
    var line = {
      article: Norm.codeText(raw.article, true),
      division: text_(raw.division, 10).toUpperCase(),
      magasin: text_(raw.magasin, 10).toUpperCase(),
      mvt: Norm.codeText(raw.mvt, false),
      text: text_(raw.text, 120),
      s: text_(raw.s, 4).toUpperCase(),
      doc: Norm.codeText(raw.doc, true),
      poste: Norm.codeText(raw.poste, true),
      date: Norm.parseDate(raw.date),
      qty: typeof raw.qty === 'number' ? raw.qty : Norm.parseNumber(raw.qty),
      uqs: text_(raw.uqs, 10).toUpperCase(),
      designation: text_(raw.designation, 200),
      user: Norm.canonUser(text_(raw.user, 60)),
      source: 'IMPORT'
    };
    var reasons = [];
    if (plant && line.division && line.division !== plant) reasons.push('Division ' + line.division + ' hors périmètre (' + plant + ' uniquement)');
    if (!line.article) reasons.push('Article manquant');
    else if (!ARTICLE_RE_.test(line.article)) reasons.push('Article illisible : « ' + text_(line.article, 40) + ' »');
    if (!line.magasin) reasons.push('Magasin manquant');
    if (!/^[0-9A-Za-z]{1,6}$/.test(line.mvt)) reasons.push('Type de mouvement (MvT) manquant ou illisible');
    if (!/^[0-9A-Za-z]{1,20}$/.test(line.doc)) reasons.push('Doc.article manquant ou illisible');
    if (line.poste && !/^[0-9A-Za-z]{1,10}$/.test(line.poste)) reasons.push('Poste illisible');
    if (!line.date) reasons.push('Date cpt. manquante ou illisible');
    if (typeof line.qty !== 'number' || !isFinite(line.qty)) reasons.push('Quantité manquante ou illisible');
    else if (Math.abs(line.qty) >= 1e9) reasons.push('Quantité hors limites');
    if (reasons.length) {
      out.rejected.push({ row: row, reason: reasons.join(' ; '), doc: line.doc, article: line.article, magasin: line.magasin, mvt: line.mvt });
      return;
    }
    if (!line.division) line.division = plant;
    var identity = [line.doc, line.article, line.magasin, line.mvt, Math.round(line.qty * 1000), line.date].join('|');
    ranks[identity] = (ranks[identity] || 0) + 1;
    var rank = Number(raw.rank) >= 1 && Number(raw.rank) <= 100000 ? Math.floor(Number(raw.rank)) : ranks[identity];
    line.rank = rank;
    line.key = Norm.keyOf(line, rank);
    out.lines.push(line);
  });
  return out;
}

function validateOpening_(rows) {
  var plant = currentPlant_();
  var out = { rows: [], rejected: [] };
  var parseNumber = typeof Norm !== 'undefined' && Norm ? Norm.parseNumber : Number;
  var parseDate = typeof Norm !== 'undefined' && Norm ? Norm.parseDate : function (v) { return v; };
  rows.forEach(function (raw, i) {
    raw = raw || {};
    var r = {
      article: articleCode_(raw.article),
      division: text_(raw.division, 10).toUpperCase(),
      magasin: text_(raw.magasin, 10).toUpperCase(),
      designation: text_(raw.designation, 200),
      qty: typeof raw.qty === 'number' ? raw.qty : parseNumber(raw.qty),
      uqs: text_(raw.uqs, 10).toUpperCase(),
      date: parseDate(raw.date) || ''
    };
    var reasons = [];
    if (plant && r.division && r.division !== plant) reasons.push('Division ' + r.division + ' hors périmètre');
    if (!r.article) reasons.push('Article manquant');
    if (!r.magasin) reasons.push('Magasin manquant');
    if (typeof r.qty !== 'number' || !isFinite(r.qty)) reasons.push('Quantité illisible');
    else if (r.qty < 0) reasons.push('Quantité négative');
    if (!r.date) reasons.push('Date du stock manquante');
    if (reasons.length) {
      out.rejected.push({ row: Number(raw.row) > 0 ? Number(raw.row) : i + 1, reason: reasons.join(' ; '), article: r.article, magasin: r.magasin });
      return;
    }
    if (!r.division) r.division = plant;
    out.rows.push(r);
  });
  return out;
}

var DOCK_STATUSES_ = ['Libre', 'Occupé - en attente chargement', 'Occupé - chargement en cours', 'Occupé - chargé, départ imminent'];

function cleanDock_(dock, known) {
  dock = dock || {};
  var quai = text_(dock.quai, 10).toUpperCase();
  var current = null;
  (known || []).forEach(function (d) {
    if (String(d.quai).toUpperCase() === quai) current = d;
  });
  if (!current) throw new Error('Quai inconnu : « ' + (quai || '?') + ' ».');
  var status = text_(dock.status, 60) || 'Libre';
  DOCK_STATUSES_.forEach(function (s) {
    if (fold_(s) === fold_(status)) status = s;
  });
  var free = status.toLowerCase() === 'libre';
  function time(v, label) {
    var s = text_(v, 8);
    if (!s) return '';
    var m = /^(\d{1,2})[:hH.](\d{2})$/.exec(s);
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(label + ' invalide (format HH:MM) : « ' + s + ' ».');
    return (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2];
  }
  function count(v, label, max) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(String(v).replace(',', '.'));
    if (!isFinite(n) || n < 0 || n > max) throw new Error(label + ' invalide : « ' + v + ' ».');
    return Math.round(n);
  }
  var cap = count(dock.capacity, 'Capacité zone quai', 999);
  var staged = count(dock.staged, 'Palettes en zone quai', 999);
  var colors = (typeof CFG !== 'undefined' && CFG.COLORS && CFG.COLORS.cabs) || {};
  var color = text_(dock.color, 20).toLowerCase();
  return {
    quai: current.quai,
    status: status,
    truck: free ? '' : text_(dock.truck, 30),
    carrier: free ? '' : text_(dock.carrier, 60),
    color: free || !Object.prototype.hasOwnProperty.call(colors, color) ? '' : color,
    arrival: free ? '' : time(dock.arrival, 'Heure d\'arrivée'),
    departure: free ? '' : time(dock.departure, 'Heure de départ'),
    planned: free ? null : count(dock.planned, 'Palettes prévues', 99),
    loaded: free ? null : count(dock.loaded, 'Palettes chargées', 99),
    staged: staged === null ? 0 : staged,
    capacity: cap === null ? current.capacity : cap
  };
}

// Simulation parameters with defaults: 14 working days (Monday to Saturday) ending on the last working day before today.
function simParams_(params) {
  function int(v, def, min, max, label) {
    if (v === null || v === undefined || v === '') return def;
    var n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n || n < min || n > max) throw new Error(label + ' invalide (' + min + ' à ' + max + ') : « ' + v + ' ».');
    return n;
  }
  var today = isoToday_();
  var days = int(params.days, 14, 1, API_LIMITS_.simDaysMax, 'Nombre de jours');
  var endDate = params.endDate ? isoDate_(params.endDate) : lastWorkingDayBefore_(today);
  if (!endDate) throw new Error('Date de fin invalide : « ' + params.endDate + ' ».');
  if (endDate > today) throw new Error('La date de fin ne peut pas être dans le futur.');
  if (weekday_(endDate) === 0) endDate = addDays_(endDate, -1);
  var startDate = params.startDate ? isoDate_(params.startDate) : '';
  if (params.startDate && !startDate) throw new Error('Date de début invalide : « ' + params.startDate + ' ».');
  if (!startDate) {
    startDate = endDate;
    for (var n = 1; n < days; n++) {
      startDate = addDays_(startDate, -1);
      if (weekday_(startDate) === 0) startDate = addDays_(startDate, -1);
    }
  }
  if (startDate > endDate) throw new Error('La date de début doit précéder la date de fin.');
  return {
    seed: int(params.seed, 2026, 0, 2147483647, 'Graine'),
    days: days,
    startDate: startDate,
    endDate: endDate,
    palletsPerDay: int(params.palletsPerDay, undefined, 5, 500, 'Palettes par jour'),
    articles: int(params.articles, 40, 10, 40, 'Nombre d\'articles'),
    edgeCases: params.edgeCases !== false
  };
}

// Keys for generated lines that have none (same rule as the import: Norm.keyOf with the rank inside the document).
function ensureLineKeys_(lines, source) {
  var ranks = {};
  return lines.map(function (l) {
    var line = {};
    for (var k in l) if (Object.prototype.hasOwnProperty.call(l, k)) line[k] = l[k];
    line.source = source;
    if (!line.key) {
      var identity = [line.doc, line.article, line.magasin, line.mvt, Math.round(Number(line.qty) * 1000), line.date].join('|');
      ranks[identity] = (ranks[identity] || 0) + 1;
      line.key = typeof Norm !== 'undefined' && Norm ? Norm.keyOf(line, ranks[identity])
        : [line.doc, line.poste || '', line.article, line.magasin, line.mvt, line.qty, line.date, ranks[identity]].join('|');
    }
    return line;
  });
}

function currentPlant_() {
  return (typeof CFG !== 'undefined' && CFG.PLANT) || 'TA11';
}

// Generated line as Repo.readInput() returns it after the append (engine input of the same execution).
function engineLine_(l) {
  var q = typeof l.qty === 'number' ? l.qty : Number(l.qty);
  return {
    key: text_(l.key), article: articleCode_(l.article), division: text_(l.division).toUpperCase(), magasin: text_(l.magasin).toUpperCase(),
    mvt: text_(l.mvt), text: text_(l.text), s: text_(l.s).toUpperCase(), doc: articleCode_(l.doc), poste: articleCode_(l.poste),
    date: isoDate_(l.date), qty: isFinite(q) ? q : NaN, uqs: text_(l.uqs), designation: text_(l.designation), user: text_(l.user),
    source: text_(l.source).toUpperCase() || 'SIMULATION'
  };
}

// 'Q01' -> 'Q1', as on every screen.
function quaiLabel_(q) {
  return String(q === null || q === undefined ? '' : q).replace(/^Q0(\d)$/, 'Q$1');
}

// Movement as shown on screens: no user name, only 'Auto' (interface) or 'Manuel'.
function publicMovement_(m) {
  return {
    date: m.date, doc: m.doc, poste: m.poste || '', magasin: m.magasin, mvt: m.mvt, text: m.text, s: m.s || '',
    qty: m.qty, uqs: m.uqs, user: userKind_(m.user), source: m.source
  };
}

function userKind_(u) {
  if (typeof Norm !== 'undefined' && Norm && Norm.userKind) return Norm.userKind(u);
  var k = String(u || '').toUpperCase().replace(/[\s_.\-]+/g, '');
  return /^BARFLOW/.test(k) ? 'Auto' : 'Manuel';
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------
function articleCode_(v) {
  var s;
  if (typeof v === 'number') s = isFinite(v) ? (Math.floor(v) === v ? v.toFixed(0) : String(v)) : '';
  else s = String(v === null || v === undefined ? '' : v).trim();
  if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
  return s;
}

function text_(v, max) {
  var s = v === null || v === undefined ? '' : String(v).replace(/[\u0000-\u001f]/g, ' ').trim();
  return max && s.length > max ? s.slice(0, max) : s;
}

function cleanId_(v) {
  var s = text_(v, 64);
  return /^[\w.:\-]{1,64}$/.test(s) ? s : '';
}

function fold_(s) {
  s = String(s === null || s === undefined ? '' : s);
  if (typeof s.normalize === 'function') s = s.normalize('NFD');
  return s.replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cmp_(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

function isoDate_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
  }
  var s = String(v === null || v === undefined ? '' : v).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(s);
  return m ? m[3] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[1]) : '';
}

function isoToday_() {
  return isoDate_(new Date());
}

function addDays_(iso, n) {
  var d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 86400000);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

// 0 = Sunday ... 6 = Saturday.
function weekday_(iso) {
  return new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).getUTCDay();
}

function lastWorkingDayBefore_(iso) {
  var d = addDays_(iso, -1);
  while (weekday_(d) === 0) d = addDays_(d, -1);
  return d;
}

function frDate_(iso) {
  return iso ? String(iso).slice(8, 10) + '.' + String(iso).slice(5, 7) + '.' + String(iso).slice(0, 4) : '';
}

function period_(a, b) {
  if (!a) return '';
  return a === b || !b ? frDate_(a) : 'du ' + frDate_(a) + ' au ' + frDate_(b);
}

function frNum_(x, dec) {
  var s = (Math.round(x * Math.pow(10, dec || 0)) / Math.pow(10, dec || 0)).toFixed(dec || 0);
  var parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return parts.join(',');
}

function frPct_(fraction) {
  var p = Math.round(fraction * 1000) / 10;
  return frNum_(p, p === Math.round(p) ? 0 : 1) + '\u00a0%';
}

function plural_(n, one, many) {
  return frNum_(n, 0) + ' ' + (n > 1 ? many : one);
}

function compactStamp_(d) {
  return d.getFullYear() + pad2_(d.getMonth() + 1) + pad2_(d.getDate()) + '-' + pad2_(d.getHours()) +
    pad2_(d.getMinutes()) + pad2_(d.getSeconds()) + '-' + Math.floor(Math.random() * 1e4);
}
