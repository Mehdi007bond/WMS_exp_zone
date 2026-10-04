/**
 * EXP2 Digital Twin - deterministic simulator (demo and test data).
 *
 * Pure JavaScript, no Google services. Same factory pattern as the engine (docs/ARCHITECTURE.md section 5):
 * on the server `var Sim = SimulationModule_();`, in the browser `SimulationModule_.toString()`, in Node through vm.
 *
 *   Sim.generate({ seed, startDate, days, palletsPerDay, articles, edgeCases })
 *       -> { movements, opening, articles, docks, asOf, openingDate, params, facts }
 *          (facts: Doc.article of the edge cases, for the LISEZ_MOI-style summary and the tests)
 *   Sim.nextDay({ seed, movements, opening, articles, asOf?, palletsPerDay? })
 *       -> { movements: new lines of the next working day only, docks, asOf }
 *   Sim.makeDocks(seed, date)        -> the 8 dock rows of that day
 *   Sim.nextWorkingDay('yyyy-mm-dd') -> next Monday-to-Saturday date
 *
 * Parameters of generate (all optional):
 *   seed           number or text (default 2026); same parameters -> identical output.
 *   startDate      'yyyy-mm-dd' first simulated day (a Sunday moves to Monday). Alternative: endDate = last day.
 *   days           number of WORKING days simulated, Monday to Saturday (default 14).
 *   palletsPerDay  pallets declared per working day (default 70, i.e. about 63-76 per day).
 *   articles       number of article references, 10 to 40 (default 40: 35 PC, 5 KG, families F1-F5).
 *   edgeCases      true (default): one 102, two 312, one article missing from ARTICLES, special stock 'E',
 *                  stuck pending lines. Partial pallets are always there.
 *
 * Model (port of the Python generator that built sample-data/):
 *   - Opening stock the day before the first working day: EXP2 ~60 % of the pallet places, PRD2 ~20 pallets,
 *     EMRT ~350 pallets.
 *   - Production runs: mostly one-pallet automatic 101 lines (BARFLOW_TA11) into PRD2, some manual multi-pallet
 *     lines (PLANIF01), a partial last pallet now and then.
 *   - PRD2 -> EXP2 transfers (311, one pallet per document, issuing leg then receiving leg). The lag is drawn from
 *     a hash of the declaration's Doc.article (78 % same day, 17 % next working day, 5 % later), so nextDay can
 *     decide from the data alone whether a pending line is due.
 *   - Stuck pending lines: about 1 run in 80 ends with a line that stays in PRD2 for 3-10 working days (hash of
 *     seed, article and date; the article is not produced meanwhile so FIFO keeps that layer visible). generate
 *     with edgeCases adds 4 more, held until the end of the generated period.
 *   - EXP2 <-> EMRT 311 flows (EMRT stays near its opening level), 601 shipments sized so that the EXP2
 *     saturation follows a slow target wave (about 62-78 %), never more than the stock available. A 601 document
 *     is one truck: postes 1..n, one article per poste.
 *   - Special stock 'E': declared, transferred and shipped with S = 'E' (generate: one cycle; nextDay: an
 *     occasional new batch or shipment). EXP2 stock of articles missing from ARTICLES slowly leaves (nextDay).
 *   - Every day is simulated in time order and Doc.article numbers follow the posting order, so the engine's
 *     processing order (date, Doc.article, issuing before receiving) is exactly the simulated order: stock never
 *     goes negative. nextDay rebuilds the stock state by replaying opening + movements in that order.
 * Quantities are handled in milli-units (integers) so KG articles stay exact (granularity 0.25 KG).
 */
function SimulationModule_() {
  var PLANT = 'TA11';
  var SOURCE = 'SIMULATION';
  var AUTO = 'BARFLOW_TA11';
  var OPS = ['OPEXP01', 'OPEXP02', 'OPEXP03'];
  var CHEF = 'CHEFQUAI1';
  var PLANIF = 'PLANIF01';
  var DAY_MS = 86400000;

  var DEFAULTS = { seed: 2026, startDate: '2026-09-21', days: 14, palletsPerDay: 70, articles: 40, edgeCases: true };
  var LIMITS = { days: [1, 120], palletsPerDay: [5, 500], articles: [10, 40] };
  var DEFAULT_CAPACITY = 1464;
  var DEFAULT_TRUCK_CAPACITY = 33;
  var DEFAULT_DOCK_CAPACITY = 12;
  var SIM_DOC_RE = /^49\d{8}$/;

  // Master data (same sets as the Python generator).
  var PC_QPP = [24, 36, 48, 60, 72, 96, 120, 144, 200, 240, 320, 480];
  var KG_QPP = [400, 500, 600, 750];
  var E_QPP = [48, 60, 72];
  var UNKNOWN_QPP = 96;
  var FAM_SHARE = { F1: 0.32, F2: 0.26, F3: 0.24, F4: 0.085, F5: 0.095 };
  var PC_FAMILY_WEIGHTS = [['F1', 12], ['F2', 9], ['F3', 7], ['F4', 3], ['F5', 2]];
  var KG_FAMILIES = ['F3', 'F3', 'F4', 'F5', 'F5'];
  var PC_NAMES = [
    'PF BOITIER 12V REF 01', 'PF CAPOT MOTEUR GRIS REF 02', 'PF SUPPORT FIXATION ACIER REF 03',
    'PF CONNECTEUR 4 VOIES REF 04', 'PF FAISCEAU CABLE 1M2 REF 05', 'PF CARTER PROTECTION NOIR REF 06',
    'PF BOUCHON RESERVOIR REF 07', 'PF GRILLE AERATION BLANCHE REF 08', 'PF POIGNEE PORTE CHROME REF 09',
    'PF JOINT ETANCHEITE 60MM REF 10', 'PF BOITIER FUSIBLES REF 11', 'PF PLATINE ELECTRONIQUE REF 12',
    'PF COUVERCLE BATTERIE REF 13', 'PF ENJOLIVEUR LATERAL REF 14', 'PF CONDUIT AIR 80MM REF 15',
    'PF BRIDE SERRAGE INOX REF 16', 'PF CAPTEUR TEMPERATURE REF 17', 'PF RESERVOIR LAVE-GLACE REF 18',
    'PF SUPPORT PARE-CHOC REF 19', 'PF CACHE MOTEUR REF 20', 'PF PANNEAU PORTE GAUCHE REF 21',
    'PF PANNEAU PORTE DROIT REF 22', 'PF BAC RANGEMENT REF 23', 'PF CONSOLE CENTRALE REF 24',
    'PF GAINE ELECTRIQUE 25MM REF 25', 'PF PATTE FIXATION REF 26', 'PF FILTRE HABITACLE REF 27',
    'PF TUYAU REFROIDISSEMENT REF 28', 'PF ECROU PLASTIQUE M8 REF 29', 'PF CLIP FIXATION X100 REF 30',
    'PF BOITIER COMMANDE REF 31', 'PF COQUE RETROVISEUR REF 32', 'PF PLAQUE INSONORISANTE REF 33'
  ];
  var E_NAME = 'PF BOITIER SERIE SPECIALE REF 34';
  var UNKNOWN_NAME = 'PF CARTER NOUVELLE VERSION REF 35';
  var KG_NAMES = ['PF GRANULE PP SAC 25KG', 'PF GRANULE PE NOIR BIG BAG', 'PF COMPOUND ABS VRAC OCTABIN',
    'PF POUDRE EPOXY SAC 20KG', 'PF MELANGE MAITRE BLANC SAC'];

  // Flows.
  var LAG_SAME = 0.78;          // share of declarations transferred the same day
  var LAG_NEXT = 0.95;          // cumulative: + next working day; the rest is late (2 working days or more)
  var P_RELEASE = 0.45;         // daily probability that a late or returned pending quantity is transferred
  // A production run ends with a stuck line (never transferred for 3-10 working days, article not produced
  // meanwhile) when a hash of (seed, article, date) is below P_STUCK_RUN: nextDay finds it from the data alone.
  var P_STUCK_RUN = 0.012;
  var HOLD_DAYS = [3, 10];
  var P_ORPHAN_SHIP = 0.1;      // nextDay: daily probability of shipping the EXP2 stock of an article missing from ARTICLES
  var DLV_SIZE_WEIGHTS = [22, 22, 18, 13, 10, 7, 4, 4]; // pallets per 601 line: 1..8

  // Docks: trucks of the user's sketch (quai -> cab color), the other docks are free.
  var DOCK_IDS = ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08'];
  var DOCK_TRUCKS = { Q01: 'bleu', Q02: 'rouge', Q04: 'vert', Q05: 'gris', Q07: 'jaune' };
  var CARRIERS = ['Transporteur A', 'Transporteur B', 'Transporteur C', 'Transporteur D'];
  var STATUS = { LOADING: 'Chargement', WAITING: 'En attente', LOADED: 'Chargé', FREE: 'Libre' };

  // Used only when Config.gs is not loaded.
  var FALLBACK_TEXTS = { '101': 'EM entrée en stock', '102': 'EM entrée stock ann.', '311': 'TR transf. dans div.',
    '312': 'TR transf. div. ann.', '601': 'SM livraison', '602': 'SM livraison annul.' };
  var FALLBACK_KINDS = { '101': 'DECL', '102': 'DECL_REV', '131': 'DECL', '132': 'DECL_REV', '311': 'TRANSFER',
    '312': 'TRANSFER_REV', '601': 'ISSUE', '602': 'ISSUE_REV' };

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

  function pad2_(n) {
    n = Number(n);
    return (n < 10 ? '0' : '') + n;
  }

  function has_(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
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
    var s = str_(v).replace(/[\s  ]/g, '');
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
    var s = str_(v);
    if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
    return s;
  }

  function iso_(v) {
    if (v === null || v === undefined || v === '') return '';
    if (Object.prototype.toString.call(v) === '[object Date]') {
      if (isNaN(v.getTime())) return '';
      return v.getFullYear() + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
    }
    var s = str_(v);
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
    m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(s);
    if (m) return m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
    return '';
  }

  function dayNum_(iso) {
    return Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS);
  }

  function isoOfDay_(n) {
    var d = new Date(n * DAY_MS);
    return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
  }

  function addDays_(iso, n) {
    return isoOfDay_(dayNum_(iso) + n);
  }

  // 0 = Sunday ... 6 = Saturday (day 0 of the epoch, 1970-01-01, was a Thursday).
  function weekdayOfNum_(n) {
    return (((n + 4) % 7) + 7) % 7;
  }

  function isWorkingDay(iso) {
    return weekdayOfNum_(dayNum_(iso)) !== 0;
  }

  function nextWorkingDay(iso) {
    var n = dayNum_(iso_(iso)) + 1;
    while (weekdayOfNum_(n) === 0) n++;
    return isoOfDay_(n);
  }

  function firstWorkingDay_(iso) {
    var n = dayNum_(iso);
    while (weekdayOfNum_(n) === 0) n++;
    return isoOfDay_(n);
  }

  function lastWorkingDayOnOrBefore_(iso) {
    var n = dayNum_(iso);
    while (weekdayOfNum_(n) === 0) n--;
    return isoOfDay_(n);
  }

  // Working days in (from, to].
  function workingDaysBetween_(from, to) {
    if (!from) return 999;
    var a = dayNum_(from), b = dayNum_(to);
    if (b <= a) return 0;
    var weeks = Math.floor((b - a) / 7);
    var count = weeks * 6;
    for (var d = a + weeks * 7 + 1; d <= b; d++) if (weekdayOfNum_(d) !== 0) count++;
    return count;
  }

  function ceilDiv_(a, b) {
    return Math.floor((a + b - 1) / b);
  }

  function qtyOut_(m) {
    return m / 1000;
  }

  function hhmm_(minutes) {
    return pad2_(Math.floor(minutes / 60)) + ':' + pad2_(minutes % 60);
  }

  function repeat_(v, k) {
    var out = [];
    for (var i = 0; i < k; i++) out.push(v);
    return out;
  }

  function sum_(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s;
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

  // Integer split of total in proportion to shares, at least `minimum` each (largest remainder).
  function allocate_(total, shares, minimum) {
    var n = shares.length;
    if (!n) return [];
    var s = sum_(shares);
    if (!(s > 0)) {
      shares = repeat_(1, n);
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

  // Split a quantity in chunks of 1-4 (pallets per transfer document between EXP2 and EMRT).
  function chunks_(rng, total) {
    var ks = [], s = 0;
    while (s < total) {
      var k = Math.min(rng.int(1, 4), total - s);
      ks.push(k);
      s += k;
    }
    return ks;
  }

  function partialQty_(rng, qppM, uqs, lo, hi) {
    var step = uqs === 'KG' ? 250 : 1000;
    if (qppM <= step) return qppM;
    var m = qppM * rng.uniform(lo, hi);
    return Math.min(qppM - step, Math.max(step, Math.round(m / step) * step));
  }

  function lagClass_(seed, doc) {
    var h = hashFloat_(seed, 'lag|' + doc);
    return h < LAG_SAME ? 'same' : (h < LAG_NEXT ? 'next' : 'late');
  }

  // Slow wave of the EXP2 saturation the shipments aim at (about 62-78 %).
  function targetSat_(seed, dn) {
    var ph = hashFloat_(seed, 'phase') * 2 * Math.PI;
    return 0.70 + 0.05 * Math.sin(2 * Math.PI * dn / 37 + ph) + 0.025 * Math.sin(2 * Math.PI * dn / 11 + 2 * ph);
  }

  function capacity_(params) {
    var c = Number(params && params.capacity);
    if (c > 0) return c;
    var blocks = params && Array.isArray(params.blocks) ? params.blocks : ((cfg_().DEFAULT_LAYOUT || {}).blocks || []);
    var total = 0;
    blocks.forEach(function (b) {
      var cap = Number(b && b.capacity);
      if (!(cap > 0)) cap = Number(b && b.cols) * Number(b && b.rows) * Number(b && b.levels);
      if (cap > 0) total += cap;
    });
    return total > 0 ? total : DEFAULT_CAPACITY;
  }

  function texts_() {
    return cfg_().MVT_TEXTS || FALLBACK_TEXTS;
  }

  // ---------------------------------------------------------------------------------------------
  // Stock state: totals per (article, magasin) and PRD2 layers (FIFO, reversals LIFO), as the engine does.
  // ---------------------------------------------------------------------------------------------
  function newState_(seed, kinds) {
    return {
      seed: seed,
      kinds: kinds || cfg_().MVT_KINDS || FALLBACK_KINDS,
      master: {},       // article -> { qppM, uqs, designation, family } (known articles, qpp > 0)
      info: {},         // article -> { designation, uqs } (every article seen)
      hiddenQpp: {},    // article -> qty per pallet the simulator knows but ARTICLES does not (unknown article)
      weight: {},       // article -> production weight
      regular: [],      // articles in the normal flows (sorted)
      isRegular: {},
      special: {},      // articles with special stock 'E'
      tot: {},          // 'article|MAG' -> milli-units
      prd2: {},         // article -> [{ doc, date, qty, mvt }] oldest first
      lastDecl: {},     // 'article|date' -> Doc.article of the last declaration of that article that day
      holdDocs: {},     // generate only: stuck declarations, never transferred during the generated period
      holdArts: {},     // generate only: articles not produced while one of their lines is stuck
      docCounter: 0
    };
  }

  function kindOf_(st, mvt) {
    return has_(st.kinds, mvt) ? str_(st.kinds[mvt]).toUpperCase() : '';
  }

  function setInfo_(st, art, designation, uqs) {
    var cur = st.info[art];
    if (!cur) st.info[art] = { designation: designation || '', uqs: uqs || '' };
    else {
      if (!cur.designation && designation) cur.designation = designation;
      if (!cur.uqs && uqs) cur.uqs = uqs;
    }
  }

  function apply_(st, art, mag, mvt, qtyM, doc, date) {
    var key = art + '|' + mag;
    var have = st.tot[key] || 0;
    if (qtyM > 0) {
      st.tot[key] = have + qtyM;
      if (mag === 'PRD2') (st.prd2[art] || (st.prd2[art] = [])).push({ doc: doc, date: date, qty: qtyM, mvt: mvt });
      if (doc && kindOf_(st, mvt) === 'DECL') st.lastDecl[art + '|' + date] = doc;
      return;
    }
    var need = Math.min(-qtyM, have);
    st.tot[key] = have - need;
    if (mag !== 'PRD2' || !st.prd2[art]) return;
    var layers = st.prd2[art];
    var lifo = /_REV$/.test(kindOf_(st, mvt));
    while (need > 0 && layers.length) {
      var L = lifo ? layers[layers.length - 1] : layers[0];
      var take = Math.min(need, L.qty);
      L.qty -= take;
      need -= take;
      if (L.qty <= 0) {
        if (lifo) layers.pop();
        else layers.shift();
      }
    }
    if (!layers.length) delete st.prd2[art];
  }

  function qppOf_(st, art) {
    var m = st.master[art];
    return m && m.qppM > 0 ? m.qppM : (st.hiddenQpp[art] || 0);
  }

  function totOf_(st, art, mag) {
    return st.tot[art + '|' + mag] || 0;
  }

  // Pallets of a magasin with the engine's rule: ceil(total qty / qpp) per known article.
  function palletsIn_(st, mag) {
    var total = 0;
    Object.keys(st.master).forEach(function (art) {
      var q = st.master[art].qppM, t = totOf_(st, art, mag);
      if (q > 0 && t > 0) total += ceilDiv_(t, q);
    });
    return total;
  }

  function setRegular_(st, arts) {
    st.regular = arts.slice().sort();
    st.isRegular = {};
    st.regular.forEach(function (a) { st.isRegular[a] = true; });
    var famCount = {};
    st.regular.forEach(function (a) {
      var f = st.master[a].family;
      famCount[f] = (famCount[f] || 0) + 1;
    });
    st.weight = {};
    st.regular.forEach(function (a) {
      var f = st.master[a].family;
      var share = has_(FAM_SHARE, f) ? FAM_SHARE[f] : 0.1;
      st.weight[a] = share / famCount[f] * (0.6 + 0.8 * hashFloat_(st.seed, 'w|' + a));
    });
  }

  function stuckRun_(seed, art, date) {
    return hashFloat_(seed, 'stuck|' + art + '|' + date) < P_STUCK_RUN;
  }

  // Is this PRD2 layer the stuck last line of a run, still held on `date`?
  function heldOn_(st, art, L, date) {
    if (!st.isRegular[art] || !L.doc || kindOf_(st, L.mvt) !== 'DECL') return false;
    if (st.lastDecl[art + '|' + L.date] !== L.doc || !stuckRun_(st.seed, art, L.date)) return false;
    var hold = HOLD_DAYS[0] + Math.floor(hashFloat_(st.seed, 'hold|' + L.doc) * (HOLD_DAYS[1] - HOLD_DAYS[0] + 1));
    return workingDaysBetween_(L.date, date) < hold;
  }

  // Is a pending PRD2 layer (declared before `date`) transferred on `date`?
  function due_(st, L, date) {
    var age = workingDaysBetween_(L.date, date);
    if (age < 1) return false;
    if (!L.doc || L.mvt === 'INIT') return true; // opening stock: first working day
    if (kindOf_(st, L.mvt) === 'DECL') {
      if (lagClass_(st.seed, L.doc) !== 'late') return true;
      if (age < 2) return false;
    }
    return hashFloat_(st.seed, 'release|' + L.doc + '|' + date) < P_RELEASE;
  }

  // ---------------------------------------------------------------------------------------------
  // One working day. o: { ppd, capacity, emrtTarget, edge, eCycle, facts }. Returns the new movement lines and
  // updates the state.
  // ---------------------------------------------------------------------------------------------
  function simulateDay_(st, date, o) {
    var seed = st.seed;
    var rng = rng_(seed, 'day|' + date);
    var edge = o.edge || null;
    var facts = o.facts || {};
    var texts = texts_();
    var truckCap = cfg_().TRUCK_CAPACITY || DEFAULT_TRUCK_CAPACITY;
    var scale = o.ppd / DEFAULTS.palletsPerDay;
    var out = [];
    var events = [];
    var seq = 0;
    var done = { pe312: false, pe312Last: null, r102Art: '' };

    function excluded_(art) {
      return !!(edge && edge.exclude && edge.exclude[art]);
    }

    function newDoc_() {
      st.docCounter += rng.int(1, 3);
      return String(st.docCounter);
    }

    function post_(art, mag, mvt, qtyM, doc, poste, user, s) {
      var info = st.info[art] || {};
      out.push({
        key: doc + '|' + poste,
        article: art,
        division: PLANT,
        magasin: mag,
        mvt: mvt,
        text: texts[mvt] || '',
        s: s || '',
        doc: doc,
        poste: String(poste),
        date: date,
        qty: qtyOut_(qtyM),
        uqs: info.uqs || '',
        designation: info.designation || '',
        user: user,
        source: SOURCE
      });
      apply_(st, art, mag, mvt, qtyM, doc, date);
    }

    // A transfer document: issuing leg (poste 1, negative) then receiving leg (poste 2, positive).
    function transfer_(art, from, to, mvt, qtyM, user, s) {
      var doc = newDoc_();
      post_(art, from, mvt, -qtyM, doc, 1, user, s);
      post_(art, to, mvt, qtyM, doc, 2, user, s);
      return doc;
    }

    // Time-ordered agenda (minutes after midnight, then insertion order).
    function at_(minute, type, data) {
      data.min = clamp_(Math.round(minute), 0, 1439);
      data.type = type;
      data.seq = seq++;
      var lo = 0, hi = events.length;
      while (lo < hi) {
        var mid = (lo + hi) >> 1, e = events[mid];
        if (e.min < data.min || (e.min === data.min && e.seq < data.seq)) lo = mid + 1;
        else hi = mid;
      }
      events.splice(lo, 0, data);
    }

    function splitPallets_(qtyM, q) {
      if (!(q > 0)) return [qtyM];
      var parts = [];
      while (qtyM > q) {
        parts.push(q);
        qtyM -= q;
      }
      parts.push(qtyM);
      return parts;
    }

    // A production run: lines spaced by a few minutes; the last one may be partial or stuck.
    function makeRun_(art, p, stuck, single) {
      var q = qppOf_(st, art), uqs = (st.info[art] || {}).uqs;
      var interval = rng.int(7, 16), start = rng.int(360, 1140);
      if (start + p * interval > 1380) {
        start = Math.max(360, 1380 - p * interval);
        if (start + p * interval > 1380) interval = Math.max(3, Math.floor((1380 - start) / p));
      }
      var t = start, remaining = p, lines = [];
      while (remaining > 0) {
        var free = remaining - (stuck ? 1 : 0);
        var line;
        if (!single && free >= 2 && rng.chance(0.10)) {
          var k = rng.int(2, Math.min(4, free));
          line = { art: art, min: t, units: repeat_(q, k), user: PLANIF, s: '', kind: 'multi' };
          remaining -= k;
          t += interval * k;
        } else {
          var partial = !single && !stuck && remaining === 1 && rng.chance(0.15);
          line = { art: art, min: t, units: [partial ? partialQty_(rng, q, uqs, 0.5, 0.9) : q],
            user: rng.chance(0.955) ? AUTO : PLANIF, s: '', kind: partial ? 'partial' : 'single' };
          remaining -= 1;
          t += interval;
        }
        lines.push(line);
      }
      if (stuck) lines[lines.length - 1].stuck = stuck;
      lines.forEach(function (l) { at_(Math.min(l.min, 1400), 'DECL', { line: l }); });
      return lines;
    }

    // --- 1. Pending PRD2 quantities of earlier days that are due: one-pallet transfers in the morning.
    // An article with a held (stuck) line is not produced, so FIFO never consumes the stuck layer.
    var morningPallets = 0;
    var blocked = {};
    Object.keys(st.prd2).sort().forEach(function (art) {
      st.prd2[art].forEach(function (L) {
        if (!(L.qty > 0) || st.holdDocs[L.doc]) return;
        if (heldOn_(st, art, L, date)) {
          blocked[art] = true;
          return;
        }
        if (!due_(st, L, date)) return;
        var user = rng.chance(0.85) ? AUTO : rng.pick(OPS);
        var t = rng.int(360, 720);
        splitPallets_(L.qty, qppOf_(st, art)).forEach(function (part) {
          at_(t, 'XPE', { art: art, qty: part, user: user, s: st.special[art] ? 'E' : '' });
          t += rng.int(1, 3);
          morningPallets++;
        });
      });
    });

    // --- 2. Production: T pallets over 9-13 articles (scaled), weighted by family share.
    var T = Math.max(1, Math.round(o.ppd * rng.uniform(0.9, 1.09)));
    var unknownP = edge && edge.unknownArt && edge.unknownPallets ? edge.unknownPallets : 0;
    var elig = st.regular.filter(function (a) { return !st.holdArts[a] && !blocked[a]; });
    var forced = edge && edge.stuckArt && elig.indexOf(edge.stuckArt) >= 0 ? [edge.stuckArt] : [];
    var runLasts = [];
    if (elig.length) {
      var nRuns = clamp_(Math.round(o.ppd / 6.4) + rng.int(-2, 2), 1, elig.length);
      nRuns = Math.max(nRuns, forced.length);
      var others = elig.filter(function (a) { return forced.indexOf(a) < 0; });
      var chosen = forced.concat(rng.sample(others, others.map(function (a) { return st.weight[a]; }), nRuns - forced.length));
      var tk = Math.max(chosen.length, T - unknownP);
      var alloc = allocate_(tk, chosen.map(function (a) { return st.weight[a] * rng.uniform(0.6, 1.4); }),
        tk >= 2 * chosen.length ? 2 : 1);
      chosen.forEach(function (a, i) {
        var stuck = forced.indexOf(a) >= 0 ? 'forced' : (stuckRun_(seed, a, date) ? 'held' : '');
        var lines = makeRun_(a, stuck === 'forced' ? Math.max(alloc[i], 4) : alloc[i], stuck, false);
        runLasts.push(lines[lines.length - 1]);
      });
    }
    if (unknownP) makeRun_(edge.unknownArt, unknownP, false, true);

    // Edge case: one automatic full pallet cancelled by a 102 a few minutes after its declaration.
    if (edge && edge.r102) {
      var r102Ok = function (l) {
        return l.kind === 'single' && !l.stuck && st.isRegular[l.art] && !st.holdArts[l.art] && !excluded_(l.art);
      };
      var cands = runLasts.filter(function (l) { return r102Ok(l) && l.user === AUTO && l.min >= 480; });
      if (!cands.length) cands = runLasts.filter(r102Ok);
      cands.sort(function (a, b) { return (a.min - b.min) || (a.art < b.art ? -1 : 1); });
      if (cands.length) {
        var c = rng.pick(cands);
        c.cancel = true;
        done.r102Art = c.art;
      }
    }

    // Special stock 'E' (sales-order stock): explicit lines in generate, a small cycle in nextDay.
    if (edge && edge.eArt && edge.eDecl) {
      var eq = qppOf_(st, edge.eArt);
      at_(600, 'DECL', { line: { art: edge.eArt, min: 600, units: [eq, eq], user: PLANIF, s: 'E', kind: 'multi' } });
      at_(690, 'XPE', { art: edge.eArt, qty: 2 * eq, user: 'OPEXP02', s: 'E' });
    }
    if (edge && edge.eArt && edge.eShip) at_(845, 'DLV_E', { art: edge.eArt, user: CHEF });
    if (o.eCycle) {
      Object.keys(st.special).sort().forEach(function (art) {
        var q = qppOf_(st, art);
        if (totOf_(st, art, 'EXP2') > 0) {
          if (rng.chance(0.3)) at_(rng.int(600, 1000), 'DLV_E', { art: art, user: CHEF });
        } else if (q > 0 && totOf_(st, art, 'PRD2') <= 0 && rng.chance(0.2)) {
          var k = rng.int(1, 3), t = rng.int(540, 900);
          at_(t, 'DECL', { line: { art: art, min: t, units: repeat_(q, k), user: PLANIF, s: 'E', kind: k > 1 ? 'multi' : 'single' } });
          at_(t + rng.int(60, 180), 'XPE', { art: art, qty: k * q, user: rng.pick(OPS), s: 'E' });
        }
      });
      // Stock of articles missing from ARTICLES eventually leaves EXP2 (one 601 line for the whole quantity).
      Object.keys(st.info).sort().forEach(function (art) {
        if (st.master[art] || st.special[art] || !(totOf_(st, art, 'EXP2') > 0)) return;
        if (rng.chance(P_ORPHAN_SHIP)) at_(rng.int(600, 1000), 'DLV_E', { art: art, user: CHEF, s: '' });
      });
    }

    // --- 3. EXP2 <-> EMRT (full pallets); EMRT is pulled back towards its opening level.
    var emrtPal = palletsIn_(st, 'EMRT');
    var drift = ((o.emrtTarget || 0) - emrtPal) / 10;
    var flowMax = Math.ceil(20 * scale);
    var xepTot = clamp_(Math.round(rng.int(6, 10) * scale + drift / 2), 0, flowMax);
    var xmeTot = clamp_(Math.round(rng.int(4, 8) * scale - drift / 2), 0, flowMax);
    if (edge && edge.ep312) xepTot = Math.max(1, xepTot);
    chunks_(rng, xepTot).forEach(function (k) { at_(rng.int(540, 1020), 'XEP', { k: k }); });
    chunks_(rng, xmeTot).forEach(function (k) { at_(rng.int(480, 960), 'XME', { k: k }); });
    if (edge && edge.ep312) {
      for (var e = 0; e < events.length; e++) {
        if (events[e].type === 'XEP') {
          events[e].reverse = true;
          break;
        }
      }
    }

    // --- 4. Shipments (601): expected inflow + a share of the gap to the target saturation.
    var exp2Pal = palletsIn_(st, 'EXP2');
    var target = o.capacity * targetSat_(seed, dayNum_(date));
    var inflow = morningPallets + LAG_SAME * T + xmeTot - xepTot;
    var P = Math.round(inflow + 0.15 * (exp2Pal - target) + rng.uniform(-4, 4) * scale);
    P = clamp_(P, Math.round(0.55 * T), Math.round(1.6 * T) + 10);
    var ks = [], s = 0;
    while (s < P) {
      var size = 1 + rng.index(DLV_SIZE_WEIGHTS);
      ks.push(size);
      s += size;
    }
    if (s > P) {
      ks[ks.length - 1] -= s - P;
      if (ks[ks.length - 1] <= 0) ks.pop();
    }
    var deliveries = [];
    for (var i = 0; i < ks.length;) {
      var grp = ks.slice(i, i + rng.pick([1, 2, 2, 3, 3, 4]));
      while (grp.length > 1 && sum_(grp) > truckCap) grp.pop();
      deliveries.push(grp);
      i += grp.length;
    }
    deliveries.forEach(function (grp, j) {
      var t = 420 + Math.floor(j * 840 / deliveries.length) + rng.int(0, 25);
      var specs = grp.map(function (k) { return { k: k, partial: rng.chance(0.2) }; });
      at_(t, 'DLV', { lines: specs, user: rng.pick([CHEF, CHEF].concat(OPS)) });
    });

    // --- Event handlers.
    var handlers = {
      DECL: function (ev) {
        var l = ev.line;
        var qty = sum_(l.units);
        var doc = newDoc_();
        post_(l.art, 'PRD2', '101', qty, doc, 1, l.user, l.s);
        if (l.stuck) {
          if (l.stuck === 'forced') {
            st.holdDocs[doc] = true;
            st.holdArts[l.art] = true;
            (facts.stuckDocs || (facts.stuckDocs = [])).push(doc);
          } else {
            (facts.heldDocs || (facts.heldDocs = [])).push(doc);
          }
          return;
        }
        if (l.cancel) {
          at_(ev.min + rng.int(3, 8), 'R102', { art: l.art, qty: qty, cancels: doc });
          return;
        }
        if (l.s === 'E' || lagClass_(seed, doc) !== 'same') return;
        var t = ev.min + rng.int(10, 150);
        if (t > 1430) return; // too late in the day: transferred tomorrow morning
        var user = rng.chance(0.85) ? AUTO : rng.pick(OPS);
        l.units.forEach(function (q) {
          at_(Math.min(t, 1438), 'XPE', { art: l.art, qty: q, user: user, s: '' });
          t += rng.int(1, 3);
        });
      },
      R102: function (ev) {
        var q = Math.min(ev.qty, totOf_(st, ev.art, 'PRD2'));
        if (q <= 0) return;
        var doc = newDoc_();
        post_(ev.art, 'PRD2', '102', -q, doc, 1, PLANIF, '');
        facts.reversal102 = { doc: doc, cancels: ev.cancels, article: ev.art, date: date };
      },
      XPE: function (ev) {
        var q = Math.min(ev.qty, totOf_(st, ev.art, 'PRD2'));
        if (q <= 0) return;
        var doc = transfer_(ev.art, 'PRD2', 'EXP2', '311', q, ev.user, ev.s);
        if (edge && edge.pe312 && !done.pe312 && st.isRegular[ev.art] && !st.holdArts[ev.art] && !blocked[ev.art] &&
            !excluded_(ev.art) && !stuckRun_(seed, ev.art, date) && ev.art !== done.r102Art && q === qppOf_(st, ev.art)) {
          done.pe312Last = { art: ev.art, qty: q, doc: doc };
          if (ev.min >= edge.pe312.after && ev.min <= 1380) reversePe_(done.pe312Last);
        }
      },
      XEP: function (ev) {
        var k = ev.k, cands = [];
        while (k >= 1) {
          cands = st.regular.filter(function (a) { return totOf_(st, a, 'EXP2') >= k * qppOf_(st, a); });
          if (cands.length) break;
          k--;
        }
        if (k < 1) return;
        var art = rng.weighted(cands, cands.map(function (a) {
          var p = totOf_(st, a, 'EXP2') / qppOf_(st, a);
          return p * p;
        }));
        var m = k * qppOf_(st, art);
        var doc = transfer_(art, 'EXP2', 'EMRT', '311', m, rng.pick(OPS.concat([CHEF])), '');
        if (ev.reverse) {
          var doc2 = transfer_(art, 'EMRT', 'EXP2', '312', m, CHEF, '');
          (facts.reversals312 || (facts.reversals312 = [])).push({ doc: doc2, cancels: doc, article: art, date: date,
            flow: 'EXP2 -> EMRT' });
        }
      },
      XME: function (ev) {
        var cands = st.regular.filter(function (a) { return totOf_(st, a, 'EMRT') >= qppOf_(st, a); });
        if (!cands.length) return;
        var art = rng.weighted(cands, cands.map(function (a) { return totOf_(st, a, 'EMRT') / qppOf_(st, a); }));
        var q = qppOf_(st, art);
        var k = Math.min(ev.k, Math.floor(totOf_(st, art, 'EMRT') / q));
        transfer_(art, 'EMRT', 'EXP2', '311', k * q, rng.pick(OPS.concat([CHEF])), '');
      },
      DLV: function (ev) {
        var doc = '', poste = 0, used = {};
        ev.lines.forEach(function (spec) {
          var cands = st.regular.filter(function (a) { return !used[a] && totOf_(st, a, 'EXP2') * 2 >= qppOf_(st, a); });
          if (!cands.length) return;
          var art = rng.weighted(cands, cands.map(function (a) { return totOf_(st, a, 'EXP2') / qppOf_(st, a); }));
          used[art] = true;
          var q = qppOf_(st, art);
          var want = spec.partial ? (spec.k - 1) * q + partialQty_(rng, q, st.info[art].uqs, 0.3, 0.9) : spec.k * q;
          var m = Math.min(want, totOf_(st, art, 'EXP2'));
          if (m <= 0) return;
          if (!doc) doc = newDoc_();
          poste++;
          post_(art, 'EXP2', '601', -m, doc, poste, ev.user, '');
        });
      },
      DLV_E: function (ev) {
        var q = qppOf_(st, ev.art), have = totOf_(st, ev.art, 'EXP2');
        var m = q > 0 ? Math.min(q, have) : have;
        if (m <= 0) return;
        post_(ev.art, 'EXP2', '601', -m, newDoc_(), 1, ev.user, ev.s === undefined ? 'E' : ev.s);
      }
    };

    // Edge case: a PRD2 -> EXP2 transfer cancelled by a 312, the pallet goes back to PRD2 (pending again).
    function reversePe_(x) {
      if (done.pe312 || totOf_(st, x.art, 'EXP2') < x.qty) return;
      done.pe312 = true;
      var doc2 = transfer_(x.art, 'EXP2', 'PRD2', '312', x.qty, 'OPEXP01', '');
      (facts.reversals312 || (facts.reversals312 = [])).push({ doc: doc2, cancels: x.doc, article: x.art, date: date,
        flow: 'PRD2 -> EXP2' });
    }

    // --- 5. Run the day in time order: Doc.article numbers follow the posting order.
    while (events.length) {
      var ev = events.shift();
      handlers[ev.type](ev);
    }
    if (edge && edge.pe312 && !done.pe312 && done.pe312Last) reversePe_(done.pe312Last);
    return out;
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
  function normParams_(params) {
    params = params || {};
    var days = intParam_(params.days, LIMITS.days, DEFAULTS.days);
    var start = iso_(params.startDate);
    if (!start) {
      var end = iso_(params.endDate);
      if (end) {
        var n = dayNum_(lastWorkingDayOnOrBefore_(end));
        for (var k = 1; k < days; k++) {
          n--;
          while (weekdayOfNum_(n) === 0) n--;
        }
        start = isoOfDay_(n);
      } else {
        start = DEFAULTS.startDate;
      }
    }
    return {
      seed: seed_(params.seed),
      startDate: firstWorkingDay_(start),
      days: days,
      palletsPerDay: intParam_(params.palletsPerDay, LIMITS.palletsPerDay, DEFAULTS.palletsPerDay),
      articles: intParam_(params.articles, LIMITS.articles, DEFAULTS.articles),
      edgeCases: boolParam_(params.edgeCases, DEFAULTS.edgeCases)
    };
  }

  // 40 references by default: 35 PC (33 regular + the special-stock one + the one missing from ARTICLES) and
  // 5 KG. Without edge cases the last two are regular articles.
  function buildArticles_(rng, count, edgeCases) {
    var nSpecial = edgeCases ? 2 : 0;
    var nKg = count >= 20 ? KG_NAMES.length : Math.max(1, Math.round(count / 8));
    var pcNames = PC_NAMES.concat(edgeCases ? [] : [E_NAME, UNKNOWN_NAME]);
    var nPc = Math.min(pcNames.length, count - nKg - nSpecial);
    var seen = {}, ids = [];
    while (ids.length < nPc + nKg + nSpecial) {
      var id = '1000' + rng.int(100000, 999999);
      if (!seen[id]) {
        seen[id] = true;
        ids.push(id);
      }
    }
    ids.sort();
    rng.shuffle(ids);
    var famCounts = allocate_(nPc, PC_FAMILY_WEIGHTS.map(function (f) { return f[1]; }), nPc >= 5 ? 1 : 0);
    var pcFams = [];
    PC_FAMILY_WEIGHTS.forEach(function (f, i) {
      for (var k = 0; k < famCounts[i]; k++) pcFams.push(f[0]);
    });
    rng.shuffle(pcFams);
    var arts = [], i;
    for (i = 0; i < nPc; i++) {
      arts.push({ id: ids[i], designation: pcNames[i], uqs: 'PC', qpp: rng.pick(PC_QPP), family: pcFams[i], role: 'regular' });
    }
    for (i = 0; i < nKg; i++) {
      arts.push({ id: ids[nPc + i], designation: KG_NAMES[i], uqs: 'KG', qpp: rng.pick(KG_QPP), family: KG_FAMILIES[i],
        role: 'regular' });
    }
    if (edgeCases) {
      arts.push({ id: ids[nPc + nKg], designation: E_NAME, uqs: 'PC', qpp: rng.pick(E_QPP), family: 'F2', role: 'E' });
      arts.push({ id: ids[nPc + nKg + 1], designation: UNKNOWN_NAME, uqs: 'PC', qpp: UNKNOWN_QPP, family: '', role: 'unknown' });
    }
    arts.forEach(function (a) {
      if (a.uqs === 'KG') {
        a.palletType = 'ISO 1200x1000';
        a.heightCm = 110 + 5 * rng.int(0, 10);
        a.levels = rng.pick([1, 2]);
      } else {
        a.palletType = rng.chance(0.15) ? 'ISO 1200x1000' : 'EUR 1200x800';
        a.heightCm = 90 + 5 * rng.int(0, 18);
        a.levels = a.heightCm <= 110 ? 3 : (a.heightCm <= 150 ? 2 : 1);
      }
    });
    return arts;
  }

  // Opening stock (one row per article and magasin): EXP2 ~60 % of the places, EMRT ~350 pallets on ~80 % of
  // the articles (full pallets), PRD2 ~0.3 day of production on 7 articles (one partial pallet).
  function buildOpening_(rng, st, regular, capacity, ppd) {
    var qty = { PRD2: {}, EXP2: {}, EMRT: {} };
    var w = function (a) { return st.weight[a]; };
    var exp2Total = Math.round(capacity * rng.uniform(0.58, 0.63));
    var pals = allocate_(exp2Total, regular.map(function (a) { return w(a) * rng.uniform(0.7, 1.3); }),
      Math.min(3, Math.floor(exp2Total / regular.length)));
    regular.forEach(function (a, i) {
      var q = qppOf_(st, a), p = pals[i];
      if (p <= 0) return;
      var m = p * q;
      if (rng.chance(0.35)) m = (p - 1) * q + partialQty_(rng, q, st.info[a].uqs, 0.2, 0.9);
      qty.EXP2[a] = m;
    });
    var emrtArts = rng.sample(regular, regular.map(w), Math.round(regular.length * 26 / 33)).sort();
    var emrtPals = allocate_(rng.int(330, 370), emrtArts.map(function (a) { return w(a) * rng.uniform(0.7, 1.3); }), 3);
    emrtArts.forEach(function (a, i) {
      if (emrtPals[i] > 0) qty.EMRT[a] = emrtPals[i] * qppOf_(st, a);
    });
    var prdArts = rng.sample(regular, regular.map(w), Math.min(7, regular.length)).sort();
    var prdPals = allocate_(Math.max(prdArts.length, Math.round(ppd * rng.uniform(0.24, 0.31))), repeat_(1, prdArts.length), 1);
    var partialDone = false;
    prdArts.forEach(function (a, i) {
      var q = qppOf_(st, a), p = prdPals[i];
      var m = p * q;
      if (!partialDone && p >= 2) {
        m = (p - 1) * q + partialQty_(rng, q, st.info[a].uqs, 0.5, 0.9);
        partialDone = true;
      }
      qty.PRD2[a] = m;
    });
    return qty;
  }

  function generate(params) {
    var p = normParams_(params);
    var seed = p.seed;
    var rng = rng_(seed, 'master');
    var capacity = capacity_(params);

    // Calendar.
    var days = [p.startDate];
    while (days.length < p.days) days.push(nextWorkingDay(days[days.length - 1]));
    var openDate = addDays_(days[0], -1);
    var asOf = days[days.length - 1];

    // Articles.
    var defs = buildArticles_(rng, p.articles, p.edgeCases);
    var st = newState_(seed, (params && params.mvtKinds) || null);
    var regular = [], eArt = '', unknownArt = '';
    defs.forEach(function (a) {
      setInfo_(st, a.id, a.designation, a.uqs);
      if (a.role === 'unknown') {
        unknownArt = a.id;
        st.hiddenQpp[a.id] = a.qpp * 1000;
        return;
      }
      st.master[a.id] = { qppM: a.qpp * 1000, uqs: a.uqs, designation: a.designation, family: a.family };
      if (a.role === 'E') {
        eArt = a.id;
        st.special[a.id] = true;
      } else {
        regular.push(a.id);
      }
    });
    setRegular_(st, regular);
    var articles = defs.filter(function (a) { return a.role !== 'unknown'; }).map(function (a) {
      return { article: a.id, designation: a.designation, uqs: a.uqs, qpp: a.qpp, palletType: a.palletType,
        heightCm: a.heightCm, levels: a.levels, family: a.family };
    }).sort(function (a, b) { return a.article < b.article ? -1 : (a.article > b.article ? 1 : 0); });

    // Opening stock.
    var openQty = buildOpening_(rng, st, st.regular, capacity, p.palletsPerDay);
    var opening = [];
    st.regular.forEach(function (a) {
      ['PRD2', 'EXP2', 'EMRT'].forEach(function (mag) {
        var m = openQty[mag][a];
        if (!(m > 0)) return;
        opening.push({ article: a, division: PLANT, magasin: mag, qty: qtyOut_(m), uqs: st.info[a].uqs,
          designation: st.info[a].designation, date: openDate });
        apply_(st, a, mag, 'INIT', m, '', openDate);
      });
    });
    var emrtTarget = palletsIn_(st, 'EMRT');
    st.docCounter = 4901000000 + rng.int(0, 899999);

    // Edge cases, placed relative to the end of the period like the sample (n = 12: days 2, 3, 4, 7-10).
    var n = days.length, plan = {};
    var facts = { unknownArticle: unknownArt, specialArticle: eArt, stuckDocs: [], heldDocs: [], reversals312: [] };
    if (p.edgeCases) {
      var dayPlan = function (d) { return plan[d] || (plan[d] = {}); };
      var exclude = {};
      exclude[eArt] = true;
      exclude[unknownArt] = true;
      // Stuck lines: declared at least 3 working days before as-of, on 4 distinct days when the period allows.
      var stuckDays = [];
      [3, 4, n - 5, n - 4].forEach(function (d) {
        d = Math.min(d, n - 4);
        if (d >= 0 && stuckDays.indexOf(d) < 0) stuckDays.push(d);
      });
      for (var sd = n - 4; sd >= 0 && stuckDays.length < 4; sd--) if (stuckDays.indexOf(sd) < 0) stuckDays.push(sd);
      var pcRegular = st.regular.filter(function (a) { return st.master[a].uqs === 'PC'; });
      var stuckArts = rng.sample(pcRegular, repeat_(1, pcRegular.length), stuckDays.length);
      stuckDays.forEach(function (d, i) {
        if (!stuckArts[i]) return;
        dayPlan(d).stuckArt = stuckArts[i];
        exclude[stuckArts[i]] = true;
      });
      dayPlan(Math.min(2, n - 1)).r102 = true;
      [n - 5, n - 4, n - 3, n - 2].forEach(function (d) {
        if (d >= 0 && !(plan[d] && plan[d].unknownPallets)) dayPlan(d).unknownPallets = rng.int(3, 4);
      });
      var eDay = Math.max(0, n - 3);
      dayPlan(eDay).eDecl = true;
      if (eDay + 1 < n) dayPlan(eDay + 1).eShip = true;
      dayPlan(Math.max(0, n - 2)).pe312 = { after: rng.int(480, 780) };
      dayPlan(Math.min(n - 1, Math.round(n * 0.6))).ep312 = true;
      Object.keys(plan).forEach(function (d) {
        plan[d].exclude = exclude;
        plan[d].eArt = eArt;
        plan[d].unknownArt = unknownArt;
      });
    }

    // Days.
    var movements = [];
    days.forEach(function (date, di) {
      var lines = simulateDay_(st, date, { ppd: p.palletsPerDay, capacity: capacity, emrtTarget: emrtTarget,
        edge: plan[di] || null, eCycle: false, facts: facts });
      for (var i = 0; i < lines.length; i++) movements.push(lines[i]);
    });

    return {
      movements: movements,
      opening: opening,
      articles: articles,
      docks: makeDocks(seed, asOf),
      asOf: asOf,
      openingDate: openDate,
      params: { seed: seed, startDate: p.startDate, days: p.days, palletsPerDay: p.palletsPerDay, articles: p.articles,
        edgeCases: p.edgeCases, capacity: capacity },
      facts: facts
    };
  }

  // ---------------------------------------------------------------------------------------------
  // nextDay: rebuild the stock state from opening + movements (engine order), then simulate the next working day.
  // ---------------------------------------------------------------------------------------------
  function estimatePpd_(st, lines) {
    var byDate = {}, dates = [];
    lines.forEach(function (l) {
      if (l.kind !== 'DECL' && l.kind !== 'DECL_REV') return;
      var q = qppOf_(st, l.art);
      var pal = q ? ceilDiv_(Math.abs(l.qty), q) : 1;
      if (!has_(byDate, l.date)) {
        byDate[l.date] = 0;
        dates.push(l.date);
      }
      byDate[l.date] += l.kind === 'DECL' ? pal : -pal;
    });
    if (!dates.length) return DEFAULTS.palletsPerDay;
    dates.sort();
    dates = dates.slice(-20);
    var total = 0;
    dates.forEach(function (d) { total += byDate[d]; });
    // Rounded to 5 pallets so that repeated calls do not drift.
    return clamp_(Math.round(total / dates.length / 5) * 5, LIMITS.palletsPerDay[0], LIMITS.palletsPerDay[1]);
  }

  function nextDay(params) {
    params = params || {};
    var seed = seed_(params.seed);
    var C = cfg_();
    var plant = str_(C.PLANT || PLANT);
    var st = newState_(seed, params.mvtKinds || null);

    // Master data.
    (params.articles || []).forEach(function (a) {
      var id = article_(a && a.article);
      if (!id || st.master[id]) return;
      var qpp = num_(a.qpp);
      setInfo_(st, id, str_(a.designation), str_(a.uqs));
      if (qpp > 0) st.master[id] = { qppM: Math.round(qpp * 1000), uqs: str_(a.uqs), designation: str_(a.designation),
        family: str_(a.family) };
    });

    // Opening stock.
    var openDate = '';
    var openRows = [];
    (params.opening || []).forEach(function (o) {
      var art = article_(o && o.article), mag = str_(o && o.magasin).toUpperCase(), q = milli_(o && o.qty);
      if (!art || !mag || !(q > 0)) return;
      var d = iso_(o.date);
      if (d && (!openDate || d < openDate)) openDate = d;
      setInfo_(st, art, str_(o.designation), str_(o.uqs));
      openRows.push({ art: art, mag: mag, qty: q, date: d });
    });
    openRows.forEach(function (r) { apply_(st, r.art, r.mag, 'INIT', r.qty, '', r.date || openDate); });
    var emrtTarget = palletsIn_(st, 'EMRT');

    // Movements, in the engine's order: date, Doc.article, issuing line first, file order.
    var lines = [], maxDoc = 0, lastDate = '';
    (params.movements || []).forEach(function (m, i) {
      if (!m) return;
      var doc = str_(m.doc), date = iso_(m.date);
      if (SIM_DOC_RE.test(doc) && Number(doc) > maxDoc) maxDoc = Number(doc);
      var art = article_(m.article), mag = str_(m.magasin).toUpperCase(), mvt = str_(m.mvt), q = milli_(m.qty);
      if (!art || !mag || !date || isNaN(q) || q === 0) return;
      var div = str_(m.division);
      if (plant && div && div !== plant) return;
      var kind = kindOf_(st, mvt);
      if (!kind || kind === 'IGNORE') return;
      if (openDate && date < openDate) return;
      if (date > lastDate) lastDate = date;
      setInfo_(st, art, str_(m.designation), str_(m.uqs));
      if (str_(m.s).toUpperCase() === 'E') st.special[art] = true;
      lines.push({ i: i, art: art, mag: mag, mvt: mvt, kind: kind, doc: doc, date: date, qty: q });
    });
    lines.sort(function (a, b) {
      return (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)) || (a.doc < b.doc ? -1 : (a.doc > b.doc ? 1 : 0)) ||
        ((a.qty < 0 ? 0 : 1) - (b.qty < 0 ? 0 : 1)) || (a.i - b.i);
    });
    lines.forEach(function (l) { apply_(st, l.art, l.mag, l.mvt, l.qty, l.doc, l.date); });

    setRegular_(st, Object.keys(st.master).filter(function (a) { return !st.special[a]; }));
    var base = lastDate;
    var given = iso_(params.asOf);
    if (given && given > base) base = given;
    if (!base) base = openDate;
    if (!base) throw new Error('Simulation +1 jour impossible : aucun mouvement ni stock initial. Lancez d\'abord une simulation.');
    if (!st.regular.length) throw new Error('Simulation +1 jour impossible : aucun article avec une quantité par palette.');
    var date = nextWorkingDay(base);
    st.docCounter = maxDoc || (4901000000 + Math.floor(hashFloat_(seed, 'doc') * 900000));

    var ppdGiven = Number(params.palletsPerDay);
    var ppd = ppdGiven > 0 ? intParam_(ppdGiven, LIMITS.palletsPerDay, DEFAULTS.palletsPerDay) : estimatePpd_(st, lines);
    var movements = simulateDay_(st, date, { ppd: ppd, capacity: capacity_(params), emrtTarget: emrtTarget, edge: null,
      eCycle: true, facts: {} });
    return { movements: movements, docks: makeDocks(seed, date), asOf: date };
  }

  return {
    DEFAULTS: DEFAULTS,
    generate: generate,
    nextDay: nextDay,
    makeDocks: makeDocks,
    nextWorkingDay: nextWorkingDay,
    isWorkingDay: isWorkingDay
  };
}

var Sim = SimulationModule_();
