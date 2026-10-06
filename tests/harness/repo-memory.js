/**
 * EXP2 Digital Twin - in-memory Repo (same interface as apps-script/src/Repo.gs).
 *
 * Used by the Node tests (loaded in the same vm context as the .gs files) and by the local harness pages
 * (plain <script>, backs the google.script.run shim). No Google service, no require: the only global it reads is
 * CFG (Config.gs), lazily, at call time. Seeded empty; setup() creates the default layout, rules, settings and
 * docks, like the sheet version. Values cross the interface as JSON copies, the way the sheet would serialise them.
 * v2 (docs/SPEC_V2.md 3): movements keep ts / label / texts as the MOUVEMENTS text columns would, ARTICLES rows carry
 * a project, PROJETS rows live in db.projects with the same simulation ownership rules; migrate() only adds the
 * missing PARAM_SEUILS rows (an in-memory store has no columns to append).
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

  // Entry time as the 'Saisie le' text column keeps it: 'yyyy-mm-dd hh:mm:ss' or '' (Repo.gs tsOf_ for text cells).
  function ts_(v) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str_(v));
    if (!m) {
      m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str_(v));
      if (!m) return '';
      m = [m[0], m[3], m[2], m[1], m[4], m[5], m[6]];
    }
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = m[6] ? +m[6] : 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return '';
    if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return '';
    return y + '-' + pad2_(mo) + '-' + pad2_(d) + ' ' + pad2_(h) + ':' + pad2_(mi) + ':' + pad2_(s);
  }

  function projectName_(v) {
    return str_(v).replace(/\s+/g, ' ');
  }

  function blockIds_(v) {
    var list = Array.isArray(v) ? v : str_(v).split(/[,;\s]+/);
    var out = [];
    list.forEach(function (b) {
      var id = code_(b, false);
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  function color_(v) {
    var s = str_(v).toLowerCase();
    if (/^[0-9a-f]{6}$/.test(s)) s = '#' + s;
    return /^#[0-9a-f]{6}$/.test(s) ? s : '';
  }

  function has_(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function reset() {
    db = {
      installed: false,
      tabs: {},              // tab name -> true once created
      movements: [],         // MOUVEMENTS rows as objects (+ importId, addedAt)
      opening: [],
      articles: [],
      projects: [],          // PROJETS rows { project, blocks: 'B1, B7', color, comment }
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

  // Missing PARAM_SEUILS rows (keys added since the store was written). -> keys added.
  function addMissingSettings_() {
    var have = {};
    db.settings.forEach(function (s) { if (s.key) have[s.key] = true; });
    var added = defaultSettings_().filter(function (s) { return !have[s.key]; });
    db.settings = db.settings.concat(added);
    return added.map(function (s) { return s.key; });
  }

  // Same result shape as Repo.gs migrate(): the store has no header rows, only settings rows can be missing. Like
  // Repo.gs, nothing is checked again once the schema version is recorded, unless forced (setup).
  function migrate(force) {
    if (!db.installed) return null;
    if (!force && db.props.SCHEMA_VERSION === '2' && Array.isArray(db.projects)) {
      return { version: 2, changed: [], settings: [] };
    }
    if (!Array.isArray(db.projects)) db.projects = [];
    var settings = addMissingSettings_();
    if (!db.tabs[cfg_().TABS.PROJECTS]) db.tabs[cfg_().TABS.PROJECTS] = true;
    db.props.SCHEMA_VERSION = JSON.stringify(2);
    return { version: 2, changed: settings.length ? [cfg_().TABS.SETTINGS] : [], settings: settings };
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
    migrate(true);
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

  function readArticles() {
    return clone_(db.articles.map(function (a) {
      var out = {};
      for (var k in a) if (has_(a, k)) out[k] = a[k];
      out.project = projectName_(a.project);
      return out;
    }).filter(function (a) { return a.article; }));
  }

  // PROJETS rows, names merged case-insensitively (blocks united, first color and comment), like Repo.gs.
  function readProjects() {
    var out = [], byKey = {};
    (db.projects || []).forEach(function (r) {
      var name = projectName_(r.project);
      if (!name) return;
      var p = byKey[name.toLowerCase()];
      if (!p) {
        p = byKey[name.toLowerCase()] = { project: name, blocks: [], color: color_(r.color), comment: str_(r.comment) };
        out.push(p);
      }
      blockIds_(r.blocks).forEach(function (b) {
        if (p.blocks.indexOf(b) < 0) p.blocks.push(b);
      });
      if (!p.color) p.color = color_(r.color);
      if (!p.comment) p.comment = str_(r.comment);
    });
    return clone_(out);
  }

  function readSettings() {
    return clone_(readSettings_());
  }

  function readInput() {
    migrate();
    var settings = readSettings_();
    var plant = settings.plant || cfg_().PLANT;
    var layout = readLayout();
    var ids = {};
    layout.blocks.forEach(function (b) { ids[String(b.id).toUpperCase()] = b.id; });
    return clone_({
      asOf: settings.asOf || null,
      plant: plant,
      movements: db.movements.map(function (m) {
        return { key: m.key, article: m.article, division: m.division, magasin: m.magasin, mvt: m.mvt, text: m.text, s: m.s,
          doc: m.doc, poste: m.poste, date: m.date, qty: m.qty, uqs: m.uqs, designation: m.designation, user: m.user,
          source: m.source, ts: m.ts || '', label: m.label || '', headerText: m.headerText || '', itemText: m.itemText || '',
          reference: m.reference || '', client: m.client || '', salesOrder: m.salesOrder || '' };
      }),
      opening: db.opening.filter(function (o) { return !o.division || !plant || o.division === plant; }),
      articles: readArticles(),
      projects: readProjects().map(function (p) {
        p.blocks = p.blocks.map(function (b) { return ids[String(b).toUpperCase()] || b; });
        return p;
      }),
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
      user: str_(l.user), source: source, importId: str_(importId), addedAt: now,
      ts: ts_(l.ts), label: code_(l.label, false), headerText: code_(l.headerText, false), itemText: code_(l.itemText, false),
      reference: code_(l.reference, false), client: code_(l.client, true), salesOrder: code_(l.salesOrder, true)
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
      palletType: str_(a.palletType), heightCm: numOrNull_(a.heightCm), levels: numOrNull_(a.levels), family: str_(a.family),
      project: projectName_(a.project) };
  }

  function project_(p) {
    return { project: projectName_(p.project), blocks: blockIds_(p.blocks).join(', '), color: color_(p.color), comment: str_(p.comment) };
  }

  function releaseSimArticles_(codes) {
    var sim = getProp('SIM_ARTICLES');
    if (!sim || !sim.length) return;
    var mine = {};
    codes.forEach(function (a) { mine[String(a).toUpperCase()] = true; });
    var left = sim.filter(function (a) { return !mine[String(a).toUpperCase()]; });
    if (left.length !== sim.length) setProp('SIM_ARTICLES', left.length ? left : null);
  }

  function saveArticleProjects(rows) {
    migrate();
    var at = {};
    db.articles.forEach(function (a, i) {
      var k = code_(a.article, true).toUpperCase();
      if (k) (at[k] = at[k] || []).push(i);
    });
    var out = { created: 0, updated: 0, unchanged: 0, articles: [] };
    var seen = {};
    (rows || []).forEach(function (row) {
      var art = code_(row.article, true);
      var k = art.toUpperCase();
      if (!art || seen[k]) return;
      seen[k] = true;
      out.articles.push(art);
      var project = projectName_(row.project);
      if (!has_(at, k)) {
        if (!project) {
          out.unchanged++;
          return;
        }
        db.articles.push(article_({ article: art, designation: row.designation, project: project }));
        out.created++;
        return;
      }
      var changed = false;
      at[k].forEach(function (i) {
        if (projectName_(db.articles[i].project) !== project) {
          db.articles[i].project = project;
          changed = true;
        }
      });
      if (changed) out.updated++;
      else out.unchanged++;
    });
    releaseSimArticles_(out.articles);
    setProp('PROJECTS_SOURCE', null);
    return clone_(out);
  }

  function addProjects(names) {
    migrate();
    var have = {};
    readProjects().forEach(function (p) { have[p.project.toLowerCase()] = true; });
    var added = [];
    (names || []).forEach(function (n) {
      var name = projectName_(n);
      if (!name || have[name.toLowerCase()]) return;
      have[name.toLowerCase()] = true;
      added.push(name);
      db.projects.push(project_({ project: name }));
    });
    setProp('PROJECTS_SOURCE', null);
    return added;
  }

  function saveProjects(rows) {
    migrate();
    db.projects = (rows || []).filter(function (p) { return projectName_(p && p.project); }).map(project_);
    setProp('PROJECTS_SOURCE', null);
    setProp('SIM_PROJECTS', null);
    return (rows || []).length;
  }

  function renameProjectRefs(from, to) {
    migrate();
    var key = projectName_(from).toLowerCase(), target = projectName_(to);
    var out = { articles: 0, rules: 0 };
    if (!key || !target) return out;
    db.articles.forEach(function (a) {
      if (projectName_(a.project).toLowerCase() === key && projectName_(a.project) !== target) {
        a.project = target;
        out.articles++;
      }
    });
    db.rules.forEach(function (r) {
      if (str_(r.criterion).toUpperCase() === 'PROJET' && projectName_(r.value).toLowerCase() === key &&
        projectName_(r.value) !== target) {
        r.value = target;
        out.rules++;
      }
    });
    return out;
  }

  function replaceSimulation(data) {
    data = data || {};
    migrate();
    var out = { removed: 0, added: 0, opening: 0, articles: 0, projects: 0, docks: 0 };
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
    if (Array.isArray(data.projects)) {
      var names = [], dropP = {}, seenP = {};
      data.projects.forEach(function (p) {
        var n = projectName_(p && p.project);
        if (n && !has_(dropP, n.toLowerCase())) names.push(n);
        if (n) dropP[n.toLowerCase()] = true;
      });
      (getProp('SIM_PROJECTS') || []).forEach(function (n) { dropP[String(n).toLowerCase()] = true; });
      var simRows = data.projects.filter(function (p) {
        var k = projectName_(p && p.project).toLowerCase();
        if (!k || seenP[k]) return false;
        seenP[k] = true;
        return true;
      }).map(project_);
      db.projects = db.projects.filter(function (r) {
        var k = projectName_(r.project).toLowerCase();
        return k && !has_(dropP, k);
      }).concat(simRows);
      setProp('SIM_PROJECTS', names);
      setProp('PROJECTS_SOURCE', SIM);
      out.projects = simRows.length;
    }
    if (Array.isArray(data.docks) && data.docks.length) {
      replaceDocks(data.docks, SIM);
      out.docks = data.docks.length;
    }
    return out;
  }

  function clearSimulation() {
    migrate();
    var out = { removed: 0, opening: false, articles: 0, projects: 0, docks: false };
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
    if (getProp('PROJECTS_SOURCE') === SIM) {
      var simNames = getProp('SIM_PROJECTS');
      var dropP = {};
      (simNames || []).forEach(function (x) { dropP[String(x).toLowerCase()] = true; });
      var before = db.projects.filter(function (r) { return projectName_(r.project); }).length;
      db.projects = simNames ? db.projects.filter(function (r) {
        var k = projectName_(r.project).toLowerCase();
        return k && !has_(dropP, k);
      }) : [];
      out.projects = before - db.projects.length;
      setProp('PROJECTS_SOURCE', null);
      setProp('SIM_PROJECTS', null);
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
      movements: db.movements, opening: db.opening, articles: db.articles, projects: db.projects, layout: db.layout,
      rules: db.rules, mvt: db.mvt, settings: db.settings, docks: db.docks, visits: db.visits, calc: db.calc,
      importLog: db.importLog, versions: db.versions, props: db.props, tabs: Object.keys(db.tabs)
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
    migrate: migrate,
    readInput: readInput,
    readLayout: readLayout,
    readDocks: readDocks,
    readSettings: readSettings,
    readArticles: readArticles,
    readProjects: readProjects,
    saveArticleProjects: saveArticleProjects,
    addProjects: addProjects,
    saveProjects: saveProjects,
    renameProjectRefs: renameProjectRefs,
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
