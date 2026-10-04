/**
 * EXP2 Digital Twin - calculation engine.
 *
 * Pure JavaScript, no Google services. The same source runs in Apps Script (var Engine = EngineModule_()),
 * in the browser (the template injects EngineModule_.toString()) and in the Node tests
 * (tests/engine.test.js reproduces every CALC_* tab of sample-data/csv).
 *
 *   Engine.compute(input)             -> result (result.state = compact JSON for the screens)
 *   Engine.toTables(result)           -> { CALC_STOCK: [headers, ...rows], CALC_EN_ATTENTE, ..., CALC_KPI }
 *   Engine.lookup(result, article)    -> { article, stock, fifo, pending, exits, locations }
 *   Engine.lookupAll(result)          -> { article: lookup(result, article) } for every article, in one pass
 *   Engine.buildState(result, extras) -> compact state (docs/ARCHITECTURE.md section 8)
 *
 * input (dates as 'yyyy-mm-dd'): { asOf, plant, movements, opening, articles, blocks, rules, mvtKinds, docks,
 *   thresholds } as in docs/ARCHITECTURE.md section 4, plus optional state extras: layout (CFG.DEFAULT_LAYOUT
 *   shape), version, computedAt, importedAt, source ('SIMULATION' | 'SAP'), openingDate.
 *
 * Quantities are handled in milli-units (integers) so FIFO arithmetic stays exact for KG articles.
 * Tables write dates as 'dd.mm.yyyy' strings and blank cells as ''.
 */
function EngineModule_() {
  var MAGS = ['PRD2', 'EXP2', 'EMRT'];
  var TO_PLACE_ID = 'À PLACER';
  var TO_PLACE_LABEL = 'Hors capacité des blocs (placeholder)';
  var ORIGIN_OPENING = 'Stock initial';
  var NO_FAMILY = 'Sans famille';
  var DAY_MS = 86400000;
  var MAX_LISTED_ALERTS = 20;
  var EXTRA_FAMILY_COLORS = ['#d9d2f0', '#f6d8bd', '#cfe0f5', '#e2e2e2', '#f3e3a6', '#cbe9dc', '#f2cfcf', '#dfe8c4'];
  var DEFAULT_THRESHOLDS = { satWarn: 0.85, satCrit: 0.95, pendingDaysWarn: 3, dockStagingWarn: 0.85 };

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

  function numOrNull_(v) {
    var n = num_(v);
    return isNaN(n) ? null : n;
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

  function daysBetween_(from, to) {
    return dayNum_(to) - dayNum_(from);
  }

  function fmtDate_(iso) {
    return iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '';
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

  function frPct_(fraction) {
    var p = round_(fraction * 100, 1);
    return frNum_(p, p === Math.round(p) ? 0 : 1) + '\u00a0%';
  }

  function plural_(n, one, many) {
    return n + ' ' + (n > 1 ? many : one);
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

  // Rules sorted by priority, ARTICLE before FAMILLE at equal priority, then sheet order.
  function normRules_(rows) {
    var out = [];
    (rows || []).forEach(function (r, i) {
      if (!r) return;
      var criterion = str_(r.criterion).toUpperCase();
      if (criterion !== 'ARTICLE' && criterion !== 'FAMILLE') return;
      var blocks = Array.isArray(r.blocks) ? r.blocks : str_(r.blocks).split(/[,;\s]+/);
      blocks = blocks.map(str_).filter(function (b) { return b; });
      var value = criterion === 'ARTICLE' ? article_(r.value) : str_(r.value);
      if (!value || !blocks.length) return;
      var p = num_(r.priority);
      out.push({ priority: isNaN(p) ? 1e9 : p, criterion: criterion, value: value, blocks: blocks, i: i });
    });
    out.sort(function (a, b) {
      return (a.priority - b.priority) || ((a.criterion === 'ARTICLE' ? 0 : 1) - (b.criterion === 'ARTICLE' ? 0 : 1)) || (a.i - b.i);
    });
    return out;
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
    var plant = str_(input.plant !== undefined && input.plant !== null ? input.plant : C.PLANT);
    var diag = { invalid: 0, otherPlant: 0, unknownMvt: {}, ignored: 0, beforeOpening: 0, future: 0, negativeOpening: 0,
      otherMag: {}, unpaired: [], negative: [] };

    var master = normArticles_(input.articles);
    var blocks = normBlocks_(input.blocks);
    var capacity = blocks.reduce(function (s, b) { return s + b.capacity; }, 0);
    function qppOf_(art) {
      var m = master.get(art);
      return m ? m.qppM : 0;
    }

    // Opening stock (one layer per row, origin 'Stock initial').
    var openRows = [];
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
      if (q === 0) return;
      openRows.push({ art: art, mag: mag, qty: q, uqs: str_(o.uqs), designation: str_(o.designation), date: iso_(o.date) });
    });
    var openDate = iso_(input.openingDate);
    if (!openDate) {
      openRows.forEach(function (r) {
        if (r.date && (!openDate || r.date < openDate)) openDate = r.date;
      });
    }

    // Movements: filter, then sort by date, doc, issuing line before receiving line, file order.
    var dataSource = 'SAP';
    var all = [];
    (input.movements || []).forEach(function (m, idx) {
      if (!m) return;
      var art = article_(m.article), mag = str_(m.magasin).toUpperCase(), mvt = str_(m.mvt), date = iso_(m.date);
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
      var kind = has_(kinds, mvt) ? str_(kinds[mvt]).toUpperCase() : '';
      if (!kind) {
        diag.unknownMvt[mvt] = (diag.unknownMvt[mvt] || 0) + 1;
        return;
      }
      if (kind === 'IGNORE') {
        diag.ignored++;
        return;
      }
      if (openDate && date < openDate) {
        diag.beforeOpening++;
        return;
      }
      if (qty === 0) return;
      if (str_(m.source).toUpperCase() === 'SIMULATION') dataSource = 'SIMULATION';
      all.push({ i: idx, art: art, mag: mag, mvt: mvt, kind: kind, rev: /_REV$/.test(kind), doc: str_(m.doc), date: date,
        qty: qty, uqs: str_(m.uqs), designation: str_(m.designation) });
    });
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
      return cmp_(a.date, b.date) || cmp_(a.doc, b.doc) || ((a.qty < 0 ? 0 : 1) - (b.qty < 0 ? 0 : 1)) || (a.i - b.i);
    });
    if (!openDate) openDate = lines.length ? addDays_(lines[0].date, -1) : asOf;

    var byDoc = new Map();
    lines.forEach(function (l) {
      if (!l.doc) return;
      var g = byDoc.get(l.doc);
      if (!g) byDoc.set(l.doc, g = []);
      g.push(l);
    });
    // Magasin of the other leg of the same document (same article, opposite sign).
    function pairedMag_(l) {
      var g = l.doc ? byDoc.get(l.doc) : null;
      if (!g) return '';
      for (var i = 0; i < g.length; i++) {
        var o = g[i];
        if (o !== l && o.art === l.art && (o.qty > 0) !== (l.qty > 0)) return o.mag;
      }
      return '';
    }

    // Article info: opening rows first, then movements, then ARTICLES (same priority as the oracle).
    var info = new Map();
    function setInfo_(art, designation, uqs) {
      if (!info.has(art)) info.set(art, { designation: designation, uqs: uqs });
    }
    openRows.forEach(function (r) { setInfo_(r.art, r.designation, r.uqs); });
    lines.forEach(function (l) { setInfo_(l.art, l.designation, l.uqs); });
    master.forEach(function (m) { setInfo_(m.article, m.designation, m.uqs); });
    info.forEach(function (v, art) {
      var m = master.get(art);
      if (m) {
        if (!v.designation) v.designation = m.designation;
        if (!v.uqs) v.uqs = m.uqs;
      }
    });

    // FIFO layers per (article, magasin).
    var buckets = new Map();
    var seq = 0;
    function bucket_(art, mag) {
      var key = art + '|' + mag;
      var b = buckets.get(key);
      if (!b) buckets.set(key, b = { art: art, mag: mag, layers: [], total: 0 });
      return b;
    }
    openRows.forEach(function (r) {
      var b = bucket_(r.art, r.mag);
      b.layers.push({ date: r.date || openDate, doc: '', qty: r.qty, origin: ORIGIN_OPENING, mvt: '', seq: seq++ });
      b.total += r.qty;
    });
    function magPallets_(mag) {
      var t = 0;
      buckets.forEach(function (b) {
        if (b.mag !== mag || b.total <= 0) return;
        var q = qppOf_(b.art);
        if (q) t += ceilDiv_(b.total, q);
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
    function apply_(l, day) {
      var q = qppOf_(l.art);
      var abs = Math.abs(l.qty);
      var pal = q ? ceilDiv_(abs, q) : 0;
      var b = bucket_(l.art, l.mag);
      var pm = pairedMag_(l);
      if ((l.kind === 'TRANSFER' || l.kind === 'TRANSFER_REV') && !pm) diag.unpaired.push(l);
      if (l.qty > 0) {
        b.layers.push({ date: l.date, doc: l.doc, qty: l.qty, origin: pm || (l.kind === 'DECL' ? 'PRD2' : 'MvT ' + l.mvt),
          mvt: l.mvt, seq: seq++ });
        b.total += l.qty;
        if (l.mag === 'EXP2' && !l.rev) day.entries += pal;
      } else {
        var need = abs, chunks = [];
        if (b.total < need) {
          diag.negative.push({ art: l.art, mag: l.mag, doc: l.doc, date: l.date, missing: need - b.total, uqs: l.uqs });
          need = b.total;
        }
        while (need > 0) {
          var L = l.rev ? b.layers[b.layers.length - 1] : b.layers[0];
          var take = Math.min(need, L.qty);
          L.qty -= take;
          b.total -= take;
          need -= take;
          chunks.push({ date: L.date, origin: L.origin, take: take });
          if (L.qty === 0) {
            if (l.rev) b.layers.pop();
            else b.layers.shift();
          }
        }
        if (l.mag === 'EXP2' && !l.rev) {
          day.exits += pal;
          var dest = destination_(l, pm);
          chunks.forEach(function (c) {
            exits.push({ article: l.art, dateIn: c.date, dateOut: l.date, qty: c.take / 1000, pallets: q ? ratio_(c.take, q, 2) : null,
              destination: dest, stay: daysBetween_(c.date, l.date), doc: l.doc, mvt: l.mvt, origin: c.origin });
          });
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
      var day = { date: isoOfDay_(dn), declared: 0, entries: 0, exits: 0, stockEnd: 0, saturation: null, pendingEnd: 0 };
      while (p < lines.length && lines[p].date === day.date) apply_(lines[p++], day);
      day.stockEnd = magPallets_('EXP2');
      day.saturation = ratio_(day.stockEnd, capacity, 4);
      day.pendingEnd = magPallets_('PRD2');
      daily.push(day);
    }

    // Stock per article.
    var arts = Array.from(info.keys()).sort();
    var stockByArt = {};
    var stock = arts.map(function (art) {
      var m = master.get(art), q = m ? m.qppM : 0, inf = info.get(art);
      var row = { article: art, designation: inf.designation, uqs: inf.uqs, qpp: q ? m.qpp : null, family: m ? m.family : '',
        known: !!q, inArticles: !!m, qty: {}, pallets: {} };
      MAGS.forEach(function (mag) {
        var b = buckets.get(art + '|' + mag), tot = b ? b.total : 0;
        row.qty[mag] = tot / 1000;
        row.pallets[mag] = q ? ceilDiv_(tot, q) : null;
      });
      stockByArt[art] = row;
      return row;
    });
    var unknown = stock.filter(function (s) { return !s.known; }).map(function (s) { return s.article; });

    // Remaining layers: PRD2 = pending, EXP2 = FIFO.
    var pending = [], fifo = [];
    buckets.forEach(function (b) {
      if (b.mag !== 'PRD2' && b.mag !== 'EXP2') return;
      var live = b.layers.filter(function (L) { return L.qty > 0; });
      if (!live.length) return;
      var q = qppOf_(b.art);
      var pals = q ? layerPallets(live.map(function (L) { return L.qty; }), q) : null;
      var s = stockByArt[b.art];
      live.forEach(function (L, i) {
        var days = daysBetween_(L.date, asOf);
        var row = { article: b.art, designation: s.designation, uqs: s.uqs, date: L.date, doc: L.doc, origin: L.origin,
          qty: L.qty / 1000, pallets: pals ? pals[i] : null, seq: L.seq };
        if (b.mag === 'PRD2') {
          row.days = days;
          pending.push(row);
        } else {
          row.age = days;
          fifo.push(row);
        }
      });
    });
    pending.sort(function (a, b) {
      return cmp_(a.date, b.date) || cmp_(a.doc, b.doc) || cmp_(a.article, b.article) || (a.seq - b.seq);
    });
    fifo.sort(function (a, b) {
      return cmp_(a.article, b.article) || cmp_(a.date, b.date) || cmp_(a.doc, b.doc) || (a.seq - b.seq);
    });

    var placement = place_(stock, fifo, blocks, normRules_(input.rules && input.rules.length ? input.rules : C.DEFAULT_RULES));

    // KPIs.
    var docks = normDocks_(input.docks);
    function sumMag_(mag) {
      return stock.reduce(function (s, r) { return s + (r.pallets[mag] || 0); }, 0);
    }
    var exp2Pallets = sumMag_('EXP2');
    var last = daily.length && daily[daily.length - 1].date === asOf ? daily[daily.length - 1] : null;
    var staged = docks.reduce(function (s, d) { return s + d.staged; }, 0);
    var dockCap = docks.reduce(function (s, d) { return s + d.capacity; }, 0);
    var stuck = pending.filter(function (x) { return x.days >= thr.pendingDaysWarn; });
    var refDate = addDays_(asOf, -7), ref = null;
    daily.forEach(function (d) {
      if (d.date === refDate) ref = d.stockEnd;
    });
    if (ref === null && openDate === refDate) ref = openPallets.EXP2;
    var netPerDay = ref === null ? null : (exp2Pallets - ref) / 7;
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
      netPerDay: netPerDay === null ? null : round_(netPerDay, 2)
    };

    var result = {
      asOf: asOf,
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
      openPallets: openPallets,
      counts: { movements: (input.movements || []).length, processed: lines.length, opening: openRows.length,
        invalid: diag.invalid, otherPlant: diag.otherPlant, ignored: diag.ignored, beforeOpening: diag.beforeOpening,
        afterAsOf: diag.future, unpaired: diag.unpaired.length, negative: diag.negative.length }
    };
    result.alerts = alerts_(result, diag, stuck, thr);
    result.computeMs = Date.now() - started;
    result.state = buildState(result, {
      layout: input.layout, version: input.version, computedAt: input.computedAt, importedAt: input.importedAt, source: input.source
    });
    return result;
  }

  // ---------------------------------------------------------------------------------------------
  // Placement (placeholder until the real rules): an article goes to the blocks of the first matching rule;
  // the pallets of a rule are spread over its blocks in proportion to their free capacity (largest remainder,
  // ties to the first block); what does not fit goes to 'À PLACER'. Articles fill the blocks in article order,
  // oldest pallets first, which gives blockContents.
  // ---------------------------------------------------------------------------------------------
  function place_(stock, fifo, blocks, rules) {
    var byId = {}, used = {}, contents = {}, labels = {};
    blocks.forEach(function (b) {
      byId[b.id] = b;
      used[b.id] = 0;
      contents[b.id] = [];
      labels[b.id] = [];
    });
    rules.forEach(function (r) {
      r.blocks.forEach(function (id) {
        if (byId[id] && labels[id].indexOf(r.value) < 0) labels[id].push(r.value);
      });
    });
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
        if ((r.criterion === 'ARTICLE' && r.value === s.article) || (r.criterion === 'FAMILLE' && s.family && r.value === s.family)) {
          groups[i].items.push(s);
          return;
        }
      }
      noRule.push(s);
    });

    var toPlaceItems = [];
    function entry_(s, n, age) {
      return { article: s.article, designation: s.designation, family: s.family, pallets: n, ageMax: age };
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
    groups.forEach(function (g) {
      if (!g.items.length) return;
      var P = g.items.reduce(function (s, x) { return s + x.pallets.EXP2; }, 0);
      var ids = [];
      g.rule.blocks.forEach(function (id) {
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
      var draw = drawer_(g.items);
      ids.forEach(function (id, i) {
        draw(alloc[i], function (e) {
          contents[id].push(e);
          used[id] += e.pallets;
        });
      });
      draw(Infinity, function (e) { toPlaceItems.push(e); });
    });
    noRule.forEach(function (s) { drawer_([s])(Infinity, function (e) { toPlaceItems.push(e); }); });

    var families = [];
    toPlaceItems.forEach(function (e) {
      var f = e.family || NO_FAMILY;
      if (families.indexOf(f) < 0) families.push(f);
    });
    families.sort();
    var toPlace = {
      id: TO_PLACE_ID,
      label: TO_PLACE_LABEL,
      families: families.join(', '),
      capacity: null,
      pallets: toPlaceItems.reduce(function (s, e) { return s + e.pallets; }, 0),
      saturation: null
    };
    if (toPlaceItems.length) contents[TO_PLACE_ID] = toPlaceItems;
    return {
      blocks: blocks.map(function (b) {
        return { id: b.id, label: b.label, families: labels[b.id].join(', '), capacity: b.capacity, pallets: used[b.id],
          saturation: ratio_(used[b.id], b.capacity, 4) };
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

    diag.negative.slice(0, MAX_LISTED_ALERTS).forEach(function (n) {
      add_('crit', 'NEGATIVE_STOCK', 'Stock négatif ramené à 0 : article ' + n.art + ' en ' + n.mag + ' (Doc.article ' + n.doc +
        ' du ' + fmtDate_(n.date) + ', manque ' + frNum_(n.missing / 1000, n.missing % 1000 ? 3 : 0) + (n.uqs ? ' ' + n.uqs : '') + ')');
    });
    if (diag.negative.length > MAX_LISTED_ALERTS) {
      add_('crit', 'NEGATIVE_STOCK', '… et ' + plural_(diag.negative.length - MAX_LISTED_ALERTS, 'autre ligne', 'autres lignes') + ' en stock négatif');
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
      add_('warn', 'TO_PLACE', plural_(result.toPlace.pallets, 'palette', 'palettes') + ' hors capacité des blocs' +
        (result.toPlace.families ? ' (famille ' + result.toPlace.families + ')' : '') + ' : à placer');
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

    result.stock.forEach(function (s) {
      if (s.known) return;
      if (s.inArticles) {
        add_('warn', 'NO_QPP', 'Article ' + s.article + (s.designation ? ' (' + s.designation + ')' : '') +
          ' : Qté par palette manquante dans l\u2019onglet ARTICLES : complétez-la, puis « Recalculer » (onglet ACCUEIL)');
      } else {
        add_('warn', 'UNKNOWN_ARTICLE', 'Article ' + s.article + (s.designation ? ' (' + s.designation + ')' : '') +
          ' absent de l\u2019onglet ARTICLES : ajoutez sa quantité par palette dans ARTICLES, puis « Recalculer » (onglet ACCUEIL)');
      }
    });

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
  // Compact state for the screens (docs/ARCHITECTURE.md section 8).
  // extras: { version, computedAt, importedAt, source, layout }
  // ---------------------------------------------------------------------------------------------
  function buildState(result, extras) {
    extras = extras || {};
    var L = extras.layout || cfg_().DEFAULT_LAYOUT || {};
    var kpi = {};
    for (var key in result.kpi) if (has_(result.kpi, key)) kpi[key] = result.kpi[key];
    return {
      version: extras.version !== undefined ? extras.version : null,
      asOf: result.asOf,
      computedAt: extras.computedAt || new Date().toISOString(),
      importedAt: extras.importedAt || null,
      source: extras.source || result.dataSource || 'SAP',
      layout: {
        building: L.building || null,
        blocks: result.blockDefs.map(function (b) {
          var row = result.blocks.filter(function (x) { return x.id === b.id; })[0];
          return { id: b.id, label: b.label, x: b.x, y: b.y, w: b.w, h: b.h, cols: b.cols, rows: b.rows, levels: b.levels,
            color: b.color, capacity: b.capacity, families: row ? row.families : '' };
        }),
        truckZone: L.truckZone || L.truck_zone || null,
        quais: L.quais || [],
        quaiLine: L.quaiLine || L.quai_common || null,
        roads: L.roads || [],
        zones: L.zones || []
      },
      kpi: kpi,
      blocks: result.blocks.map(function (b) {
        return { id: b.id, label: b.label, families: b.families, capacity: b.capacity, pallets: b.pallets, saturation: b.saturation };
      }),
      blockContents: result.blockContents,
      families: result.families,
      daily: result.daily.map(function (d) {
        return { date: d.date, declared: d.declared, entries: d.entries, exits: d.exits, stockEnd: d.stockEnd,
          saturation: d.saturation, pendingEnd: d.pendingEnd };
      }),
      pending: result.pending.map(function (x) {
        return { article: x.article, designation: x.designation, date: x.date, doc: x.doc, qty: x.qty, pallets: x.pallets, days: x.days };
      }),
      docks: result.docks,
      alerts: result.alerts
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Sheet tables (CALC_* tabs): [headers, ...rows], dates as dd.mm.yyyy, blanks as ''.
  // ---------------------------------------------------------------------------------------------
  function kpiRows_(result) {
    var k = result.kpi, day = fmtDate_(result.asOf);
    var ids = result.blocks.map(function (b) { return b.id; });
    var range = ids.length > 1 ? ids[0] + '-' + ids[ids.length - 1] : (ids[0] || '');
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
        ' (palettes non calculables)']
    ];
  }

  function toTables(result) {
    var H = cfg_().HEADERS;
    if (!H) throw new Error('CFG.HEADERS introuvable : charger Config.gs avant Engine.gs');
    function table_(name, rows) {
      return [H[name].slice()].concat(rows);
    }
    var blocRows = result.blocks.concat([result.toPlace]).map(function (b) {
      return [b.id, b.label, b.families, blank_(b.capacity), b.pallets, blank_(b.saturation)];
    });
    return {
      CALC_STOCK: table_('CALC_STOCK', result.stock.map(function (s) {
        return [s.article, s.designation, s.uqs, s.qpp === null ? 'INCONNU' : s.qpp, s.qty.PRD2, blank_(s.pallets.PRD2),
          s.qty.EXP2, blank_(s.pallets.EXP2), s.qty.EMRT, blank_(s.pallets.EMRT)];
      })),
      CALC_EN_ATTENTE: table_('CALC_EN_ATTENTE', result.pending.map(function (x) {
        return [x.article, x.designation, fmtDate_(x.date), x.doc, x.qty, blank_(x.pallets), x.days];
      })),
      CALC_FIFO_EXP2: table_('CALC_FIFO_EXP2', result.fifo.map(function (f) {
        return [f.article, f.designation, fmtDate_(f.date), f.doc, f.origin, f.qty, blank_(f.pallets), f.age];
      })),
      CALC_SORTIES: table_('CALC_SORTIES', result.exits.map(function (x) {
        return [x.article, fmtDate_(x.dateIn), fmtDate_(x.dateOut), x.qty, blank_(x.pallets), x.destination, x.stay, x.doc];
      })),
      CALC_JOURNALIER: table_('CALC_JOURNALIER', result.daily.map(function (d) {
        return [fmtDate_(d.date), d.declared, d.entries, d.exits, d.stockEnd, blank_(d.saturation), d.pendingEnd];
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
    var stock = { article: s.article, designation: s.designation, uqs: s.uqs, qpp: s.qpp, family: s.family, known: s.known };
    MAGS.forEach(function (mag) {
      stock[mag] = { qty: s.qty[mag], pallets: s.pallets[mag] };
    });
    return stock;
  }

  function lookupFifo_(f) {
    return { date: f.date, doc: f.doc, origin: f.origin, qty: f.qty, pallets: f.pallets, age: f.age };
  }

  function lookupPending_(x) {
    return { date: x.date, doc: x.doc, qty: x.qty, pallets: x.pallets, days: x.days };
  }

  function lookupExit_(x) {
    return { dateIn: x.dateIn, dateOut: x.dateOut, qty: x.qty, pallets: x.pallets, destination: x.destination, stay: x.stay, doc: x.doc };
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
        out[art] = { article: art, stock: null, fifo: [], pending: [], exits: [], locations: [] };
      }
      return out[art];
    }
    result.stock.forEach(function (s) {
      var e = entry(s.article);
      if (!e.stock) e.stock = lookupStock_(s);
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
    fmtDate: fmtDate_,
    isoDate: iso_
  };
}

var Engine = EngineModule_();
