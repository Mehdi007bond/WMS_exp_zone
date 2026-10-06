/**
 * EXP2 Digital Twin - persistence layer (Repo).
 *
 * The only file that reads and writes the data: SpreadsheetApp (tabs), CacheService (state cache), PropertiesService
 * (versions, keys, small settings) and LockService. Api.gs only sees the interface below, which
 * tests/harness/repo-memory.js implements in memory with the same behaviour (Node tests and local harness).
 *
 *   setup(opts)                       create / repair every tab (opts.resetParams: rewrite LAYOUT, rules, settings, docks)
 *   isInstalled()                     true once setup ran (MOUVEMENTS exists)
 *   migrate(force)                    v1 sheet -> v2 (docs/SPEC_V2.md 3): appends missing headers, creates PROJETS, adds
 *                                     missing PARAM_SEUILS rows; idempotent, never deletes; Script Property SCHEMA_VERSION
 *   readInput()                       engine input (docs/ARCHITECTURE.md section 4, docs/SPEC_V2.md 4.1), dates
 *                                     'yyyy-mm-dd', entry times 'yyyy-mm-dd hh:mm:ss', plus .layout
 *   readLayout()                      layout shaped like CFG.DEFAULT_LAYOUT (LAYOUT tab, defaults for missing parts)
 *   readDocks()                       current state of the docks (QUAIS_CAMIONS)
 *   readSettings()                    { plant, asOf, thresholds } (PARAM_SEUILS)
 *   readArticles()                    ARTICLES rows [{ article, designation, ..., family, project }]
 *   readProjects()                    PROJETS rows [{ project, blocks: ['B1'], color, comment }] (names merged
 *                                     case-insensitively)
 *   saveArticleProjects(rows)         rows [{ article, project, designation }]: upsert of ARTICLES › Projet (designation
 *                                     for new rows) -> { created, updated, unchanged }; the user owns those rows now
 *   addProjects(names)                new PROJETS rows without blocks (names not there yet)
 *   saveProjects(rows)                PROJETS replaced (the user owns the tab: PROJECTS_SOURCE cleared)
 *   renameProjectRefs(from, to)       ARTICLES › Projet and PROJET rules of REGLES_PLACEMENT -> { articles, rules }
 *   writeCalcTables(tables)           CALC_* tabs from Engine.toTables
 *   saveState(state) / loadState()    compact state JSON: cache chunks + hidden _STATE tab
 *   saveLookups(version, rows)        per-article lookup data (hidden _LOOKUP tab): rows [{ article, designation, json }]
 *   loadLookup(article)               { version, entry } of one article (entry null when absent), null before the first save
 *   readLookupIndex()                 [[article, designation]] of every saved lookup row (search fallback)
 *   getVersions() / bumpVersion(kind) { data, docks } stamps ('data' | 'docks'), copied in the script cache
 *   existingKeys()                    { key: true } for every MOUVEMENTS line
 *   appendMovements(lines, meta)      meta: { importId, source: 'IMPORT' | 'SIMULATION', fileName }
 *   replaceSimulation(data)           { movements, opening, articles, projects, docks }: drops SIMULATION rows, keeps
 *                                     IMPORT rows, and the articles / projects the user owns
 *   clearSimulation()                 removes everything the simulation wrote (PROJETS rows only while PROJECTS_SOURCE
 *                                     is still SIMULATION)
 *   replaceOpening(rows)              STOCK_INITIAL from an import
 *   replaceDocks(docks, source)       QUAIS_CAMIONS rewritten (simulation)
 *   saveDock(dock, who)               one dock + one VISITES_CAMIONS row
 *   logImport(entry) / lastImport()   IMPORT_LOG
 *   withLock(kind, fn, waitMs)        script lock for every write ('data' | 'docks' only name the message), 30 s;
 *                                     waitMs 0: no wait, throws an error with .busy = true when the lock is taken
 *   getKeys() / ensureKeys()          { admin, docks } access keys (Script Properties)
 *   resetKeys()                       new admin and docks keys (after a leak)
 *   getProp(name) / setProp(name, v)  small JSON settings (Script Properties)
 *   cacheGet(key) / cachePut(key, v, seconds)  JSON values of any size (inline when small, else chunked)
 *   cachePutMany({ key: v }, seconds)  small JSON values in one putAll (values over one cache entry are skipped)
 *
 * Batch I/O only: one getValues / setValues per tab and per call, number formats per column group. Columns are found
 * by their header label, so columns moved or added by hand never receive another column's values.
 */
function RepoModule_() {
  var SCHEMA_VERSION = 2;             // docs/SPEC_V2.md 3 (v2 columns appended, PROJETS, new PARAM_SEUILS rows)
  var TEXT = '@';
  var DATE = 'dd.mm.yyyy';
  var DATETIME = 'dd.mm.yyyy hh:mm';
  var DATETIME_S = 'dd.mm.yyyy hh:mm:ss';
  var PERCENT = '0.0%';
  var CACHE_TTL_S = 21600;            // CacheService maximum (6 h)
  var CACHE_CHUNK_BYTES = 90000;      // CacheService values are limited to 100 KB
  var CELL_CHUNK_CHARS = 45000;       // Sheets cells are limited to 50,000 characters
  var CHUNK_PREFIX = 'J';             // keeps a chunk from starting with '=', '+', '-' or a digit
  var CACHE_INLINE = '=';             // cache value holding the text itself (a chunk index is JSON, starts with '{')
  var VERSIONS_CACHE_KEY = 'VERSIONS';
  var VERSIONS_CACHE_S = 600;         // the copy is rewritten on every bump; the TTL only bounds a failed rewrite
  var LOCK_WAIT_MS = 30000;
  var SPARE_ROWS_ADMIN = 20;          // empty formatted rows kept in tabs edited by hand
  var KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var PROPS = {
    DATA: 'DATA_VERSION', DOCKS: 'DOCKS_VERSION', ADMIN_KEY: 'ADMIN_KEY', DOCKS_KEY: 'DOCKS_KEY', SCHEMA: 'SCHEMA_VERSION',
    PREFIX: 'P_'
  };
  var STATE_CACHE_KEY = 'STATE';
  var SIM = 'SIMULATION';
  var TS_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
  var TS_FR_RE = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

  // Number formats per tab and header (columns not listed keep the automatic format). 'Saisie le' is text
  // 'yyyy-mm-dd hh:mm:ss' (SAP wall clock: no time-zone conversion), labels and SAP codes are text.
  var FORMATS = {
    MOUVEMENTS: { 'Clé': TEXT, 'Article': TEXT, 'Division': TEXT, 'Magasin': TEXT, 'MvT': TEXT, 'Texte code mvt': TEXT,
      'S': TEXT, 'Doc.article': TEXT, 'Poste': TEXT, 'Date cpt.': DATE, 'UQS': TEXT, 'Désignation article': TEXT,
      'Nom utilisateur': TEXT, 'Source': TEXT, 'Import': TEXT, 'Ajouté le': DATETIME, 'Saisie le': TEXT,
      'Étiquette': TEXT, 'Texte en-tête': TEXT, 'Texte': TEXT, 'Référence': TEXT, 'Client': TEXT, 'Commande client': TEXT },
    STOCK_INITIAL: { 'Article': TEXT, 'Division': TEXT, 'Magasin': TEXT, 'Désignation article': TEXT, 'UQS': TEXT,
      'Date stock': DATE },
    ARTICLES: { 'Article': TEXT, 'Désignation article': TEXT, 'UQS': TEXT, 'Type palette': TEXT, 'Famille': TEXT,
      'Projet': TEXT },
    PROJETS: { 'Projet': TEXT, 'Blocs': TEXT, 'Couleur': TEXT, 'Commentaire': TEXT },
    LAYOUT: { 'ID': TEXT, 'Type': TEXT, 'Libellé (sketch)': TEXT, 'Couleur': TEXT, 'Statut': TEXT },
    REGLES_PLACEMENT: { 'Critère': TEXT, 'Valeur': TEXT, 'Bloc cible': TEXT, 'Commentaire': TEXT },
    PARAM_MOUVEMENTS: { 'MvT': TEXT, 'Type': TEXT, 'Texte': TEXT, 'Signification': TEXT, 'Pris en compte': TEXT },
    PARAM_SEUILS: { 'Paramètre': TEXT, 'Clé': TEXT, 'Unité': TEXT, 'Commentaire': TEXT },
    QUAIS_CAMIONS: { 'Quai': TEXT, 'Statut quai': TEXT, 'Camion': TEXT, 'Transporteur': TEXT, 'Couleur cabine': TEXT,
      'Arrivée': TEXT, 'Départ prévu': TEXT },
    VISITES_CAMIONS: { 'Horodatage': DATETIME, 'Quai': TEXT, 'Statut quai': TEXT, 'Camion': TEXT, 'Transporteur': TEXT,
      'Arrivée': TEXT, 'Départ prévu': TEXT, 'Saisi par': TEXT },
    IMPORT_LOG: { 'Horodatage': DATETIME_S, 'Type': TEXT, 'Fichier': TEXT, 'Période': TEXT, 'Résultat': TEXT }
  };

  // French meaning of each movement kind (PARAM_MOUVEMENTS).
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

  // PARAM_SEUILS rows: key -> [French label, unit, comment].
  var SETTING_LABELS = {
    satWarn: ['Seuil saturation - alerte', 'fraction', '0,85 = 85 % (blocs et entrepôt)'],
    satCrit: ['Seuil saturation - critique', 'fraction', '0,95 = 95 %'],
    pendingDaysWarn: ['Seuil attente PRD2 en jours - alerte', 'jours',
      'Lignes sans heure de saisie : déclaré mais pas encore transféré vers EXP2'],
    dockStagingWarn: ['Seuil zone quai - alerte', 'fraction', 'Palettes en zone quai / capacité de la zone'],
    freshWarnH: ['Fraîcheur des données - alerte', 'heures', 'Badge orange sur la TV après ce délai sans import'],
    freshCritH: ['Fraîcheur des données - critique', 'heures', 'Badge rouge sur la TV'],
    tvRefreshS: ['Rafraîchissement écran TV', 's', 'Période de vérification de la version des données'],
    tvSceneS: ['Durée d\'une scène TV', 's', 'Rotation des scènes (vue, saturation, attente, quais)'],
    pendingHoursWarn: ['Seuil attente PRD2 - pré-alerte', 'heures',
      'Étiquette déclarée en PRD2 et pas encore transférée vers EXP2 depuis ce délai (heure de saisie SAP)'],
    pendingHoursCrit: ['Seuil attente PRD2 - alerte', 'heures',
      'Une référence en PRD2 depuis plus de 6 h est un vrai problème'],
    labelIsPallet: ['1 étiquette = 1 palette', '1/0', '1 = chaque numéro d\'étiquette (contenant) compte pour une palette'],
    importTrackedOnly: ['Import : produits finis seulement', '1/0',
      '1 = l\'import ignore les articles absents de ARTICLES qui ne passent pas par EXP2'],
    trackAll: ['Calcul : tous les articles', '1/0', '0 = produits finis seulement (ARTICLES ou passés par EXP2)']
  };

  var memo = {};      // per execution: spreadsheet, time zone check, state JSON
  var held = false;   // the script lock is held by this execution

  // -------------------------------------------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------------------------------------------
  function C_() {
    return CFG;
  }

  function T_() {
    return CFG.TABS;
  }

  function str_(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function pad2_(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function isDate_(v) {
    return Object.prototype.toString.call(v) === '[object Date]';
  }

  function has_(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function clone_(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  // SAP code as text: 1000914295 (number) -> '1000914295'; optional leading-zero removal for all-digit codes.
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

  function cellNum_(v) {
    return v === null || v === undefined || (typeof v === 'number' && !isFinite(v)) ? '' : v;
  }

  function fold_(s) {
    s = str_(s);
    if (typeof s.normalize === 'function') s = s.normalize('NFD');
    return s.replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  // The script is bound to the sheet (@OnlyCurrentDoc): getActiveSpreadsheet() is that sheet, in the web app too.
  function ss_() {
    if (memo.ss) return memo.ss;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      throw new Error('Classeur introuvable : le script doit être lié au Google Sheet (Extensions › Apps Script depuis le classeur).');
    }
    memo.ss = ss;
    return ss;
  }

  function sheet_(name) {
    return ss_().getSheetByName(name);
  }

  function props_() {
    return PropertiesService.getScriptProperties();
  }

  function cache_() {
    return CacheService.getScriptCache();
  }

  // Spreadsheet and script time zones: equal after setup, so dates convert with plain JS getters (fast).
  function sameTz_() {
    if (memo.sameTz === undefined) {
      memo.tz = ss_().getSpreadsheetTimeZone();
      memo.sameTz = memo.tz === Session.getScriptTimeZone();
    }
    return memo.sameTz;
  }

  // Cell value -> 'yyyy-mm-dd' ('' when empty or unreadable).
  function isoOf_(v) {
    if (v === null || v === undefined || v === '') return '';
    if (isDate_(v)) {
      if (isNaN(v.getTime())) return '';
      if (sameTz_()) return v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
      return Utilities.formatDate(v, memo.tz, 'yyyy-MM-dd');
    }
    if (typeof v === 'number') {
      if (v < 61 || v > 2958465) return '';
      var t = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
      return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
    }
    var s = str_(v);
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]);
    m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/.exec(s);
    if (m) return m[3] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[1]);
    return '';
  }

  // 'yyyy-mm-dd' -> Date at midnight of the spreadsheet time zone ('' when empty).
  function dateOf_(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str_(iso));
    if (!m) return '';
    if (sameTz_()) return new Date(+m[1], +m[2] - 1, +m[3]);
    return Utilities.parseDate(m[1] + '-' + m[2] + '-' + m[3], memo.tz, 'yyyy-MM-dd');
  }

  function instant_(v) {
    if (isDate_(v)) return v;
    if (v === null || v === undefined || v === '') return new Date();
    var d = new Date(v);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  // 'HH:mm' from a time cell (Date) or text.
  function time_(v) {
    if (isDate_(v)) {
      if (isNaN(v.getTime())) return '';
      return sameTz_() ? pad2_(v.getHours()) + ':' + pad2_(v.getMinutes()) : Utilities.formatDate(v, memo.tz, 'HH:mm');
    }
    return str_(v);
  }

  // Entry time 'yyyy-mm-dd hh:mm:ss' (SAP wall clock) from the stored text ('Saisie le'), or from a cell Sheets turned
  // into a date (typed by hand: read in the spreadsheet time zone) or an Excel serial; '' when empty or unreadable.
  function tsOf_(v) {
    if (v === null || v === undefined || v === '') return '';
    var y, mo, d, h, mi, s;
    if (isDate_(v)) {
      if (isNaN(v.getTime())) return '';
      if (!sameTz_()) return Utilities.formatDate(v, memo.tz, 'yyyy-MM-dd HH:mm:ss');
      y = v.getFullYear();
      mo = v.getMonth() + 1;
      d = v.getDate();
      h = v.getHours();
      mi = v.getMinutes();
      s = v.getSeconds();
    } else if (typeof v === 'number') {
      if (!(v >= 61 && v <= 2958465)) return '';
      var t = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400) * 1000);
      y = t.getUTCFullYear();
      mo = t.getUTCMonth() + 1;
      d = t.getUTCDate();
      h = t.getUTCHours();
      mi = t.getUTCMinutes();
      s = t.getUTCSeconds();
    } else {
      var text = str_(v);
      var m = TS_RE.exec(text);
      if (m) {
        y = +m[1]; mo = +m[2]; d = +m[3]; h = +m[4]; mi = +m[5]; s = m[6] ? +m[6] : 0;
      } else {
        m = TS_FR_RE.exec(text);
        if (!m) return '';
        y = +m[3]; mo = +m[2]; d = +m[1]; h = +m[4]; mi = +m[5]; s = m[6] ? +m[6] : 0;
      }
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return '';
      if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return '';
    }
    return y + '-' + pad2_(mo) + '-' + pad2_(d) + ' ' + pad2_(h) + ':' + pad2_(mi) + ':' + pad2_(s);
  }

  // Project name as stored: trimmed, inner spaces collapsed (validated by Api.gs before a write).
  function projectName_(v) {
    return str_(v).replace(/\s+/g, ' ');
  }

  // Block ids of a 'Blocs' cell ('B1, B7', 'B1;B7', 'B1 B7') or an array, unique, in order.
  function blockIds_(v) {
    var list = Array.isArray(v) ? v : str_(v).split(/[,;\s]+/);
    var out = [];
    list.forEach(function (b) {
      var id = code_(b, false);
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  // '#rrggbb' in lower case, '' when empty or not a color (automatic color).
  function color_(v) {
    var s = str_(v).toLowerCase();
    if (/^[0-9a-f]{6}$/.test(s)) s = '#' + s;
    return /^#[0-9a-f]{6}$/.test(s) ? s : '';
  }

  // -------------------------------------------------------------------------------------------------------------
  // Sheet primitives (batch only)
  // -------------------------------------------------------------------------------------------------------------
  function headers_(name) {
    return C_().HEADERS[name] ? C_().HEADERS[name].slice() : [];
  }

  function ensureSheet_(name) {
    return sheet_(name) || ss_().insertSheet(name);
  }

  // Exact sheet size: rows x cols (at least 2 rows so the frozen header never holds every row).
  function fitSize_(sh, rows, cols) {
    rows = Math.max(rows, 2);
    cols = Math.max(cols, 1);
    var maxRows = sh.getMaxRows(), maxCols = sh.getMaxColumns();
    if (maxRows < rows) sh.insertRowsAfter(maxRows, rows - maxRows);
    else if (maxRows > rows) sh.deleteRows(rows + 1, maxRows - rows);
    if (maxCols < cols) sh.insertColumnsAfter(maxCols, cols - maxCols);
    else if (maxCols > cols) sh.deleteColumns(cols + 1, maxCols - cols);
  }

  function ensureRows_(sh, lastNeeded) {
    var maxRows = sh.getMaxRows();
    if (maxRows < lastNeeded) sh.insertRowsAfter(maxRows, lastNeeded - maxRows);
  }

  function ensureCols_(sh, lastNeeded) {
    var maxCols = sh.getMaxColumns();
    if (maxCols < lastNeeded) sh.insertColumnsAfter(maxCols, lastNeeded - maxCols);
  }

  // Header labels of row 1 ([] for an empty tab).
  function headerRow_(sh) {
    var lastCol = sh.getLastColumn();
    return lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(str_) : [];
  }

  // Appends the labels of 'header' missing from row 1 after the last used column (never over data), with their
  // number formats on every row. -> the labels added. 'have': row 1 already read, else read here.
  function appendHeaders_(name, sh, header, have) {
    have = have || headerRow_(sh);
    var missing = header.filter(function (h) { return have.indexOf(h) < 0; });
    if (!missing.length) return [];
    var empty = !have.some(function (h) { return h; }) && sh.getLastRow() === 0;
    var start = empty ? 1 : Math.max(sh.getLastColumn(), have.length) + 1;
    var labels = empty ? header.slice() : missing;
    ensureCols_(sh, start + labels.length - 1);
    var range = sh.getRange(1, start, 1, labels.length);
    range.setValues([labels]);
    range.setFontWeight('bold').setBackground('#e8edf2').setFontColor('#1f2a37');
    if (sh.getFrozenRows() !== 1) sh.setFrozenRows(1);
    if (sh.getMaxRows() > 1) {
      var full = [];
      for (var i = 1; i < start; i++) full.push('');
      applyFormats_(sh, FORMATS[name], full.concat(labels), 2, sh.getMaxRows() - 1);
    }
    return missing;
  }

  // Sheet column (0-based) of every CFG label of the tab; labels missing from row 1 are appended first.
  // -> { idx: [col per CFG label], width, aligned (CFG labels are the first columns, in order), labels: row 1 }
  function columnsOf_(name, sh, header) {
    var have = headerRow_(sh);
    var aligned = header.every(function (h, i) { return have[i] === h; });
    if (aligned) {
      return { idx: header.map(function (h, i) { return i; }), width: header.length, aligned: true, labels: have };
    }
    if (appendHeaders_(name, sh, header, have).length) have = headerRow_(sh);
    var idx = header.map(function (h) { return have.indexOf(h); });
    return { idx: idx, width: Math.max(have.length, Math.max.apply(null, idx) + 1), aligned: false, labels: have };
  }

  // One setNumberFormat per run of consecutive columns sharing a format.
  function applyFormats_(sh, formatsByHeader, header, startRow, n) {
    if (!formatsByHeader || n <= 0) return;
    var c = 0;
    while (c < header.length) {
      var f = formatsByHeader[header[c]];
      if (!f) {
        c++;
        continue;
      }
      var end = c;
      while (end + 1 < header.length && formatsByHeader[header[end + 1]] === f) end++;
      sh.getRange(startRow, c + 1, n, end - c + 1).setNumberFormat(f);
      c = end + 1;
    }
  }

  function styleHeader_(sh, width) {
    sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#e8edf2').setFontColor('#1f2a37');
    if (sh.getFrozenRows() !== 1) sh.setFrozenRows(1);
  }

  // Reads a whole tab once: header labels, data rows (fully empty rows dropped unless keepEmpty) and a column index.
  function readTable_(name, keepEmpty) {
    var sh = sheet_(name);
    var out = { found: !!sh, header: [], rows: [], col: {}, sheet: sh };
    if (!sh) return out;
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 1) return out;
    var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
    out.header = values[0].map(str_);
    out.header.forEach(function (h, i) {
      if (h && !has_(out.col, h)) out.col[h] = i;
    });
    var rows = values.slice(1);
    out.rows = keepEmpty ? rows : rows.filter(function (r) {
      for (var i = 0; i < r.length; i++) if (r[i] !== '' && r[i] !== null) return true;
      return false;
    });
    return out;
  }

  function getter_(t) {
    return function (row, label) {
      var i = t.col[label];
      return i === undefined ? '' : row[i];
    };
  }

  // Rows of a table re-ordered to the CFG header of the tab (tolerates moved columns).
  function remap_(t, header) {
    var idx = header.map(function (h) { return has_(t.col, h) ? t.col[h] : -1; });
    return t.rows.map(function (r) {
      return idx.map(function (i) { return i < 0 ? '' : r[i]; });
    });
  }

  // Columns added by hand after the CFG ones (kept, with their data, when a tab is rewritten).
  function extraLabels_(t, header) {
    return t.header.filter(function (h) { return h && header.indexOf(h) < 0; });
  }

  // Replaces every data row of a CFG tab (header rewritten, size trimmed to the data + spare rows).
  // fullHeader: CFG header followed by the extra columns of the tab, when rows carry them.
  function writeRows_(name, rows, spare, fullHeader) {
    var sh = ensureSheet_(name);
    var header = fullHeader || headers_(name);
    var width = header.length;
    var n = rows.length;
    var lastRow = sh.getLastRow();
    if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, sh.getMaxColumns()).clearContent();
    fitSize_(sh, n + 1 + (spare || 0), width);
    applyFormats_(sh, FORMATS[name], header, 2, n + (spare || 0));
    sh.getRange(1, 1, n + 1, width).setValues([header].concat(rows.map(function (r) { return fixWidth_(r, width); })));
  }

  // Appends rows given in the CFG column order of the tab. Columns are matched by header label: a tab whose columns
  // were moved or extended by hand gets each value under its own header (one setValues either way).
  function appendRows_(name, rows) {
    if (!rows.length) return 0;
    var sh = ensureSheet_(name);
    var header = headers_(name);
    var width = header.length;
    var start = sh.getLastRow() + 1;
    var cols;
    if (start < 2) {
      ensureCols_(sh, width);
      sh.getRange(1, 1, 1, width).setValues([header]);
      styleHeader_(sh, width);
      start = 2;
      cols = { aligned: true };
    } else {
      cols = columnsOf_(name, sh, header);
    }
    ensureRows_(sh, start + rows.length - 1);
    if (cols.aligned) {
      applyFormats_(sh, FORMATS[name], header, start, rows.length);
      sh.getRange(start, 1, rows.length, width).setValues(rows.map(function (r) { return fixWidth_(r, width); }));
      return rows.length;
    }
    var labels = [];
    for (var c = 0; c < cols.width; c++) labels.push('');
    header.forEach(function (h, i) { labels[cols.idx[i]] = h; });
    applyFormats_(sh, FORMATS[name], labels, start, rows.length);
    sh.getRange(start, 1, rows.length, cols.width).setValues(rows.map(function (r) {
      var src = fixWidth_(r, width), out = fixWidth_([], cols.width);
      for (var i = 0; i < width; i++) out[cols.idx[i]] = src[i];
      return out;
    }));
    return rows.length;
  }

  // Rewrites one column of the data rows (rows 2..n+1) by header label: values[i] goes to row i + 2.
  function writeColumn_(name, sh, label, values) {
    if (!values.length) return;
    var col = headerRow_(sh).indexOf(label);
    if (col < 0) throw new Error('Colonne « ' + label + ' » introuvable dans l\'onglet ' + name + '.');
    var range = sh.getRange(2, col + 1, values.length, 1);
    if (FORMATS[name] && FORMATS[name][label]) range.setNumberFormat(FORMATS[name][label]);
    range.setValues(values.map(function (v) { return [v === null || v === undefined ? '' : v]; }));
  }

  function fixWidth_(r, width) {
    var out = r.slice(0, width);
    while (out.length < width) out.push('');
    for (var i = 0; i < width; i++) {
      if (out[i] === null || out[i] === undefined || (typeof out[i] === 'number' && !isFinite(out[i]))) out[i] = '';
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Default content
  // -------------------------------------------------------------------------------------------------------------
  function layoutRow_(id, type, label, o, extra) {
    extra = extra || {};
    return [id, type, label, cellNum_(o.x), cellNum_(o.y), cellNum_(o.w), cellNum_(o.h), cellNum_(extra.cols),
      cellNum_(extra.rows), cellNum_(extra.levels), cellNum_(extra.capacity), extra.color || '', 'à confirmer'];
  }

  function defaultLayoutRows_() {
    var L = C_().DEFAULT_LAYOUT;
    var rows = [];
    if (L.building) rows.push(layoutRow_(L.building.id, 'BATIMENT', L.building.label, L.building));
    (L.blocks || []).forEach(function (b) {
      rows.push(layoutRow_(b.id, 'BLOC_STOCKAGE', b.label, b, { cols: b.cols, rows: b.rows, levels: b.levels,
        capacity: b.cols * b.rows * b.levels, color: b.color }));
    });
    if (L.truck_zone) rows.push(layoutRow_(L.truck_zone.id, 'ZONE_CAMION', L.truck_zone.label, L.truck_zone));
    var qc = L.quai_common || {};
    (L.quais || []).forEach(function (q) {
      rows.push(layoutRow_(q.id, 'QUAI', 'Quai d\'expédition', { x: q.x, y: q.y !== undefined ? q.y : qc.y,
        w: q.w !== undefined ? q.w : qc.w, h: q.h !== undefined ? q.h : qc.h }));
    });
    (L.roads || []).forEach(function (r) {
      rows.push(layoutRow_(r.id, 'VOIE_CHARIOT', r.label || 'Voie chariot à sens unique', r));
    });
    (L.zones || []).forEach(function (z) {
      rows.push(layoutRow_(z.id, z.type || 'ZONE', z.label, z, { color: z.color }));
    });
    return rows;
  }

  function defaultRuleRows_() {
    return (C_().DEFAULT_RULES || []).map(function (r) {
      return [r.priority, r.criterion, r.value, r.blocks.join(', '), 'provisoire'];
    });
  }

  function defaultMvtRows_() {
    var kinds = C_().MVT_KINDS, texts = C_().MVT_TEXTS || {};
    return Object.keys(kinds).sort().map(function (mvt) {
      var k = kinds[mvt];
      return [mvt, k, texts[mvt] || '', KIND_MEANINGS[k] || '', k === 'IGNORE' ? 'Non' : 'Oui'];
    });
  }

  function defaultSettingRows_() {
    var th = C_().THRESHOLDS || {};
    var rows = [
      ['Division SAP', 'plant', C_().PLANT, '', 'Les lignes des autres divisions sont rejetées'],
      ['Date de référence', 'asOf', '', 'date', 'Vide = date du dernier mouvement (recommandé)']
    ];
    Object.keys(th).forEach(function (k) {
      var l = SETTING_LABELS[k] || [k, '', ''];
      rows.push([l[0], k, th[k], l[1], l[2]]);
    });
    return rows;
  }

  function defaultDocks_() {
    return (C_().DEFAULT_LAYOUT.quais || []).map(function (q) {
      return { quai: q.id, status: 'Libre', truck: '', carrier: '', color: '', arrival: '', departure: '',
        planned: null, loaded: null, staged: 0, capacity: C_().DOCK_STAGING_CAPACITY };
    });
  }

  function dockRow_(d) {
    return [str_(d.quai), str_(d.status) || 'Libre', str_(d.truck), str_(d.carrier), str_(d.color), str_(d.arrival),
      str_(d.departure), cellNum_(d.planned), cellNum_(d.loaded), cellNum_(d.staged === null || d.staged === undefined ? 0 : d.staged),
      cellNum_(d.capacity === null || d.capacity === undefined ? C_().DOCK_STAGING_CAPACITY : d.capacity)];
  }

  // -------------------------------------------------------------------------------------------------------------
  // setup
  // -------------------------------------------------------------------------------------------------------------
  function tabOrder_() {
    var t = T_();
    return [t.HOME, t.MOVEMENTS, t.OPENING, t.ARTICLES, t.PROJECTS, t.LAYOUT, t.RULES, t.MVT, t.SETTINGS, t.DOCKS, t.VISITS,
      t.CALC_STOCK, t.CALC_PENDING, t.CALC_FIFO, t.CALC_EXITS, t.CALC_DAILY, t.CALC_BLOCKS, t.CALC_KPI, t.IMPORT_LOG,
      t.STATE, t.LOOKUP];
  }

  // Tabs edited by hand (blue tab, spare formatted rows).
  function adminTabs_() {
    var t = T_();
    return [t.ARTICLES, t.PROJECTS, t.LAYOUT, t.RULES, t.MVT, t.SETTINGS, t.DOCKS];
  }

  // Hidden tabs of the app (one text column of JSON chunks, never edited by hand).
  function hiddenTabs_() {
    return [T_().STATE, T_().LOOKUP];
  }

  function calcTabs_() {
    var t = T_();
    return [t.CALC_STOCK, t.CALC_PENDING, t.CALC_FIFO, t.CALC_EXITS, t.CALC_DAILY, t.CALC_BLOCKS, t.CALC_KPI];
  }

  function isEmptyTab_(name) {
    var sh = sheet_(name);
    return !sh || sh.getLastRow() < 2;
  }

  function setup(opts) {
    opts = opts || {};
    var ss = ss_();
    var t = T_();
    try {
      if (ss.getSpreadsheetTimeZone() !== Session.getScriptTimeZone()) ss.setSpreadsheetTimeZone(Session.getScriptTimeZone());
    } catch (e) {
      // Not fatal: dates then convert through Utilities.formatDate.
    }
    memo.sameTz = undefined;

    var created = [];
    tabOrder_().forEach(function (name) {
      if (!ss.getSheetByName(name)) {
        ss.insertSheet(name);
        created.push(name);
      }
    });

    // Defaults: written when the tab is empty, or on demand (reset of the parameters).
    var reset = !!opts.resetParams;
    var defaults = {};
    defaults[t.LAYOUT] = defaultLayoutRows_;
    defaults[t.RULES] = defaultRuleRows_;
    defaults[t.MVT] = defaultMvtRows_;
    defaults[t.SETTINGS] = defaultSettingRows_;
    defaults[t.DOCKS] = function () { return defaultDocks_().map(dockRow_); };
    Object.keys(defaults).forEach(function (name) {
      if (reset || isEmptyTab_(name)) writeRows_(name, defaults[name](), SPARE_ROWS_ADMIN);
    });
    if (reset) props_().deleteProperty(PROPS.PREFIX + 'DOCKS_SOURCE');

    // A sheet installed with v1: v2 headers appended, PARAM_SEUILS rows added (data never moved).
    migrate_(true);

    // Headers, formats, trimming of every data tab.
    var adminTabs = adminTabs_();
    tabOrder_().forEach(function (name) {
      if (name === t.HOME || hiddenTabs_().indexOf(name) >= 0) return;
      var sh = ss.getSheetByName(name);
      var header = headers_(name);
      if (!header.length) return;
      var spare = adminTabs.indexOf(name) >= 0 ? SPARE_ROWS_ADMIN : 1;
      var table = readTable_(name);
      var aligned = header.every(function (h, i) { return table.header[i] === h; });
      if (!aligned && table.rows.length) {
        // Columns moved or renamed by hand: rewrite in the standard order, extra columns kept at the end.
        var extras = extraLabels_(table, header);
        writeRows_(name, remap_(table, header.concat(extras)), spare, header.concat(extras));
      }
      var last = Math.max(sh.getLastRow(), 1);
      fitSize_(sh, last + spare, Math.max(header.length, sh.getLastColumn()));
      sh.getRange(1, 1, 1, header.length).setValues([header]);
      styleHeader_(sh, header.length);
      applyFormats_(sh, FORMATS[name], header, 2, sh.getMaxRows() - 1);
    });

    // Tab colors and warning-only protections on calculated tabs.
    calcTabs_().forEach(function (name) {
      var sh = ss.getSheetByName(name);
      sh.setTabColor('#9aa5b1');
      if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
        sh.protect().setDescription('Onglet calculé : réécrit à chaque recalcul').setWarningOnly(true);
      }
    });
    [t.ARTICLES, t.PROJECTS, t.LAYOUT, t.RULES, t.MVT, t.SETTINGS].forEach(function (name) {
      ss.getSheetByName(name).setTabColor('#5b8def');
    });
    [t.DOCKS, t.VISITS].forEach(function (name) {
      ss.getSheetByName(name).setTabColor('#1baf7a');
    });

    // Hidden tabs: calculated state, per-article lookup data (text cells only).
    hiddenTabs_().forEach(function (name) {
      var hs = ss.getSheetByName(name);
      fitSize_(hs, Math.max(hs.getLastRow(), 2), Math.max(hs.getLastColumn(), 1));
      hs.getRange(1, 1, hs.getMaxRows(), hs.getMaxColumns()).setNumberFormat(TEXT);
      if (!hs.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
        hs.protect().setDescription(name === t.STATE ? 'État calculé du jumeau (ne pas modifier)' : 'Fiches articles calculées (ne pas modifier)')
          .setWarningOnly(true);
      }
    });

    // Default empty sheet of a new spreadsheet.
    ss.getSheets().forEach(function (sh) {
      var name = sh.getName();
      if (tabOrder_().indexOf(name) < 0 && /^(Feuille|Sheet)\s?\d+$/i.test(name) && sh.getLastRow() === 0 &&
        ss.getSheets().length > 1) {
        ss.deleteSheet(sh);
      }
    });

    // Tab order, then hide the hidden tabs (activating a sheet shows it).
    tabOrder_().forEach(function (name, i) {
      var sh = ss.getSheetByName(name);
      if (sh.getIndex() !== i + 1) {
        ss.setActiveSheet(sh);
        ss.moveActiveSheet(i + 1);
      }
    });
    ss.setActiveSheet(ss.getSheetByName(t.HOME));
    hiddenTabs_().forEach(function (name) { ss.getSheetByName(name).hideSheet(); });

    ensureKeys();
    memo = { ss: ss, migrated: memo.migrated };
    return { created: created, reset: reset };
  }

  function isInstalled() {
    return !!sheet_(T_().MOVEMENTS);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Migration of a sheet installed with v1 (docs/SPEC_V2.md 3)
  // -------------------------------------------------------------------------------------------------------------
  // Quick check once the migration ran (Script Property): no getValues, only the sizes of two tabs.
  function schemaCurrent_() {
    var H = C_().HEADERS;
    var mv = sheet_(T_().MOVEMENTS), art = sheet_(T_().ARTICLES);
    return !!sheet_(T_().PROJECTS) && !!mv && mv.getLastColumn() >= H.MOUVEMENTS.length &&
      (!art || art.getLastColumn() >= H.ARTICLES.length);
  }

  // PROJETS after ARTICLES: formatted header and spare rows (empty: no project until the user or a simulation adds one).
  function ensureProjectsTab_() {
    var name = T_().PROJECTS;
    var sh = sheet_(name);
    if (sh) return appendHeaders_(name, sh, headers_(name)).length > 0;
    var ss = ss_();
    var active = null;
    try {
      active = ss.getActiveSheet();
    } catch (e) {
      active = null;
    }
    var after = sheet_(T_().ARTICLES);
    sh = after ? ss.insertSheet(name, after.getIndex()) : ss.insertSheet(name);
    var header = headers_(name);
    fitSize_(sh, 1 + SPARE_ROWS_ADMIN, header.length);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    styleHeader_(sh, header.length);
    applyFormats_(sh, FORMATS[name], header, 2, SPARE_ROWS_ADMIN);
    sh.setTabColor('#5b8def');
    // insertSheet activates the new tab: give the person in the sheet their tab back.
    if (active) {
      try {
        ss.setActiveSheet(active);
      } catch (e) {
        // Cosmetic.
      }
    }
    return true;
  }

  // PARAM_SEUILS rows of keys added since the tab was written (CFG.THRESHOLDS, plant, asOf). -> keys added.
  function addMissingSettings_() {
    var t = readTable_(T_().SETTINGS);
    if (!t.found || !has_(t.col, 'Clé')) return [];
    var have = {};
    t.rows.forEach(function (r) {
      var k = str_(r[t.col['Clé']]);
      if (k) have[k] = true;
    });
    var rows = defaultSettingRows_().filter(function (r) { return !has_(have, r[1]); });
    appendRows_(T_().SETTINGS, rows);
    return rows.map(function (r) { return r[1]; });
  }

  /**
   * Brings a sheet installed with an older version to the current schema: appends the missing headers of
   * MOUVEMENTS, ARTICLES and CALC_*, creates PROJETS, adds the missing PARAM_SEUILS rows. Never deletes or moves a
   * column or a row; idempotent. Run by setup (force), readInput and before every write to MOUVEMENTS, ARTICLES or
   * PROJETS; once done, Script Property SCHEMA_VERSION = 2 and the next runs only check two tab sizes.
   * -> { version, changed: [tab names], settings: [keys added] } (null before setup).
   */
  function migrate_(force) {
    if (memo.migrated && !force) return memo.migrated;
    if (!isInstalled()) return null;
    var p = props_();
    if (!force && Number(p.getProperty(PROPS.SCHEMA)) >= SCHEMA_VERSION && schemaCurrent_()) {
      memo.migrated = { version: SCHEMA_VERSION, changed: [], settings: [] };
      return memo.migrated;
    }
    var t = T_();
    var changed = [];
    [t.MOVEMENTS, t.ARTICLES].concat(calcTabs_()).forEach(function (name) {
      var sh = sheet_(name);
      if (sh && appendHeaders_(name, sh, headers_(name)).length) changed.push(name);
    });
    if (ensureProjectsTab_()) changed.push(t.PROJECTS);
    var settings = addMissingSettings_();
    if (settings.length) changed.push(t.SETTINGS);
    p.setProperty(PROPS.SCHEMA, String(SCHEMA_VERSION));
    memo.migrated = { version: SCHEMA_VERSION, changed: changed, settings: settings };
    return memo.migrated;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reading the engine input
  // -------------------------------------------------------------------------------------------------------------
  function readSettings_() {
    var t = readTable_(T_().SETTINGS);
    var g = getter_(t);
    var out = { thresholds: {}, plant: '', asOf: '' };
    t.rows.forEach(function (r) {
      var key = str_(g(r, 'Clé'));
      if (!key) return;
      var v = g(r, 'Valeur');
      if (key === 'plant') out.plant = str_(v).toUpperCase();
      else if (key === 'asOf') out.asOf = isoOf_(v);
      else if (!isNaN(num_(v))) out.thresholds[key] = num_(v);
    });
    return out;
  }

  function readMvtKinds_() {
    var t = readTable_(T_().MVT);
    var g = getter_(t);
    var out = {}, n = 0;
    t.rows.forEach(function (r) {
      var mvt = code_(g(r, 'MvT'), false);
      var kind = str_(g(r, 'Type')).toUpperCase();
      if (!mvt || !kind) return;
      if (/^non/i.test(str_(g(r, 'Pris en compte')))) kind = 'IGNORE';
      out[mvt] = kind;
      n++;
    });
    return n ? out : clone_(C_().MVT_KINDS);
  }

  // MOUVEMENTS rows as movement lines (v2 fields '' on a row written before the migration). Free texts stay as typed
  // (a number cell becomes its digits); client and sales order lose their leading zeros like the import.
  function readMovements_() {
    var t = readTable_(T_().MOVEMENTS);
    var g = getter_(t);
    return t.rows.map(function (r) {
      return {
        key: str_(g(r, 'Clé')),
        article: code_(g(r, 'Article'), true),
        division: str_(g(r, 'Division')).toUpperCase(),
        magasin: str_(g(r, 'Magasin')).toUpperCase(),
        mvt: code_(g(r, 'MvT'), false),
        text: str_(g(r, 'Texte code mvt')),
        s: str_(g(r, 'S')).toUpperCase(),
        doc: code_(g(r, 'Doc.article'), true),
        poste: code_(g(r, 'Poste'), true),
        date: isoOf_(g(r, 'Date cpt.')),
        qty: num_(g(r, 'Qté en UQS')),
        uqs: str_(g(r, 'UQS')),
        designation: str_(g(r, 'Désignation article')),
        user: str_(g(r, 'Nom utilisateur')),
        source: str_(g(r, 'Source')).toUpperCase() || 'IMPORT',
        ts: tsOf_(g(r, 'Saisie le')),
        label: code_(g(r, 'Étiquette'), false),
        headerText: code_(g(r, 'Texte en-tête'), false),
        itemText: code_(g(r, 'Texte'), false),
        reference: code_(g(r, 'Référence'), false),
        client: code_(g(r, 'Client'), true),
        salesOrder: code_(g(r, 'Commande client'), true)
      };
    });
  }

  function readOpening_(plant) {
    var t = readTable_(T_().OPENING);
    var g = getter_(t);
    var out = [];
    t.rows.forEach(function (r) {
      var div = str_(g(r, 'Division')).toUpperCase();
      if (plant && div && div !== plant) return;
      out.push({
        article: code_(g(r, 'Article'), true),
        division: div || plant,
        magasin: str_(g(r, 'Magasin')).toUpperCase(),
        designation: str_(g(r, 'Désignation article')),
        qty: num_(g(r, 'Stock utilisation libre')),
        uqs: str_(g(r, 'UQS')),
        date: isoOf_(g(r, 'Date stock'))
      });
    });
    return out;
  }

  function readArticles() {
    var t = readTable_(T_().ARTICLES);
    var g = getter_(t);
    return t.rows.map(function (r) {
      return {
        article: code_(g(r, 'Article'), true),
        designation: str_(g(r, 'Désignation article')),
        uqs: str_(g(r, 'UQS')),
        qpp: numOrNull_(g(r, 'Qté par palette')),
        palletType: str_(g(r, 'Type palette')),
        heightCm: numOrNull_(g(r, 'Hauteur palette (cm)')),
        levels: numOrNull_(g(r, 'Niveaux gerbage max')),
        family: str_(g(r, 'Famille')),
        project: projectName_(g(r, 'Projet'))
      };
    }).filter(function (a) { return a.article; });
  }

  // PROJETS rows; a name written twice (any case) is one project: blocks united, first color and comment.
  function readProjects() {
    var t = readTable_(T_().PROJECTS);
    var g = getter_(t);
    var out = [], byKey = {};
    t.rows.forEach(function (r) {
      var name = projectName_(g(r, 'Projet'));
      if (!name) return;
      var blocks = blockIds_(g(r, 'Blocs')), color = color_(g(r, 'Couleur')), comment = str_(g(r, 'Commentaire'));
      var p = byKey[name.toLowerCase()];
      if (!p) {
        p = byKey[name.toLowerCase()] = { project: name, blocks: [], color: color, comment: comment };
        out.push(p);
      }
      blocks.forEach(function (b) {
        if (p.blocks.indexOf(b) < 0) p.blocks.push(b);
      });
      if (!p.color) p.color = color;
      if (!p.comment) p.comment = comment;
    });
    return out;
  }

  function readRules_() {
    var t = readTable_(T_().RULES);
    var g = getter_(t);
    return t.rows.map(function (r) {
      return {
        priority: numOrNull_(g(r, 'Priorité')),
        criterion: str_(g(r, 'Critère')).toUpperCase(),
        value: code_(g(r, 'Valeur'), false),
        blocks: str_(g(r, 'Bloc cible')),
        comment: str_(g(r, 'Commentaire'))
      };
    }).filter(function (r) { return r.criterion && r.value && r.blocks; });
  }

  function readDocks() {
    var t = readTable_(T_().DOCKS);
    var g = getter_(t);
    var docks = t.rows.map(function (r) {
      var staged = numOrNull_(g(r, 'Palettes en zone quai'));
      var cap = numOrNull_(g(r, 'Capacité zone quai (pal)'));
      return {
        quai: code_(g(r, 'Quai'), false),
        status: str_(g(r, 'Statut quai')) || 'Libre',
        truck: str_(g(r, 'Camion')),
        carrier: str_(g(r, 'Transporteur')),
        color: str_(g(r, 'Couleur cabine')),
        arrival: time_(g(r, 'Arrivée')),
        departure: time_(g(r, 'Départ prévu')),
        planned: numOrNull_(g(r, 'Palettes prévues')),
        loaded: numOrNull_(g(r, 'Palettes chargées')),
        staged: staged === null ? 0 : staged,
        capacity: cap === null ? C_().DOCK_STAGING_CAPACITY : cap
      };
    }).filter(function (d) { return d.quai; });
    return docks.length ? docks : defaultDocks_();
  }

  // Block ids typed by hand in another case ('b1') take the LAYOUT spelling.
  function layoutIds_(projects, blocks) {
    var ids = {};
    blocks.forEach(function (b) { ids[String(b.id).toUpperCase()] = b.id; });
    projects.forEach(function (p) {
      p.blocks = p.blocks.map(function (b) { return ids[String(b).toUpperCase()] || b; });
    });
    return projects;
  }

  function readInput() {
    migrate_();
    var settings = readSettings_();
    var plant = settings.plant || C_().PLANT;
    var layout = readLayout();
    return {
      asOf: settings.asOf || null,
      plant: plant,
      movements: readMovements_(),
      opening: readOpening_(plant),
      articles: readArticles(),
      projects: layoutIds_(readProjects(), layout.blocks),
      blocks: layout.blocks.map(function (b) {
        return { id: b.id, label: b.label, x: b.x, y: b.y, w: b.w, h: b.h, cols: b.cols, rows: b.rows, levels: b.levels,
          color: b.color, capacity: b.capacity };
      }),
      rules: readRules_(),
      mvtKinds: readMvtKinds_(),
      docks: readDocks(),
      thresholds: settings.thresholds,
      layout: layout
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------------------------------------------
  function colorKey_(v) {
    return fold_(v).replace(/[^a-z0-9#]/g, '');
  }

  function readLayout() {
    var def = C_().DEFAULT_LAYOUT;
    var t = readTable_(T_().LAYOUT);
    var g = getter_(t);
    var defZones = {};
    (def.zones || []).forEach(function (z) { defZones[z.id] = z; });
    var L = { building: null, blocks: [], truck_zone: null, quais: [], quai_common: null, roads: [], zones: [] };
    t.rows.forEach(function (r) {
      var id = code_(g(r, 'ID'), false);
      if (!id || /^(inactif|supprim)/i.test(fold_(g(r, 'Statut')))) return;
      var type = fold_(g(r, 'Type')).toUpperCase().replace(/[^A-Z]+/g, '_');
      var label = str_(g(r, 'Libellé (sketch)'));
      var box = { x: numOrNull_(g(r, 'X (m)')), y: numOrNull_(g(r, 'Y (m)')), w: numOrNull_(g(r, 'Largeur (m)')),
        h: numOrNull_(g(r, 'Profondeur (m)')) };
      var color = colorKey_(g(r, 'Couleur'));
      if (type === 'BATIMENT') {
        L.building = { id: id, type: 'BATIMENT', label: label, x: box.x, y: box.y, w: box.w, h: box.h };
      } else if (type === 'BLOC_STOCKAGE' || type === 'BLOC') {
        var b = { id: id, label: label, x: box.x, y: box.y, w: box.w, h: box.h, cols: numOrNull_(g(r, 'Colonnes')),
          rows: numOrNull_(g(r, 'Rangées')), levels: numOrNull_(g(r, 'Niveaux')), color: color };
        var cap = numOrNull_(g(r, 'Capacité (palettes)'));
        if (cap !== null) b.capacity = cap;
        else if (b.cols && b.rows && b.levels) b.capacity = b.cols * b.rows * b.levels;
        L.blocks.push(b);
      } else if (type === 'ZONE_CAMION') {
        L.truck_zone = { id: id, label: label, x: box.x, y: box.y, w: box.w, h: box.h };
      } else if (type === 'QUAI') {
        if (!L.quai_common) L.quai_common = { y: box.y, w: box.w, h: box.h };
        var q = { id: id, x: box.x };
        ['y', 'w', 'h'].forEach(function (k) {
          if (box[k] !== L.quai_common[k]) q[k] = box[k];
        });
        L.quais.push(q);
      } else if (type === 'VOIE_CHARIOT' || type === 'VOIE' || type === 'ROUTE') {
        L.roads.push({ id: id, x: box.x, y: box.y, w: box.w, h: box.h });
      } else {
        var z = { id: id, label: label, x: box.x, y: box.y, w: box.w, h: box.h };
        if (type && type !== 'ZONE') z.type = type;
        if (color) z.color = color;
        var dz = defZones[id];
        z.short = dz && has_(dz, 'short') ? dz.short : label;
        L.zones.push(z);
      }
    });
    return {
      building: L.building || clone_(def.building),
      blocks: L.blocks.length ? L.blocks : clone_(def.blocks).map(function (b) {
        b.capacity = b.cols * b.rows * b.levels;
        return b;
      }),
      truck_zone: L.truck_zone || clone_(def.truck_zone),
      quais: L.quais.length ? L.quais : clone_(def.quais),
      quai_common: L.quai_common || clone_(def.quai_common),
      roads: L.roads.length ? L.roads : clone_(def.roads),
      zones: L.zones.length ? L.zones : clone_(def.zones),
      trucks_sketch: clone_(def.trucks_sketch || [])
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // CALC_* tabs
  // -------------------------------------------------------------------------------------------------------------
  function writeCalcTables(tables) {
    Object.keys(tables || {}).forEach(function (name) {
      var table = tables[name];
      if (!table || !table.length) return;
      var header = table[0].map(str_);
      var rows = table.slice(1);
      var width = header.length;
      var sh = ensureSheet_(name);
      var lastRow = sh.getLastRow();
      if (lastRow > 0) sh.getRange(1, 1, lastRow, sh.getMaxColumns()).clearContent();
      fitSize_(sh, rows.length + 1, width);
      sh.getRange(2, 1, sh.getMaxRows() - 1, width).clearFormat();
      // Text columns (every non-empty value is a string: articles, documents, dd.mm.yyyy dates) and percentages.
      var formats = {};
      var risky = [];   // [col, row] of strings Sheets would parse ('5/8', '12'), in otherwise numeric columns
      header.forEach(function (h, j) {
        if (/^Saturation/i.test(h)) {
          formats[h] = PERCENT;
          return;
        }
        var text = false, other = false;
        for (var i = 0; i < rows.length; i++) {
          var v = rows[i][j];
          if (v === '' || v === null || v === undefined) continue;
          if (typeof v === 'string') text = true;
          else other = true;
        }
        if (text && !other) {
          formats[h] = TEXT;
          return;
        }
        if (text) {
          rows.forEach(function (r, i) {
            if (typeof r[j] === 'string' && /^[=+\-]|^[\d\s.,\/:%]+$/.test(r[j])) risky.push([j, i]);
          });
        }
      });
      styleHeader_(sh, width);
      applyFormats_(sh, formats, header, 2, Math.max(rows.length, 1));
      // One call per run of consecutive risky rows of a column (in practice a single KPI cell).
      for (var k = 0; k < risky.length; k++) {
        var end = k;
        while (end + 1 < risky.length && risky[end + 1][0] === risky[k][0] && risky[end + 1][1] === risky[end][1] + 1) end++;
        sh.getRange(risky[k][1] + 2, risky[k][0] + 1, end - k + 1, 1).setNumberFormat(TEXT);
        k = end;
      }
      sh.getRange(1, 1, rows.length + 1, width)
        .setValues([header].concat(rows.map(function (r) { return fixWidth_(r, width); })));
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // State (cache chunks + hidden tab) and big cache values
  // -------------------------------------------------------------------------------------------------------------
  // Splits s into pieces of at most maxBytes UTF-8 bytes, never inside a surrogate pair.
  function splitBytes_(s, maxBytes) {
    var out = [], start = 0, bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      var b = c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : (c >= 0xdc00 && c <= 0xdfff) ? 0 : 3;
      if (b && bytes + b > maxBytes && i > start) {
        out.push(s.slice(start, i));
        start = i;
        bytes = 0;
      }
      bytes += b;
    }
    if (start < s.length || !out.length) out.push(s.slice(start));
    return out;
  }

  // Splits s into pieces of at most maxChars characters, never inside a surrogate pair.
  function splitChars_(s, maxChars) {
    var out = [], i = 0;
    while (i < s.length) {
      var end = Math.min(i + maxChars, s.length);
      var c = s.charCodeAt(end - 1);
      if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--;
      out.push(s.slice(i, end));
      i = end;
    }
    return out.length ? out : [''];
  }

  function chunkKeys_(key, meta) {
    var keys = [];
    for (var i = 0; i < meta.n; i++) keys.push(key + ':' + meta.id + ':' + i);
    return keys;
  }

  // UTF-8 size of a string (CacheService limits are in bytes).
  function bytes_(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 4 : (c >= 0xdc00 && c <= 0xdfff) ? 0 : 3;
    }
    return n;
  }

  // inline: a text that fits in one cache entry is stored under the key itself (one item instead of two).
  // Otherwise chunks first, then the meta entry that points to them; the previous chunks are dropped.
  function cachePutText_(key, text, seconds, inline) {
    var cache = cache_();
    var ttl = Math.min(seconds || CACHE_TTL_S, CACHE_TTL_S);
    var old = null;
    try {
      var prev = cache.get(key);
      old = prev && prev.charAt(0) === '{' ? JSON.parse(prev) : null;
    } catch (e) {
      old = null;
    }
    if (inline && bytes_(text) + CACHE_INLINE.length <= CACHE_CHUNK_BYTES) {
      cache.put(key, CACHE_INLINE + text, ttl);
    } else {
      var chunks = splitBytes_(text, CACHE_CHUNK_BYTES);
      var meta = { id: Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), n: chunks.length };
      var obj = {};
      chunkKeys_(key, meta).forEach(function (k, i) { obj[k] = chunks[i]; });
      obj[key] = JSON.stringify(meta);
      cache.putAll(obj, ttl);
    }
    if (old && old.id && old.n) cache.removeAll(chunkKeys_(key, old));
  }

  function cacheGetText_(key) {
    var cache = cache_();
    var metaText = cache.get(key);
    if (!metaText) return null;
    if (metaText.charAt(0) === CACHE_INLINE) return metaText.slice(CACHE_INLINE.length);
    var meta = JSON.parse(metaText);
    var keys = chunkKeys_(key, meta);
    var got = cache.getAll(keys);
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
      if (typeof got[keys[j]] !== 'string') return null;
      parts.push(got[keys[j]]);
    }
    return parts.join('');
  }

  function saveState(state) {
    var json = JSON.stringify(state);
    memo.stateJson = json;
    try {
      cachePutText_(STATE_CACHE_KEY, json, CACHE_TTL_S);
    } catch (e) {
      // The persistent copy below is enough; the next read refills the cache.
    }
    var cells = splitChars_(json, CELL_CHUNK_CHARS);
    var meta = JSON.stringify({ version: state && state.version !== undefined ? state.version : null,
      savedAt: new Date().toISOString(), n: cells.length, length: json.length });
    var values = [[meta]].concat(cells.map(function (c) { return [CHUNK_PREFIX + c]; }));
    var sh = ensureSheet_(T_().STATE);
    sh.clearContents();
    fitSize_(sh, values.length, 1);
    var range = sh.getRange(1, 1, values.length, 1);
    range.setNumberFormat(TEXT);
    range.setValues(values);
  }

  function loadState() {
    if (memo.stateJson) return JSON.parse(memo.stateJson);
    var json = null;
    try {
      json = cacheGetText_(STATE_CACHE_KEY);
    } catch (e) {
      json = null;
    }
    if (!json) {
      var sh = sheet_(T_().STATE);
      if (!sh || sh.getLastRow() < 2) return null;
      var values = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
      var meta;
      try {
        meta = JSON.parse(String(values[0][0]));
      } catch (e) {
        return null;
      }
      var parts = [];
      for (var i = 1; i <= meta.n; i++) {
        if (!values[i]) return null;
        parts.push(String(values[i][0]).slice(CHUNK_PREFIX.length));
      }
      json = parts.join('');
      if (meta.length !== undefined && json.length !== meta.length) return null;
      try {
        cachePutText_(STATE_CACHE_KEY, json, CACHE_TTL_S);
      } catch (e) {
        // Cache refill is best effort.
      }
    }
    memo.stateJson = json;
    return JSON.parse(json);
  }

  function cacheGet(key) {
    try {
      var text = cacheGetText_('C_' + key);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      return null;
    }
  }

  function cachePut(key, value, seconds) {
    try {
      cachePutText_('C_' + key, JSON.stringify(value), seconds, true);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Many small values in a few putAll calls (cache warming). Returns the number of values cached.
  function cachePutMany(values, seconds) {
    var keys = Object.keys(values || {});
    var ttl = Math.min(seconds || CACHE_TTL_S, CACHE_TTL_S);
    var done = 0, batch = {}, n = 0;
    function flush() {
      if (!n) return;
      try {
        cache_().putAll(batch, ttl);
        done += n;
      } catch (e) {
        // Best effort: the values are read from the sheet on a miss.
      }
      batch = {};
      n = 0;
    }
    keys.forEach(function (k) {
      var text = JSON.stringify(values[k]);
      if (bytes_(text) + CACHE_INLINE.length > CACHE_CHUNK_BYTES) return;
      batch['C_' + k] = CACHE_INLINE + text;
      n++;
      if (n >= 50) flush();
    });
    flush();
    return done;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Per-article lookup data (hidden _LOOKUP tab): A1 = { version, savedAt, n }; then one row per article:
  // article, designation, JSON in cells of at most 45,000 characters (each prefixed like the state chunks).
  // -------------------------------------------------------------------------------------------------------------
  function saveLookups(version, rows) {
    rows = rows || [];
    var name = T_().LOOKUP;
    var sh = sheet_(name);
    var created = !sh;
    if (created) sh = ss_().insertSheet(name);
    var values = rows.map(function (r) {
      return [code_(r.article, false), str_(r.designation).slice(0, 200)].concat(splitChars_(String(r.json), CELL_CHUNK_CHARS)
        .map(function (c) { return CHUNK_PREFIX + c; }));
    });
    var width = 3;
    values.forEach(function (r) { if (r.length > width) width = r.length; });
    var meta = JSON.stringify({ version: version, savedAt: new Date().toISOString(), n: rows.length });
    var all = [fixWidth_([meta], width)].concat(values.map(function (r) { return fixWidth_(r, width); }));
    sh.clearContents();
    fitSize_(sh, all.length, width);
    var range = sh.getRange(1, 1, all.length, width);
    range.setNumberFormat(TEXT);
    range.setValues(all);
    if (created) sh.hideSheet();
  }

  function lookupMeta_(sh) {
    try {
      var meta = JSON.parse(String(sh.getRange(1, 1).getValue()));
      return meta && typeof meta.version === 'number' ? meta : null;
    } catch (e) {
      return null;
    }
  }

  function loadLookup(article) {
    var sh = sheet_(T_().LOOKUP);
    if (!sh || sh.getLastRow() < 1) return null;
    var meta = lookupMeta_(sh);
    if (!meta) return null;
    var out = { version: meta.version, entry: null };
    var last = sh.getLastRow();
    var art = code_(article, false);
    if (last < 2 || !art) return out;
    var cell = sh.getRange(2, 1, last - 1, 1).createTextFinder(art).matchCase(true).matchEntireCell(true).findNext();
    if (!cell) return out;
    var row = sh.getRange(cell.getRow(), 1, 1, Math.max(sh.getLastColumn(), 3)).getValues()[0];
    var parts = [];
    for (var i = 2; i < row.length; i++) {
      var c = row[i] === null || row[i] === undefined ? '' : String(row[i]);
      if (!c) break;
      parts.push(c.slice(CHUNK_PREFIX.length));
    }
    try {
      out.entry = parts.length ? JSON.parse(parts.join('')) : null;
    } catch (e) {
      out.entry = null;
    }
    return out;
  }

  function readLookupIndex() {
    var sh = sheet_(T_().LOOKUP);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().map(function (r) {
      return [code_(r[0], false), str_(r[1])];
    }).filter(function (r) { return r[0]; });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Versions, keys, properties
  // -------------------------------------------------------------------------------------------------------------
  // Versions are polled by every screen: the script cache holds a copy so a poll costs no Properties read
  // (Properties quota: 50,000 reads / writes a day on consumer accounts).
  function versionsOf_(all) {
    return { data: Number(all[PROPS.DATA]) || 0, docks: Number(all[PROPS.DOCKS]) || 0 };
  }

  function cacheVersions_(v) {
    try {
      cache_().put(VERSIONS_CACHE_KEY, JSON.stringify(v), VERSIONS_CACHE_S);
    } catch (e) {
      // The next read falls back to the properties.
    }
  }

  function getVersions() {
    try {
      var c = cache_().get(VERSIONS_CACHE_KEY);
      var v = c ? JSON.parse(c) : null;
      if (v && typeof v.data === 'number' && typeof v.docks === 'number') return { data: v.data, docks: v.docks };
    } catch (e) {
      // Fall back to the properties.
    }
    var fresh = versionsOf_(props_().getProperties());
    cacheVersions_(fresh);
    return fresh;
  }

  function bumpVersion(kind) {
    var name = kind === 'docks' ? PROPS.DOCKS : PROPS.DATA;
    var p = props_();
    try {
      cache_().remove(VERSIONS_CACHE_KEY);   // never leave an old copy behind if the rewrite below fails
    } catch (e) {
      // Best effort.
    }
    var all = p.getProperties();
    var v = (Number(all[name]) || 0) + 1;
    p.setProperty(name, String(v));
    all[name] = String(v);
    cacheVersions_(versionsOf_(all));
    return v;
  }

  function newKey_() {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + Date.now() + Math.random());
    var out = '';
    for (var i = 0; out.length < 12 && i < bytes.length; i++) {
      out += KEY_ALPHABET.charAt(((bytes[i] % 256) + 256) % 256 % KEY_ALPHABET.length);
    }
    return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8, 12);
  }

  function getKeys() {
    var all = props_().getProperties();
    return { admin: all[PROPS.ADMIN_KEY] || '', docks: all[PROPS.DOCKS_KEY] || '' };
  }

  function ensureKeys() {
    var keys = getKeys();
    var set = {};
    if (!keys.admin) set[PROPS.ADMIN_KEY] = keys.admin = newKey_();
    if (!keys.docks) set[PROPS.DOCKS_KEY] = keys.docks = newKey_();
    if (Object.keys(set).length) props_().setProperties(set);
    return keys;
  }

  function resetKeys() {
    var p = props_();
    p.deleteProperty(PROPS.ADMIN_KEY);
    p.deleteProperty(PROPS.DOCKS_KEY);
    return ensureKeys();
  }

  function getProp(name) {
    var v = props_().getProperty(PROPS.PREFIX + name);
    if (v === null || v === undefined) return null;
    try {
      return JSON.parse(v);
    } catch (e) {
      return v;
    }
  }

  function setProp(name, value) {
    if (value === null || value === undefined) props_().deleteProperty(PROPS.PREFIX + name);
    else props_().setProperty(PROPS.PREFIX + name, JSON.stringify(value));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Movements, opening, articles, docks
  // -------------------------------------------------------------------------------------------------------------
  function existingKeys() {
    var sh = sheet_(T_().MOVEMENTS);
    var out = {};
    if (!sh) return out;
    var last = sh.getLastRow(), width = sh.getLastColumn();
    if (last < 2 || width < 1) return out;
    var header = sh.getRange(1, 1, 1, width).getValues()[0].map(str_);
    var col = header.indexOf('Clé');
    if (col < 0) return out;
    sh.getRange(2, col + 1, last - 1, 1).getValues().forEach(function (r) {
      var k = str_(r[0]);
      if (k) out[k] = true;
    });
    return out;
  }

  // One MOUVEMENTS row in the CFG column order (v1 columns, then the v2 ones: entry time as text, label, texts).
  function movementRow_(l, source, importId, now) {
    var q = typeof l.qty === 'number' ? l.qty : num_(l.qty);
    return [str_(l.key), code_(l.article, true), str_(l.division), str_(l.magasin), code_(l.mvt, false), str_(l.text),
      str_(l.s), code_(l.doc, true), code_(l.poste, true), dateOf_(l.date), isFinite(q) ? q : '', str_(l.uqs),
      str_(l.designation), str_(l.user), source, str_(importId), now,
      tsOf_(l.ts), code_(l.label, false), code_(l.headerText, false), code_(l.itemText, false), code_(l.reference, false),
      code_(l.client, true), code_(l.salesOrder, true)];
  }

  function appendMovements(lines, meta) {
    meta = meta || {};
    migrate_();
    var source = str_(meta.source).toUpperCase() || 'IMPORT';
    var now = new Date();
    return appendRows_(T_().MOVEMENTS, (lines || []).map(function (l) {
      return movementRow_(l, str_(l.source).toUpperCase() === SIM ? SIM : source, meta.importId, now);
    }));
  }

  function openingRow_(o) {
    var q = typeof o.qty === 'number' ? o.qty : num_(o.qty);
    return [code_(o.article, true), str_(o.division) || C_().PLANT, str_(o.magasin).toUpperCase(), str_(o.designation),
      isFinite(q) ? q : '', str_(o.uqs), dateOf_(o.date)];
  }

  function articleRow_(a) {
    return [code_(a.article, true), str_(a.designation), str_(a.uqs), cellNum_(numOrNull_(a.qpp)), str_(a.palletType),
      cellNum_(numOrNull_(a.heightCm)), cellNum_(numOrNull_(a.levels)), str_(a.family), projectName_(a.project)];
  }

  function projectRow_(p) {
    return [projectName_(p.project), blockIds_(p.blocks).join(', '), color_(p.color), str_(p.comment)];
  }

  // PROJETS rows with their extra columns (added by hand), and the full header to write them back.
  function projectTable_() {
    var name = T_().PROJECTS;
    var t = readTable_(name);
    var header = headers_(name).concat(extraLabels_(t, headers_(name)));
    return { header: header, rows: remap_(t, header) };
  }

  // Rewrites PROJETS: rows in CFG order; extra columns kept for the names (any case) that stay.
  function writeProjectRows_(table, rows) {
    var width = headers_(T_().PROJECTS).length;
    var extras = {};
    table.rows.forEach(function (r) {
      var k = projectName_(r[0]).toLowerCase();
      if (k && !has_(extras, k)) extras[k] = r.slice(width);
    });
    writeRows_(T_().PROJECTS, rows.map(function (r) {
      var k = projectName_(r[0]).toLowerCase();
      return fixWidth_(r, width).concat(has_(extras, k) ? extras[k] : []);
    }), SPARE_ROWS_ADMIN, table.header);
  }

  // Article codes released by the simulation (the user owns those ARTICLES rows from now on).
  function releaseSimArticles_(codes) {
    var sim = getProp('SIM_ARTICLES');
    if (!sim || !sim.length) return;
    var mine = {};
    codes.forEach(function (a) { mine[String(a).toUpperCase()] = true; });
    var left = sim.filter(function (a) { return !mine[String(a).toUpperCase()]; });
    if (left.length !== sim.length) setProp('SIM_ARTICLES', left.length ? left : null);
  }

  function replaceSimulation(data) {
    data = data || {};
    migrate_();
    var t = T_();
    var out = { removed: 0, added: 0, opening: 0, articles: 0, projects: 0, docks: 0 };
    if (data.movements) {
      var table = readTable_(t.MOVEMENTS);
      var header = headers_(t.MOVEMENTS).concat(extraLabels_(table, headers_(t.MOVEMENTS)));
      var srcCol = header.indexOf('Source');
      var kept = remap_(table, header).filter(function (r) { return str_(r[srcCol]).toUpperCase() !== SIM; });
      out.removed = table.rows.length - kept.length;
      var now = new Date();
      var rows = kept.concat(data.movements.map(function (l) { return movementRow_(l, SIM, data.importId, now); }));
      writeRows_(t.MOVEMENTS, rows, 0, header);
      out.added = data.movements.length;
    }
    if (Array.isArray(data.opening)) {
      writeRows_(t.OPENING, data.opening.map(openingRow_), 0);
      setProp('OPENING_SOURCE', SIM);
      out.opening = data.opening.length;
    }
    if (Array.isArray(data.articles)) {
      var ids = data.articles.map(function (a) { return code_(a.article, true); }).filter(function (a) { return a; });
      var drop = {};
      (getProp('SIM_ARTICLES') || []).concat(ids).forEach(function (a) { drop[a] = true; });
      var at = readTable_(t.ARTICLES);
      var aHeader = headers_(t.ARTICLES).concat(extraLabels_(at, headers_(t.ARTICLES)));
      var keptArticles = remap_(at, aHeader).filter(function (r) { return !drop[code_(r[0], true)]; });
      writeRows_(t.ARTICLES, keptArticles.concat(data.articles.map(articleRow_)), SPARE_ROWS_ADMIN, aHeader);
      setProp('SIM_ARTICLES', ids);
      out.articles = ids.length;
    }
    if (Array.isArray(data.projects)) {
      // Simulated projects replace the previous simulated ones and same-named rows; the user's other rows stay.
      var names = [], dropP = {};
      data.projects.forEach(function (p) {
        var n = projectName_(p && p.project);
        if (n && !has_(dropP, n.toLowerCase())) names.push(n);
        if (n) dropP[n.toLowerCase()] = true;
      });
      (getProp('SIM_PROJECTS') || []).forEach(function (n) { dropP[String(n).toLowerCase()] = true; });
      var pt = projectTable_();
      var keptP = pt.rows.filter(function (r) {
        var k = projectName_(r[0]).toLowerCase();
        return k && !has_(dropP, k);
      });
      var seenP = {};
      var simRows = data.projects.filter(function (p) {
        var k = projectName_(p && p.project).toLowerCase();
        if (!k || has_(seenP, k)) return false;
        seenP[k] = true;
        return true;
      }).map(projectRow_);
      writeProjectRows_(pt, keptP.concat(simRows));
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
    migrate_();
    var t = T_();
    var out = { removed: 0, opening: false, articles: 0, projects: 0, docks: false };
    var table = readTable_(t.MOVEMENTS);
    var header = headers_(t.MOVEMENTS).concat(extraLabels_(table, headers_(t.MOVEMENTS)));
    var srcCol = header.indexOf('Source');
    var kept = remap_(table, header).filter(function (r) { return str_(r[srcCol]).toUpperCase() !== SIM; });
    out.removed = table.rows.length - kept.length;
    if (out.removed) writeRows_(t.MOVEMENTS, kept, 0, header);
    if (getProp('OPENING_SOURCE') === SIM) {
      writeRows_(t.OPENING, [], 0);
      setProp('OPENING_SOURCE', null);
      out.opening = true;
    }
    var simArticles = getProp('SIM_ARTICLES') || [];
    if (simArticles.length) {
      var drop = {};
      simArticles.forEach(function (a) { drop[a] = true; });
      var at = readTable_(t.ARTICLES);
      var aHeader = headers_(t.ARTICLES).concat(extraLabels_(at, headers_(t.ARTICLES)));
      var all = remap_(at, aHeader);
      var keptArticles = all.filter(function (r) { return !drop[code_(r[0], true)]; });
      out.articles = all.length - keptArticles.length;
      writeRows_(t.ARTICLES, keptArticles, SPARE_ROWS_ADMIN, aHeader);
      setProp('SIM_ARTICLES', null);
    }
    // PROJETS: only while the simulation still owns it (a save from the projects panel gives it to the user).
    if (getProp('PROJECTS_SOURCE') === SIM) {
      var simNames = getProp('SIM_PROJECTS');
      var pt = projectTable_();
      var dropP = {};
      (simNames || []).forEach(function (n) { dropP[String(n).toLowerCase()] = true; });
      var keptP = simNames ? pt.rows.filter(function (r) {
        var k = projectName_(r[0]).toLowerCase();
        return k && !has_(dropP, k);
      }) : [];
      out.projects = pt.rows.filter(function (r) { return projectName_(r[0]); }).length - keptP.length;
      writeProjectRows_(pt, keptP);
      setProp('PROJECTS_SOURCE', null);
      setProp('SIM_PROJECTS', null);
    }
    if (getProp('DOCKS_SOURCE') === SIM) {
      replaceDocks(defaultDocks_(), null);
      out.docks = true;
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------
  // References -> projects (projects panel and page). Validation and spelling are done by Api.gs.
  // -------------------------------------------------------------------------------------------------------------
  /**
   * Upsert of ARTICLES › Projet: rows [{ article, project, designation }] (project '' removes it). An article is
   * matched case-insensitively (every row of a code written twice); a new article gets a new row with the given
   * designation. One write of the Projet column plus one append. The user owns these rows from now on (removed
   * from SIM_ARTICLES) and owns PROJETS (PROJECTS_SOURCE cleared). -> { created, updated, unchanged, articles }
   */
  function saveArticleProjects(rows) {
    migrate_();
    var name = T_().ARTICLES;
    var t = readTable_(name, true);
    if (t.found && !has_(t.col, 'Projet') && appendHeaders_(name, t.sheet, headers_(name)).length) t = readTable_(name, true);
    var aCol = t.col['Article'], pCol = t.col['Projet'];
    var at = {};
    t.rows.forEach(function (r, i) {
      var a = aCol === undefined ? '' : code_(r[aCol], true).toUpperCase();
      if (a) (at[a] = at[a] || []).push(i);
    });
    var column = t.rows.map(function (r) { return pCol === undefined ? '' : r[pCol]; });
    var out = { created: 0, updated: 0, unchanged: 0, articles: [] };
    var fresh = [], seen = {};
    (rows || []).forEach(function (row) {
      var art = code_(row.article, true);
      var k = art.toUpperCase();
      if (!art || has_(seen, k)) return;
      seen[k] = true;
      out.articles.push(art);
      var project = projectName_(row.project);
      if (!has_(at, k)) {
        // No row to take a project away from (a new row would make the article tracked by the engine).
        if (!project) {
          out.unchanged++;
          return;
        }
        fresh.push(articleRow_({ article: art, designation: row.designation, project: project }));
        out.created++;
        return;
      }
      var changed = false;
      at[k].forEach(function (i) {
        if (projectName_(column[i]) !== project) {
          column[i] = project;
          changed = true;
        }
      });
      if (changed) out.updated++;
      else out.unchanged++;
    });
    if (out.updated) writeColumn_(name, t.sheet, 'Projet', column);
    appendRows_(name, fresh);
    releaseSimArticles_(out.articles);
    setProp('PROJECTS_SOURCE', null);
    return out;
  }

  // New PROJETS rows without blocks (names already there, any case, are skipped). -> names added.
  function addProjects(names) {
    migrate_();
    var have = {};
    readProjects().forEach(function (p) { have[p.project.toLowerCase()] = true; });
    var added = [];
    (names || []).forEach(function (n) {
      var name = projectName_(n);
      if (!name || has_(have, name.toLowerCase())) return;
      have[name.toLowerCase()] = true;
      added.push(name);
    });
    appendRows_(T_().PROJECTS, added.map(function (n) { return projectRow_({ project: n }); }));
    setProp('PROJECTS_SOURCE', null);
    return added;
  }

  // PROJETS replaced by rows [{ project, blocks, color, comment }]: the user owns the tab from now on.
  function saveProjects(rows) {
    migrate_();
    writeProjectRows_(projectTable_(), (rows || []).filter(function (p) {
      return projectName_(p && p.project);
    }).map(projectRow_));
    setProp('PROJECTS_SOURCE', null);
    setProp('SIM_PROJECTS', null);
    return (rows || []).length;
  }

  // Every ARTICLES › Projet and every PROJET rule of REGLES_PLACEMENT equal to 'from' (any case) becomes 'to'.
  function renameProjectRefs(from, to) {
    migrate_();
    var key = projectName_(from).toLowerCase(), target = projectName_(to);
    var out = { articles: 0, rules: 0 };
    if (!key || !target) return out;
    var at = readTable_(T_().ARTICLES, true);
    if (has_(at.col, 'Projet')) {
      var col = at.rows.map(function (r) {
        var p = r[at.col['Projet']];
        if (projectName_(p).toLowerCase() !== key || projectName_(p) === target) return p;
        out.articles++;
        return target;
      });
      if (out.articles) writeColumn_(T_().ARTICLES, at.sheet, 'Projet', col);
    }
    var rt = readTable_(T_().RULES, true);
    if (has_(rt.col, 'Critère') && has_(rt.col, 'Valeur')) {
      var vals = rt.rows.map(function (r) {
        var v = r[rt.col['Valeur']];
        if (str_(r[rt.col['Critère']]).toUpperCase() !== 'PROJET' || projectName_(v).toLowerCase() !== key ||
          projectName_(v) === target) return v;
        out.rules++;
        return target;
      });
      if (out.rules) writeColumn_(T_().RULES, rt.sheet, 'Valeur', vals);
    }
    return out;
  }

  function replaceOpening(rows) {
    writeRows_(T_().OPENING, (rows || []).map(openingRow_), 0);
    setProp('OPENING_SOURCE', 'IMPORT');
    return (rows || []).length;
  }

  function replaceDocks(docks, source) {
    writeRows_(T_().DOCKS, (docks || []).map(dockRow_), SPARE_ROWS_ADMIN);
    setProp('DOCKS_SOURCE', source || null);
    return (docks || []).length;
  }

  function saveDock(dock, who) {
    var t = T_();
    var table = readTable_(t.DOCKS, true);
    var header = headers_(t.DOCKS);
    var g = getter_(table);
    var row = dockRow_(dock);
    var at = -1;
    for (var i = 0; i < table.rows.length; i++) {
      if (code_(g(table.rows[i], 'Quai'), false) === row[0]) {
        at = i;
        break;
      }
    }
    var aligned = header.every(function (h, i) { return table.header[i] === h; });
    if (at >= 0 && aligned) {
      var sh = table.sheet;
      applyFormats_(sh, FORMATS[t.DOCKS], header, at + 2, 1);
      sh.getRange(at + 2, 1, 1, header.length).setValues([row]);
    } else if (at >= 0) {
      // Columns were moved by hand: rewrite the tab in the standard order (extra columns kept).
      var full = header.concat(extraLabels_(table, header));
      var rows = remap_(table, full).filter(function (r) { return str_(r[0]); });
      rows = rows.map(function (r) { return code_(r[0], false) === row[0] ? row.concat(r.slice(row.length)) : r; });
      writeRows_(t.DOCKS, rows, SPARE_ROWS_ADMIN, full);
    } else {
      appendRows_(t.DOCKS, [row]);
    }
    appendRows_(t.VISITS, [[new Date(), row[0], row[1], row[2], row[3], row[5], row[6], row[7], row[8], row[9],
      str_(who) || 'Manuel']]);
    setProp('DOCKS_SOURCE', 'MANUEL');
    return readDocks().filter(function (d) { return d.quai === row[0]; })[0] || null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Import log
  // -------------------------------------------------------------------------------------------------------------
  function logImport(entry) {
    entry = entry || {};
    appendRows_(T_().IMPORT_LOG, [[instant_(entry.at), str_(entry.kind), str_(entry.file), str_(entry.period),
      cellNum_(numOrNull_(entry.read)), cellNum_(numOrNull_(entry.fresh)), cellNum_(numOrNull_(entry.known)),
      cellNum_(numOrNull_(entry.rejected)), cellNum_(numOrNull_(entry.alerts)), str_(entry.result) || 'OK',
      cellNum_(numOrNull_(entry.seconds))]]);
  }

  // Last import or simulation (clearing entries and failures are skipped).
  function lastImport() {
    var sh = sheet_(T_().IMPORT_LOG);
    if (!sh) return null;
    var last = sh.getLastRow(), width = sh.getLastColumn();
    if (last < 2 || width < 1) return null;
    var first = Math.max(2, last - 49);
    var header = sh.getRange(1, 1, 1, width).getValues()[0].map(str_);
    var rows = sh.getRange(first, 1, last - first + 1, width).getValues();
    var t = { col: {} };
    header.forEach(function (h, i) { if (h && !has_(t.col, h)) t.col[h] = i; });
    var g = getter_(t);
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      var kind = str_(g(r, 'Type'));
      var result = str_(g(r, 'Résultat'));
      if (!kind || /^EFFACEMENT/i.test(kind) || /^(ÉCHEC|ECHEC)/i.test(result)) continue;
      var at = g(r, 'Horodatage');
      return {
        at: isDate_(at) ? at.toISOString() : str_(at),
        kind: kind,
        file: str_(g(r, 'Fichier')),
        period: str_(g(r, 'Période')),
        read: numOrNull_(g(r, 'Lues')),
        fresh: numOrNull_(g(r, 'Nouvelles')),
        known: numOrNull_(g(r, 'Déjà connues')),
        rejected: numOrNull_(g(r, 'Rejetées')),
        alerts: numOrNull_(g(r, 'Alertes')),
        result: result,
        seconds: numOrNull_(g(r, 'Durée (s)'))
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------------------------------------------
  // One script lock for every write. Dock saves and data writes touch the same tabs, state and versions, and a web
  // app execution has no current document (LockService.getDocumentLock() is null there).
  function withLock(kind, fn, waitMs) {
    kind = kind === 'docks' ? 'docks' : 'data';
    if (held) return fn();
    var lock = LockService.getScriptLock();
    var ok = false;
    if (waitMs === 0) {
      ok = lock.tryLock(0);
    } else {
      try {
        lock.waitLock(waitMs > 0 ? waitMs : LOCK_WAIT_MS);
        ok = true;
      } catch (e) {
        ok = false;
      }
    }
    if (!ok) {
      var err = new Error(kind === 'docks'
        ? 'Une autre mise à jour est en cours (quais, import, simulation ou recalcul) : réessayez dans quelques secondes.'
        : 'Une autre mise à jour des données est en cours (import, simulation, recalcul ou quais) : réessayez dans une minute.');
      err.busy = true;
      throw err;
    }
    held = true;
    try {
      var result = fn();
      SpreadsheetApp.flush();
      return result;
    } finally {
      held = false;
      lock.releaseLock();
    }
  }

  return {
    setup: setup,
    isInstalled: isInstalled,
    migrate: migrate_,
    readInput: readInput,
    readLayout: readLayout,
    readDocks: readDocks,
    readSettings: readSettings_,
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
    cachePutMany: cachePutMany
  };
}

var Repo = RepoModule_();
