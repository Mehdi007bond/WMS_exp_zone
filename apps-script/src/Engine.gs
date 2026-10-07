/**
 * EXP2 Digital Twin - calculation engine.
 *
 * Pure JavaScript, no Google services. The same source runs in Apps Script (var Engine = EngineModule_()),
 * in the browser (the template injects EngineModule_.toString()) and in the Node tests
 * (tests/engine.test.js reproduces every CALC_* tab of sample-data/csv and the real-format fixture).
 *
 *   Engine.compute(input)             -> result (result.state = compact JSON for the screens)
 *   Engine.toTables(result)           -> { CALC_STOCK: [headers, ...rows], CALC_EN_ATTENTE, ..., CALC_KPI }
 *   Engine.lookup(result, article)    -> { article, project, stock, fifo, pending, exits, locations }
 *   Engine.lookupAll(result)          -> { article: lookup(result, article) } for every article, in one pass
 *   Engine.buildState(result, extras) -> compact state (docs/ARCHITECTURE.md section 8, docs/SPEC_V2.md 4.9)
 *
 * input (dates as 'yyyy-mm-dd'): { asOf, plant, movements, opening, articles, projects, blocks, rules, mvtKinds,
 *   docks, thresholds } as in docs/ARCHITECTURE.md section 4 and docs/SPEC_V2.md 4.1, plus optional state extras:
 *   layout (CFG.DEFAULT_LAYOUT shape), version, computedAt, importedAt, source ('SIMULATION' | 'SAP'), openingDate.
 *   Movements may carry ts ('yyyy-mm-dd hh:mm:ss', SAP entry date + time) and label (container number): without
 *   them (v1 data) every v1 figure is unchanged.
 *
 * Quantities are handled in milli-units (integers) and times in whole seconds, so FIFO arithmetic and hours stay
 * exact. Tables write dates as 'dd.mm.yyyy', times as 'dd.mm.yyyy hh:mm:ss' strings and blank cells as ''.
 */
function EngineModule_() {
  var MAGS = ['PRD2', 'EXP2', 'EMRT'];
  var TO_PLACE_ID = 'À PLACER';
  var TO_PLACE_LABEL = 'Hors capacité des blocs (placeholder)';
  var ORIGIN_OPENING = 'Stock initial';
  var NO_FAMILY = 'Sans famille';
  var NO_PROJECT = 'Sans projet';
  var QPP_ARTICLES = 'ARTICLES';
  var QPP_LABELS = 'ÉTIQUETTES';
  // Pending level as written in CALC_EN_ATTENTE › Niveau (the result and the state keep 'crit' / 'warn').
  var LEVEL_TEXT = { crit: 'alerte', warn: 'pré-alerte' };
  var DAY_MS = 86400000;
  var DAY_S = 86400;
  var MAX_LISTED_ALERTS = 20;
  var MAX_SINGLE_QPP_ALERTS = 5;       // above: one grouped alert per code
  var MAX_GROUPED_CODES = 10;          // article codes quoted in a grouped alert
  var MAX_STATE_PENDING = 500;         // pending rows in the state (oldest first); kpi carries the totals
  var EXTRA_FAMILY_COLORS = ['#d9d2f0', '#f6d8bd', '#cfe0f5', '#e2e2e2', '#f3e3a6', '#cbe9dc', '#f2cfcf', '#dfe8c4'];
  // Copies of CFG.COLORS.projects / noProject and CFG.AUTO_USERS for the browser copy injected without Config.
  var PROJECT_COLORS = ['#7fb3e0', '#f2b27a', '#8fd19e', '#e79ac0', '#c3a6e8', '#f3d36b', '#7fd1cf', '#e8a39a',
    '#b4c77a', '#a9b8d6', '#d9b48f', '#9fd4f0'];
  var NO_PROJECT_COLOR = '#c9ced6';
  var AUTO_USERS = ['BARFLOW_TA11', 'ADMINJOB'];
  var DEFAULT_THRESHOLDS = { satWarn: 0.85, satCrit: 0.95, pendingDaysWarn: 3, dockStagingWarn: 0.85,
    pendingHoursWarn: 4, pendingHoursCrit: 6, labelIsPallet: 1, trackAll: 0 };
  // Placement rule order at equal priority (docs/SPEC_V2.md 4.7).
  var RULE_RANK = { ARTICLE: 0, PROJET: 1, FAMILLE: 2 };
  var TS_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
  var TS_FR_RE = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;
  var ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  var dayCache = {};                   // 'yyyy-mm-dd' -> day number (a few hundred dates)

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

  function isDate_(v) {
    return Object.prototype.toString.call(v) === '[object Date]';
  }

  function has_(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function assign_(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (has_(src, k) && src[k] !== undefined && src[k] !== null && src[k] !== '') target[k] = src[k];
    }
    return target;
  }

  // Number from a number or a French / SAP formatted string ('1.234,5', '729,25', '320-'). NaN when empty.
  function num_(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var s = str_(v).replace(/[\s  ]/g, '');
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

  function numOrNull_(v) {
    var n = num_(v);
    return isNaN(n) ? null : n;
  }

  // Setting switch (1 / 0, true / false) with a default when empty or unreadable.
  function flag_(v, def) {
    if (v === true || v === false) return v;
    var n = num_(v);
    return isNaN(n) ? def : n > 0;
  }

  function milli_(v) {
    var n = num_(v);
    return isNaN(n) ? NaN : Math.round(n * 1000);
  }

  // Numeric articles lose their leading zeros (same rule as the import normaliser).
  function article_(v) {
    var s = str_(v);
    if (/^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
    return s;
  }

  function iso_(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string' && v.length === 10 && ISO_DAY_RE.test(v)) return v;
    if (isDate_(v)) {
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

  // Entry time 'yyyy-mm-dd hh:mm:ss' (SAP wall clock, never converted between time zones) from the stored text,
  // or from a Date (its local fields); '' when unknown or unreadable.
  function ts_(v) {
    if (v === null || v === undefined || v === '') return '';
    if (isDate_(v)) {
      if (isNaN(v.getTime())) return '';
      return iso_(v) + ' ' + pad2_(v.getHours()) + ':' + pad2_(v.getMinutes()) + ':' + pad2_(v.getSeconds());
    }
    var text = typeof v === 'string' ? v : str_(v);
    var m = TS_RE.exec(text), isoForm = !!m;
    if (!m) {
      text = text.trim();
      m = TS_RE.exec(text);
      isoForm = !!m;
      var fr = m ? null : TS_FR_RE.exec(text);
      if (fr) m = [fr[0], fr[3], fr[2], fr[1], fr[4], fr[5], fr[6]];
      if (!m) return '';
    }
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] || 0);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return '';
    if (d > 28 && new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return '';
    // Already canonical (the stored format): returned as is.
    if (isoForm && text.length === 19 && m[0].length === 19 && text.charAt(10) === ' ') return text;
    return m[1] + '-' + pad2_(mo) + '-' + pad2_(d) + ' ' + pad2_(h) + ':' + pad2_(mi) + ':' + pad2_(s);
  }

  // Seconds of a ts on a continuous scale (the wall clock read as UTC: only differences are used); null for ''.
  function tsSec_(ts) {
    if (!ts) return null;
    return dayNum_(ts) * DAY_S + Number(ts.slice(11, 13)) * 3600 + Number(ts.slice(14, 16)) * 60 + Number(ts.slice(17, 19));
  }

  function dayNum_(iso) {
    var key = iso.length === 10 ? iso : iso.slice(0, 10);
    var n = dayCache[key];
    if (n === undefined) {
      n = Math.round(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / DAY_MS);
      dayCache[key] = n;
    }
    return n;
  }

  function isoOfDay_(n) {
    var d = new Date(n * DAY_MS);
    return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
  }

  function addDays_(iso, n) {
    return isoOfDay_(dayNum_(iso) + n);
  }

  function daysBetween_(from, to) {
    return dayNum_(to) - dayNum_(from);
  }

  function fmtDate_(iso) {
    return iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';
  }

  // 'dd.mm.yyyy hh:mm:ss' for the sheet tables ('' when unknown).
  function fmtTs_(ts) {
    return ts ? fmtDate_(ts) + ts.slice(10) : '';
  }

  // Duration for alert texts: '8 h 12' (hours and minutes, truncated).
  function fmtHm_(sec) {
    sec = Math.max(0, sec || 0);
    return Math.floor(sec / 3600) + ' h ' + pad2_(Math.floor((sec % 3600) / 60));
  }

  // 'HH:mm' from a Sheets time cell (Date) or the text as typed.
  function time_(v) {
    if (isDate_(v)) return isNaN(v.getTime()) ? '' : pad2_(v.getHours()) + ':' + pad2_(v.getMinutes());
    return str_(v);
  }

  function ceilDiv_(a, b) {
    return Math.floor((a + b - 1) / b);
  }

  // Half-up rounding of the exact ratio num / den (integers, den > 0) to dec decimals; null when den <= 0.
  function ratio_(num, den, dec) {
    if (!(den > 0)) return null;
    var f = Math.pow(10, dec);
    var sign = num < 0 ? -1 : 1;
    return sign * Math.floor((2 * f * Math.abs(num) + den) / (2 * den)) / f;
  }

  // Hours (2 decimals, half-up) of a whole number of seconds; null when unknown.
  function hours_(sec) {
    return sec === null || sec === undefined ? null : ratio_(sec, 3600, 2);
  }

  function round_(x, dec) {
    var f = Math.pow(10, dec);
    return Math.round(x * f) / f;
  }

  function cmp_(a, b) {
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  // Natural order for ids such as B2 < B10.
  function natCmp_(a, b) {
    var re = /(\d+)|(\D+)/g;
    var ax = String(a).match(re) || [];
    var bx = String(b).match(re) || [];
    for (var i = 0; i < Math.min(ax.length, bx.length); i++) {
      var x = ax[i], y = bx[i];
      if (x === y) continue;
      if (/^\d/.test(x) && /^\d/.test(y) && Number(x) !== Number(y)) return Number(x) - Number(y);
      return x < y ? -1 : 1;
    }
    return ax.length - bx.length;
  }

  // Project names: case-insensitive order, then as written (deterministic, no locale).
  function nameCmp_(a, b) {
    return cmp_(a.toLowerCase(), b.toLowerCase()) || cmp_(a, b);
  }

  function blank_(v) {
    return v === null || v === undefined || (typeof v === 'number' && isNaN(v)) ? '' : v;
  }

  // French number for alert texts: 1 464 · 67,9
  function frNum_(x, dec) {
    var s = round_(x, dec || 0).toFixed(dec || 0);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return parts.join(',');
  }

  // Setting value as written: 6 · 4,5
  function frSetting_(x) {
    return frNum_(x, x === Math.round(x) ? 0 : (round_(x, 1) === x ? 1 : 2));
  }

  function frPct_(fraction) {
    var p = round_(fraction * 100, 1);
    return frNum_(p, p === Math.round(p) ? 0 : 1) + '\u00a0%';
  }

  function plural_(n, one, many) {
    return n + ' ' + (n > 1 ? many : one);
  }

  // Median (mean of the two middle values when even) and P90 (nearest rank: sorted[ceil(0.9 n) - 1]) of whole
  // seconds, in hours with 2 decimals; nulls when there is no value (docs/SPEC_V2.md 4.6).
  function dwellStats_(secs) {
    var n = secs.length;
    if (!n) return { count: 0, medianH: null, p90H: null };
    var s = secs.slice().sort(function (a, b) { return a - b; });
    var h = n >> 1;
    var median = n % 2 ? ratio_(s[h], 3600, 2) : ratio_(s[h - 1] + s[h], 7200, 2);
    return { count: n, medianH: median, p90H: ratio_(s[Math.ceil(0.9 * n) - 1], 3600, 2) };
  }

  // ---------------------------------------------------------------------------------------------
  // Pallet attribution of ONE bucket (article, magasin).
  // qtys: remaining quantities of the bucket's layers, oldest first (milli-units, > 0); qppM: qty per pallet.
  // The bucket holds ceil(Q / qpp) pallets with one partial pallet, the oldest. Walking the layers oldest
  // first, the first pallet takes Q mod qpp units (when > 0), every following pallet qpp units; each pallet
  // belongs to the layer holding its oldest unit (a layer may get 0 pallets).
  // ---------------------------------------------------------------------------------------------
  function layerPallets(qtys, qppM) {
    var out = [], total = 0, i;
    for (i = 0; i < qtys.length; i++) total += qtys[i];
    var n = total > 0 && qppM > 0 ? ceilDiv_(total, qppM) : 0;
    if (!n) {
      for (i = 0; i < qtys.length; i++) out.push(0);
      return out;
    }
    var first = total % qppM || qppM; // offset of pallet 1; pallet 0 starts at offset 0
    var c = 0, k = 0;
    for (i = 0; i < qtys.length; i++) {
      var end = c + qtys[i], cnt = 0;
      while (k < n && (k === 0 ? 0 : first + (k - 1) * qppM) < end) {
        cnt++;
        k++;
      }
      out.push(cnt);
      c = end;
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Input normalisation
  // ---------------------------------------------------------------------------------------------
  function normArticles_(rows) {
    var master = new Map();
    (rows || []).forEach(function (a) {
      var id = article_(a && a.article);
      if (!id || master.has(id)) return;
      var qpp = num_(a.qpp);
      var qppM = qpp > 0 ? Math.round(qpp * 1000) : 0;
      master.set(id, {
        article: id,
        designation: str_(a.designation),
        uqs: str_(a.uqs),
        qpp: qppM > 0 ? qpp : null,
        qppM: qppM,
        family: str_(a.family),
        project: str_(a.project),
        palletType: str_(a.palletType),
        heightCm: numOrNull_(a.heightCm),
        levels: numOrNull_(a.levels)
      });
    });
    return master;
  }

  function normBlocks_(rows) {
    var seen = {};
    return (rows || []).map(function (b) {
      var cols = num_(b.cols), rws = num_(b.rows), levels = num_(b.levels), cap = num_(b.capacity);
      if (!(cap >= 0)) cap = cols > 0 && rws > 0 && levels > 0 ? cols * rws * levels : 0;
      return {
        id: str_(b.id),
        label: str_(b.label),
        x: numOrNull_(b.x),
        y: numOrNull_(b.y),
        w: numOrNull_(b.w),
        h: numOrNull_(b.h),
        cols: isNaN(cols) ? null : cols,
        rows: isNaN(rws) ? null : rws,
        levels: isNaN(levels) ? null : levels,
        color: str_(b.color),
        capacity: Math.round(cap)
      };
    }).filter(function (b) {
      if (!b.id || seen[b.id]) return false;
      seen[b.id] = true;
      return true;
    }).sort(function (a, b) {
      return natCmp_(a.id, b.id);
    });
  }

  function blockList_(v) {
    var list = Array.isArray(v) ? v : str_(v).split(/[,;\s]+/);
    var out = [];
    list.map(str_).forEach(function (b) {
      if (b && out.indexOf(b) < 0) out.push(b);
    });
    return out;
  }

  // Projects of PROJETS, then of ARTICLES › Projet, then of PROJET placement rules: one entry per name compared
  // case-insensitively, displayed as first written (PROJETS first). -> Map key -> { name, key, blocks, color, comment }
  function normProjects_(rows, master, ruleRows) {
    var out = new Map();
    function add_(name, blocks, color, comment) {
      var key = name.toLowerCase();
      var p = out.get(key);
      if (!p) out.set(key, p = { name: name, key: key, blocks: [], color: '', comment: comment || '' });
      (blocks || []).forEach(function (b) {
        if (p.blocks.indexOf(b) < 0) p.blocks.push(b);
      });
      if (!p.color && color) p.color = color;
      return p;
    }
    (rows || []).forEach(function (r) {
      var name = str_(r && r.project);
      if (!name) return;
      var color = str_(r.color);
      add_(name, blockList_(r.blocks), /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '', str_(r.comment));
    });
    master.forEach(function (m) {
      if (m.project) add_(m.project);
    });
    (ruleRows || []).forEach(function (r) {
      if (r && str_(r.criterion).toUpperCase() === 'PROJET' && str_(r.value)) add_(str_(r.value));
    });
    return out;
  }

  // Effective rules sorted by priority, then ARTICLE < PROJET < FAMILLE, then input order (docs/SPEC_V2.md 4.7).
  // PROJET rules carry key (lower case) and label (the project's display name).
  function normRules_(rows, projects) {
    var out = [];
    (rows || []).forEach(function (r, i) {
      if (!r) return;
      var criterion = str_(r.criterion).toUpperCase();
      if (!has_(RULE_RANK, criterion)) return;
      var blocks = blockList_(r.blocks);
      var value = criterion === 'ARTICLE' ? article_(r.value) : str_(r.value);
      if (!value || !blocks.length) return;
      var p = num_(r.priority);
      var rule = { priority: isNaN(p) ? 1e9 : p, criterion: criterion, value: value, blocks: blocks, i: i, label: value, key: '' };
      if (criterion === 'PROJET') {
        rule.key = value.toLowerCase();
        if (projects && projects.has(rule.key)) rule.label = projects.get(rule.key).name;
      }
      out.push(rule);
    });
    out.sort(function (a, b) {
      return (a.priority - b.priority) || (RULE_RANK[a.criterion] - RULE_RANK[b.criterion]) || (a.i - b.i);
    });
    return out;
  }

  // Colors: PROJETS › Couleur, else the fixed palette by rank in sorted name order; 'Sans projet' grey.
  function projectColors_(projects) {
    var C = cfg_().COLORS || {};
    var palette = C.projects && C.projects.length ? C.projects : PROJECT_COLORS;
    var names = [];
    projects.forEach(function (p) { names.push(p.name); });
    names.sort(nameCmp_);
    // A project without a color takes the palette color of its rank in name order, or the next one not already used
    // (by a PROJETS color or an earlier project), so a new project never copies the color of another one.
    var taken = {};
    projects.forEach(function (p) {
      if (p.color) taken[p.color.toLowerCase()] = true;
    });
    var out = {};
    names.forEach(function (name, i) {
      var p = projects.get(name.toLowerCase());
      if (!p.color) {
        p.color = palette[i % palette.length];
        for (var k = 0; k < palette.length; k++) {
          var c = palette[(i + k) % palette.length];
          if (!taken[c.toLowerCase()]) {
            p.color = c;
            break;
          }
        }
        taken[p.color.toLowerCase()] = true;
      }
      out[name] = p.color;
    });
    out[NO_PROJECT] = C.noProject || NO_PROJECT_COLOR;
    return { map: out, names: names };
  }

  function normDocks_(rows) {
    var defCap = cfg_().DOCK_STAGING_CAPACITY || 0;
    return (rows || []).map(function (d) {
      var staged = num_(d.staged), cap = num_(d.capacity);
      return {
        quai: str_(d.quai),
        status: str_(d.status) || 'Libre',
        truck: str_(d.truck),
        carrier: str_(d.carrier),
        color: str_(d.color),
        arrival: time_(d.arrival),
        departure: time_(d.departure),
        planned: numOrNull_(d.planned),
        loaded: numOrNull_(d.loaded),
        staged: isNaN(staged) ? 0 : staged,
        capacity: isNaN(cap) ? defCap : cap
      };
    }).filter(function (d) { return d.quai; });
  }

  function isFreeDock_(d) {
    return str_(d.status).toLowerCase() === 'libre';
  }

  function familyColors_(master) {
    var base = (cfg_().COLORS || {}).families || {};
    var out = {}, k, extra = [];
    for (k in base) if (has_(base, k)) out[k] = base[k];
    master.forEach(function (m) {
      if (m.family && !has_(out, m.family) && extra.indexOf(m.family) < 0) extra.push(m.family);
    });
    extra.sort(natCmp_).forEach(function (f, i) {
      out[f] = EXTRA_FAMILY_COLORS[i % EXTRA_FAMILY_COLORS.length];
    });
    return out;
  }

  // Screens never show user names: automatic scans (BARFLOW..., CFG.AUTO_USERS) are 'Auto', others 'Manuel'.
  function userKindOf_() {
    var autos = (cfg_().AUTO_USERS || AUTO_USERS).map(function (u) {
      return String(u).toUpperCase().replace(/[\s_.\-]+/g, '');
    });
    var memo = new Map();
    return function (u) {
      var k = str_(u).toUpperCase().replace(/[\s_.\-]+/g, '');
      if (!k) return '';
      var v = memo.get(k);
      if (v === undefined) {
        v = /^BARFLOW/.test(k) || autos.indexOf(k) >= 0 ? 'Auto' : 'Manuel';
        memo.set(k, v);
      }
      return v;
    };
  }

  // ---------------------------------------------------------------------------------------------
  // FIFO layers of one bucket (article, magasin), docs/SPEC_V2.md 4.4. Layers stay in seq order in b.layers;
  // a consumed layer keeps qty 0 until a walk passes it (labels are taken out of the middle of the queue).
  // b.unlQ holds the unlabeled layers, b.byLabel the layers of each label ever stored in the bucket.
  // ---------------------------------------------------------------------------------------------
  function newBucket_(art, mag) {
    return { art: art, mag: mag, layers: [], head: 0, total: 0, unl: 0, nLab: 0, unlQ: [], unlHead: 0, byLabel: null };
  }

  function pushLayer_(b, L) {
    b.layers.push(L);
    b.total += L.qty;
    if (L.label) {
      b.nLab++;
      if (!b.byLabel) b.byLabel = new Map();
      var arr = b.byLabel.get(L.label);
      if (!arr) b.byLabel.set(L.label, arr = []);
      arr.push(L);
    } else {
      b.unl += L.qty;
      b.unlQ.push(L);
    }
  }

  function takeLayer_(b, L, n) {
    L.qty -= n;
    b.total -= n;
    if (!L.label) b.unl -= n;
    else if (L.qty === 0) b.nLab--;
  }

  // Oldest live layer of the bucket (labeled or not), or null.
  function oldestLayer_(b) {
    var a = b.layers;
    while (b.head < a.length && a[b.head].qty === 0) b.head++;
    if (b.head > 64 && b.head * 2 > a.length) {
      b.layers = a = a.slice(b.head);
      b.head = 0;
    }
    return b.head < a.length ? a[b.head] : null;
  }

  // Newest live layer of the bucket, or null.
  function newestLayer_(b) {
    var a = b.layers;
    while (a.length > b.head && a[a.length - 1].qty === 0) a.pop();
    return a.length > b.head ? a[a.length - 1] : null;
  }

  // Oldest live unlabeled layer, or null.
  function oldestUnlabeled_(b) {
    var a = b.unlQ;
    while (b.unlHead < a.length && a[b.unlHead].qty === 0) b.unlHead++;
    if (b.unlHead > 64 && b.unlHead * 2 > a.length) {
      b.unlQ = a = a.slice(b.unlHead);
      b.unlHead = 0;
    }
    return b.unlHead < a.length ? a[b.unlHead] : null;
  }

  function liveLayers_(b) {
    var out = [];
    for (var i = b.head; i < b.layers.length; i++) if (b.layers[i].qty > 0) out.push(b.layers[i]);
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // compute
  // ---------------------------------------------------------------------------------------------
  function compute(input) {
    var started = Date.now();
    input = input || {};
    var C = cfg_();
    var kinds = input.mvtKinds || C.MVT_KINDS || {};
    var thr = assign_({}, DEFAULT_THRESHOLDS, C.THRESHOLDS, input.thresholds);
    if (!(thr.pendingDaysCrit > 0)) thr.pendingDaysCrit = 2 * thr.pendingDaysWarn;
    ['pendingHoursWarn', 'pendingHoursCrit'].forEach(function (k) {
      var n = num_(thr[k]);
      thr[k] = n >= 0 ? n : DEFAULT_THRESHOLDS[k];
    });
    var labelIsPallet = flag_(thr.labelIsPallet, true);
    var trackAll = flag_(thr.trackAll, false);
    thr.labelIsPallet = labelIsPallet ? 1 : 0;
    thr.trackAll = trackAll ? 1 : 0;
    var warnS = Math.round(thr.pendingHoursWarn * 3600), critS = Math.round(thr.pendingHoursCrit * 3600);
    var plant = str_(input.plant !== undefined && input.plant !== null ? input.plant : C.PLANT);
    var diag = { invalid: 0, otherPlant: 0, unknownMvt: {}, ignored: 0, beforeOpening: 0, future: 0, negativeOpening: 0,
      otherMag: {}, unpaired: [], unpairedLabeled: 0, negative: [], preData: 0, untracked: 0 };
    var userKind_ = userKindOf_();

    var master = normArticles_(input.articles);
    var blocks = normBlocks_(input.blocks);
    var capacity = blocks.reduce(function (s, b) { return s + b.capacity; }, 0);

    // Opening stock (one layer per row, origin 'Stock initial').
    var openRows = [], openValid = 0;
    (input.opening || []).forEach(function (o) {
      var art = article_(o && o.article), mag = str_(o && o.magasin).toUpperCase(), q = milli_(o && o.qty);
      if (!art || !mag || isNaN(q)) {
        diag.invalid++;
        return;
      }
      if (q < 0) {
        diag.negativeOpening++;
        return;
      }
      openValid++;
      if (q === 0) return;
      openRows.push({ art: art, mag: mag, qty: q, uqs: str_(o.uqs), designation: str_(o.designation), date: iso_(o.date) });
    });
    var openDate = iso_(input.openingDate);
    if (!openDate) {
      openRows.forEach(function (r) {
        if (r.date && (!openDate || r.date < openDate)) openDate = r.date;
      });
    }

    // Movements: valid lines of the plant first (they define the tracked articles), then the other filters.
    var cand = [];
    (input.movements || []).forEach(function (m, idx) {
      if (!m) return;
      var art = article_(m.article), mag = str_(m.magasin).toUpperCase(), date = iso_(m.date);
      var qty = milli_(m.qty);
      if (!art || !mag || !date || isNaN(qty)) {
        diag.invalid++;
        return;
      }
      var div = str_(m.division);
      if (plant && div && div !== plant) {
        diag.otherPlant++;
        return;
      }
      cand.push({ m: m, i: idx, art: art, mag: mag, date: date, qty: qty });
    });

    // Tracked articles (finished goods): ARTICLES + articles with a movement or an opening row in EXP2.
    var tracked = null;
    if (!trackAll) {
      tracked = new Set();
      master.forEach(function (m, art) { tracked.add(art); });
      cand.forEach(function (c) {
        if (c.mag === 'EXP2') tracked.add(c.art);
      });
      openRows.forEach(function (r) {
        if (r.mag === 'EXP2') tracked.add(r.art);
      });
    }
    var untrackedArts = new Set();
    function isTracked_(art) {
      if (!tracked || tracked.has(art)) return true;
      diag.untracked++;
      untrackedArts.add(art);
      return false;
    }
    openRows = openRows.filter(function (r) { return isTracked_(r.art); });

    // Then sort by date, entry time, doc, issuing line before receiving line, file order.
    var dataSource = 'SAP';
    var all = [];
    cand.forEach(function (c) {
      if (!isTracked_(c.art)) return;
      var m = c.m, mvt = str_(m.mvt);
      var kind = has_(kinds, mvt) ? str_(kinds[mvt]).toUpperCase() : '';
      if (!kind) {
        diag.unknownMvt[mvt] = (diag.unknownMvt[mvt] || 0) + 1;
        return;
      }
      if (kind === 'IGNORE') {
        diag.ignored++;
        return;
      }
      if (openDate && c.date < openDate) {
        diag.beforeOpening++;
        return;
      }
      if (c.qty === 0) return;
      if (str_(m.source).toUpperCase() === 'SIMULATION') dataSource = 'SIMULATION';
      var ts = ts_(m.ts);
      all.push({ i: c.i, art: c.art, mag: c.mag, mvt: mvt, kind: kind, rev: /_REV$/.test(kind), doc: str_(m.doc), date: c.date,
        qty: c.qty, uqs: str_(m.uqs), designation: str_(m.designation), ts: ts, tsSec: tsSec_(ts), label: str_(m.label),
        user: m.user });
    });
    cand = null;
    var asOf = iso_(input.asOf);
    if (!asOf) {
      all.forEach(function (l) {
        if (l.date > asOf) asOf = l.date;
      });
      if (!asOf) asOf = openDate || iso_(new Date());
    }
    var lines = all.filter(function (l) { return l.date <= asOf; });
    diag.future = all.length - lines.length;
    // Other storage locations are computed but not shown in the twin: report them.
    openRows.concat(lines).forEach(function (l) {
      if (MAGS.indexOf(l.mag) < 0) diag.otherMag[l.mag] = (diag.otherMag[l.mag] || 0) + 1;
    });
    lines.sort(function (a, b) {
      return cmp_(a.date, b.date) || cmp_(a.ts, b.ts) || cmp_(a.doc, b.doc) || ((a.qty < 0 ? 0 : 1) - (b.qty < 0 ? 0 : 1)) ||
        (a.i - b.i);
    });
    if (!openDate) openDate = lines.length ? addDays_(lines[0].date, -1) : asOf;

    // "The time of the data": latest entry time of the processed lines.
    var asOfTs = '';
    lines.forEach(function (l) {
      if (l.ts > asOfTs) asOfTs = l.ts;
    });
    var asOfSec = tsSec_(asOfTs);

    // Other leg of the same document: lines of the same document and article, in processing order.
    var byDoc = new Map();
    lines.forEach(function (l) {
      if (!l.doc) return;
      var k = l.doc + '\u0001' + l.art;
      var g = byDoc.get(k);
      if (!g) byDoc.set(k, g = []);
      g.push(l);
    });
    // Magasin of the other leg of the same document (same article, opposite sign).
    function pairedMag_(l) {
      var g = l.doc ? byDoc.get(l.doc + '\u0001' + l.art) : null;
      if (!g) return '';
      for (var i = 0; i < g.length; i++) {
        var o = g[i];
        if (o !== l && (o.qty > 0) !== (l.qty > 0)) return o.mag;
      }
      return '';
    }

    // Article info: opening rows first, then movements, then ARTICLES (same priority as the oracle).
    var info = new Map();
    function setInfo_(art, designation, uqs) {
      if (!info.has(art)) info.set(art, { designation: designation, uqs: uqs, lastTs: '', lastDate: '' });
    }
    openRows.forEach(function (r) { setInfo_(r.art, r.designation, r.uqs); });
    lines.forEach(function (l) {
      setInfo_(l.art, l.designation, l.uqs);
      var v = info.get(l.art);
      if (l.ts > v.lastTs) v.lastTs = l.ts;
      if (l.date > v.lastDate) v.lastDate = l.date;
    });
    master.forEach(function (m) { setInfo_(m.article, m.designation, m.uqs); });
    info.forEach(function (v, art) {
      var m = master.get(art);
      if (m) {
        if (!v.designation) v.designation = m.designation;
        if (!v.uqs) v.uqs = m.uqs;
      }
    });

    // Quantity per pallet: ARTICLES, else learned = most frequent quantity of the labeled positive lines
    // (ties -> the larger quantity), else unknown.
    var qtyCounts = new Map();
    lines.forEach(function (l) {
      if (!l.label || l.qty <= 0) return;
      var c = qtyCounts.get(l.art);
      if (!c) qtyCounts.set(l.art, c = new Map());
      c.set(l.qty, (c.get(l.qty) || 0) + 1);
    });
    var learned = new Map();
    qtyCounts.forEach(function (c, art) {
      var best = 0, bestN = 0;
      c.forEach(function (n, q) {
        if (n > bestN || (n === bestN && q > best)) {
          best = q;
          bestN = n;
        }
      });
      learned.set(art, best);
    });
    var qppCache = new Map();
    function qppOf_(art) {
      var q = qppCache.get(art);
      if (q === undefined) {
        var m = master.get(art);
        q = m && m.qppM ? m.qppM : (learned.get(art) || 0);
        qppCache.set(art, q);
      }
      return q;
    }

    // Projects (ARTICLES › Projet, PROJETS) and the effective placement rules: input rules + one PROJET rule
    // (priority 5) per project of PROJETS with blocks of the layout (a project whose blocks were all removed from
    // LAYOUT is a project without blocks: free blocks). No fallback rules.
    var projects = normProjects_(input.projects, master, input.rules);
    var colors = projectColors_(projects);
    var blockIds = {};
    blocks.forEach(function (b) { blockIds[b.id] = true; });
    var ruleRows = (input.rules || []).slice(), generated = {};
    (input.projects || []).forEach(function (row) {
      var name = str_(row && row.project);
      var p = name ? projects.get(name.toLowerCase()) : null;
      if (!p || generated[p.key]) return;
      var ids = p.blocks.filter(function (id) { return blockIds[id]; });
      if (!ids.length) return;
      generated[p.key] = true;
      ruleRows.push({ priority: 5, criterion: 'PROJET', value: p.name, blocks: ids });
    });
    var rules = normRules_(ruleRows, projects);
    function projectOf_(art) {
      var m = master.get(art);
      return m && m.project ? projects.get(m.project.toLowerCase()) : null;
    }

    // FIFO layers per (article, magasin).
    var buckets = new Map();
    var seq = 0;
    function bucket_(art, mag) {
      var key = art + '|' + mag;
      var b = buckets.get(key);
      if (!b) buckets.set(key, b = newBucket_(art, mag));
      return b;
    }
    openRows.forEach(function (r) {
      pushLayer_(bucket_(r.art, r.mag), { date: r.date || openDate, doc: '', qty: r.qty, origin: ORIGIN_OPENING, mvt: '',
        seq: seq++, label: '', ts: '', tsSec: null, user: '' });
    });
    // Pallets of a bucket: with labels, 1 per live labeled layer + the unlabeled rest by qpp; else v1
    // (ceil(total / qpp)). null when qpp is unknown (a labeled layer implies a learned qpp).
    function bucketPallets_(b) {
      var q = qppOf_(b.art);
      if (!q) return null;
      if (b.total <= 0) return 0;
      if (labelIsPallet && b.nLab > 0) return b.nLab + (b.unl > 0 ? ceilDiv_(b.unl, q) : 0);
      return ceilDiv_(b.total, q);
    }
    function magPallets_(mag) {
      var t = 0;
      buckets.forEach(function (b) {
        if (b.mag === mag && b.total > 0) t += bucketPallets_(b) || 0;
      });
      return t;
    }
    var openPallets = { PRD2: magPallets_('PRD2'), EXP2: magPallets_('EXP2'), EMRT: magPallets_('EMRT') };

    var exits = [];
    function destination_(l, pm) {
      if (l.mvt === '601') return 'Client (601)';
      if (l.kind === 'ISSUE') return 'Sortie (' + l.mvt + ')';
      if (pm) return pm + ' (' + l.mvt + ')';
      if (l.kind === 'ADJ') return 'Inventaire (' + l.mvt + ')';
      return 'Inconnu (' + l.mvt + ')';
    }
    function chunk_(L, take) {
      return { date: L.date, origin: L.origin, take: take, label: L.label, ts: L.ts, tsSec: L.tsSec };
    }
    // Issuing line without a label (v1): FIFO, LIFO for reversals, over every live layer; missing units are
    // negative stock, clamped to 0. -> [{ date, origin, take, label, ts, tsSec }] in the order taken
    function consume_(b, l, need) {
      var chunks = [];
      if (b.total < need) {
        diag.negative.push({ art: l.art, mag: l.mag, doc: l.doc, date: l.date, missing: need - b.total, uqs: l.uqs });
        need = b.total;
      }
      while (need > 0) {
        var L = l.rev ? newestLayer_(b) : oldestLayer_(b);
        var take = Math.min(need, L.qty);
        takeLayer_(b, L, take);
        need -= take;
        chunks.push(chunk_(L, take));
      }
      return chunks;
    }
    // Issuing line with a label: its own layers first (oldest first), then FIFO over the unlabeled layers, never
    // another label. Missing units: stock from before the data when the label was never stored here, else negative.
    // -> chunks in the order taken (the first one is of its own label when the label is here)
    function consumeLabel_(b, l, need) {
      var chunks = [], arr = b.byLabel ? b.byLabel.get(l.label) : null;
      if (arr) {
        var dead = false;
        for (var i = 0; i < arr.length && need > 0; i++) {
          var L = arr[i];
          if (!L.qty) continue;
          var take = Math.min(need, L.qty);
          takeLayer_(b, L, take);
          need -= take;
          chunks.push(chunk_(L, take));
          if (!L.qty) dead = true;
        }
        if (dead) b.byLabel.set(l.label, arr.filter(function (x) { return x.qty > 0; }));
      }
      while (need > 0) {
        var U = oldestUnlabeled_(b);
        if (!U) break;
        var t = Math.min(need, U.qty);
        takeLayer_(b, U, t);
        need -= t;
        chunks.push(chunk_(U, t));
      }
      if (need > 0) {
        if (arr) diag.negative.push({ art: l.art, mag: l.mag, doc: l.doc, date: l.date, missing: need, uqs: l.uqs });
        else diag.preData++;
      }
      return chunks;
    }
    function apply_(l, day) {
      var q = qppOf_(l.art);
      var abs = Math.abs(l.qty);
      var pal = labelIsPallet && l.label ? 1 : (q ? ceilDiv_(abs, q) : 0);
      var b = bucket_(l.art, l.mag);
      var pm = pairedMag_(l);
      if ((l.kind === 'TRANSFER' || l.kind === 'TRANSFER_REV') && !pm) {
        // A labeled leg whose other leg is outside the export (PRD5...) is normal (docs/SPEC_V2.md 1).
        if (l.label) diag.unpairedLabeled++;
        else diag.unpaired.push(l);
      }
      if (l.qty > 0) {
        pushLayer_(b, { date: l.date, doc: l.doc, qty: l.qty, origin: pm || (l.kind === 'DECL' ? 'PRD2' : 'MvT ' + l.mvt),
          mvt: l.mvt, seq: seq++, label: l.label, ts: l.ts, tsSec: l.tsSec, user: l.user, decl: l.kind === 'DECL' });
        if (l.mag === 'EXP2' && !l.rev) day.entries += pal;
      } else {
        var taken = l.label ? consumeLabel_(b, l, abs) : consume_(b, l, abs);
        if (l.mag === 'EXP2' && !l.rev) {
          day.exits += pal;
          var dest = destination_(l, pm);
          taken.forEach(function (c) {
            exits.push({ article: l.art, dateIn: c.date, dateOut: l.date, qty: c.take / 1000, pallets: q ? ratio_(c.take, q, 2) : null,
              destination: dest, stay: daysBetween_(c.date, l.date), doc: l.doc, mvt: l.mvt, origin: c.origin,
              label: c.label || l.label, tsIn: c.ts, tsOut: l.ts,
              stayHours: c.tsSec !== null && l.tsSec !== null ? hours_(l.tsSec - c.tsSec) : null });
          });
        }
        // Dwell PRD2 -> EXP2: time between the declaration of the label and its transfer to EXP2, when the first
        // layer taken is labeled (a labeled line takes its own label first; an unlabeled one the oldest layer).
        var first = taken.length ? taken[0] : null;
        if (first && first.label && l.mag === 'PRD2' && pm === 'EXP2' && first.tsSec !== null && l.tsSec !== null) {
          day.dwell.push(l.tsSec - first.tsSec);
        }
      }
      if (l.kind === 'DECL') day.declared += pal;
      else if (l.kind === 'DECL_REV') day.declared -= pal;
    }

    // Day by day, from the first movement to asOf (calendar days).
    var daily = [];
    var p = 0;
    var firstDay = lines.length ? lines[0].date : asOf;
    for (var dn = dayNum_(firstDay), lastDn = dayNum_(asOf); dn <= lastDn; dn++) {
      var day = { date: isoOfDay_(dn), declared: 0, entries: 0, exits: 0, stockEnd: 0, saturation: null, pendingEnd: 0,
        dwellMedianH: null, dwellP90H: null, dwellCount: 0, dwell: [] };
      while (p < lines.length && lines[p].date === day.date) apply_(lines[p++], day);
      day.stockEnd = magPallets_('EXP2');
      day.saturation = ratio_(day.stockEnd, capacity, 4);
      day.pendingEnd = magPallets_('PRD2');
      var ds = dwellStats_(day.dwell);
      day.dwellMedianH = ds.medianH;
      day.dwellP90H = ds.p90H;
      day.dwellCount = ds.count;
      delete day.dwell;
      daily.push(day);
    }

    // Stock per article.
    var arts = Array.from(info.keys()).sort();
    var stockByArt = {};
    var stock = arts.map(function (art) {
      var m = master.get(art), q = qppOf_(art), inf = info.get(art), pr = projectOf_(art);
      var row = { article: art, designation: inf.designation, uqs: inf.uqs, qpp: q ? (m && m.qppM ? m.qpp : q / 1000) : null,
        family: m ? m.family : '', known: !!q, inArticles: !!m, qty: {}, pallets: {},
        qppSource: q ? (m && m.qppM ? QPP_ARTICLES : QPP_LABELS) : '', project: pr ? pr.name : '', projectKey: pr ? pr.key : '',
        lastTs: inf.lastTs, lastDate: inf.lastDate };
      MAGS.forEach(function (mag) {
        var b = buckets.get(art + '|' + mag);
        row.qty[mag] = (b ? b.total : 0) / 1000;
        row.pallets[mag] = q ? (b ? bucketPallets_(b) : 0) : null;
      });
      stockByArt[art] = row;
      return row;
    });
    var unknown = stock.filter(function (s) { return !s.known; }).map(function (s) { return s.article; });

    // Remaining layers: PRD2 = pending, EXP2 = FIFO. Labeled layers are 1 pallet each; the unlabeled ones share
    // the rest with the v1 attribution (all layers together when there is no label or labelIsPallet = 0).
    var pending = [], fifo = [];
    buckets.forEach(function (b) {
      if (b.mag !== 'PRD2' && b.mag !== 'EXP2') return;
      var live = liveLayers_(b);
      if (!live.length) return;
      var q = qppOf_(b.art);
      var pals = null;
      if (q && labelIsPallet && b.nLab > 0) {
        var unl = [], at = [];
        pals = live.map(function (L, i) {
          if (L.label) return 1;
          unl.push(L.qty);
          at.push(i);
          return 0;
        });
        layerPallets(unl, q).forEach(function (n, k) { pals[at[k]] = n; });
      } else if (q) {
        pals = layerPallets(live.map(function (L) { return L.qty; }), q);
      }
      var s = stockByArt[b.art];
      live.forEach(function (L, i) {
        var days = daysBetween_(L.date, asOf);
        var ageSec = asOfSec !== null && L.tsSec !== null ? asOfSec - L.tsSec : null;
        var row = { article: b.art, designation: s.designation, uqs: s.uqs, date: L.date, doc: L.doc, origin: L.origin,
          qty: L.qty / 1000, pallets: pals ? pals[i] : null, seq: L.seq, label: L.label, ts: L.ts, project: s.project };
        if (b.mag === 'PRD2') {
          row.days = days;
          row.hours = hours_(ageSec);
          row.ageSec = ageSec;
          // Declared containers (a label, or a declaration) with an entry time are judged in hours: the 6 h alert is
          // about pallets declared and not yet transferred to EXP2 (docs/SPEC_V2.md 1 and 4.10). Unlabeled stock moved
          // into PRD2 (returns from EMRT, legs from a storage location outside the export, opening) and rows without an
          // entry time keep the day rule.
          row.timed = ageSec !== null && (!!L.label || !!L.decl);
          if (row.timed) row.level = ageSec >= critS ? 'crit' : (ageSec >= warnS ? 'warn' : '');
          else row.level = days >= thr.pendingDaysCrit ? 'crit' : (days >= thr.pendingDaysWarn ? 'warn' : '');
          row.user = userKind_(L.user);
          pending.push(row);
        } else {
          row.age = days;
          row.ageHours = hours_(ageSec);
          fifo.push(row);
        }
      });
    });
    pending.sort(function (a, b) {
      return cmp_(a.date, b.date) || cmp_(a.ts, b.ts) || cmp_(a.doc, b.doc) || cmp_(a.article, b.article) || (a.seq - b.seq);
    });
    fifo.sort(function (a, b) {
      return cmp_(a.article, b.article) || cmp_(a.date, b.date) || cmp_(a.ts, b.ts) || cmp_(a.doc, b.doc) || (a.seq - b.seq);
    });

    var placement = place_(stock, fifo, blocks, rules);

    // KPIs.
    var docks = normDocks_(input.docks);
    function sumMag_(mag) {
      return stock.reduce(function (s, r) { return s + (r.pallets[mag] || 0); }, 0);
    }
    var exp2Pallets = sumMag_('EXP2');
    var last = daily.length && daily[daily.length - 1].date === asOf ? daily[daily.length - 1] : null;
    var staged = docks.reduce(function (s, d) { return s + d.staged; }, 0);
    var dockCap = docks.reduce(function (s, d) { return s + d.capacity; }, 0);
    // Rows judged in hours raise PRD2_CRIT / PRD2_WARN, the others are judged in days (PENDING_STUCK).
    var stuck = pending.filter(function (x) { return !x.timed && x.days >= thr.pendingDaysWarn; });
    var refDate = addDays_(asOf, -7), ref = null;
    daily.forEach(function (d) {
      if (d.date === refDate) ref = d.stockEnd;
    });
    if (ref === null && openDate === refDate) ref = openPallets.EXP2;
    var netPerDay = ref === null ? null : (exp2Pallets - ref) / 7;
    var pendingByLevel = { warn: 0, crit: 0 }, oldestPendingSec = null, projectKeys = {};
    pending.forEach(function (x) {
      if (x.level) pendingByLevel[x.level] += x.pallets || 0;
      if (x.timed && (oldestPendingSec === null || x.ageSec > oldestPendingSec)) oldestPendingSec = x.ageSec;
    });
    stock.forEach(function (s) {
      if (s.projectKey) projectKeys[s.projectKey] = true;
    });
    var kpi = {
      exp2Pallets: exp2Pallets,
      capacity: capacity,
      saturation: ratio_(exp2Pallets, capacity, 4),
      pendingPallets: sumMag_('PRD2'),
      oldestPendingDays: pending.reduce(function (m, x) { return Math.max(m, x.days); }, 0),
      stuckPendingLines: stuck.length,
      entriesToday: last ? last.entries : 0,
      exitsToday: last ? last.exits : 0,
      emrtPallets: sumMag_('EMRT'),
      dockSaturation: ratio_(staged, dockCap, 4),
      docksOccupied: docks.filter(function (d) { return !isFreeDock_(d); }).length,
      docksTotal: docks.length,
      docksStaged: staged,
      docksCapacity: dockCap,
      oldestExp2Days: fifo.reduce(function (m, x) { return Math.max(m, x.age); }, 0),
      unknownArticles: unknown.length,
      toPlacePallets: placement.toPlace.pallets,
      daysToSaturation: netPerDay !== null && netPerDay > 0 ? round_(Math.max(0, capacity - exp2Pallets) / netPerDay, 1) : null,
      netPerDay: netPerDay === null ? null : round_(netPerDay, 2),
      asOfTs: asOfTs,
      pendingTotal: pending.length,
      pendingLabels: pending.filter(function (x) { return x.label; }).length,
      pendingWarn: pendingByLevel.warn,
      pendingCrit: pendingByLevel.crit,
      oldestPendingHours: hours_(oldestPendingSec),
      dwellMedianH: last ? last.dwellMedianH : null,
      dwellP90H: last ? last.dwellP90H : null,
      dwellCount: last ? last.dwellCount : 0,
      trackedArticles: stock.length,
      noProjectArticles: stock.filter(function (s) { return !s.projectKey && (s.qty.EXP2 > 0 || s.qty.PRD2 > 0); }).length,
      projects: Object.keys(projectKeys).length
    };

    var result = {
      asOf: asOf,
      asOfTs: asOfTs,
      openDate: openDate,
      plant: plant,
      capacity: capacity,
      dataSource: dataSource,
      thresholds: thr,
      stock: stock,
      pending: pending,
      fifo: fifo,
      exits: exits,
      daily: daily,
      blocks: placement.blocks,
      toPlace: placement.toPlace,
      blockContents: placement.contents,
      blockDefs: blocks,
      kpi: kpi,
      unknown: unknown,
      docks: docks,
      families: familyColors_(master),
      projects: colors.map,
      projectsList: projectsList_(projects, colors.names, rules, blocks, stock, pending),
      learnedQpp: learnedQpp_(learned),
      openPallets: openPallets,
      counts: { movements: (input.movements || []).length, processed: lines.length, opening: openRows.length,
        invalid: diag.invalid, otherPlant: diag.otherPlant, ignored: diag.ignored, beforeOpening: diag.beforeOpening,
        afterAsOf: diag.future, unpaired: diag.unpaired.length, negative: diag.negative.length,
        untracked: diag.untracked, untrackedArticles: untrackedArts.size, preData: diag.preData,
        unpairedLabeled: diag.unpairedLabeled, openingRows: openValid,
        withTime: lines.filter(function (l) { return l.ts; }).length,
        withLabel: lines.filter(function (l) { return l.label; }).length }
    };
    result.alerts = alerts_(result, diag, stuck, thr);
    result.computeMs = Date.now() - started;
    result.state = buildState(result, {
      layout: input.layout, version: input.version, computedAt: input.computedAt, importedAt: input.importedAt, source: input.source
    });
    return result;
  }

  // Learned quantities per pallet in units: { article: qpp } (every article with labeled positive lines).
  function learnedQpp_(learned) {
    var out = {};
    Array.from(learned.keys()).sort().forEach(function (art) { out[art] = learned.get(art) / 1000; });
    return out;
  }

  // One row per project (sorted by name, 'Sans projet' last when some tracked article has none):
  // { project, color, blocks, articles, exp2Pallets, pendingPallets, pendingCrit }.
  function projectsList_(projects, names, rules, blocks, stock, pending) {
    var exists = {};
    blocks.forEach(function (b) { exists[b.id] = true; });
    var rows = {}, none = null;
    names.forEach(function (name) {
      var p = projects.get(name.toLowerCase());
      rows[p.key] = { project: p.name, color: p.color, blocks: [], articles: 0, exp2Pallets: 0, pendingPallets: 0, pendingCrit: 0 };
    });
    rules.forEach(function (r) {
      if (r.criterion !== 'PROJET' || !rows[r.key]) return;
      r.blocks.forEach(function (id) {
        if (exists[id] && rows[r.key].blocks.indexOf(id) < 0) rows[r.key].blocks.push(id);
      });
    });
    function row_(key) {
      if (key) return rows[key];
      if (!none) none = { project: NO_PROJECT, color: (cfg_().COLORS || {}).noProject || NO_PROJECT_COLOR, blocks: [], articles: 0,
        exp2Pallets: 0, pendingPallets: 0, pendingCrit: 0 };
      return none;
    }
    var keyOf = {};
    stock.forEach(function (s) {
      var r = row_(s.projectKey);
      keyOf[s.article] = s.projectKey;
      r.articles++;
      r.exp2Pallets += s.pallets.EXP2 || 0;
      r.pendingPallets += s.pallets.PRD2 || 0;
    });
    pending.forEach(function (x) {
      if (x.level === 'crit') row_(keyOf[x.article] || '').pendingCrit += x.pallets || 0;
    });
    var out = names.map(function (name) { return rows[name.toLowerCase()]; });
    if (none) out.push(none);
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Placement: an article goes to the blocks of the first matching rule (ARTICLE, PROJET, FAMILLE);
  // the pallets of a rule are spread over its blocks in proportion to their free capacity (largest remainder,
  // ties to the first block); articles matching no rule are spread the same way over the free blocks (targeted
  // by no rule); what does not fit goes to 'À PLACER'. Articles fill the blocks in article order, oldest pallets
  // first, which gives blockContents.
  // ---------------------------------------------------------------------------------------------
  function place_(stock, fifo, blocks, rules) {
    // Block labels: families = values of the FAMILLE and ARTICLE rules (v1), projects = names of the PROJET rules.
    var byId = {}, used = {}, contents = {}, labels = {}, projs = {}, fams = {}, artVals = {}, targeted = {};
    blocks.forEach(function (b) {
      byId[b.id] = b;
      used[b.id] = 0;
      contents[b.id] = [];
      labels[b.id] = [];
      projs[b.id] = [];
      fams[b.id] = [];
      artVals[b.id] = [];
    });
    function addOnce_(list, v) {
      if (list.indexOf(v) < 0) list.push(v);
    }
    rules.forEach(function (r) {
      r.blocks.forEach(function (id) {
        if (!byId[id]) return;
        targeted[id] = true;
        if (r.criterion === 'PROJET') {
          addOnce_(projs[id], r.label);
          return;
        }
        addOnce_(labels[id], r.label);
        addOnce_(r.criterion === 'FAMILLE' ? fams[id] : artVals[id], r.label);
      });
    });
    // Block title on the screens: its projects, else its families, else its articles, else 'Libre'.
    function title_(id) {
      if (projs[id].length) return projs[id].join(' / ');
      if (fams[id].length) return 'Famille ' + fams[id].join(', ');
      if (artVals[id].length) return (artVals[id].length > 1 ? 'Articles ' : 'Article ') + artVals[id].join(', ');
      return 'Libre';
    }
    var queues = {};
    fifo.forEach(function (f) {
      if (!(f.pallets > 0)) return;
      if (!queues[f.article]) queues[f.article] = [];
      queues[f.article].push({ age: f.age, n: f.pallets });
    });
    var groups = rules.map(function (r) { return { rule: r, items: [] }; });
    var noRule = [];
    stock.forEach(function (s) {
      if (!s.known || !(s.pallets.EXP2 > 0)) return;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if ((r.criterion === 'ARTICLE' && r.value === s.article) || (r.criterion === 'PROJET' && s.projectKey && r.key === s.projectKey) ||
          (r.criterion === 'FAMILLE' && s.family && r.value === s.family)) {
          groups[i].items.push(s);
          return;
        }
      }
      noRule.push(s);
    });

    var toPlaceItems = [];
    function entry_(s, n, age) {
      return { article: s.article, designation: s.designation, family: s.family, pallets: n, ageMax: age, project: s.project };
    }
    function drawer_(items) {
      var queue = items.map(function (s) {
        return { s: s, left: s.pallets.EXP2, q: (queues[s.article] || []).map(function (x) { return { age: x.age, n: x.n }; }) };
      });
      var qi = 0;
      return function (n, sink) {
        while (n > 0 && qi < queue.length) {
          var it = queue[qi], k = Math.min(n, it.left), age = it.q.length ? it.q[0].age : null, rest = k;
          while (rest > 0 && it.q.length) {
            var h = it.q[0], t = Math.min(rest, h.n);
            h.n -= t;
            rest -= t;
            if (!h.n) it.q.shift();
          }
          sink(entry_(it.s, k, age));
          it.left -= k;
          n -= k;
          if (!it.left) qi++;
        }
      };
    }
    function spread_(blockIds, items) {
      var P = items.reduce(function (s, x) { return s + x.pallets.EXP2; }, 0);
      var ids = [];
      blockIds.forEach(function (id) {
        if (byId[id] && ids.indexOf(id) < 0) ids.push(id);
      });
      var caps = ids.map(function (id) { return Math.max(0, byId[id].capacity - used[id]); });
      var S = caps.reduce(function (s, c) { return s + c; }, 0);
      var alloc;
      if (P >= S) {
        alloc = caps.slice();
      } else {
        var rem = [];
        alloc = caps.map(function (c, i) {
          var exact = P * c;
          rem.push({ i: i, r: exact % S });
          return Math.floor(exact / S);
        });
        var rest = P - alloc.reduce(function (s, a) { return s + a; }, 0);
        rem.sort(function (a, b) { return (b.r - a.r) || (a.i - b.i); });
        for (var j = 0; j < rest; j++) alloc[rem[j].i] += 1;
      }
      var draw = drawer_(items);
      ids.forEach(function (id, i) {
        draw(alloc[i], function (e) {
          contents[id].push(e);
          used[id] += e.pallets;
        });
      });
      draw(Infinity, function (e) { toPlaceItems.push(e); });
    }
    groups.forEach(function (g) {
      if (g.items.length) spread_(g.rule.blocks, g.items);
    });
    var free = blocks.filter(function (b) { return !targeted[b.id]; }).map(function (b) { return b.id; });
    if (noRule.length && free.length) spread_(free, noRule);
    else noRule.forEach(function (s) { drawer_([s])(Infinity, function (e) { toPlaceItems.push(e); }); });

    var families = [], projects = [];
    toPlaceItems.forEach(function (e) {
      var f = e.family || NO_FAMILY, pr = e.project || NO_PROJECT;
      if (families.indexOf(f) < 0) families.push(f);
      if (projects.indexOf(pr) < 0) projects.push(pr);
    });
    families.sort();
    projects.sort(function (a, b) {
      return ((a === NO_PROJECT ? 1 : 0) - (b === NO_PROJECT ? 1 : 0)) || nameCmp_(a, b);
    });
    var toPlace = {
      id: TO_PLACE_ID,
      label: TO_PLACE_LABEL,
      families: families.join(', '),
      projects: projects,
      capacity: null,
      pallets: toPlaceItems.reduce(function (s, e) { return s + e.pallets; }, 0),
      saturation: null
    };
    if (toPlaceItems.length) contents[TO_PLACE_ID] = toPlaceItems;
    return {
      blocks: blocks.map(function (b) {
        return { id: b.id, label: b.label, families: labels[b.id].join(', '), capacity: b.capacity, pallets: used[b.id],
          saturation: ratio_(used[b.id], b.capacity, 4), projects: projs[b.id].slice(), title: title_(b.id) };
      }),
      toPlace: toPlace,
      contents: contents
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Alerts (French texts), critical first.
  // ---------------------------------------------------------------------------------------------
  function alerts_(result, diag, stuck, thr) {
    var list = [];
    function add_(level, code, text) {
      list.push({ level: level, code: code, text: text });
    }
    var k = result.kpi;

    // Declared pallets waiting in PRD2 (entry time known), the user's first concern: first in the list and the ticker.
    var timed = { crit: 0, warn: 0 }, oldest = null;
    result.pending.forEach(function (x) {
      if (!x.timed) return;
      if (x.level) timed[x.level] += x.pallets || 0;
      if (!oldest || x.ageSec > oldest.ageSec) oldest = x;
    });
    if (timed.crit > 0) {
      add_('crit', 'PRD2_CRIT', plural_(timed.crit, 'palette', 'palettes') + ' en PRD2 depuis plus de ' + frSetting_(thr.pendingHoursCrit) +
        ' h · la plus ancienne : ' + oldest.article + (oldest.project ? ' ' + oldest.project : '') + ' depuis ' + fmtHm_(oldest.ageSec) +
        (oldest.label ? ' (étiquette ' + oldest.label + ')' : ''));
    }
    if (timed.warn > 0) {
      add_('warn', 'PRD2_WARN', plural_(timed.warn, 'palette', 'palettes') + ' en PRD2 depuis ' + frSetting_(thr.pendingHoursWarn) +
        ' à ' + frSetting_(thr.pendingHoursCrit) + ' h');
    }

    if (result.counts.openingRows > 0) {
      diag.negative.slice(0, MAX_LISTED_ALERTS).forEach(function (n) {
        add_('crit', 'NEGATIVE_STOCK', 'Stock négatif ramené à 0 : article ' + n.art + ' en ' + n.mag + ' (Doc.article ' + n.doc +
          ' du ' + fmtDate_(n.date) + ', manque ' + frNum_(n.missing / 1000, n.missing % 1000 ? 3 : 0) + (n.uqs ? ' ' + n.uqs : '') + ')');
      });
      if (diag.negative.length > MAX_LISTED_ALERTS) {
        add_('crit', 'NEGATIVE_STOCK', '… et ' + plural_(diag.negative.length - MAX_LISTED_ALERTS, 'autre ligne', 'autres lignes') + ' en stock négatif');
      }
    } else if (diag.negative.length) {
      // No opening stock: issues of stock from before the data are expected, one calm hint.
      add_('warn', 'NEGATIVE_STOCK', plural_(diag.negative.length, 'sortie', 'sorties') +
        ' sans stock connu : importez le stock initial (MB52)');
    }

    if (k.saturation !== null && k.saturation >= thr.satWarn) {
      add_(k.saturation >= thr.satCrit ? 'crit' : 'warn', 'EXP2_SAT', 'Entrepôt EXP2 saturé à ' + frPct_(k.saturation) + ' (' +
        frNum_(k.exp2Pallets) + ' / ' + frNum_(k.capacity) + ' pal)');
    }
    result.blocks.forEach(function (b) {
      if (b.saturation === null || b.saturation < thr.satWarn) return;
      add_(b.saturation >= thr.satCrit ? 'crit' : 'warn', 'BLOCK_SAT', 'Bloc ' + b.id + ' saturé à ' + frPct_(b.saturation) +
        ' (' + b.pallets + ' / ' + b.capacity + ' pal)');
    });
    if (result.toPlace.pallets > 0) {
      // Named after its projects when it holds some, else after its families (v1), else nothing.
      var tp = result.toPlace, named = tp.projects.filter(function (x) { return x !== NO_PROJECT; }).length;
      var what = named ? ' (projet ' + tp.projects.join(', ') + ')' :
        (tp.families && tp.families !== NO_FAMILY ? ' (famille ' + tp.families + ')' : '');
      add_('warn', 'TO_PLACE', plural_(tp.pallets, 'palette', 'palettes') + ' hors capacité des blocs' + what + ' : à placer');
    }
    if (k.noProjectArticles > 0) {
      add_('warn', 'NO_PROJECT', plural_(k.noProjectArticles, 'référence suivie', 'références suivies') +
        ' sans projet : affectez-' + (k.noProjectArticles > 1 ? 'les' : 'la') + ' dans la page Projets');
    }

    stuck.slice(0, MAX_LISTED_ALERTS).forEach(function (x) {
      add_(x.days >= thr.pendingDaysCrit ? 'crit' : 'warn', 'PENDING_STUCK', 'En attente PRD2 depuis ' + plural_(x.days, 'jour', 'jours') +
        ' : article ' + x.article + (x.designation ? ' ' + x.designation : '') + ' (Doc.article ' + x.doc + ' du ' + fmtDate_(x.date) +
        ', ' + frNum_(x.qty, x.qty === Math.round(x.qty) ? 0 : 3) + (x.uqs ? ' ' + x.uqs : '') + ')');
    });
    if (stuck.length > MAX_LISTED_ALERTS) {
      add_('warn', 'PENDING_STUCK', '… et ' + plural_(stuck.length - MAX_LISTED_ALERTS, 'autre ligne', 'autres lignes') +
        ' en attente depuis au moins ' + thr.pendingDaysWarn + ' jours');
    }

    result.docks.forEach(function (d) {
      if (!(d.capacity > 0)) return;
      var r = d.staged / d.capacity;
      if (r >= thr.dockStagingWarn) {
        add_('warn', 'DOCK_STAGING', 'Quai ' + String(d.quai).replace(/^Q0(\d)$/, 'Q$1') + ' : zone quai remplie à ' + frPct_(r) +
          ' (' + d.staged + ' / ' + d.capacity + ' pal)');
      }
    });

    // Articles without a quantity per pallet: one alert each (v1), grouped per code beyond a few (real exports
    // carry raw-material moves of finished goods without labels: no wall of identical lines).
    var noQpp = result.stock.filter(function (s) { return !s.known; });
    var missing = noQpp.filter(function (s) { return s.inArticles; }), absent = noQpp.filter(function (s) { return !s.inArticles; });
    function codes_(list) {
      var shown = list.slice(0, MAX_GROUPED_CODES).map(function (s) { return s.article; });
      return shown.join(', ') + (list.length > MAX_GROUPED_CODES ? ', …' : '');
    }
    if (missing.length > MAX_SINGLE_QPP_ALERTS) {
      add_('warn', 'NO_QPP', plural_(missing.length, 'article', 'articles') + ' de l\u2019onglet ARTICLES sans Qté par palette (' +
        codes_(missing) + ') : complétez-la, puis « Recalculer » (onglet ACCUEIL)');
    } else {
      missing.forEach(function (s) {
        add_('warn', 'NO_QPP', 'Article ' + s.article + (s.designation ? ' (' + s.designation + ')' : '') +
          ' : Qté par palette manquante dans l\u2019onglet ARTICLES : complétez-la, puis « Recalculer » (onglet ACCUEIL)');
      });
    }
    if (absent.length > MAX_SINGLE_QPP_ALERTS) {
      add_('warn', 'UNKNOWN_ARTICLE', plural_(absent.length, 'article', 'articles') + ' sans quantité par palette (absents de ' +
        'l\u2019onglet ARTICLES, sans étiquette pour l\u2019apprendre : ' + codes_(absent) + ') : ajoutez leur quantité par palette ' +
        'dans ARTICLES, puis « Recalculer » (onglet ACCUEIL)');
    } else {
      absent.forEach(function (s) {
        add_('warn', 'UNKNOWN_ARTICLE', 'Article ' + s.article + (s.designation ? ' (' + s.designation + ')' : '') +
          ' absent de l\u2019onglet ARTICLES : ajoutez sa quantité par palette dans ARTICLES, puis « Recalculer » (onglet ACCUEIL)');
      });
    }

    if (diag.unpaired.length) {
      var u = diag.unpaired[0];
      add_('warn', 'UNPAIRED_TRANSFER', plural_(diag.unpaired.length, 'ligne de transfert', 'lignes de transfert') +
        ' sans ligne opposée dans le même Doc.article (ex. Doc.article ' + (u.doc || '?') + ', article ' + u.art + ', ' + u.mag + ')');
    }
    Object.keys(diag.unknownMvt).sort().forEach(function (mvt) {
      add_('warn', 'UNKNOWN_MVT', 'MvT ' + (mvt || '(vide)') + ' non paramétré (PARAM_MOUVEMENTS) : ' +
        plural_(diag.unknownMvt[mvt], 'ligne ignorée', 'lignes ignorées'));
    });
    Object.keys(diag.otherMag).sort().forEach(function (mag) {
      add_('warn', 'OTHER_MAGASIN', 'Magasin ' + mag + ' hors du jumeau (PRD2, EXP2, EMRT) : ' +
        plural_(diag.otherMag[mag], 'ligne non affichée', 'lignes non affichées'));
    });
    if (diag.otherPlant) {
      add_('warn', 'OTHER_PLANT', plural_(diag.otherPlant, 'ligne', 'lignes') + ' d\'une autre division que ' + result.plant + ' ignorée(s)');
    }
    if (diag.beforeOpening) {
      add_('warn', 'BEFORE_OPENING', plural_(diag.beforeOpening, 'ligne', 'lignes') + ' antérieure(s) au stock initial du ' +
        fmtDate_(result.openDate) + ' ignorée(s)');
    }
    if (diag.negativeOpening) {
      add_('warn', 'NEGATIVE_OPENING', plural_(diag.negativeOpening, 'ligne', 'lignes') + ' de stock initial négative(s) ignorée(s)');
    }
    if (diag.invalid) {
      add_('warn', 'INVALID_LINE', plural_(diag.invalid, 'ligne incomplète ignorée', 'lignes incomplètes ignorées') +
        ' (article, magasin, date ou quantité manquant)');
    }

    var crit = list.filter(function (a) { return a.level === 'crit'; });
    var warn = list.filter(function (a) { return a.level !== 'crit'; });
    return crit.concat(warn);
  }

  // ---------------------------------------------------------------------------------------------
  // Compact state for the screens (docs/ARCHITECTURE.md section 8, docs/SPEC_V2.md 4.9).
  // extras: { version, computedAt, importedAt, source, layout }
  // ---------------------------------------------------------------------------------------------
  function buildState(result, extras) {
    extras = extras || {};
    var L = extras.layout || cfg_().DEFAULT_LAYOUT || {};
    var kpi = {};
    for (var key in result.kpi) if (has_(result.kpi, key)) kpi[key] = result.kpi[key];
    var blockById = {};
    result.blocks.forEach(function (b) { blockById[b.id] = b; });
    return {
      version: extras.version !== undefined ? extras.version : null,
      asOf: result.asOf,
      asOfTs: result.asOfTs || '',
      computedAt: extras.computedAt || new Date().toISOString(),
      importedAt: extras.importedAt || null,
      source: extras.source || result.dataSource || 'SAP',
      layout: {
        building: L.building || null,
        blocks: result.blockDefs.map(function (b) {
          var row = blockById[b.id];
          return { id: b.id, label: b.label, x: b.x, y: b.y, w: b.w, h: b.h, cols: b.cols, rows: b.rows, levels: b.levels,
            color: b.color, capacity: b.capacity, families: row ? row.families : '', projects: row ? row.projects.slice() : [],
            title: row ? row.title : 'Libre' };
        }),
        truckZone: L.truckZone || L.truck_zone || null,
        quais: L.quais || [],
        quaiLine: L.quaiLine || L.quai_common || null,
        roads: L.roads || [],
        zones: L.zones || []
      },
      kpi: kpi,
      blocks: result.blocks.map(function (b) {
        return { id: b.id, label: b.label, families: b.families, capacity: b.capacity, pallets: b.pallets, saturation: b.saturation,
          projects: b.projects.slice(), title: b.title };
      }),
      blockContents: result.blockContents,
      families: result.families,
      projects: result.projects,
      projectsList: result.projectsList,
      daily: result.daily.map(function (d) {
        return { date: d.date, declared: d.declared, entries: d.entries, exits: d.exits, stockEnd: d.stockEnd,
          saturation: d.saturation, pendingEnd: d.pendingEnd, dwellMedianH: d.dwellMedianH, dwellP90H: d.dwellP90H };
      }),
      pending: result.pending.slice(0, MAX_STATE_PENDING).map(function (x) {
        return { article: x.article, designation: x.designation, date: x.date, doc: x.doc, qty: x.qty, pallets: x.pallets, days: x.days,
          label: x.label, ts: x.ts, hours: x.hours, level: x.level, project: x.project, origin: x.origin, user: x.user };
      }),
      pendingTotal: result.pending.length,
      articles: result.stock.map(function (s) {
        return { a: s.article, d: s.designation, p: s.project, e: s.pallets.EXP2, w: s.pallets.PRD2, m: s.pallets.EMRT, q: s.qpp,
          qs: s.qppSource, t: s.lastTs || s.lastDate || '' };
      }),
      docks: result.docks,
      alerts: result.alerts
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Sheet tables (CALC_* tabs): [headers, ...rows], dates as dd.mm.yyyy, blanks as ''. The v1 columns come
  // first (sample-data/csv), the v2 columns are appended (docs/SPEC_V2.md 3).
  // ---------------------------------------------------------------------------------------------
  function kpiRows_(result) {
    var k = result.kpi, day = fmtDate_(result.asOf), thr = result.thresholds || {};
    var ids = result.blocks.map(function (b) { return b.id; });
    var range = ids.length > 1 ? ids[0] + '-' + ids[ids.length - 1] : (ids[0] || '');
    var hWarn = frSetting_(thr.pendingHoursWarn), hCrit = frSetting_(thr.pendingHoursCrit);
    return [
      ['Palettes EXP2', k.exp2Pallets, 'palettes',
        'Somme, sur les articles connus, de l\'arrondi supérieur (qté EXP2 totale de l\'article / Qté par palette) : une seule palette incomplète par article'],
      ['Capacité totale de stockage', k.capacity, 'palettes', 'Somme de Capacité (palettes) des blocs ' + range + ' (LAYOUT)'],
      ['Saturation EXP2', blank_(k.saturation), '%',
        'Palettes EXP2 / capacité totale de stockage (fraction arrondie à 4 décimales ; tests : tolérance 1e-4)'],
      ['Palettes en attente (PRD2)', k.pendingPallets, 'palettes',
        'Somme, sur les articles connus, de l\'arrondi supérieur (qté PRD2 totale de l\'article / Qté par palette) : quantités déclarées (101) ou retournées (312) et pas encore transférées vers EXP2'],
      ['Plus ancienne attente', k.oldestPendingDays, 'jours',
        'Date de référence - plus ancienne date des couches PRD2 restantes (jours calendaires)'],
      ['Entrées EXP2 du jour', k.entriesToday, 'palettes',
        'Lignes positives EXP2 hors annulations (102/312/602) du ' + day + ', arrondi supérieur par ligne'],
      ['Sorties EXP2 du jour', k.exitsToday, 'palettes',
        'Lignes négatives EXP2 hors annulations (601 + 311 vers EMRT) du ' + day + ', arrondi supérieur par ligne'],
      ['Palettes EMRT', k.emrtPallets, 'palettes',
        'Somme, sur les articles connus, de l\'arrondi supérieur (qté EMRT totale de l\'article / Qté par palette)'],
      ['Saturation zone quais', blank_(k.dockSaturation), '%', 'Somme Palettes en zone quai / somme Capacité zone quai (QUAIS_CAMIONS)'],
      ['Quais occupés', k.docksOccupied + '/' + k.docksTotal, 'quais', 'Quais dont le statut n\'est pas « Libre » (QUAIS_CAMIONS)'],
      ['Âge plus ancienne couche EXP2', k.oldestExp2Days, 'jours',
        'Date de référence - plus ancienne Date entrée des couches EXP2 restantes'],
      ['Articles inconnus', k.unknownArticles, 'articles',
        'Articles présents dans les extractions SAP mais absents de ARTICLES : ' + (result.unknown.length ? result.unknown.join(', ') : 'aucun') +
        ' (palettes non calculables)'],
      ['Heure des données', fmtTs_(k.asOfTs), '',
        'Plus récente heure de saisie SAP des lignes traitées (jusqu\'à la date de référence incluse)'],
      ['Palettes en attente > ' + hCrit + ' h', k.pendingCrit, 'palettes',
        'Palettes PRD2 déclarées depuis au moins ' + hCrit + ' h à l\'heure des données (sans heure de saisie : depuis au moins ' +
        thr.pendingDaysCrit + ' jours)'],
      ['Palettes en attente ' + hWarn + ' à ' + hCrit + ' h', k.pendingWarn, 'palettes',
        'Palettes PRD2 déclarées depuis ' + hWarn + ' à ' + hCrit + ' h à l\'heure des données (sans heure de saisie : depuis ' +
        thr.pendingDaysWarn + ' à ' + thr.pendingDaysCrit + ' jours)'],
      ['Plus ancienne attente (h)', blank_(k.oldestPendingHours), 'heures',
        'Heure des données - plus ancienne heure de saisie des couches PRD2 restantes'],
      ['Étiquettes en attente', k.pendingLabels, 'étiquettes', 'Couches PRD2 restantes portant un numéro d\'étiquette'],
      ['Délai PRD2→EXP2 médian', blank_(k.dwellMedianH), 'heures',
        'Médiane, sur les transferts PRD2→EXP2 du ' + day + ', du temps entre la déclaration de l\'étiquette et son transfert'],
      ['Délai PRD2→EXP2 P90', blank_(k.dwellP90H), 'heures',
        '90 % des étiquettes transférées le ' + day + ' l\'ont été en moins de ce délai (rang le plus proche)'],
      ['Articles suivis', k.trackedArticles, 'articles',
        'Articles de ARTICLES et articles ayant au moins une ligne ou un stock initial en EXP2 (produits finis)'],
      ['Références sans projet', k.noProjectArticles, 'articles',
        'Articles suivis en stock EXP2 ou PRD2 sans projet dans ARTICLES (page Projets)'],
      ['Projets', k.projects, 'projets', 'Projets ayant au moins un article suivi (ARTICLES › Projet)']
    ];
  }

  function toTables(result) {
    var H = cfg_().HEADERS;
    if (!H) throw new Error('CFG.HEADERS introuvable : charger Config.gs avant Engine.gs');
    function table_(name, rows) {
      return [H[name].slice()].concat(rows);
    }
    var blocRows = result.blocks.concat([result.toPlace]).map(function (b) {
      return [b.id, b.label, b.families, blank_(b.capacity), b.pallets, blank_(b.saturation), (b.projects || []).join(', ')];
    });
    return {
      CALC_STOCK: table_('CALC_STOCK', result.stock.map(function (s) {
        return [s.article, s.designation, s.uqs, s.qpp === null ? 'INCONNU' : s.qpp, s.qty.PRD2, blank_(s.pallets.PRD2),
          s.qty.EXP2, blank_(s.pallets.EXP2), s.qty.EMRT, blank_(s.pallets.EMRT), s.qppSource || '', s.project || ''];
      })),
      CALC_EN_ATTENTE: table_('CALC_EN_ATTENTE', result.pending.map(function (x) {
        return [x.article, x.designation, fmtDate_(x.date), x.doc, x.qty, blank_(x.pallets), x.days,
          x.label || '', fmtTs_(x.ts), blank_(x.hours), LEVEL_TEXT[x.level] || '', x.project || ''];
      })),
      CALC_FIFO_EXP2: table_('CALC_FIFO_EXP2', result.fifo.map(function (f) {
        return [f.article, f.designation, fmtDate_(f.date), f.doc, f.origin, f.qty, blank_(f.pallets), f.age,
          f.label || '', fmtTs_(f.ts), blank_(f.ageHours), f.project || ''];
      })),
      CALC_SORTIES: table_('CALC_SORTIES', result.exits.map(function (x) {
        return [x.article, fmtDate_(x.dateIn), fmtDate_(x.dateOut), x.qty, blank_(x.pallets), x.destination, x.stay, x.doc,
          x.label || '', fmtTs_(x.tsIn), fmtTs_(x.tsOut), blank_(x.stayHours)];
      })),
      CALC_JOURNALIER: table_('CALC_JOURNALIER', result.daily.map(function (d) {
        return [fmtDate_(d.date), d.declared, d.entries, d.exits, d.stockEnd, blank_(d.saturation), d.pendingEnd,
          blank_(d.dwellMedianH), blank_(d.dwellP90H)];
      })),
      CALC_BLOCS: table_('CALC_BLOCS', blocRows),
      CALC_KPI: table_('CALC_KPI', kpiRows_(result))
    };
  }

  // ---------------------------------------------------------------------------------------------
  // One article: stock per magasin, EXP2 layers, pending layers, exits, theoretical location.
  // ---------------------------------------------------------------------------------------------
  // Lookup entries (one article): same shapes for lookup() and lookupAll().
  function lookupStock_(s) {
    var stock = { article: s.article, designation: s.designation, uqs: s.uqs, qpp: s.qpp, family: s.family, known: s.known,
      qppSource: s.qppSource || '', project: s.project || '' };
    MAGS.forEach(function (mag) {
      stock[mag] = { qty: s.qty[mag], pallets: s.pallets[mag] };
    });
    return stock;
  }

  function lookupFifo_(f) {
    return { date: f.date, doc: f.doc, origin: f.origin, qty: f.qty, pallets: f.pallets, age: f.age, label: f.label || '', ts: f.ts || '',
      ageHours: f.ageHours === undefined ? null : f.ageHours };
  }

  function lookupPending_(x) {
    return { date: x.date, doc: x.doc, qty: x.qty, pallets: x.pallets, days: x.days, label: x.label || '', ts: x.ts || '',
      hours: x.hours === undefined ? null : x.hours, level: x.level || '', user: x.user || '' };
  }

  function lookupExit_(x) {
    return { dateIn: x.dateIn, dateOut: x.dateOut, qty: x.qty, pallets: x.pallets, destination: x.destination, stay: x.stay, doc: x.doc,
      label: x.label || '', tsIn: x.tsIn || '', tsOut: x.tsOut || '', stayHours: x.stayHours === undefined ? null : x.stayHours };
  }

  function lookup(result, article) {
    var art = article_(article);
    var s = null;
    for (var i = 0; i < result.stock.length; i++) {
      if (result.stock[i].article === art) {
        s = result.stock[i];
        break;
      }
    }
    var locations = [];
    Object.keys(result.blockContents).forEach(function (id) {
      result.blockContents[id].forEach(function (e) {
        if (e.article === art) locations.push({ block: id, pallets: e.pallets, ageMax: e.ageMax });
      });
    });
    return {
      article: art,
      project: s ? s.project || '' : '',
      stock: s ? lookupStock_(s) : null,
      fifo: result.fifo.filter(function (f) { return f.article === art; }).map(lookupFifo_),
      pending: result.pending.filter(function (x) { return x.article === art; }).map(lookupPending_),
      exits: result.exits.filter(function (x) { return x.article === art; }).map(lookupExit_),
      locations: locations
    };
  }

  /**
   * lookup() of every article of the result in one pass: { article: entry }. Used to precompute the article pages
   * when the state is saved (a year of movements: one pass instead of one per article).
   */
  function lookupAll(result) {
    var out = {};
    function entry(art) {
      if (!Object.prototype.hasOwnProperty.call(out, art)) {
        out[art] = { article: art, project: '', stock: null, fifo: [], pending: [], exits: [], locations: [] };
      }
      return out[art];
    }
    result.stock.forEach(function (s) {
      var e = entry(s.article);
      if (!e.stock) {
        e.stock = lookupStock_(s);
        e.project = s.project || '';
      }
    });
    result.fifo.forEach(function (f) { entry(f.article).fifo.push(lookupFifo_(f)); });
    result.pending.forEach(function (x) { entry(x.article).pending.push(lookupPending_(x)); });
    result.exits.forEach(function (x) { entry(x.article).exits.push(lookupExit_(x)); });
    Object.keys(result.blockContents).forEach(function (id) {
      result.blockContents[id].forEach(function (e) {
        entry(e.article).locations.push({ block: id, pallets: e.pallets, ageMax: e.ageMax });
      });
    });
    return out;
  }

  return {
    compute: compute,
    toTables: toTables,
    lookup: lookup,
    lookupAll: lookupAll,
    buildState: buildState,
    layerPallets: layerPallets,
    dwellStats: dwellStats_,
    fmtDate: fmtDate_,
    isoDate: iso_,
    tsText: ts_
  };
}

var Engine = EngineModule_();
