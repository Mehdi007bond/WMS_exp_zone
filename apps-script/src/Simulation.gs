/**
 * EXP2 Digital Twin - deterministic simulator v2 (demo and test data in the real MB51 format).
 *
 * Pure JavaScript, no Google services. Same factory pattern as the engine (docs/ARCHITECTURE.md section 5):
 * on the server 'var Sim = SimulationModule_();', in the browser 'SimulationModule_.toString()', in Node through vm.
 * Contract: docs/SPEC_V2.md section 6. The lines look like the user's real MB51 export (SPEC_V2 section 1) and
 * exercise every v2 rule: labels, entry times, night posting, PRD2 waits over 4 and 6 hours, projects.
 *
 *   Sim.generate({ seed, startDate | endDate, days, palletsPerDay, edgeCases, blocks })
 *       -> { movements, opening, articles, projects, docks, asOf, openingDate, params, facts }
 *   Sim.nextDay({ seed, movements, opening, articles, asOf?, palletsPerDay?, edgeCases? })
 *       -> { movements: lines of the next day only, docks, asOf, facts }
 *   Sim.mb51Rows(movements, { noise, seed }) -> [the 22 headers of the real export, ...rows] (an MB51 file to test
 *       the import; noise adds semi-finished 131 lines and EMRT <-> PRD2 raw-material 311 lines that the
 *       finished-goods filter must drop)
 *   Sim.makeDocks(seed, date)        -> the 8 dock rows of that day
 *   Sim.nextWorkingDay('yyyy-mm-dd') -> the next day (the plant runs 7 days a week)
 *
 * Parameters of generate (all optional):
 *   seed           number or text (default 2026); same parameters -> identical output.
 *   endDate        'yyyy-mm-dd' last simulated posting day (default 2026-10-05); or startDate = first day (endDate
 *                  wins when both are given).
 *   days           posting days simulated, 1 to 60 (default 7).
 *   palletsPerDay  labels declared per day, 20 to 1,500 (default 450; 1 label = 1 container = 1 pallet).
 *   edgeCases      true (default): long PRD2 waits (2 % 4-6 h, 1 % over 6 h, and at the end of the period 2-4
 *                  labels waiting over 6 h plus 2-4 between 4 and 6 h, listed in facts), re-scans, partial labels,
 *                  manual EXP2 -> EMRT moves, '_1|' header texts.
 *   blocks         layout blocks (capacity of EXP2, block ids of the projects); default CFG.DEFAULT_LAYOUT.
 *
 * Model (docs/SPEC_V2.md 6, shapes measured on sample-data/mb51-reel/):
 *   - 36 fictional finished goods (codes: two letters + five digits, or eight digits starting 58), unit PCE,
 *     one quantity per label each; 6 fictional projects (blocks and colors), 3 articles without a project.
 *     Production volume per project follows the capacity of its blocks.
 *   - Time: entry times to the second ('yyyy-mm-dd hh:mm:ss', wall clock). A posting day D covers the entries from
 *     D 02:00:00 to D+1 01:59:59: entries between 00:00 and 01:59 are posted on the previous day, as in SAP.
 *   - Declarations (131): around the clock with the hourly profile of the real export, from a daily production
 *     plan (each article's quota in runs of 6-30 consecutive labels of one line); one line per label, label numbers
 *     sequential from 434500000 (time order), header 'label|yyyymmddhhmmss' (UTC stamp of the label, a few seconds
 *     before the entry) or 'label'; ~7 % of the labels are declared directly into EXP2.
 *   - Transfers PRD2 -> EXP2 (311): two lines, same document, header 'TA11P1' + 8 digits, Texte = label. The lag
 *     is a hash of (seed, label): log-normal body (median ~36 min, 90 % under 2 h), 2 % between 4 and 6 h, 1 % over
 *     6 h, so nextDay finds from the data alone when a pending label is due.
 *   - Re-scans (~1.5 % of the labels): EXP2 -> PRD2 then PRD2 -> EXP2 10-60 s later, same label. Manual EXP2 ->
 *     EMRT moves now and then (no label, header 'Lot ddmmyyyy').
 *   - Exits (601), one document per truck (~14 a day at 450 labels): the oldest pallets of the warehouse (near
 *     FIFO across articles), one unlabeled line per article = whole labels of its oldest stock (FIFO, as the engine
 *     consumes it), Client 'CLIENT A'-'CLIENT D', Commande client 10 digits. Pallets shipped = expected inflow + a
 *     share of the gap to a slow target wave, so EXP2 stays around 60-85 % of its places (labelIsPallet: 1 label =
 *     1 pallet). Never more than the stock.
 *   - Opening stock (MB52-like, unlabeled) the day before the first day: EXP2 ~55 % of the places.
 *   - Documents: 10 digits starting 69, increasing with time; every line also carries the normaliser's key
 *     ('Doc.article|Article|Magasin|MvT|qty|date|rank': the real export has no Poste).
 *   - The stock is kept with the engine's rules (FIFO layers per article and magasin, a labeled issue takes its
 *     own label first), and every day runs in time order, so the engine replays it without a negative stock.
 *     nextDay rebuilds that state by replaying opening + movements in the engine's order.
 */
function SimulationModule_() {
  var PLANT = 'TA11';
  var SOURCE = 'SIMULATION';
  var AUTO = 'BARFLOW_TA11';   // canonical automatic scan user (the export writes 'BARFLOWTA11')
  var JOB = 'ADMINJOB';        // SAP batch job
  var OPS = ['OPERATEUR01', 'OPERATEUR02', 'OPERATEUR03'];
  var CLIENTS = ['CLIENT A', 'CLIENT B', 'CLIENT C', 'CLIENT D'];
  var CLIENT_WEIGHTS = [4, 3, 2, 1];
  var DAY_S = 86400;
  var HOUR_S = 3600;
  var DAY_MS = 86400000;
  var NIGHT_S = 7200;          // a posting day starts at 02:00 (entries 00:00-01:59 belong to the previous day)

  var DEFAULTS = { seed: 2026, endDate: '2026-10-05', days: 7, palletsPerDay: 450, edgeCases: true };
  var LIMITS = { days: [1, 60], palletsPerDay: [20, 1500] };
  var DEFAULT_CAPACITY = 1464;
  var DEFAULT_TRUCK_CAPACITY = 33;
  var DEFAULT_DOCK_CAPACITY = 12;
  var PENDING_WARN_H = 4;      // PARAM_SEUILS pendingHoursWarn / pendingHoursCrit defaults (facts, end of period)
  var PENDING_CRIT_H = 6;

  // The 22 column headers of the real export, exactly as SAP writes them (docs/SPEC_V2.md 1).
  var MB51_HEADERS = ['Article', 'Division', 'Magasin', 'Code mouvement', 'Texte code mouvement', 'Stock spécial',
    'Document article', 'Date comptable', 'Qté en unité saisie', 'UQ de saisie', 'Désignation article', 'Montant DI',
    'Date de saisie', 'Heure de saisie', "Nom de l'utilisateur", "Texte d'en-tête pièce", 'Motif du mouvement',
    'Texte', 'Référence', 'Client', 'Fournisseur', 'Commande client'];
  // Movement texts of the real export.
  var MVT_TEXTS = { '131': 'Entrée marchandises', '311': 'TR dans division', '601': 'SM livraison' };
  // Same values as CFG.MVT_KINDS, used when Config.gs is not loaded (browser copy): nextDay gives the same result.
  var FALLBACK_KINDS = {
    '101': 'DECL', '102': 'DECL_REV', '131': 'DECL', '132': 'DECL_REV',
    '311': 'TRANSFER', '312': 'TRANSFER_REV', '313': 'TRANSFER', '315': 'TRANSFER',
    '601': 'ISSUE', '602': 'ISSUE_REV', '641': 'ISSUE', '643': 'ISSUE', '551': 'ISSUE',
    '701': 'ADJ', '702': 'ADJ', '261': 'IGNORE', '262': 'IGNORE',
    '321': 'IGNORE', '322': 'IGNORE', '343': 'IGNORE', '344': 'IGNORE'
  };

  // Numbering. Labels are 9 digits; simulated documents start with 69 (real ones: 6184..., 5006...).
  var LABEL_START = 434500000;
  var DOC_RE = /^69\d{8}$/;
  var TA_PREFIX = 'TA11P1';
  var TA_RE = /^TA11P1(\d{8})$/;
  var DELIVERY_RE = /^80\d{8}$/;
  var ORDER_RE = /^45\d{8}$/;
  // Label patterns of the normaliser (CFG.LABEL defaults), to continue the label numbers of the data.
  var ITEM_LABEL_RE = /^\d{6,12}$/;
  var HEADER_LABEL_RE = /^(\d{6,12})(?:[_|].*)?$/;
  var HEADER_LABEL_MVTS = { '101': true, '102': true, '131': true, '132': true };

  // Projects (fictional) and their blocks in the default layout; colors readable on light and dark backgrounds.
  var PROJECTS = [
    { project: 'ATLAS', blocks: ['B1', 'B7'], color: '#7fb3e0' },
    { project: 'BOREAL', blocks: ['B2', 'B8'], color: '#8fd19e' },
    { project: 'CORSO', blocks: ['B3'], color: '#f2b27a' },
    { project: 'DELTA', blocks: ['B4'], color: '#e79ac0' },
    { project: 'ETNA', blocks: ['B5'], color: '#c3a6e8' },
    { project: 'FJORD', blocks: ['B6'], color: '#7fd1cf' }
  ];
  var PROJECT_COMMENT = 'Projet fictif (simulation)';
  // Places of the default layout: production volume per project follows them (same in generate and nextDay).
  var BLOCK_PLACES = { B1: 260, B2: 96, B3: 96, B4: 120, B5: 260, B6: 80, B7: 240, B8: 312 };
  var NO_PROJECT_SHARE = 0.03;     // all the articles without a project together
  var OTHER_PROJECT_SHARE = 0.16;  // a project renamed or created by the user (nextDay)

  // Finished goods: [project, designation, quantity per label]. Codes are drawn per seed.
  var CATALOG = [
    ['ATLAS', 'PROJECTEUR ATLAS ECO TD G', 18], ['ATLAS', 'PROJECTEUR ATLAS ECO TD D', 18],
    ['ATLAS', 'PROJECTEUR ATLAS LED TD G', 15], ['ATLAS', 'PROJECTEUR ATLAS LED TD D', 15],
    ['ATLAS', 'PROJECTEUR ATLAS ECO TI G', 18], ['ATLAS', 'PROJECTEUR ATLAS ECO TI D', 18],
    ['ATLAS', 'FEU ARRIERE ATLAS G', 24], ['ATLAS', 'FEU ARRIERE ATLAS D', 24],
    ['ATLAS', 'PROJECTEUR ATLAS OES TD G', 6],
    ['BOREAL', 'PROJECTEUR BOREAL HALOGENE TD G', 12], ['BOREAL', 'PROJECTEUR BOREAL HALOGENE TD D', 12],
    ['BOREAL', 'PROJECTEUR BOREAL LED TD G', 15], ['BOREAL', 'PROJECTEUR BOREAL LED TD D', 15],
    ['BOREAL', 'PROJECTEUR BOREAL LED TI G', 15], ['BOREAL', 'PROJECTEUR BOREAL LED TI D', 15],
    ['BOREAL', 'ANTIBROUILLARD BOREAL G', 24], ['BOREAL', 'ANTIBROUILLARD BOREAL D', 24],
    ['CORSO', 'TRINGLERIE ESSUIE-GLACE CORSO G', 84], ['CORSO', 'TRINGLERIE ESSUIE-GLACE CORSO D', 84],
    ['CORSO', 'BRAS ESSUIE-GLACE CORSO', 60],
    ['DELTA', 'PROJECTEUR DELTA PREMIUM TD G', 8], ['DELTA', 'PROJECTEUR DELTA PREMIUM TD D', 8],
    ['DELTA', 'FEU DIURNE DELTA', 50],
    ['ETNA', 'PROJECTEUR ETNA ECO TD G', 18], ['ETNA', 'PROJECTEUR ETNA ECO TD D', 18],
    ['ETNA', 'PROJECTEUR ETNA BASE TD G', 12], ['ETNA', 'PROJECTEUR ETNA BASE TD D', 12],
    ['ETNA', 'MOTEUR ESSUIE-GLACE ETNA', 80], ['ETNA', 'FEU ARRIERE ETNA G', 24],
    ['FJORD', 'PROJECTEUR FJORD ECO TD G', 6], ['FJORD', 'PROJECTEUR FJORD ECO TD D', 6],
    ['FJORD', 'TRINGLERIE ESSUIE-GLACE FJORD', 50], ['FJORD', 'PROJECTEUR FJORD OES TI D', 6],
    ['', 'KIT FIXATION PROJECTEUR UNIVERSEL', 60], ['', 'PROJECTEUR ADAPTABLE ECO TD G', 12],
    ['', 'CACHE ANTIBROUILLARD UNIVERSEL', 80]
  ];
  // First letters of the alphanumeric codes (the real ones start with L or W: never the same code).
  var CODE_PREFIXES = ['KA', 'KB', 'KD', 'KE', 'QA', 'QB', 'QD', 'QE'];

  // Noise of mb51Rows (articles that never reach EXP2): semi-finished parts declared in PRD2 and raw materials
  // moved between EMRT and PRD2. Codes start with 57 and 56 (finished goods: 58 or letters).
  var NOISE_SEMI = [['CORPS PROJECTEUR ATLAS G', 8], ['CORPS PROJECTEUR ATLAS D', 8], ['REFLECTEUR BOREAL LED', 104],
    ['GLACE PROJECTEUR ETNA D', 12], ['BOITIER FEU ARRIERE ATLAS', 24], ['MODULE LED DELTA', 120],
    ['MASQUE PROJECTEUR FJORD', 12], ['PLATINE ELECTRONIQUE BOREAL', 48], ['TRINGLE NUE CORSO', 60],
    ['SUPPORT MOTEUR ETNA', 30], ['JOINT GLACE ATLAS', 200], ['CONNECTEUR FAISCEAU DELTA', 150]];
  var NOISE_RAW = [['GRANULE PC NOIR', 'KG', 500, 3000], ['PP TALC 40% NOIR', 'KG', 500, 3000],
    ['PMMA CRISTAL', 'KG', 250, 2000], ['VIS M5X12 TORX', 'PCE', 1000, 20000], ['CLIP FIXATION 8MM', 'PCE', 500, 10000],
    ['COLLE SILICONE GRISE', 'KG', 25, 200], ['FILM PROTECTION 300MM', 'M', 100, 2000],
    ['CARTON EMBALLAGE 600X400', 'PCE', 50, 500]];
  var NOISE_SEMI_RATE = 0.4;     // semi-finished declarations per finished-goods declaration
  var NOISE_RAW_RATE = 0.05;     // raw-material transfer documents per finished-goods declaration

  // Flows.
  // Declarations per wall-clock hour (0-23), shape of the real export: three shifts, dips at breaks and changes.
  var HOURLY = [28, 32, 52, 46, 48, 55, 54, 45, 26, 42, 40, 22, 42, 43, 44, 30, 22, 52, 40, 24, 26, 46, 20, 16];
  var RUN_LABELS = [6, 30];      // labels of an article in a row on one production line
  var P_DIRECT = 0.07;           // labels declared directly into EXP2
  var P_RESCAN = 0.015;          // labels scanned back to PRD2 and again to EXP2 (edge cases)
  var P_PARTIAL = 0.02;          // labels with less than the usual quantity (edge cases)
  var P_HEADER_PLAIN = 0.2;      // header text 'label' instead of 'label|yyyymmddhhmmss'
  var P_HEADER_PLAIN_DIRECT = 0.7;
  var P_HEADER_SUFFIX = 0.003;   // 'label_1|yyyymmddhhmm' (edge cases)
  var P_MANUAL_DAY = 0.35;       // daily chance of a manual EXP2 -> EMRT document (edge cases)
  var LAG_MEDIAN_S = 35 * 60;    // PRD2 -> EXP2 lag: log-normal body
  var LAG_SIGMA = 0.72;
  var LAG_MIN_S = 5 * 60;
  var LAG_BODY_MAX_S = 3 * HOUR_S + 50 * 60;
  var P_LAG_OVER6 = 0.01;        // edge cases: lag over 6 h (uniform in LAG_OVER6_S)
  var P_LAG_4TO6 = 0.02;         // edge cases: lag between 4 and 6 h
  var LAG_4TO6_S = [4 * HOUR_S + 180, 6 * HOUR_S - 180];
  var LAG_OVER6_S = [6 * HOUR_S + 180, 12 * HOUR_S];
  var RESCAN_DELAY_S = [180, 3 * HOUR_S];   // re-scan after the arrival in EXP2
  var RESCAN_GAP_S = [10, 60];              // second scan after the first
  var EXIT_GAIN = 0.6;           // share of the gap to the target saturation corrected each day
  var TRUCK_FILL = 31;           // average pallets per truck (capacity 33)
  var TRUCK_PICK = 0.8;          // a truck takes each of the oldest pallets with this chance (near FIFO)
  var TRUCK_HOURS = [5, 22.5];   // trucks leave between 05:00 and 22:30

  // Docks: trucks of the user's sketch (quai -> cab color), the other docks are free.
  var DOCK_IDS = ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08'];
  var DOCK_TRUCKS = { Q01: 'bleu', Q02: 'rouge', Q04: 'vert', Q05: 'gris', Q07: 'jaune' };
  var CARRIERS = ['Transporteur A', 'Transporteur B', 'Transporteur C', 'Transporteur D'];
  var STATUS = { LOADING: 'Chargement', WAITING: 'En attente', LOADED: 'Chargé', FREE: 'Libre' };

  // CFG is resolved at call time: Config.gs may be evaluated after this file in Apps Script.
  function cfg_() {
    return typeof CFG !== 'undefined' && CFG ? CFG : {};
  }

  // ---------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------
  function str_(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  // Code as text: a number without exponent or decimals (a label or a document read from a numeric cell).
  function code_(v) {
    if (typeof v === 'number') return isFinite(v) ? (Math.floor(v) === v ? v.toFixed(0) : String(v)) : '';
    return str_(v);
  }

  function pad2_(n) {
    n = Number(n);
    return (n < 10 ? '0' : '') + n;
  }

  function pad8_(n) {
    var s = String(n);
    while (s.length < 8) s = '0' + s;
    return s;
  }

  function has_(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // Map keyed by codes from the data (an article or a label may be any text): no prototype, no inherited key.
  function map_() {
    return Object.create(null);
  }

  function clamp_(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  function intParam_(v, limits, def) {
    var n = v === null || v === undefined || v === '' ? NaN : Number(v);
    if (!isFinite(n)) n = def;
    return clamp_(Math.round(n), limits[0], limits[1]);
  }

  function boolParam_(v, def) {
    if (v === null || v === undefined || v === '') return def;
    if (typeof v === 'string') return !/^(false|faux|non|no|off|0)$/i.test(v.trim());
    return !!v;
  }

  // Number from a number or a French / SAP formatted string ('1.234,5', '729,25', '320-'). NaN when empty.
  function num_(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = str_(v).replace(/\s/g, '');  // \s covers the no-break and narrow no-break spaces
    if (s === '') return NaN;
    var neg = false;
    if (/-$/.test(s)) {
      neg = true;
      s = s.slice(0, -1);
    }
    if (s.indexOf(',') >= 0) s = s.indexOf('.') >= 0 ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.');
    var n = Number(s);
    return neg ? -n : n;
  }

  function milli_(v) {
    var n = num_(v);
    return isNaN(n) ? NaN : Math.round(n * 1000);
  }

  // Numeric articles lose their leading zeros (same rule as the engine and the import normaliser).
  function article_(v) {
    var s = code_(v);
    if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
    return s;
  }

  // Date (local calendar day), 'yyyy-mm-dd...' or 'dd.mm.yyyy' -> 'yyyy-mm-dd'; '' when empty or not a real date.
  function iso_(v) {
    if (v === null || v === undefined || v === '') return '';
    var s = '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return '';
      s = v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
    } else {
      var t = str_(v);
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
      if (m) s = m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
      m = m ? null : /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(t);
      if (m) s = m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
    }
    return s && isoOfDay_(dayNum_(s)) === s ? s : '';
  }

  function dayNum_(iso) {
    return Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS);
  }

  var isoCache_ = {};
  function isoOfDay_(n) {
    var s = isoCache_[n];
    if (s) return s;
    var d = new Date(n * DAY_MS);
    s = d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
    isoCache_[n] = s;
    return s;
  }

  function addDays_(iso, n) {
    return isoOfDay_(dayNum_(iso) + n);
  }

  // 0 = Sunday ... 6 = Saturday (day 0 of the epoch, 1970-01-01, was a Thursday).
  function weekdayOfNum_(n) {
    return (((n + 4) % 7) + 7) % 7;
  }

  // The plant runs 7 days a week: every valid date is a working day.
  function isWorkingDay(iso) {
    return iso_(iso) !== '';
  }

  function nextWorkingDay(iso) {
    var d = iso_(iso);
    return d ? addDays_(d, 1) : '';
  }

  // 'yyyy-mm-dd' -> 'dd.mm.yyyy' (SAP French display).
  function frDate_(iso) {
    return iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';
  }

  function ceilDiv_(a, b) {
    return Math.floor((a + b - 1) / b);
  }

  function hhmm_(minutes) {
    return pad2_(Math.floor(minutes / 60)) + ':' + pad2_(minutes % 60);
  }

  function sum_(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s;
  }

  function round2_(x) {
    return Math.round(x * 100) / 100;
  }

  // Quantity text inside keys, as Norm.keyOf writes it: at most 3 decimals, no '-0'.
  function qtyKey_(q) {
    var r = Math.round(q * 1000) / 1000;
    return String(r === 0 ? 0 : r);
  }

  // ---------------------------------------------------------------------------------------------
  // Time: seconds of wall clock since 1970-01-01 00:00 (no time zone: SAP's local time is kept as is).
  // ---------------------------------------------------------------------------------------------
  function hms_(r) {
    return pad2_(Math.floor(r / 3600)) + ':' + pad2_(Math.floor(r / 60) % 60) + ':' + pad2_(r % 60);
  }

  function tsText_(sec) {
    var dn = Math.floor(sec / DAY_S);
    return isoOfDay_(dn) + ' ' + hms_(sec - dn * DAY_S);
  }

  // 'yyyy-mm-dd hh:mm:ss' (or a Date: local wall clock) -> seconds, null when unknown.
  function tsSec_(v) {
    if (v === null || v === undefined || v === '') return null;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return null;
      return Math.round(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) / DAY_MS) * DAY_S +
        v.getHours() * 3600 + v.getMinutes() * 60 + v.getSeconds();
    }
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(str_(v));
    if (!m) return null;
    return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS) * DAY_S +
      Number(m[4]) * 3600 + Number(m[5]) * 60 + (m[6] ? Number(m[6]) : 0);
  }

  // First second of the posting day (02:00:00 of that date).
  function windowStart_(date) {
    return dayNum_(date) * DAY_S + NIGHT_S;
  }

  // Posting date of an entry: entries between 00:00 and 01:59 belong to the previous day.
  function postingDate_(sec) {
    return isoOfDay_(Math.floor((sec - NIGHT_S) / DAY_S));
  }

  function lastSunday_(year, month0) {
    var n = Math.round(Date.UTC(year, month0 + 1, 0) / DAY_MS);
    while (weekdayOfNum_(n) !== 0) n--;
    return n;
  }

  // Local time - UTC in Central Europe: 2 h from the last Sunday of March to the last Sunday of October, else 1 h.
  function utcOffset_(sec) {
    var dn = Math.floor(sec / DAY_S);
    var y = Number(isoOfDay_(dn).slice(0, 4));
    return dn >= lastSunday_(y, 2) && dn < lastSunday_(y, 9) ? 7200 : 3600;
  }

  // 'yyyymmddhhmmss' (digits 14) or 'yyyymmddhhmm' (12).
  function stamp_(sec, digits) {
    var s = tsText_(sec).replace(/[^0-9]/g, '');
    return s.slice(0, digits);
  }

  // ---------------------------------------------------------------------------------------------
  // Seeded randomness: FNV-1a + murmur3 finaliser for string seeds, mulberry32 generator.
  // ---------------------------------------------------------------------------------------------
  function seed_(v) {
    var s = str_(v);
    return s === '' ? String(DEFAULTS.seed) : s;
  }

  function hash32_(s) {
    s = String(s);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  function mulberry32_(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Stateless draw in [0, 1) for a (seed, tag) pair.
  function hashFloat_(seed, tag) {
    return mulberry32_(hash32_(seed + '|' + tag))();
  }

  function rng_(seed, tag) {
    var next = mulberry32_(hash32_(seed + '|' + tag));
    var r = {
      random: next,
      int: function (lo, hi) {
        return hi <= lo ? lo : lo + Math.floor(next() * (hi - lo + 1));
      },
      uniform: function (lo, hi) {
        return lo + (hi - lo) * next();
      },
      chance: function (p) {
        return next() < p;
      },
      pick: function (arr) {
        return arr[Math.floor(next() * arr.length)];
      },
      index: function (weights) {
        var tot = sum_(weights);
        if (!(tot > 0)) return Math.floor(next() * weights.length);
        var x = next() * tot, acc = 0;
        for (var i = 0; i < weights.length; i++) {
          acc += weights[i];
          if (x < acc) return i;
        }
        return weights.length - 1;
      },
      weighted: function (items, weights) {
        return items[r.index(weights)];
      },
      // Weighted sample without replacement.
      sample: function (items, weights, k) {
        items = items.slice();
        weights = weights.slice();
        var out = [];
        k = Math.min(k, items.length);
        for (var n = 0; n < k; n++) {
          var i = r.index(weights);
          out.push(items.splice(i, 1)[0]);
          weights.splice(i, 1);
        }
        return out;
      },
      shuffle: function (arr) {
        for (var i = arr.length - 1; i > 0; i--) {
          var j = Math.floor(next() * (i + 1));
          var t = arr[i];
          arr[i] = arr[j];
          arr[j] = t;
        }
        return arr;
      }
    };
    return r;
  }

  // Integer split of total in proportion to shares, at least 'minimum' each (largest remainder).
  function allocate_(total, shares, minimum) {
    var n = shares.length;
    if (!n) return [];
    var s = sum_(shares);
    if (!(s > 0)) {
      shares = shares.map(function () { return 1; });
      s = n;
    }
    var exact = shares.map(function (x) { return total * x / s; });
    var base = exact.map(function (e) { return Math.max(minimum, Math.floor(e)); });
    var order = exact.map(function (e, i) { return i; }).sort(function (a, b) {
      return ((exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a]))) || (a - b);
    });
    var diff = total - sum_(base), i = 0;
    while (diff > 0) {
      base[order[i % n]]++;
      diff--;
      i++;
    }
    while (diff < 0) {
      var j = 0;
      for (var k = 1; k < n; k++) if (base[k] > base[j]) j = k;
      if (base[j] <= minimum) break;
      base[j]--;
      diff++;
    }
    return base;
  }

  function capacity_(params) {
    var c = Number(params && params.capacity);
    if (c > 0) return c;
    var blocks = params && Array.isArray(params.blocks) && params.blocks.length ? params.blocks :
      ((cfg_().DEFAULT_LAYOUT || {}).blocks || []);
    var total = 0;
    blocks.forEach(function (b) {
      var cap = Number(b && b.capacity);
      if (!(cap > 0)) cap = Number(b && b.cols) * Number(b && b.rows) * Number(b && b.levels);
      if (cap > 0) total += cap;
    });
    return total > 0 ? total : DEFAULT_CAPACITY;
  }

  // Slow wave of the EXP2 saturation the exits aim at (about 66-80 %).
  function targetSat_(seed, dn) {
    var ph = hashFloat_(seed, 'phase') * 2 * Math.PI;
    return 0.73 + 0.05 * Math.sin(2 * Math.PI * dn / 9 + ph) + 0.015 * Math.sin(2 * Math.PI * dn / 4 + 2 * ph);
  }

  // ---------------------------------------------------------------------------------------------
  // Per-label draws (hash of seed and label: nextDay finds them again from the data alone)
  // ---------------------------------------------------------------------------------------------

  // Seconds between the declaration of a label in PRD2 and its transfer to EXP2.
  function lagOf_(seed, label, edge) {
    var u = hashFloat_(seed, 'lag|' + label);
    if (edge && u < P_LAG_OVER6) {
      return Math.round(LAG_OVER6_S[0] + hashFloat_(seed, 'lagt|' + label) * (LAG_OVER6_S[1] - LAG_OVER6_S[0]));
    }
    if (edge && u < P_LAG_OVER6 + P_LAG_4TO6) {
      return Math.round(LAG_4TO6_S[0] + hashFloat_(seed, 'lagt|' + label) * (LAG_4TO6_S[1] - LAG_4TO6_S[0]));
    }
    // Log-normal body (Box-Muller), drawn again when outside 5 min - 3 h 50.
    for (var k = 0; k < 8; k++) {
      var u1 = hashFloat_(seed, 'lagb|' + label + '|' + k) || 1e-9;
      var u2 = hashFloat_(seed, 'lagc|' + label + '|' + k);
      var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      var s = LAG_MEDIAN_S * Math.exp(LAG_SIGMA * z);
      if (s >= LAG_MIN_S && s <= LAG_BODY_MAX_S) return Math.round(s);
    }
    return LAG_MEDIAN_S;
  }

  function between_(seed, tag, range) {
    return range[0] + Math.floor(hashFloat_(seed, tag) * (range[1] - range[0] + 1));
  }

  // User of the PRD2 -> EXP2 transfer of a label: the scan, now and then the batch job or an operator.
  function transferUser_(seed, label) {
    var u = hashFloat_(seed, 'xu|' + label);
    return u < 0.005 ? JOB : (u < 0.01 ? OPS[Math.floor(u * 1000) % OPS.length] : AUTO);
  }

  // Header text of a declaration: 'label|yyyymmddhhmmss' (UTC stamp of the label, 2-20 s before the entry),
  // 'label', or now and then 'label_1|yyyymmddhhmm'.
  function declHeader_(seed, label, t, direct, edge) {
    var u = hashFloat_(seed, 'hdr|' + label);
    var stamp = t - utcOffset_(t) - between_(seed, 'hds|' + label, [2, 20]);
    if (direct) return u < P_HEADER_PLAIN_DIRECT ? label : label + '|' + stamp_(stamp, 14);
    if (edge && u < P_HEADER_SUFFIX) return label + '_1|' + stamp_(stamp, 12);
    if (u < P_HEADER_SUFFIX + P_HEADER_PLAIN) return label;
    return label + '|' + stamp_(stamp, 14);
  }

  // ---------------------------------------------------------------------------------------------
  // Stock state, with the engine's rules (docs/SPEC_V2.md 4.4): FIFO layers per (article, magasin); a labeled
  // issue takes its own label first, then FIFO among the unlabeled layers; an unlabeled issue takes FIFO (LIFO for
  // reversals) over every layer. Quantities in milli-units.
  // ---------------------------------------------------------------------------------------------
  function newState_(seed, kinds, edge) {
    return {
      seed: seed,
      kinds: kinds || cfg_().MVT_KINDS || FALLBACK_KINDS,
      edge: edge,
      arts: map_(),     // article -> { article, designation, uqs, qppM, project, weight }
      regular: [],      // articles the simulator produces and ships (sorted)
      buckets: map_(),  // 'article|MAG' -> { art, mag, layers, head, byLabel, nLab, unl, total }
      carry: [],        // planned events after the current posting day (long lags)
      evSeq: 0,
      layerSeq: 0,
      label: LABEL_START - 1,
      doc: 0, ta: 0, delivery: 0, order: 0,
      lines: [],        // lines produced by this call
      ranks: {},        // line identity -> count (keys)
      stats: { declared: 0, direct: 0, transfers: 0, rescans: 0, trucks: 0, exitLines: 0, manualMoves: 0 }
    };
  }

  function bucket_(st, art, mag) {
    var k = art + '|' + mag;
    return st.buckets[k] || (st.buckets[k] = { art: art, mag: mag, layers: [], head: 0, byLabel: map_(), nLab: 0, unl: 0, total: 0 });
  }

  function take_(b, L, q) {
    L.qty -= q;
    b.total -= q;
    if (L.label) {
      if (L.qty === 0) b.nLab--;
    } else {
      b.unl -= q;
    }
  }

  // Oldest live layer (advances the head over consumed layers).
  function oldest_(b) {
    var a = b.layers;
    while (b.head < a.length && a[b.head].qty === 0) b.head++;
    if (b.head > 256 && b.head * 2 > a.length) {
      b.layers = a = a.slice(b.head);
      b.head = 0;
    }
    return b.head < a.length ? a[b.head] : null;
  }

  // Applies one line to the stock; returns the missing quantity of an issue (0 when the stock was enough).
  function apply_(st, art, mag, qtyM, label, ts, rev, fromDecl) {
    var b = bucket_(st, art, mag);
    var L, i, q;
    if (qtyM > 0) {
      L = { qty: qtyM, label: label || '', ts: ts, seq: st.layerSeq++, decl: !!fromDecl };
      b.layers.push(L);
      b.total += qtyM;
      if (L.label) {
        if (has_(b.byLabel, L.label)) b.byLabel[L.label].push(L);
        else b.byLabel[L.label] = [L];
        b.nLab++;
      } else {
        b.unl += qtyM;
      }
      return 0;
    }
    var need = -qtyM;
    if (label) {
      var own = has_(b.byLabel, label) ? b.byLabel[label] : null;
      if (own) {
        for (i = 0; i < own.length && need > 0; i++) {
          L = own[i];
          if (!L.qty) continue;
          q = Math.min(need, L.qty);
          take_(b, L, q);
          need -= q;
        }
        own = own.filter(function (x) { return x.qty > 0; });
        if (own.length) b.byLabel[label] = own;
        else delete b.byLabel[label];
      }
      for (i = b.head; i < b.layers.length && need > 0; i++) {
        L = b.layers[i];
        if (L.label || !L.qty) continue;
        q = Math.min(need, L.qty);
        take_(b, L, q);
        need -= q;
      }
      return need;
    }
    if (rev) {
      for (i = b.layers.length - 1; i >= b.head && need > 0; i--) {
        L = b.layers[i];
        if (!L.qty) continue;
        q = Math.min(need, L.qty);
        take_(b, L, q);
        need -= q;
        if (L.label && !L.qty) pruneLabel_(b, L.label);
      }
      return need;
    }
    while (need > 0) {
      L = oldest_(b);
      if (!L) break;
      q = Math.min(need, L.qty);
      take_(b, L, q);
      need -= q;
      if (L.label && !L.qty) pruneLabel_(b, L.label);
    }
    return need;
  }

  function pruneLabel_(b, label) {
    var own = has_(b.byLabel, label) ? b.byLabel[label] : null;
    if (!own) return;
    own = own.filter(function (x) { return x.qty > 0; });
    if (own.length) b.byLabel[label] = own;
    else delete b.byLabel[label];
  }

  // Live quantity of a label in a bucket.
  function labelQty_(b, label) {
    var own = b && has_(b.byLabel, label) ? b.byLabel[label] : null;
    if (!own) return 0;
    var q = 0;
    for (var i = 0; i < own.length; i++) q += own[i].qty;
    return q;
  }

  // Pallets of a bucket with the engine's rule (labelIsPallet): 1 per live label + the unlabeled rest by qpp.
  function pallets_(st, b) {
    if (!b || b.total <= 0) return 0;
    var a = st.arts[b.art];
    var q = a && a.qppM > 0 ? a.qppM : 0;
    return b.nLab + (b.unl > 0 ? (q ? ceilDiv_(b.unl, q) : 1) : 0);
  }

  function magPallets_(st, mag) {
    var t = 0;
    for (var k in st.buckets) {
      if (has_(st.buckets, k) && st.buckets[k].mag === mag) t += pallets_(st, st.buckets[k]);
    }
    return t;
  }

  // Quantity of the k oldest pallets of a bucket (a label is one pallet, unlabeled stock goes by qpp): what an
  // unlabeled FIFO issue of that quantity consumes, in the engine as here.
  function oldestUnits_(b, k, qppM) {
    var sum = 0, units = 0;
    for (var i = b.head; i < b.layers.length && units < k; i++) {
      var L = b.layers[i];
      if (!(L.qty > 0)) continue;
      if (L.label) {
        sum += L.qty;
        units++;
        continue;
      }
      var left = L.qty;
      while (left > 0 && units < k) {
        var c = qppM > 0 ? Math.min(qppM, left) : left;
        sum += c;
        left -= c;
        units++;
      }
    }
    return sum;
  }

  // ---------------------------------------------------------------------------------------------
  // Lines
  // ---------------------------------------------------------------------------------------------
  function newDoc_(st, rng) {
    st.doc += rng.int(1, 3);
    return String(st.doc);
  }

  function newTa_(st, rng) {
    st.ta += rng.int(1, 2);
    return TA_PREFIX + pad8_(st.ta);
  }

  // One MB51 line with every field of the normaliser, applied to the stock.
  // o: { art, mag, mvt, qtyM, doc, t, user, label, headerText, itemText, reference, client, salesOrder }
  function emit_(st, o) {
    var a = st.arts[o.art] || {};
    var date = postingDate_(o.t);
    var qty = o.qtyM / 1000;
    var id = [o.doc, o.art, o.mag, o.mvt, qtyKey_(qty), date].join('|');
    var rank = (st.ranks[id] || 0) + 1;
    st.ranks[id] = rank;
    st.lines.push({
      key: id + '|' + rank,
      article: o.art,
      division: PLANT,
      magasin: o.mag,
      mvt: o.mvt,
      text: MVT_TEXTS[o.mvt] || '',
      s: '',
      doc: o.doc,
      poste: '',
      date: date,
      qty: qty,
      uqs: a.uqs || 'PCE',
      designation: a.designation || '',
      user: o.user,
      ts: tsText_(o.t),
      label: o.label || '',
      headerText: o.headerText || '',
      itemText: o.itemText || '',
      reference: o.reference || '',
      client: o.client || '',
      salesOrder: o.salesOrder || '',
      source: SOURCE
    });
    apply_(st, o.art, o.mag, o.qtyM, o.label || '', o.t, false, o.mvt === '131');
  }

  // A transfer document: issuing leg then receiving leg (same document, same texts).
  function emitPair_(st, o, from, to, qtyM) {
    var leg = {};
    for (var k in o) if (has_(o, k)) leg[k] = o[k];
    leg.mag = from;
    leg.qtyM = -qtyM;
    emit_(st, leg);
    leg.mag = to;
    leg.qtyM = qtyM;
    emit_(st, leg);
  }

  // ---------------------------------------------------------------------------------------------
  // Events of a posting day, executed in time order (documents follow that order)
  // ---------------------------------------------------------------------------------------------
  var EXEC = {
    // Declaration (131) of one label into PRD2, or directly into EXP2.
    DECL: function (st, ev, rng) {
      emit_(st, { art: ev.art, mag: ev.mag, mvt: '131', qtyM: ev.qtyM, doc: newDoc_(st, rng), t: ev.t, user: ev.user,
        label: ev.label, headerText: ev.header });
      st.stats.declared++;
      if (ev.mag === 'EXP2') st.stats.direct++;
    },
    // Transfer PRD2 -> EXP2 of a label (scan); a re-scan's second leg waits for its first one.
    XFER: function (st, ev, rng) {
      if (ev.after && !ev.after.done) return;
      var q = labelQty_(st.buckets[ev.art + '|PRD2'], ev.label);
      if (!(q > 0)) return;
      emitPair_(st, { art: ev.art, mvt: '311', doc: newDoc_(st, rng), t: ev.t, user: ev.user || AUTO, label: ev.label,
        headerText: newTa_(st, rng), itemText: ev.label }, 'PRD2', 'EXP2', q);
      ev.done = true;
      if (ev.rescan) st.stats.rescans++;
      else st.stats.transfers++;
    },
    // Re-scan, first leg: the label goes back from EXP2 to PRD2.
    RS1: function (st, ev, rng) {
      var q = labelQty_(st.buckets[ev.art + '|EXP2'], ev.label);
      if (!(q > 0)) return;
      emitPair_(st, { art: ev.art, mvt: '311', doc: newDoc_(st, rng), t: ev.t, user: AUTO, label: ev.label,
        headerText: newTa_(st, rng), itemText: ev.label }, 'EXP2', 'PRD2', q);
      ev.done = true;
    },
    // Unlabeled PRD2 stock (data without labels: v1 simulation, opening stock) sent to EXP2 in one document.
    XUNL: function (st, ev, rng) {
      var b = st.buckets[ev.art + '|PRD2'];
      var q = b ? b.unl : 0;
      if (!(q > 0)) return;
      emitPair_(st, { art: ev.art, mvt: '311', doc: newDoc_(st, rng), t: ev.t, user: rng.pick(OPS), headerText: '' },
        'PRD2', 'EXP2', q);
    },
    // A truck: the oldest pallets of the warehouse (near FIFO across articles, so every article stays about as long
    // in EXP2), one 601 line per article = whole labels of its oldest stock. Never more than the stock.
    TRUCK: function (st, ev, rng) {
      var units = [];
      st.regular.forEach(function (art) {
        var b = st.buckets[art + '|EXP2'];
        if (!b || b.total <= 0) return;
        var qppM = st.arts[art].qppM, n = 0;
        for (var i = b.head; i < b.layers.length; i++) {
          var L = b.layers[i];
          if (!(L.qty > 0)) continue;
          // Opening stock (no entry time) is the oldest; an unlabeled layer holds ceil(qty / qpp) pallets.
          var k = L.label ? 1 : Math.max(1, ceilDiv_(L.qty, qppM || L.qty));
          for (var j = 0; j < k; j++) units.push({ art: art, t: L.ts === null ? -1 : L.ts, seq: L.seq, n: n++ });
        }
      });
      units.sort(function (a, b) { return (a.t - b.t) || (a.seq - b.seq) || (a.n - b.n) || (a.art < b.art ? -1 : 1); });
      var count = map_(), chosen = [], taken = 0;
      for (var u = 0; u < units.length && taken < ev.size; u++) {
        if (!rng.chance(TRUCK_PICK)) continue;
        var a = units[u].art;
        if (!count[a]) chosen.push(a);
        count[a] = (count[a] || 0) + 1;
        taken++;
      }
      chosen.sort();
      var doc = '';
      chosen.forEach(function (art) {
        var b = st.buckets[art + '|EXP2'];
        var q = oldestUnits_(b, count[art], st.arts[art].qppM);
        if (!(q > 0)) return;
        if (!doc) {
          doc = newDoc_(st, rng);
          st.delivery += 1;
          st.order += rng.int(1, 9);
          st.stats.trucks++;
        }
        emit_(st, { art: art, mag: 'EXP2', mvt: '601', qtyM: -q, doc: doc, t: ev.t, user: ev.user,
          reference: String(st.delivery), client: ev.client, salesOrder: String(st.order) });
        st.stats.exitLines++;
      });
    },
    // Manual EXP2 -> EMRT move of a few pieces of several articles (no label, header 'Lot ddmmyyyy').
    MANUAL: function (st, ev, rng) {
      var cands = [], weights = [];
      st.regular.forEach(function (art) {
        var b = st.buckets[art + '|EXP2'];
        if (b && b.total > 0) {
          cands.push(art);
          weights.push(pallets_(st, b));
        }
      });
      if (!cands.length) return;
      var chosen = rng.sample(cands, weights, Math.min(cands.length, ev.n)).sort();
      var lot = 'Lot ' + frDate_(isoOfDay_(Math.floor(ev.t / DAY_S) - 1)).replace(/\./g, '');
      var doc = newDoc_(st, rng), user = rng.pick(OPS);
      chosen.forEach(function (art) {
        var b = st.buckets[art + '|EXP2'];
        var pcs = Math.max(1, Math.round(st.arts[art].qppM / 1000));
        var q = Math.min(b.total, rng.int(1, 2 * pcs) * 1000);
        if (!(q > 0)) return;
        emitPair_(st, { art: art, mvt: '311', doc: doc, t: ev.t, user: user, headerText: lot }, 'EXP2', 'EMRT', q);
      });
      st.stats.manualMoves++;
    }
  };

  // Article weights: share of the project (capacity of its default blocks) split among its articles.
  function setWeights_(st) {
    var count = map_();
    function key_(a) {
      return str_(st.arts[a].project).toUpperCase();
    }
    st.regular.forEach(function (a) {
      var k = key_(a);
      count[k] = (count[k] || 0) + 1;
    });
    var places = 0, share = map_();
    for (var b in BLOCK_PLACES) if (has_(BLOCK_PLACES, b)) places += BLOCK_PLACES[b];
    PROJECTS.forEach(function (p) {
      var c = 0;
      p.blocks.forEach(function (b) { c += BLOCK_PLACES[b] || 0; });
      share[p.project] = (1 - NO_PROJECT_SHARE) * c / places;
    });
    st.regular.forEach(function (a) {
      var k = key_(a);
      var s = k === '' ? NO_PROJECT_SHARE : (has_(share, k) ? share[k] : OTHER_PROJECT_SHARE);
      st.arts[a].weight = s / count[k] * (0.6 + 0.8 * hashFloat_(st.seed, 'w|' + a));
    });
  }

  function pickArticle_(st, rng, avoid) {
    var weights = st.regular.map(function (a) {
      return a === avoid && st.regular.length > 1 ? 0 : st.arts[a].weight;
    });
    return st.regular[rng.index(weights)];
  }

  // Entry time of a declaration on a posting day: hour from the hourly profile, second uniform.
  function sampleTime_(rng, date) {
    var h = rng.index(HOURLY);
    var base = dayNum_(date) * DAY_S + (h * HOUR_S < NIGHT_S ? DAY_S : 0);
    return base + h * HOUR_S + rng.int(0, HOUR_S - 1);
  }

  // Articles of the day's n labels (in time order), from a production plan: each article's quota (its weight,
  // +-15 %) is split into runs of 6-30 labels; ~1 line per 40 labels a day, each line takes the runs one after the
  // other, so an article comes out as consecutive labels of one line for a few hours, and the daily mix follows
  // the weights (stock per project stays in proportion to the blocks of the project).
  function productionPlan_(st, rng, n, ppd) {
    var quotas = allocate_(n, st.regular.map(function (a) { return st.arts[a].weight * rng.uniform(0.85, 1.15); }), 0);
    var runs = [];
    st.regular.forEach(function (a, i) {
      for (var left = quotas[i]; left > 0;) {
        var c = Math.min(left, rng.int(RUN_LABELS[0], RUN_LABELS[1]));
        runs.push({ art: a, left: c });
        left -= c;
      }
    });
    rng.shuffle(runs);
    var active = runs.splice(0, clamp_(Math.round(ppd / 40), 1, 30));
    var out = [];
    for (var j = 0; j < n; j++) {
      var idx = rng.int(0, active.length - 1), r = active[idx];
      out.push(r.art);
      if (--r.left > 0) continue;
      if (runs.length) active[idx] = runs.shift();
      else active.splice(idx, 1);
    }
    return out;
  }

  // Plans one label: its declaration and, from PRD2, its transfer (unless held).
  function planLabel_(st, rng, art, t, add, opts) {
    opts = opts || {};
    var seed = st.seed, label = String(++st.label), a = st.arts[art];
    var direct = !opts.prd2 && hashFloat_(seed, 'dir|' + label) < P_DIRECT;
    var qtyM = a.qppM;
    if (st.edge && hashFloat_(seed, 'part|' + label) < P_PARTIAL) {
      var pcs = Math.round(a.qppM / 1000);
      var cut = 1 + Math.floor(hashFloat_(seed, 'cut|' + label) * Math.max(1, Math.floor(pcs / 2)));
      if (cut < pcs) qtyM = (pcs - cut) * 1000;
    }
    var r = rng.random();
    var user = r < 0.005 ? JOB : (r < 0.015 ? rng.pick(OPS) : AUTO);
    add({ type: 'DECL', t: t, art: art, label: label, mag: direct ? 'EXP2' : 'PRD2', qtyM: qtyM, user: user,
      header: declHeader_(seed, label, t, direct, st.edge) });
    if (direct || opts.hold) return null;
    return add({ type: 'XFER', t: t + lagOf_(seed, label, st.edge), art: art, label: label, declT: t,
      user: transferUser_(seed, label) });
  }

  /**
   * Plans posting day 'date' (entries from date 02:00 to date+1 01:59) and returns its events in time order.
   * o: { ppd, capacity, rng, hold (end of generate: 2-4 labels over 6 h and 2-4 between 4 and 6 h) }
   */
  function planDay_(st, date, o) {
    var rng = o.rng, seed = st.seed;
    var w0 = windowStart_(date), w1 = w0 + DAY_S;
    var events = [], later = [];
    st.carry.forEach(function (ev) {
      if (ev.t < w1) events.push(ev);
      else later.push(ev);
    });
    st.carry = later;
    function add(ev) {
      ev.seq = st.evSeq++;
      if (ev.t < w1) events.push(ev);
      else st.carry.push(ev);
      return ev;
    }

    // 1. Declarations: labels numbered in time order.
    var n = Math.max(1, Math.round(o.ppd * rng.uniform(0.95, 1.05)));
    var times = [];
    for (var i = 0; i < n; i++) times.push(sampleTime_(rng, date));
    times.sort(function (a, b) { return a - b; });
    var plan = productionPlan_(st, rng, n, o.ppd);
    times.forEach(function (t, k) { planLabel_(st, rng, plan[k], t, add); });

    // 2. Exits: expected inflow into EXP2 + a share of the gap to the target saturation; ~31 pallets a truck.
    var inflow = 0;
    events.forEach(function (ev) {
      if (ev.type === 'XFER' || (ev.type === 'DECL' && ev.mag === 'EXP2')) inflow++;
      else if (ev.type === 'XUNL') inflow += pallets_(st, st.buckets[ev.art + '|PRD2']);
    });
    var target = o.capacity * targetSat_(seed, dayNum_(date));
    var P = Math.round(inflow + EXIT_GAIN * (magPallets_(st, 'EXP2') - target));
    P = clamp_(P, 0, 2 * inflow + 60);
    var truckCap = cfg_().TRUCK_CAPACITY || DEFAULT_TRUCK_CAPACITY;
    var nTrucks = P > 0 ? Math.ceil(P / Math.min(TRUCK_FILL, truckCap)) : 0;
    var shares = [];
    for (i = 0; i < nTrucks; i++) shares.push(rng.uniform(0.85, 1.15));
    var sizes = allocate_(P, shares, 1);
    for (i = 0; i < sizes.length; i++) {
      // Never above the truck capacity: the excess goes to the smallest truck.
      while (sizes[i] > truckCap) {
        var j = 0;
        for (var k = 1; k < sizes.length; k++) if (sizes[k] < sizes[j]) j = k;
        if (sizes[j] >= truckCap) break;
        sizes[i]--;
        sizes[j]++;
      }
    }
    var day0 = dayNum_(date) * DAY_S, span = (TRUCK_HOURS[1] - TRUCK_HOURS[0]) * HOUR_S;
    sizes.forEach(function (size, idx) {
      add({ type: 'TRUCK', t: day0 + Math.round(TRUCK_HOURS[0] * HOUR_S + (idx + rng.uniform(0.15, 0.85)) * span / sizes.length),
        size: size, user: rng.chance(0.5) ? JOB : rng.pick(OPS), client: rng.weighted(CLIENTS, CLIENT_WEIGHTS) });
    });
    if (st.edge && rng.chance(P_MANUAL_DAY)) {
      add({ type: 'MANUAL', t: day0 + 8 * HOUR_S + rng.int(0, 9 * HOUR_S), n: rng.int(2, 6) });
    }

    // 3. Re-scans of today's transfers (both scans inside the posting day).
    if (st.edge) {
      events.slice().forEach(function (ev) {
        if (ev.type !== 'XFER' || ev.rescan || hashFloat_(seed, 'rs|' + ev.label) >= P_RESCAN) return;
        var t1 = ev.t + between_(seed, 'rsd|' + ev.label, RESCAN_DELAY_S);
        var t2 = t1 + between_(seed, 'rsg|' + ev.label, RESCAN_GAP_S);
        if (t2 >= w1 - 60) return;
        var first = add({ type: 'RS1', t: t1, art: ev.art, label: ev.label });
        add({ type: 'XFER', t: t2, art: ev.art, label: ev.label, after: first, rescan: true, user: AUTO });
        ev.rescanned = true;
      });
    }

    // 4. End of the generated period: labels waiting in PRD2 over 6 h and between 4 and 6 h.
    if (o.hold) planEndHolds_(st, rng, events, add);

    events.sort(function (a, b) { return (a.t - b.t) || (a.seq - b.seq); });
    return events;
  }

  /**
   * End of the generated period (edge cases): exactly 2-4 labels waiting in PRD2 for 6 h or more and 2-4 for 4 to
   * 6 h at the time of the data (the last entry of the day). Transfers planned after the period keep their labels
   * in PRD2 ("natural" waits); some are released (transferred before the end) when there are too many or when
   * their wait is within 9 minutes of a threshold, and some of today's transfers are held when there are too few.
   * At a low volume, extra declarations are added in the right time band (their labels then come last).
   */
  function planEndHolds_(st, rng, events, add) {
    var end = 0;
    events.forEach(function (ev) {
      if (!ev.cancelled && ev.t > end) end = ev.t;
    });
    var margin = 0.15 * HOUR_S;
    function age_(ev) {
      return end - ev.declT;
    }
    var natural = st.carry.filter(function (ev) { return ev.type === 'XFER' && !ev.rescan && ev.declT !== undefined; });
    function release_(ev) {
      var lo = Math.max(ev.declT + LAG_MIN_S, end - 2 * HOUR_S), hi = end - 120;
      ev.t = lo < hi ? lo + rng.int(0, hi - lo) : hi;
      st.carry.splice(st.carry.indexOf(ev), 1);
      natural.splice(natural.indexOf(ev), 1);
      events.push(ev);
    }
    natural.slice().forEach(function (ev) {
      var a = age_(ev);
      if (Math.abs(a - PENDING_WARN_H * HOUR_S) < margin || Math.abs(a - PENDING_CRIT_H * HOUR_S) < margin) release_(ev);
    });
    var bands = [
      { lo: PENDING_CRIT_H, hi: Infinity, pick: [6.4, 11], wide: [6.25, 12.5] },
      { lo: PENDING_WARN_H, hi: PENDING_CRIT_H, pick: [4.25, 5.75], wide: null }
    ];
    bands.forEach(function (band) {
      var want = rng.int(2, 4);
      function inBand_(ev, range) {
        var h = age_(ev) / HOUR_S;
        return h >= range[0] && h < range[1];
      }
      var have = rng.shuffle(natural.filter(function (ev) { return inBand_(ev, [band.lo, band.hi]); }));
      while (have.length > want) release_(have.pop());
      var need = want - have.length;
      [band.pick, band.wide].forEach(function (range) {
        if (!range || need <= 0) return;
        var cands = events.filter(function (ev) {
          return ev.type === 'XFER' && !ev.cancelled && !ev.rescan && !ev.rescanned && ev.declT !== undefined &&
            ev.t < end - 600 && inBand_(ev, range);
        });
        rng.shuffle(cands).slice(0, need).forEach(function (ev) {
          ev.cancelled = true;
          need--;
        });
      });
      while (need > 0) {
        var t = end - Math.round(rng.uniform(band.pick[0], band.pick[1]) * HOUR_S);
        planLabel_(st, rng, pickArticle_(st, rng, ''), t, add, { prd2: true, hold: true });
        need--;
      }
    });
  }

  function runEvents_(st, events, rng) {
    for (var i = 0; i < events.length; i++) {
      if (!events[i].cancelled) EXEC[events[i].type](st, events[i], rng);
    }
  }

  // Labels still in PRD2 at the time of the data (the latest entry time), EXP2 at the end, the call's counters.
  function facts_(st, capacity) {
    var asOfTs = '';
    var docFirst = '', docLast = '', labelFirst = '', labelLast = '';
    st.lines.forEach(function (l) {
      if (l.ts > asOfTs) asOfTs = l.ts;
      if (!docFirst || l.doc < docFirst) docFirst = l.doc;
      if (l.doc > docLast) docLast = l.doc;
      if (l.mvt === '131' && l.label) {
        if (!labelFirst || Number(l.label) < Number(labelFirst)) labelFirst = l.label;
        if (!labelLast || Number(l.label) > Number(labelLast)) labelLast = l.label;
      }
    });
    var now = tsSec_(asOfTs);
    var over = [], warn = [], pendingLabels = 0;
    Object.keys(st.buckets).sort().forEach(function (k) {
      var b = st.buckets[k];
      if (b.mag !== 'PRD2') return;
      for (var i = b.head; i < b.layers.length; i++) {
        var L = b.layers[i];
        if (!(L.qty > 0) || !L.label) continue;
        pendingLabels++;
        if (L.ts === null || now === null) continue;
        var h = (now - L.ts) / HOUR_S;
        var row = { label: L.label, article: b.art, project: (st.arts[b.art] || {}).project || '', ts: tsText_(L.ts), hours: round2_(h) };
        if (h >= PENDING_CRIT_H) over.push(row);
        else if (h >= PENDING_WARN_H) warn.push(row);
      }
    });
    function byAge_(a, b) {
      return (b.hours - a.hours) || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0));
    }
    over.sort(byAge_);
    warn.sort(byAge_);
    var exp2 = magPallets_(st, 'EXP2');
    var s = st.stats;
    return {
      asOfTs: asOfTs,
      lines: st.lines.length,
      declared: s.declared,
      directExp2: s.direct,
      transfers: s.transfers,
      rescans: s.rescans,
      trucks: s.trucks,
      exitLines: s.exitLines,
      manualMoves: s.manualMoves,
      labels: { first: labelFirst, last: labelLast },
      docs: { first: docFirst, last: docLast },
      exp2Pallets: exp2,
      saturation: Math.round(exp2 / capacity * 10000) / 10000,
      pendingLabels: pendingLabels,
      pendingOver6h: over,
      pending4to6h: warn
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Docks: Q01-Q08, trucks at the docks of the sketch; statuses and pallet counts vary with seed and day.
  // ---------------------------------------------------------------------------------------------
  function makeDocks(seed, date) {
    var rng = rng_(seed_(seed), 'docks|' + iso_(date));
    var C = cfg_();
    var cap = C.DOCK_STAGING_CAPACITY || DEFAULT_DOCK_CAPACITY;
    var truckCap = C.TRUCK_CAPACITY || DEFAULT_TRUCK_CAPACITY;
    var n = 0;
    return DOCK_IDS.map(function (quai) {
      var color = has_(DOCK_TRUCKS, quai) ? DOCK_TRUCKS[quai] : '';
      if (!color || rng.chance(0.1)) {
        return { quai: quai, status: STATUS.FREE, truck: '', carrier: '', color: '', arrival: '', departure: '',
          planned: null, loaded: null, staged: 0, capacity: cap };
      }
      n++;
      var r = rng.random();
      var status = r < 0.5 ? STATUS.LOADING : (r < 0.75 ? STATUS.WAITING : STATUS.LOADED);
      var planned = rng.int(14, truckCap);
      var loaded = status === STATUS.LOADING ? rng.int(1, planned - 1) : (status === STATUS.LOADED ? planned : 0);
      var staged = status === STATUS.LOADED ? 0 :
        Math.min(cap, planned - loaded, status === STATUS.LOADING ? rng.int(2, cap) : rng.int(4, cap));
      var arrival = rng.int(72, 180) * 5;           // 06:00 - 15:00
      var departure = arrival + rng.int(18, 42) * 5; // 1 h 30 - 3 h 30 later
      return { quai: quai, status: status, truck: 'CAM-' + pad2_(n), carrier: rng.pick(CARRIERS), color: color,
        arrival: hhmm_(arrival), departure: hhmm_(departure), planned: planned, loaded: loaded, staged: staged,
        capacity: cap };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // generate
  // ---------------------------------------------------------------------------------------------
  // The period: 'days' days ending on endDate, else starting on startDate, else ending on the default end date.
  // endDate wins when both are given (callers that still compute a v1 start date with Monday-Saturday weeks).
  function normParams_(params) {
    params = params || {};
    var days = intParam_(params.days, LIMITS.days, DEFAULTS.days);
    var end = iso_(params.endDate), start = iso_(params.startDate);
    if (end || !start) {
      end = end || DEFAULTS.endDate;
      start = addDays_(end, 1 - days);
    } else {
      end = addDays_(start, days - 1);
    }
    return {
      seed: seed_(params.seed),
      startDate: start,
      endDate: end,
      days: days,
      palletsPerDay: intParam_(params.palletsPerDay, LIMITS.palletsPerDay, DEFAULTS.palletsPerDay),
      edgeCases: boolParam_(params.edgeCases, DEFAULTS.edgeCases)
    };
  }

  // The 36 references with codes drawn for the seed (unique, shaped like the real ones).
  function buildArticles_(rng) {
    var seen = {};
    return CATALOG.map(function (c) {
      var code;
      do {
        code = rng.chance(0.6) ? rng.pick(CODE_PREFIXES) + String(rng.int(10000, 99999)) : '58' + String(rng.int(100000, 999999));
      } while (seen[code]);
      seen[code] = true;
      var heightCm = 100 + 5 * rng.int(0, 14);
      return { article: code, designation: c[1], uqs: 'PCE', qpp: c[2], palletType: rng.chance(0.15) ? 'ISO 1200x1000' : 'EUR 1200x800',
        heightCm: heightCm, levels: heightCm <= 115 ? 3 : (heightCm <= 150 ? 2 : 1), family: '', project: c[0] };
    }).sort(function (a, b) { return a.article < b.article ? -1 : (a.article > b.article ? 1 : 0); });
  }

  // Projects with the blocks of the layout (a block missing from the given layout is left out).
  function buildProjects_(params) {
    var ids = null;
    if (params && Array.isArray(params.blocks) && params.blocks.length) {
      ids = map_();
      params.blocks.forEach(function (b) {
        if (b && b.id) ids[str_(b.id)] = true;
      });
    }
    return PROJECTS.map(function (p) {
      return { project: p.project, blocks: p.blocks.filter(function (b) { return !ids || ids[b]; }), color: p.color,
        comment: PROJECT_COMMENT };
    });
  }

  function generate(params) {
    var p = normParams_(params);
    var seed = p.seed;
    var rng = rng_(seed, 'master');
    var capacity = capacity_(params);
    var st = newState_(seed, null, p.edgeCases);

    // Articles and projects.
    var articles = buildArticles_(rng);
    articles.forEach(function (a) {
      st.arts[a.article] = { article: a.article, designation: a.designation, uqs: a.uqs, qppM: a.qpp * 1000, project: a.project };
      st.regular.push(a.article);
    });
    setWeights_(st);

    // Opening stock (MB52-like, unlabeled, the day before the first day): EXP2 ~55 % of the places.
    var openDate = addDays_(p.startDate, -1);
    var openTotal = Math.round(capacity * rng.uniform(0.54, 0.57));
    var openPallets = allocate_(openTotal, st.regular.map(function (a) { return st.arts[a].weight * rng.uniform(0.7, 1.3); }), 1);
    var opening = [];
    st.regular.forEach(function (a, i) {
      if (!(openPallets[i] > 0)) return;
      var info = st.arts[a];
      var qtyM = openPallets[i] * info.qppM;
      opening.push({ article: a, division: PLANT, magasin: 'EXP2', qty: qtyM / 1000, uqs: info.uqs,
        designation: info.designation, date: openDate });
      apply_(st, a, 'EXP2', qtyM, '', null, false, false);
    });

    // Sequences.
    st.doc = 6912000000 + rng.int(0, 999999);
    st.ta = 1900000 + rng.int(0, 99999);
    st.delivery = 8012000000 + rng.int(0, 99999);
    st.order = 4512000000 + rng.int(0, 999999);

    // Days, in time order.
    for (var d = 0; d < p.days; d++) {
      var date = addDays_(p.startDate, d);
      var dayRng = rng_(seed, 'day|' + date);
      runEvents_(st, planDay_(st, date, { ppd: p.palletsPerDay, capacity: capacity, rng: dayRng,
        hold: p.edgeCases && d === p.days - 1 }), dayRng);
    }

    var facts = facts_(st, capacity);
    return {
      movements: st.lines,
      opening: opening,
      articles: articles,
      projects: buildProjects_(params),
      docks: makeDocks(seed, p.endDate),
      asOf: p.endDate,
      openingDate: openDate,
      params: { seed: seed, startDate: p.startDate, endDate: p.endDate, days: p.days, palletsPerDay: p.palletsPerDay,
        edgeCases: p.edgeCases, capacity: capacity },
      facts: facts
    };
  }

  // ---------------------------------------------------------------------------------------------
  // nextDay: rebuild the stock from opening + movements (engine order), then simulate the next posting day.
  // ---------------------------------------------------------------------------------------------
  function nextDay(params) {
    params = params || {};
    var seed = seed_(params.seed);
    var edge = boolParam_(params.edgeCases, DEFAULTS.edgeCases);
    var plant = str_(cfg_().PLANT || PLANT);
    var st = newState_(seed, params.mvtKinds || null, edge);
    var info = map_();
    function setInfo_(art, designation, uqs) {
      var cur = info[art] || (info[art] = { designation: '', uqs: '' });
      if (!cur.designation && designation) cur.designation = designation;
      if (!cur.uqs && uqs) cur.uqs = uqs;
    }

    // Master data: the articles with a quantity per label are produced; the others only take part in the replay.
    var given = [];
    (params.articles || []).forEach(function (a) {
      var id = article_(a && a.article);
      if (!id || has_(st.arts, id)) return;
      var qpp = num_(a.qpp);
      st.arts[id] = { article: id, designation: str_(a.designation), uqs: str_(a.uqs).toUpperCase(),
        qppM: qpp > 0 ? Math.round(qpp * 1000) : 0, project: str_(a.project) };
      given.push(id);
    });

    // Opening stock.
    var openDate = '', openRows = [];
    (params.opening || []).forEach(function (o) {
      var art = article_(o && o.article), mag = str_(o && o.magasin).toUpperCase(), q = milli_(o && o.qty);
      if (!art || !mag || !(q > 0)) return;
      var d = iso_(o.date);
      if (d && (!openDate || d < openDate)) openDate = d;
      setInfo_(art, str_(o.designation), str_(o.uqs).toUpperCase());
      openRows.push({ art: art, mag: mag, qty: q });
    });

    // Movements, in the engine's order: date, entry time, Doc.article, issuing line first, file order.
    var lines = [], lastDate = '', maxDoc = 0, maxLabel = 0, maxTa = 0, maxDelivery = 0, maxOrder = 0;
    var qtyCounts = map_(), simDecl = map_();
    (params.movements || []).forEach(function (m, i) {
      if (!m) return;
      var doc = code_(m.doc), label = code_(m.label), mvt = code_(m.mvt);
      if (DOC_RE.test(doc) && Number(doc) > maxDoc) maxDoc = Number(doc);
      // The next label follows every label number of the data, also those only found in the texts.
      var hl = has_(HEADER_LABEL_MVTS, mvt) ? HEADER_LABEL_RE.exec(str_(m.headerText)) : null;
      [label, code_(m.itemText), hl ? hl[1] : ''].forEach(function (x) {
        if (ITEM_LABEL_RE.test(x) && Number(x) > maxLabel) maxLabel = Number(x);
      });
      var ta = TA_RE.exec(str_(m.headerText));
      if (ta && Number(ta[1]) > maxTa) maxTa = Number(ta[1]);
      var ref = code_(m.reference), order = code_(m.salesOrder);
      if (DELIVERY_RE.test(ref) && Number(ref) > maxDelivery) maxDelivery = Number(ref);
      if (ORDER_RE.test(order) && Number(order) > maxOrder) maxOrder = Number(order);
      var art = article_(m.article), mag = str_(m.magasin).toUpperCase(), q = milli_(m.qty);
      var date = iso_(m.date);
      if (!art || !mag || !date || isNaN(q) || q === 0) return;
      var div = str_(m.division);
      if (plant && div && div !== plant) return;
      var kind = has_(st.kinds, mvt) ? str_(st.kinds[mvt]).toUpperCase() : '';
      if (!kind || kind === 'IGNORE') return;
      if (openDate && date < openDate) return;
      if (date > lastDate) lastDate = date;
      setInfo_(art, str_(m.designation), str_(m.uqs).toUpperCase());
      if (kind === 'DECL' && q > 0 && str_(m.source).toUpperCase() === SOURCE) simDecl[art] = true;
      var t = tsSec_(m.ts);
      lines.push({ i: i, art: art, mag: mag, kind: kind, doc: doc, date: date, ts: t === null ? '' : tsText_(t), t: t,
        qty: q, label: label });
      if (label && q > 0) {
        var c = qtyCounts[art] || (qtyCounts[art] = {});
        c[q] = (c[q] || 0) + 1;
      }
    });
    function cmp_(a, b) {
      return a < b ? -1 : (a > b ? 1 : 0);
    }
    lines.sort(function (a, b) {
      return cmp_(a.date, b.date) || cmp_(a.ts, b.ts) || cmp_(a.doc, b.doc) || ((a.qty < 0 ? 0 : 1) - (b.qty < 0 ? 0 : 1)) ||
        (a.i - b.i);
    });
    openRows.forEach(function (r) { apply_(st, r.art, r.mag, r.qty, '', null, false, false); });
    lines.forEach(function (l) {
      apply_(st, l.art, l.mag, l.qty, l.label, l.t, /_REV$/.test(l.kind), l.kind === 'DECL');
    });

    // Producible articles: those of ARTICLES (else the articles the simulation declared), with a quantity per label
    // from ARTICLES, else learned from the labels (most frequent quantity, ties -> the larger one, as the engine).
    if (!given.length) {
      given = Object.keys(simDecl).sort();
      given.forEach(function (art) {
        st.arts[art] = { article: art, designation: '', uqs: '', qppM: 0, project: '' };
      });
    }
    given.forEach(function (art) {
      var a = st.arts[art];
      if (!(a.qppM > 0) && qtyCounts[art]) {
        var best = 0, bestN = 0;
        Object.keys(qtyCounts[art]).forEach(function (q) {
          var nq = qtyCounts[art][q], v = Number(q);
          if (nq > bestN || (nq === bestN && v > best)) {
            best = v;
            bestN = nq;
          }
        });
        a.qppM = best;
      }
      var inf = info[art] || {};
      if (!a.designation) a.designation = inf.designation || '';
      if (!a.uqs) a.uqs = inf.uqs || 'PCE';
      if (a.qppM > 0) st.regular.push(art);
    });
    st.regular.sort();

    var base = lastDate;
    var asOf = iso_(params.asOf);
    if (asOf && asOf > base) base = asOf;
    if (!base) base = openDate;
    if (!base) throw new Error('Simulation +1 jour impossible : aucun mouvement ni stock initial. Lancez d\'abord une simulation.');
    if (!st.regular.length) {
      throw new Error('Simulation +1 jour impossible : aucun article à produire (onglet ARTICLES vide ou sans quantité par palette).');
    }
    setWeights_(st);
    var date = addDays_(base, 1);
    var w0 = windowStart_(date), w1 = w0 + DAY_S;
    var rng = rng_(seed, 'day|' + date);

    // Sequences continue from the data.
    st.label = Math.max(LABEL_START - 1, maxLabel);
    st.doc = maxDoc || 6912000000 + Math.floor(hashFloat_(seed, 'doc') * 1000000);
    st.ta = maxTa || 1900000 + Math.floor(hashFloat_(seed, 'ta') * 100000);
    st.delivery = maxDelivery || 8012000000 + Math.floor(hashFloat_(seed, 'delivery') * 100000);
    st.order = maxOrder || 4512000000 + Math.floor(hashFloat_(seed, 'order') * 1000000);

    // Labels waiting in PRD2: transferred when due (declaration + lag of the label; a re-scan's second leg right
    // away). Overdue ones are cleared at the start of the day, oldest first. Unlabeled PRD2 stock goes in one move.
    var overdue = [];
    st.regular.forEach(function (art) {
      var b = st.buckets[art + '|PRD2'];
      if (!b) return;
      var seen = map_();
      for (var i = b.head; i < b.layers.length; i++) {
        var L = b.layers[i];
        if (!(L.qty > 0) || !L.label || seen[L.label]) continue;
        seen[L.label] = true;
        var due = L.ts === null ? null : L.ts + (L.decl ? lagOf_(seed, L.label, edge) : between_(seed, 'rsg|' + L.label, RESCAN_GAP_S));
        var ev = { type: 'XFER', art: art, label: L.label, declT: L.decl && L.ts !== null ? L.ts : undefined,
          user: transferUser_(seed, L.label) };
        if (due === null || due < w0) {
          ev.order = L.seq;
          overdue.push(ev);
        } else {
          ev.t = due;
          ev.seq = st.evSeq++;
          st.carry.push(ev);
        }
      }
      if (b.unl > 0) st.carry.push({ type: 'XUNL', t: w0 + rng.int(HOUR_S / 2, 4 * HOUR_S), art: art, seq: st.evSeq++ });
    });
    overdue.sort(function (a, b) { return a.order - b.order; });
    var t = w0 + 60;
    overdue.forEach(function (ev) {
      t = Math.min(t + rng.int(15, 90), w1 - 1);
      ev.t = t;
      ev.seq = st.evSeq++;
      st.carry.push(ev);
    });

    var ppd = Number(params.palletsPerDay) > 0 ? intParam_(params.palletsPerDay, LIMITS.palletsPerDay, DEFAULTS.palletsPerDay) :
      estimatePpd_(lines, st);
    var capacity = capacity_(params);
    runEvents_(st, planDay_(st, date, { ppd: ppd, capacity: capacity, rng: rng, hold: false }), rng);
    return { movements: st.lines, docks: makeDocks(seed, date), asOf: date, facts: facts_(st, capacity) };
  }

  // Labels declared per day over the last 7 posting days of the data (rounded to 5 so that repeated calls do not
  // drift); the default when there are none.
  function estimatePpd_(lines, st) {
    var byDate = {}, dates = [];
    lines.forEach(function (l) {
      if (l.kind !== 'DECL' || !(l.qty > 0) || !has_(st.arts, l.art)) return;
      if (!has_(byDate, l.date)) {
        byDate[l.date] = 0;
        dates.push(l.date);
      }
      byDate[l.date] += l.label ? 1 : Math.max(1, ceilDiv_(l.qty, st.arts[l.art].qppM || l.qty));
    });
    if (!dates.length) return DEFAULTS.palletsPerDay;
    dates.sort();
    dates = dates.slice(-7);
    var total = 0;
    dates.forEach(function (d) { total += byDate[d]; });
    return clamp_(Math.round(total / dates.length / 5) * 5, LIMITS.palletsPerDay[0], LIMITS.palletsPerDay[1]);
  }

  // ---------------------------------------------------------------------------------------------
  // mb51Rows: an MB51 export of movement lines (header row of the 22 real labels, then one row per line)
  // ---------------------------------------------------------------------------------------------

  // The export writes the scan user without '_' ('BARFLOWTA11'); the normaliser turns it back.
  function rawUser_(u) {
    return str_(u).replace(/^BARFLOW_/, 'BARFLOW');
  }

  function rowOf_(m, t) {
    var ts = t === null ? '' : tsText_(t);
    var mvt = code_(m.mvt);
    var q = num_(m.qty);
    return [
      article_(m.article), str_(m.division) || PLANT, str_(m.magasin).toUpperCase(), mvt, str_(m.text) || MVT_TEXTS[mvt] || '',
      str_(m.s), code_(m.doc), frDate_(iso_(m.date)), isNaN(q) ? '' : q, str_(m.uqs), str_(m.designation), 0,
      ts ? frDate_(ts.slice(0, 10)) : '', ts ? ts.slice(11) : '', rawUser_(m.user), str_(m.headerText), '0',
      code_(m.itemText), code_(m.reference), str_(m.client), '', code_(m.salesOrder)
    ];
  }

  // Lines of articles that never reach EXP2, for each posting date of the movements: semi-finished parts declared
  // in PRD2 (with labels) and raw materials moved between EMRT and PRD2 (transfer requests in Référence).
  function noiseLines_(movements, seed) {
    var byDate = {}, dates = [];
    movements.forEach(function (m) {
      var d = m ? iso_(m.date) : '';
      if (!d) return;
      if (!has_(byDate, d)) {
        byDate[d] = 0;
        dates.push(d);
      }
      if (code_(m.mvt) === '131') byDate[d]++;
    });
    dates.sort();
    var rng0 = rng_(seed, 'noise');
    var seen = {};
    function code6_(prefix) {
      var c;
      do {
        c = prefix + String(rng0.int(100000, 999999));
      } while (seen[c]);
      seen[c] = true;
      return c;
    }
    var semi = NOISE_SEMI.map(function (s) { return { article: code6_('57'), designation: s[0], qty: s[1], uqs: 'PCE' }; });
    var raw = NOISE_RAW.map(function (r) { return { article: code6_('56'), designation: r[0], uqs: r[1], lo: r[2], hi: r[3] }; });
    var docDecl = 6812000000 + rng0.int(0, 999999), docMove = 5007000000 + rng0.int(0, 999999);
    var label = 436000000 + rng0.int(0, 99999), request = 700012000 + rng0.int(0, 9999);
    var out = [];
    dates.forEach(function (d) {
      var rng = rng_(seed, 'noise|' + d);
      var w0 = windowStart_(d);
      var evs = [], i;
      for (i = Math.max(3, Math.round(byDate[d] * NOISE_SEMI_RATE)); i > 0; i--) {
        evs.push({ t: sampleTime_(rng, d), kind: 'S', a: rng.pick(semi) });
      }
      for (i = Math.max(2, Math.round(byDate[d] * NOISE_RAW_RATE)); i > 0; i--) {
        evs.push({ t: w0 + rng.int(4 * HOUR_S, 20 * HOUR_S), kind: 'R', a: rng.pick(raw) });
      }
      evs.sort(function (x, y) { return x.t - y.t; });
      evs.forEach(function (ev) {
        var a = ev.a;
        var line = { article: a.article, division: PLANT, magasin: 'PRD2', designation: a.designation, uqs: a.uqs,
          date: postingDate_(ev.t), headerText: '', itemText: '', reference: '' };
        if (ev.kind === 'S') {
          docDecl += rng.int(1, 3);
          label += 1;
          var lab = String(label);
          var stamp = ev.t - utcOffset_(ev.t) - rng.int(2, 20);
          line.mvt = '131';
          line.doc = String(docDecl);
          line.qty = a.qty;
          line.user = AUTO;
          line.headerText = lab + '|' + stamp_(stamp, 14);
          out.push({ t: ev.t, doc: line.doc, line: line });
          return;
        }
        docMove += rng.int(1, 4);
        request += 1;
        var step = a.uqs === 'KG' ? 25 : 1;
        var q = rng.int(Math.ceil(a.lo / step), Math.floor(a.hi / step)) * step;
        var back = rng.chance(0.15);
        var user = rng.pick(OPS);
        [[back ? 'PRD2' : 'EMRT', -q], [back ? 'EMRT' : 'PRD2', q]].forEach(function (leg) {
          var l = {};
          for (var k in line) if (has_(line, k)) l[k] = line[k];
          l.magasin = leg[0];
          l.qty = leg[1];
          l.mvt = '311';
          l.doc = String(docMove);
          l.user = user;
          l.reference = '0' + String(request);
          out.push({ t: ev.t, doc: l.doc, line: l });
        });
      });
    });
    return out;
  }

  /**
   * MB51 export of movement lines: [MB51_HEADERS, ...rows] with Excel-friendly values (dates 'dd.mm.yyyy' text,
   * times 'hh:mm:ss', quantities as numbers, codes as text). opts: { noise: true adds lines of articles that never
   * reach EXP2 (dropped by the finished-goods filter), seed }. With noise, rows are sorted by entry time.
   * Does not modify its input.
   */
  function mb51Rows(movements, opts) {
    opts = opts || {};
    var list = Array.isArray(movements) ? movements : [];
    var items = [];
    list.forEach(function (m, i) {
      if (!m) return;
      var t = tsSec_(m.ts);
      items.push({ t: t === null ? -1 : t, doc: code_(m.doc), i: i, row: rowOf_(m, t) });
    });
    if (opts.noise) {
      noiseLines_(list, seed_(opts.seed)).forEach(function (n, k) {
        items.push({ t: n.t, doc: n.doc, i: list.length + k, row: rowOf_(n.line, n.t) });
      });
      items.sort(function (a, b) {
        return (a.t - b.t) || (a.doc < b.doc ? -1 : (a.doc > b.doc ? 1 : 0)) || (a.i - b.i);
      });
    }
    return [MB51_HEADERS.slice()].concat(items.map(function (x) { return x.row; }));
  }

  return {
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    MB51_HEADERS: MB51_HEADERS,
    generate: generate,
    nextDay: nextDay,
    mb51Rows: mb51Rows,
    makeDocks: makeDocks,
    nextWorkingDay: nextWorkingDay,
    isWorkingDay: isWorkingDay
  };
}

var Sim = SimulationModule_();
