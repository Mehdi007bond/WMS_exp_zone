/**
 * EXP2 Digital Twin - in-memory Repo (same interface as apps-script/src/Repo.gs).
 *
 * Used by the Node tests (loaded in the same vm context as the .gs files) and by the local harness pages
 * (plain <script>, backs the google.script.run shim). No Google service, no require: the only global it reads is
 * CFG (Config.gs), lazily, at call time. Seeded empty; setup() creates the default layout, rules, settings and
 * docks, like the sheet version. Values cross the interface as JSON copies, the way the sheet would serialise them.
 *
 * Extra helpers for tests and the harness: reset(), dump(), snapshot(), restore(). The harness pages share one store
 * through localStorage with snapshot() / restore(), like several screens share the one Google Sheet.
 */
var Repo = (function RepoMemoryModule_() {
  var SIM = 'SIMULATION';
  var KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var db;

  function cfg_() {
    if (typeof CFG !== 'undefined' && CFG) return CFG;
    if (typeof globalThis !== 'undefined' && globalThis.CFG) return globalThis.CFG;
    throw new Error('CFG introuvable : charger Config.gs avant repo-memory.js');
  }

  function clone_(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  function str_(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function code_(v, stripZeros) {
    var s;
    if (typeof v === 'number') s = isFinite(v) ? (Math.floor(v) === v ? v.toFixed(0) : String(v)) : '';
    else s = str_(v);
    if (stripZeros && /^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
    return s;
  }

  function num_(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof Norm !== 'undefined' && Norm && Norm.parseNumber) return Norm.parseNumber(v);
    var n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? n : NaN;
  }

  function numOrNull_(v) {
    var n = num_(v);
    return isNaN(n) ? null : n;
  }

  function pad2_(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function iso_(v) {
    if (v === null || v === undefined || v === '') return '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      return isNaN(v.getTime()) ? '' : v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
    }
    var s = str_(v);
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]);
    m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/.exec(s);
    if (m) return m[3] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[1]);
    return '';
  }

  function nowIso_() {
    return new Date().toISOString();
  }

  function reset() {
    db = {
      installed: false,
      tabs: {},              // tab name -> true once created
      movements: [],         // MOUVEMENTS rows as objects (+ importId, addedAt)
      opening: [],
      articles: [],
      layout: null,          // layout object (CFG.DEFAULT_LAYOUT shape)
      rules: [],
      mvt: [],               // { mvt, kind, text, meaning, used }
      settings: [],          // { label, key, value, unit, comment }
      docks: [],
      visits: [],
      calc: {},
      importLog: [],
      stateJson: null,
      lookups: null,         // { version, rows: [[article, designation, json]] } (hidden _LOOKUP tab)
      versions: { data: 0, docks: 0 },
      keys: { admin: '', docks: '' },
      props: {},
      cache: {},
      locks: {}
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Defaults (same content as Repo.gs)
  // -------------------------------------------------------------------------------------------------------------
  var KIND_MEANINGS = {
    DECL: 'Déclaration de production (entrée en PRD2)',
    DECL_REV: 'Annulation de déclaration (consomme la couche la plus récente)',
    TRANSFER: 'Transfert entre magasins (2 lignes, même Doc.article)',
    TRANSFER_REV: 'Annulation de transfert (consomme la couche la plus récente)',
    ISSUE: 'Sortie de stock (client, rebut, autre division)',
    ISSUE_REV: 'Annulation de sortie (retour en stock)',
    ADJ: 'Écart d\'inventaire',
    IGNORE: 'Ignoré par le jumeau (composants, changement de statut)'
  };

  function defaultLayout_() {
    var L = clone_(cfg_().DEFAULT_LAYOUT);
    L.blocks.forEach(function (b) { b.capacity = b.cols * b.rows * b.levels; });
    return L;
  }

  function defaultRules_() {
    return (cfg_().DEFAULT_RULES || []).map(function (r) {
      return { priority: r.priority, criterion: r.criterion, value: r.value, blocks: r.blocks.join(', '), comment: 'provisoire' };
    });
  }

  function defaultMvt_() {
    var kinds = cfg_().MVT_KINDS, texts = cfg_().MVT_TEXTS || {};
    return Object.keys(kinds).sort().map(function (mvt) {
      var k = kinds[mvt];
      return { mvt: mvt, kind: k, text: texts[mvt] || '', meaning: KIND_MEANINGS[k] || '', used: k === 'IGNORE' ? 'Non' : 'Oui' };
    });
  }

  function defaultSettings_() {
    var th = cfg_().THRESHOLDS || {};
    var rows = [
      { label: 'Division SAP', key: 'plant', value: cfg_().PLANT, unit: '', comment: 'Les lignes des autres divisions sont rejetées' },
      { label: 'Date de référence', key: 'asOf', value: '', unit: 'date', comment: 'Vide = date du dernier mouvement (recommandé)' }
    ];
    Object.keys(th).forEach(function (k) {
      rows.push({ label: k, key: k, value: th[k], unit: '', comment: '' });
    });
    return rows;
  }

  function defaultDocks_() {
    return (cfg_().DEFAULT_LAYOUT.quais || []).map(function (q) {
      return { quai: q.id, status: 'Libre', truck: '', carrier: '', color: '', arrival: '', departure: '',
        planned: null, loaded: null, staged: 0, capacity: cfg_().DOCK_STAGING_CAPACITY };
    });
  }

  function cleanDock_(d) {
    var staged = numOrNull_(d.staged), cap = numOrNull_(d.capacity);
    return {
      quai: code_(d.quai, false),
      status: str_(d.status) || 'Libre',
      truck: str_(d.truck),
      carrier: str_(d.carrier),
      color: str_(d.color),
      arrival: str_(d.arrival),
      departure: str_(d.departure),
      planned: numOrNull_(d.planned),
      loaded: numOrNull_(d.loaded),
      staged: staged === null ? 0 : staged,
      capacity: cap === null ? cfg_().DOCK_STAGING_CAPACITY : cap
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Interface
  // -------------------------------------------------------------------------------------------------------------
  function setup(opts) {
    opts = opts || {};
    var t = cfg_().TABS;
    var created = [];
    Object.keys(t).forEach(function (k) {
      if (!db.tabs[t[k]]) {
        db.tabs[t[k]] = true;
        created.push(t[k]);
      }
    });
    var reset = !!opts.resetParams;
    if (reset || !db.layout) db.layout = defaultLayout_();
    if (reset || !db.rules.length) db.rules = defaultRules_();
    if (reset || !db.mvt.length) db.mvt = defaultMvt_();
    if (reset || !db.settings.length) db.settings = defaultSettings_();
    if (reset || !db.docks.length) db.docks = defaultDocks_();
    if (reset) delete db.props.DOCKS_SOURCE;
    db.installed = true;
    ensureKeys();
    return { created: created, reset: reset };
  }

  function isInstalled() {
    return db.installed;
  }

  function readSettings_() {
    var out = { thresholds: {}, plant: '', asOf: '' };
    db.settings.forEach(function (s) {
      if (!s.key) return;
      if (s.key === 'plant') out.plant = str_(s.value).toUpperCase();
      else if (s.key === 'asOf') out.asOf = iso_(s.value);
      else if (!isNaN(num_(s.value))) out.thresholds[s.key] = num_(s.value);
    });
    return out;
  }

  function readMvtKinds_() {
    var out = {}, n = 0;
    db.mvt.forEach(function (r) {
      var mvt = code_(r.mvt, false), kind = str_(r.kind).toUpperCase();
      if (!mvt || !kind) return;
      if (/^non/i.test(str_(r.used))) kind = 'IGNORE';
      out[mvt] = kind;
      n++;
    });
    return n ? out : clone_(cfg_().MVT_KINDS);
  }

  function readLayout() {
    return clone_(db.layout || defaultLayout_());
  }

  function readDocks() {
    return clone_(db.docks.length ? db.docks : defaultDocks_());
  }

  function readInput() {
    var settings = readSettings_();
    var plant = settings.plant || cfg_().PLANT;
    var layout = readLayout();
    return clone_({
      asOf: settings.asOf || null,
      plant: plant,
      movements: db.movements.map(function (m) {
        return { key: m.key, article: m.article, division: m.division, magasin: m.magasin, mvt: m.mvt, text: m.text, s: m.s,
          doc: m.doc, poste: m.poste, date: m.date, qty: m.qty, uqs: m.uqs, designation: m.designation, user: m.user,
          source: m.source };
      }),
      opening: db.opening.filter(function (o) { return !o.division || !plant || o.division === plant; }),
      articles: db.articles,
      blocks: layout.blocks.map(function (b) {
        return { id: b.id, label: b.label, x: b.x, y: b.y, w: b.w, h: b.h, cols: b.cols, rows: b.rows, levels: b.levels,
          color: b.color, capacity: b.capacity };
      }),
      rules: db.rules.filter(function (r) { return r.criterion && r.value && r.blocks; }),
      mvtKinds: readMvtKinds_(),
      docks: readDocks(),
      thresholds: settings.thresholds,
      layout: layout
    });
  }

  function writeCalcTables(tables) {
    Object.keys(tables || {}).forEach(function (name) {
      db.calc[name] = clone_(tables[name]);
      db.tabs[name] = true;
    });
  }

  function saveState(state) {
    db.stateJson = JSON.stringify(state);
  }

  function loadState() {
    return db.stateJson ? JSON.parse(db.stateJson) : null;
  }

  function saveLookups(version, rows) {
    db.lookups = {
      version: version,
      rows: (rows || []).map(function (r) { return [code_(r.article, false), str_(r.designation).slice(0, 200), String(r.json)]; })
    };
  }

  function loadLookup(article) {
    if (!db.lookups) return null;
    var art = code_(article, false);
    var row = null;
    for (var i = 0; i < db.lookups.rows.length && !row; i++) if (db.lookups.rows[i][0] === art) row = db.lookups.rows[i];
    return { version: db.lookups.version, entry: row ? JSON.parse(row[2]) : null };
  }

  function readLookupIndex() {
    return db.lookups ? db.lookups.rows.map(function (r) { return [r[0], r[1]]; }) : [];
  }

  function getVersions() {
    return { data: db.versions.data, docks: db.versions.docks };
  }

  function bumpVersion(kind) {
    var k = kind === 'docks' ? 'docks' : 'data';
    db.versions[k] += 1;
    return db.versions[k];
  }

  function existingKeys() {
    var out = {};
    db.movements.forEach(function (m) {
      if (m.key) out[m.key] = true;
    });
    return out;
  }

  function movement_(l, source, importId, now) {
    var q = typeof l.qty === 'number' ? l.qty : num_(l.qty);
    return {
      key: str_(l.key), article: code_(l.article, true), division: str_(l.division), magasin: str_(l.magasin),
      mvt: code_(l.mvt, false), text: str_(l.text), s: str_(l.s), doc: code_(l.doc, true), poste: code_(l.poste, true),
      date: iso_(l.date), qty: isFinite(q) ? q : null, uqs: str_(l.uqs), designation: str_(l.designation),
      user: str_(l.user), source: source, importId: str_(importId), addedAt: now
    };
  }

  function appendMovements(lines, meta) {
    meta = meta || {};
    var source = str_(meta.source).toUpperCase() || 'IMPORT';
    var now = nowIso_();
    (lines || []).forEach(function (l) {
      db.movements.push(movement_(l, str_(l.source).toUpperCase() === SIM ? SIM : source, meta.importId, now));
    });
    return (lines || []).length;
  }

  function opening_(o) {
    var q = typeof o.qty === 'number' ? o.qty : num_(o.qty);
    return { article: code_(o.article, true), division: str_(o.division) || cfg_().PLANT, magasin: str_(o.magasin).toUpperCase(),
      designation: str_(o.designation), qty: isFinite(q) ? q : null, uqs: str_(o.uqs), date: iso_(o.date) };
  }

  function article_(a) {
    return { article: code_(a.article, true), designation: str_(a.designation), uqs: str_(a.uqs), qpp: numOrNull_(a.qpp),
      palletType: str_(a.palletType), heightCm: numOrNull_(a.heightCm), levels: numOrNull_(a.levels), family: str_(a.family) };
  }

  function replaceSimulation(data) {
    data = data || {};
    var out = { removed: 0, added: 0, opening: 0, articles: 0, docks: 0 };
    if (data.movements) {
      var before = db.movements.length;
      db.movements = db.movements.filter(function (m) { return m.source !== SIM; });
      out.removed = before - db.movements.length;
      var now = nowIso_();
      data.movements.forEach(function (l) { db.movements.push(movement_(l, SIM, data.importId, now)); });
      out.added = data.movements.length;
    }
    if (Array.isArray(data.opening)) {
      db.opening = data.opening.map(opening_);
      setProp('OPENING_SOURCE', SIM);
      out.opening = data.opening.length;
    }
    if (Array.isArray(data.articles)) {
      var ids = data.articles.map(function (a) { return code_(a.article, true); }).filter(function (a) { return a; });
      var drop = {};
      (getProp('SIM_ARTICLES') || []).concat(ids).forEach(function (a) { drop[a] = true; });
      db.articles = db.articles.filter(function (a) { return !drop[a.article]; }).concat(data.articles.map(article_));
      setProp('SIM_ARTICLES', ids);
      out.articles = ids.length;
    }
    if (Array.isArray(data.docks) && data.docks.length) {
      replaceDocks(data.docks, SIM);
      out.docks = data.docks.length;
    }
    return out;
  }

  function clearSimulation() {
    var out = { removed: 0, opening: false, articles: 0, docks: false };
    var before = db.movements.length;
    db.movements = db.movements.filter(function (m) { return m.source !== SIM; });
    out.removed = before - db.movements.length;
    if (getProp('OPENING_SOURCE') === SIM) {
      db.opening = [];
      setProp('OPENING_SOURCE', null);
      out.opening = true;
    }
    var simArticles = getProp('SIM_ARTICLES') || [];
    if (simArticles.length) {
      var drop = {};
      simArticles.forEach(function (a) { drop[a] = true; });
      var n = db.articles.length;
      db.articles = db.articles.filter(function (a) { return !drop[a.article]; });
      out.articles = n - db.articles.length;
      setProp('SIM_ARTICLES', null);
    }
    if (getProp('DOCKS_SOURCE') === SIM) {
      replaceDocks(defaultDocks_(), null);
      out.docks = true;
    }
    return out;
  }

  function replaceOpening(rows) {
    db.opening = (rows || []).map(opening_);
    setProp('OPENING_SOURCE', 'IMPORT');
    return db.opening.length;
  }

  function replaceDocks(docks, source) {
    db.docks = (docks || []).map(cleanDock_);
    setProp('DOCKS_SOURCE', source || null);
    return db.docks.length;
  }

  function saveDock(dock, who) {
    var d = cleanDock_(dock);
    var found = false;
    db.docks = db.docks.map(function (x) {
      if (x.quai !== d.quai) return x;
      found = true;
      return d;
    });
    if (!found) db.docks.push(d);
    db.visits.push({ at: nowIso_(), quai: d.quai, status: d.status, truck: d.truck, carrier: d.carrier, arrival: d.arrival,
      departure: d.departure, planned: d.planned, loaded: d.loaded, staged: d.staged, by: str_(who) || 'Manuel' });
    setProp('DOCKS_SOURCE', 'MANUEL');
    return clone_(d);
  }

  function logImport(entry) {
    entry = entry || {};
    var at = entry.at ? new Date(entry.at) : new Date();
    db.importLog.push({
      at: isNaN(at.getTime()) ? nowIso_() : at.toISOString(), kind: str_(entry.kind), file: str_(entry.file),
      period: str_(entry.period), read: numOrNull_(entry.read), fresh: numOrNull_(entry.fresh), known: numOrNull_(entry.known),
      rejected: numOrNull_(entry.rejected), alerts: numOrNull_(entry.alerts), result: str_(entry.result) || 'OK',
      seconds: numOrNull_(entry.seconds)
    });
  }

  function lastImport() {
    for (var i = db.importLog.length - 1; i >= 0; i--) {
      var e = db.importLog[i];
      if (!e.kind || /^EFFACEMENT/i.test(e.kind) || /^(ÉCHEC|ECHEC)/i.test(e.result)) continue;
      return clone_(e);
    }
    return null;
  }

  // Single-threaded: the lock is never taken by another execution (waitMs only matters in Repo.gs).
  function withLock(kind, fn) {
    kind = kind === 'docks' ? 'docks' : 'data';
    if (db.locks[kind]) return fn();
    db.locks[kind] = true;
    try {
      return fn();
    } finally {
      db.locks[kind] = false;
    }
  }

  function newKey_() {
    var out = '';
    for (var i = 0; i < 12; i++) out += KEY_ALPHABET.charAt(Math.floor(Math.random() * KEY_ALPHABET.length));
    return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
  }

  function getKeys() {
    return { admin: db.keys.admin, docks: db.keys.docks };
  }

  function ensureKeys() {
    if (!db.keys.admin) db.keys.admin = newKey_();
    if (!db.keys.docks) db.keys.docks = newKey_();
    return getKeys();
  }

  function resetKeys() {
    db.keys = { admin: '', docks: '' };
    return ensureKeys();
  }

  function getProp(name) {
    return Object.prototype.hasOwnProperty.call(db.props, name) ? JSON.parse(db.props[name]) : null;
  }

  function setProp(name, value) {
    if (value === null || value === undefined) delete db.props[name];
    else db.props[name] = JSON.stringify(value);
  }

  function cacheGet(key) {
    var e = db.cache[key];
    if (!e || e.until < Date.now()) return null;
    return JSON.parse(e.json);
  }

  function cachePut(key, value, seconds) {
    db.cache[key] = { json: JSON.stringify(value), until: Date.now() + 1000 * Math.min(seconds || 21600, 21600) };
    return true;
  }

  function cachePutMany(values, seconds) {
    var n = 0;
    Object.keys(values || {}).forEach(function (k) {
      cachePut(k, values[k], seconds);
      n++;
    });
    return n;
  }

  // Test / harness helper: a JSON copy of the whole store.
  function dump() {
    return clone_({
      movements: db.movements, opening: db.opening, articles: db.articles, layout: db.layout, rules: db.rules, mvt: db.mvt,
      settings: db.settings, docks: db.docks, visits: db.visits, calc: db.calc, importLog: db.importLog,
      versions: db.versions, props: db.props, tabs: Object.keys(db.tabs)
    });
  }

  // Harness helper: the whole store as JSON text (cache and lock flags excluded: they belong to one execution).
  function snapshot() {
    var copy = {};
    Object.keys(db).forEach(function (k) {
      if (k !== 'cache' && k !== 'locks') copy[k] = db[k];
    });
    return JSON.stringify(copy);
  }

  // Harness helper: replaces the store with a snapshot() (text or object). The cache starts empty.
  function restore(saved) {
    var data = typeof saved === 'string' ? JSON.parse(saved) : clone_(saved);
    reset();
    Object.keys(data || {}).forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(db, k) && k !== 'cache' && k !== 'locks') db[k] = data[k];
    });
  }

  reset();

  return {
    setup: setup,
    isInstalled: isInstalled,
    readInput: readInput,
    readLayout: readLayout,
    readDocks: readDocks,
    writeCalcTables: writeCalcTables,
    saveState: saveState,
    loadState: loadState,
    saveLookups: saveLookups,
    loadLookup: loadLookup,
    readLookupIndex: readLookupIndex,
    getVersions: getVersions,
    bumpVersion: bumpVersion,
    existingKeys: existingKeys,
    appendMovements: appendMovements,
    replaceSimulation: replaceSimulation,
    clearSimulation: clearSimulation,
    replaceOpening: replaceOpening,
    replaceDocks: replaceDocks,
    saveDock: saveDock,
    logImport: logImport,
    lastImport: lastImport,
    withLock: withLock,
    getKeys: getKeys,
    ensureKeys: ensureKeys,
    resetKeys: resetKeys,
    getProp: getProp,
    setProp: setProp,
    cacheGet: cacheGet,
    cachePut: cachePut,
    cachePutMany: cachePutMany,
    reset: reset,
    dump: dump,
    snapshot: snapshot,
    restore: restore
  };
})();

if (typeof module !== 'undefined') module.exports = Repo;
