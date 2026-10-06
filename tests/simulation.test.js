'use strict';
// Simulation v2 invariants (docs/SPEC_V2.md 6): real MB51 format (labels, entry times, night posting rule),
// determinism, articles and projects, PRD2 -> EXP2 lags, re-scans, exits per truck, EXP2 saturation, the PRD2 waits
// at the end of the period, nextDay continuity, mb51Rows through the normaliser, and Engine.compute on the data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGs, SRC } = require('./lib/load-gs');

const has = name => fs.existsSync(path.join(SRC, name + '.gs'));
const HAS_ENGINE = has('Engine');
const HAS_NORM = has('Normalize');
const ctx = loadGs(['Config'].concat(HAS_NORM ? ['Normalize'] : [], HAS_ENGINE ? ['Engine'] : [], ['Simulation']));
const CFG = ctx.CFG;
const Sim = ctx.Sim;
const Norm = HAS_NORM ? ctx.Norm : null;
const Engine = HAS_ENGINE ? ctx.Engine : null;

let XLSX = null;
try {
  XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
} catch (e) {
  XLSX = null;
}
const FIXTURE = path.join(__dirname, '..', 'sample-data', 'mb51-reel', 'MB51_reel_anonymise.xlsx');

const CAPACITY = CFG.DEFAULT_LAYOUT.blocks.reduce((s, b) => s + b.cols * b.rows * b.levels, 0);
const QPP_SET = new Set([6, 8, 12, 15, 18, 24, 50, 60, 80, 84]);
const PROJECT_BLOCKS = { ATLAS: ['B1', 'B7'], BOREAL: ['B2', 'B8'], CORSO: ['B3'], DELTA: ['B4'], ETNA: ['B5'], FJORD: ['B6'] };
const USERS = new Set(['BARFLOW_TA11', 'ADMINJOB', 'OPERATEUR01', 'OPERATEUR02', 'OPERATEUR03']);
const DOCK_COLORS = { Q01: 'bleu', Q02: 'rouge', Q04: 'vert', Q05: 'gris', Q07: 'jaune' };
const DOCK_STATUSES = new Set(['Chargement', 'En attente', 'Chargé', 'Libre']);
const LINE_FIELDS = ['key', 'article', 'division', 'magasin', 'mvt', 'text', 's', 'doc', 'poste', 'date', 'qty', 'uqs',
  'designation', 'user', 'ts', 'label', 'headerText', 'itemText', 'reference', 'client', 'salesOrder', 'source'];
const NORM_FIELDS = LINE_FIELDS.filter(f => f !== 'source');
const TEXTS = { '131': 'Entrée marchandises', '311': 'TR dans division', '601': 'SM livraison' };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const json = v => JSON.stringify(v);
// Objects made in the vm context belong to another realm: compare plain copies.
const plain = v => JSON.parse(JSON.stringify(v));
const same = (actual, expected, msg) => assert.deepStrictEqual(plain(actual), plain(expected), msg);
const milli = q => Math.round(Number(q) * 1000);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sec = ts => Date.parse(ts.replace(' ', 'T') + 'Z') / 1000;
const hoursBetween = (a, b) => (sec(b) - sec(a)) / 3600;
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// Posting date of an entry time: entries between 00:00 and 01:59 belong to the previous day.
const postingDate = ts => new Date((sec(ts) - 7200) * 1000).toISOString().slice(0, 10);
const quantile = (sorted, p) => sorted[Math.ceil(p * sorted.length) - 1];
const maxTs = lines => lines.reduce((m, l) => (l.ts > m ? l.ts : m), '');

// Engine processing order (docs/SPEC_V2.md 4.3): date, entry time, Doc.article, issuing line first, file order.
function engineOrder(movements) {
  return movements.map((m, i) => ({ m, i }))
    .sort((a, b) => cmp(a.m.date, b.m.date) || cmp(a.m.ts, b.m.ts) || cmp(a.m.doc, b.m.doc) ||
      ((a.m.qty < 0 ? 0 : 1) - (b.m.qty < 0 ? 0 : 1)) || (a.i - b.i))
    .map(x => x.m);
}

function qppMap(articles) {
  const out = {};
  for (const a of articles) out[a.article] = milli(a.qpp);
  return out;
}

function byDoc(movements) {
  const docs = new Map();
  for (const m of movements) {
    if (!docs.has(m.doc)) docs.set(m.doc, []);
    docs.get(m.doc).push(m);
  }
  return docs;
}

// Label-aware stock replay written independently of Simulation.gs (rules of docs/SPEC_V2.md 4.4): a labeled issue
// takes its own label, then the unlabeled layers (FIFO); an unlabeled issue takes FIFO over every layer. Throws on a
// missing quantity (negative stock). Counts 601 lines that would cut a label in two (exits must take whole labels).
class Ledger {
  constructor(opening, qpp) {
    this.qpp = qpp;
    this.buckets = new Map();
    this.cutLabels = 0;
    for (const o of opening) this.bucket(o.article, o.magasin).push({ qty: milli(o.qty), label: '', ts: '' });
  }

  bucket(art, mag) {
    const k = art + '|' + mag;
    if (!this.buckets.has(k)) this.buckets.set(k, []);
    return this.buckets.get(k);
  }

  add(l) {
    const layers = this.bucket(l.article, l.magasin);
    const q = milli(l.qty);
    if (q > 0) {
      layers.push({ qty: q, label: l.label, ts: l.ts });
      return;
    }
    let need = -q;
    const takeFrom = L => {
      const t = Math.min(need, L.qty);
      if (l.mvt === '601' && L.label && t < L.qty) this.cutLabels++;
      L.qty -= t;
      need -= t;
    };
    if (l.label) {
      for (const L of layers) if (need > 0 && L.qty > 0 && L.label === l.label) takeFrom(L);
      for (const L of layers) if (need > 0 && L.qty > 0 && !L.label) takeFrom(L);
    } else {
      for (const L of layers) if (need > 0 && L.qty > 0) takeFrom(L);
    }
    if (need > 0) throw new Error(`negative stock: ${l.article} ${l.magasin} doc ${l.doc} ${l.ts} label ${l.label} missing ${need / 1000}`);
    this.buckets.set(l.article + '|' + l.magasin, layers.filter(L => L.qty > 0));
  }

  // Applies lines already in engine order; onDayEnd(date) after the last line of each posting date.
  apply(lines, onDayEnd) {
    lines.forEach((l, i) => {
      this.add(l);
      if (onDayEnd && (i === lines.length - 1 || lines[i + 1].date !== l.date)) onDayEnd(l.date);
    });
  }

  // Pallets with labelIsPallet: one per live label + ceil(unlabeled / qpp).
  pallets(mag) {
    let n = 0;
    for (const [k, layers] of this.buckets) {
      const [art, m] = k.split('|');
      if (m !== mag) continue;
      const unl = layers.filter(L => !L.label).reduce((s, L) => s + L.qty, 0);
      n += layers.filter(L => L.label).length + (unl > 0 ? ceilDiv(unl, this.qpp[art]) : 0);
    }
    return n;
  }

  labels(mag) {
    const out = [];
    for (const [k, layers] of this.buckets) {
      const [art, m] = k.split('|');
      if (m === mag) for (const L of layers) if (L.label) out.push({ article: art, label: L.label, ts: L.ts });
    }
    return out;
  }
}

function replay(data, movements) {
  const ledger = new Ledger(data.opening, qppMap(data.articles));
  ledger.apply(engineOrder(movements || data.movements));
  return ledger;
}

// Labels waiting in PRD2 at the time of the data, by band (hours >= 6, 4 <= hours < 6).
function pendingBands(ledger, asOfTs) {
  const over = [], warn = [];
  for (const p of ledger.labels('PRD2')) {
    const h = hoursBetween(p.ts, asOfTs);
    if (h >= 6) over.push(p.label);
    else if (h >= 4) warn.push(p.label);
  }
  return { over: over.sort(), warn: warn.sort() };
}

// PRD2 -> EXP2 lag of every label transferred after its declaration (re-scans excluded), in hours.
function lags(movements) {
  const declared = new Map(), done = new Set(), out = [];
  for (const m of movements) {
    if (m.mvt === '131' && m.magasin === 'PRD2') declared.set(m.label, m.ts);
    if (m.mvt === '311' && m.magasin === 'PRD2' && m.qty < 0 && declared.has(m.label) && !done.has(m.label)) {
      done.add(m.label);
      out.push(hoursBetween(declared.get(m.label), m.ts));
    }
  }
  return out.sort((a, b) => a - b);
}

function engineInput(data, movements, docks, asOf) {
  return {
    asOf, plant: 'TA11', movements, opening: data.opening, articles: data.articles, projects: data.projects,
    blocks: CFG.DEFAULT_LAYOUT.blocks, rules: CFG.DEFAULT_RULES, mvtKinds: CFG.MVT_KINDS, docks,
    thresholds: CFG.THRESHOLDS, computedAt: '2026-10-06T00:00:00.000Z', version: 1
  };
}

function fixtureHeader() {
  if (!XLSX || !fs.existsSync(FIXTURE)) return null;
  const wb = XLSX.readFile(FIXTURE);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' })[0];
}

function fixtureArticles() {
  if (!XLSX || !fs.existsSync(FIXTURE)) return new Set();
  const wb = XLSX.readFile(FIXTURE);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  return new Set(rows.slice(1).map(r => String(r[0])));
}

// ---------------------------------------------------------------------------------------------
// Shared datasets
// ---------------------------------------------------------------------------------------------
const GEN = Sim.generate();
const QPP = qppMap(GEN.articles);
const INFO = {};
for (const a of GEN.articles) INFO[a.article] = a;
const LEDGER = replay(GEN);

let chainCache = null;
// generate (5 days, 300 labels a day) + 12 nextDay calls (the volume is estimated from the data).
function chain() {
  if (chainCache) return chainCache;
  const base = Sim.generate({ seed: 'chaîne', days: 5, palletsPerDay: 300 });
  let movements = base.movements.slice();
  const steps = [];
  for (let i = 0; i < 12; i++) {
    const res = Sim.nextDay({ seed: 'chaîne', movements, opening: base.opening, articles: base.articles });
    steps.push({ res, prevAsOf: i ? steps[i - 1].res.asOf : base.asOf, prevMovements: movements });
    movements = movements.concat(res.movements);
  }
  chainCache = { base, steps, movements };
  return chainCache;
}

// ---------------------------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------------------------
test('generate is deterministic: same parameters -> identical output, another seed -> other data', () => {
  assert.equal(json(Sim.generate()), json(GEN));
  assert.equal(json(Sim.generate({})), json(GEN), 'defaults');
  assert.equal(json(Sim.generate({ seed: '2026', endDate: '2026-10-05', days: 7, palletsPerDay: 450 })), json(GEN),
    'explicit defaults, text seed');
  const other = Sim.generate({ seed: 2027 });
  assert.notEqual(json(other.movements), json(GEN.movements));
  assert.notEqual(json(other.articles.map(a => a.article)), json(GEN.articles.map(a => a.article)), 'codes drawn per seed');
});

test('parameters: 7 days ending 2026-10-05 by default, startDate / endDate, limits, every day a working day', () => {
  assert.equal(GEN.asOf, '2026-10-05');
  assert.equal(GEN.openingDate, '2026-09-28');
  same(GEN.params, { seed: '2026', startDate: '2026-09-29', endDate: '2026-10-05', days: 7, palletsPerDay: 450,
    edgeCases: true, capacity: CAPACITY });
  same([...new Set(GEN.movements.map(m => m.date))].sort(),
    ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'], 'Saturday and Sunday included');
  const fwd = Sim.generate({ startDate: '2026-10-03', days: 2, palletsPerDay: 40 });
  assert.equal(fwd.params.endDate, '2026-10-04');
  assert.equal(fwd.asOf, '2026-10-04');
  assert.equal(fwd.openingDate, '2026-10-02');
  const back = Sim.generate({ endDate: '2026-09-30', days: 3, palletsPerDay: 40 });
  assert.equal(back.params.startDate, '2026-09-28');
  const both = Sim.generate({ startDate: '2026-09-19', endDate: '2026-10-03', days: 14, palletsPerDay: 20 });
  assert.equal(both.asOf, '2026-10-03', 'endDate wins over a start date computed with v1 weeks');
  assert.equal(both.params.startDate, '2026-09-20');
  assert.equal(Sim.generate({ days: 0, palletsPerDay: 5 }).params.days, 1);
  assert.equal(Sim.generate({ days: 1, palletsPerDay: 5 }).params.palletsPerDay, 20);
  assert.equal(Sim.generate({ days: 1, palletsPerDay: 99999 }).params.palletsPerDay, 1500);
  assert.equal(Sim.generate({ days: 1, palletsPerDay: 30, edgeCases: 'non' }).params.edgeCases, false);
  assert.equal(Sim.generate({ days: 1, palletsPerDay: 30, blocks: [{ id: 'B1', capacity: 500 }] }).params.capacity, 500);
  assert.equal(Sim.nextWorkingDay('2026-10-03'), '2026-10-04');
  assert.equal(Sim.nextWorkingDay('2026-10-04'), '2026-10-05');
  assert.equal(Sim.nextWorkingDay('2026-12-31'), '2027-01-01');
  assert.equal(Sim.isWorkingDay('2026-10-04'), true, 'Sunday');
});

test('articles and projects: 36 fictional finished goods, 6 projects with blocks and colors, 3 without project', () => {
  const arts = GEN.articles;
  assert.equal(arts.length, 36);
  assert.equal(new Set(arts.map(a => a.article)).size, 36);
  assert.equal(json(arts.map(a => a.article)), json(arts.map(a => a.article).slice().sort()), 'sorted by article');
  const real = fixtureArticles();
  for (const a of arts) {
    assert.match(a.article, /^([A-Z]{2}\d{5}|58\d{6})$/, a.article);
    assert.ok(!real.has(a.article), `${a.article} is a code of the real export`);
    assert.ok(a.designation && a.designation.length <= 40 && a.designation === a.designation.toUpperCase(), a.designation);
    assert.equal(a.uqs, 'PCE');
    assert.ok(QPP_SET.has(a.qpp), `${a.article} qpp ${a.qpp}`);
    assert.equal(a.family, '');
    assert.ok(a.project === '' || PROJECT_BLOCKS[a.project], a.project);
    if (a.project) assert.ok(a.designation.includes(a.project), `${a.designation} names its project`);
    assert.ok(['EUR 1200x800', 'ISO 1200x1000'].includes(a.palletType));
    assert.ok(a.heightCm >= 100 && a.heightCm <= 170 && [1, 2, 3].includes(a.levels));
  }
  assert.equal(arts.filter(a => !a.project).length, 3);
  same(GEN.projects.map(p => p.project), ['ATLAS', 'BOREAL', 'CORSO', 'DELTA', 'ETNA', 'FJORD']);
  for (const p of GEN.projects) {
    same(p.blocks, PROJECT_BLOCKS[p.project]);
    assert.match(p.color, /^#[0-9a-f]{6}$/);
    assert.ok(p.comment);
    assert.ok(arts.some(a => a.project === p.project), `${p.project} has articles`);
  }
  assert.equal(new Set(GEN.projects.map(p => p.color)).size, 6, 'distinct colors');
  for (const c of GEN.projects.map(p => p.color)) assert.ok(!['#d03b3b', '#fab219', '#2a78d6'].includes(c));
  // Blocks missing from the given layout are left out of the projects.
  const small = Sim.generate({ days: 1, palletsPerDay: 30, blocks: [{ id: 'B1', capacity: 200 }, { id: 'B2', capacity: 100 }] });
  same(small.projects.map(p => p.blocks.join(',')), ['B1', 'B2', '', '', '', '']);
});

test('opening stock: unlabeled EXP2 rows the day before the first day, ~55 % of the places', () => {
  const ledger = new Ledger(GEN.opening, QPP);
  const exp2 = ledger.pallets('EXP2');
  assert.ok(exp2 / CAPACITY >= 0.53 && exp2 / CAPACITY <= 0.58, `EXP2 ${exp2} / ${CAPACITY}`);
  for (const o of GEN.opening) {
    assert.ok(INFO[o.article]);
    assert.equal(o.magasin, 'EXP2');
    assert.equal(o.division, 'TA11');
    assert.equal(o.date, GEN.openingDate);
    assert.equal(o.uqs, 'PCE');
    assert.equal(o.designation, INFO[o.article].designation);
    assert.ok(o.qty > 0 && o.qty % INFO[o.article].qpp === 0, 'whole pallets');
  }
  assert.equal(new Set(GEN.opening.map(o => o.article)).size, GEN.opening.length, 'one row per article');
});

test('lines: every normaliser field, real-format keys, documents increasing with time, night posting rule', () => {
  const keys = new Set();
  let prev = null;
  for (const m of GEN.movements) {
    same(Object.keys(m), LINE_FIELDS, 'field list');
    assert.equal(m.source, 'SIMULATION');
    assert.equal(m.division, 'TA11');
    assert.equal(m.s, '');
    assert.equal(m.poste, '', 'no Poste in the real export');
    assert.match(m.doc, /^69\d{8}$/);
    assert.match(m.ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(m.date, postingDate(m.ts), `night posting rule: ${m.ts} -> ${m.date}`);
    assert.equal(m.text, TEXTS[m.mvt], m.mvt);
    assert.ok(['PRD2', 'EXP2', 'EMRT'].includes(m.magasin));
    assert.ok(USERS.has(m.user), m.user);
    assert.ok(Number.isInteger(m.qty) && m.qty !== 0, `PCE quantity ${m.qty}`);
    assert.equal(m.uqs, INFO[m.article].uqs);
    assert.equal(m.designation, INFO[m.article].designation);
    assert.ok(!keys.has(m.key), `duplicate key ${m.key}`);
    keys.add(m.key);
    if (Norm) assert.equal(m.key, Norm.keyOf(m, 1), 'key = Norm.keyOf (no Poste)');
    if (prev) {
      assert.ok(m.ts >= prev.ts, `time order: ${prev.ts} then ${m.ts}`);
      assert.ok(m.doc >= prev.doc, `Doc.article increases with time: ${prev.doc} then ${m.doc}`);
    }
    prev = m;
  }
  const night = GEN.movements.filter(m => m.ts.slice(11, 13) < '02');
  assert.ok(night.length > 300, `night entries ${night.length}`);
  assert.ok(night.every(m => m.date === addDays(m.ts.slice(0, 10), -1)), 'night entries posted on the previous day');
  assert.ok(GEN.movements.every(m => m.date >= GEN.params.startDate && m.date <= GEN.asOf));
  assert.ok(GEN.movements.length >= 8000 && GEN.movements.length <= 13000, `about 10k lines: ${GEN.movements.length}`);
  for (const [doc, lines] of byDoc(GEN.movements)) {
    assert.equal(new Set(lines.map(l => l.mvt)).size, 1, `${doc}: one MvT`);
    assert.equal(new Set(lines.map(l => l.ts)).size, 1, `${doc}: one entry time`);
  }
});

test('declarations: one 131 per label, sequential unique labels, header texts, ~7 % into EXP2, hourly profile', () => {
  const decl = GEN.movements.filter(m => m.mvt === '131');
  const n = decl.length;
  assert.ok(n >= 0.93 * 450 * 7 && n <= 1.07 * 450 * 7, `declared ${n}`);
  const labels = decl.map(m => Number(m.label));
  assert.equal(new Set(labels).size, n, 'labels unique');
  assert.equal(Math.min(...labels), 434500000, 'first label');
  assert.equal(Math.max(...labels), 434500000 + n - 1, 'sequential, no gap');
  for (let i = 1; i < labels.length; i++) assert.ok(labels[i] > labels[i - 1], 'numbered in time order');
  let plain = 0, stamped = 0;
  for (const m of decl) {
    assert.ok(m.qty > 0 && m.qty <= INFO[m.article].qpp, `${m.label}: ${m.qty} of ${INFO[m.article].qpp}`);
    assert.equal(m.itemText, '');
    assert.equal(m.reference + m.client + m.salesOrder, '');
    const h = /^(\d{9})(?:(\|)(\d{14})|_1\|(\d{12}))?$/.exec(m.headerText);
    assert.ok(h, m.headerText);
    assert.equal(h[1], m.label);
    if (Norm) assert.equal(Norm.labelOf({ mvt: '131', headerText: m.headerText, itemText: '' }), m.label);
    if (!h[2] && !h[4]) plain++;
    if (h[3]) {
      stamped++;
      // UTC stamp of the label (Central European summer time: 2 h behind the entry), 2-20 s before the entry.
      const stamp = h[3].replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3 $4:$5:$6');
      const gap = sec(m.ts) - sec(stamp) - 7200;
      assert.ok(gap >= 2 && gap <= 20, `${m.headerText} vs ${m.ts}`);
    }
  }
  assert.ok(stamped / n >= 0.7 && plain / n >= 0.1 && plain / n <= 0.3, `stamped ${stamped}, plain ${plain} / ${n}`);
  const direct = decl.filter(m => m.magasin === 'EXP2').length;
  assert.ok(direct / n >= 0.05 && direct / n <= 0.09, `direct EXP2 ${direct} / ${n}`);
  const auto = decl.filter(m => m.user === 'BARFLOW_TA11').length;
  assert.ok(auto / n >= 0.97 && auto < n, `automatic ${auto} / ${n}`);
  const partial = decl.filter(m => m.qty < INFO[m.article].qpp).length;
  assert.ok(partial / n >= 0.01 && partial / n <= 0.035, `partial labels ${partial}`);
  // Hourly profile of the real export: production around the clock, dips at the breaks and shift changes.
  const hours = new Array(24).fill(0);
  for (const m of decl) hours[Number(m.ts.slice(11, 13))]++;
  assert.ok(hours.every(c => c > 0), 'around the clock');
  for (const [low, high] of [[8, 6], [11, 12], [16, 17], [22, 21], [23, 2]]) {
    assert.ok(hours[low] < 0.75 * hours[high], `hour ${low} (${hours[low]}) below hour ${high} (${hours[high]})`);
  }
});

test('transfers: two legs per article and document, TA11P1 headers, label in Texte, declared before', () => {
  const declTs = new Map(GEN.movements.filter(m => m.mvt === '131').map(m => [m.label, m]));
  const flows = new Map();
  let prevTa = '';
  for (const [doc, lines] of byDoc(GEN.movements)) {
    if (lines[0].mvt !== '311') continue;
    const arts = new Set(lines.map(l => l.article));
    assert.equal(lines.length, 2 * arts.size, `${doc}: two legs per article`);
    for (const art of arts) {
      const legs = lines.filter(l => l.article === art);
      assert.equal(legs[0].qty, -legs[1].qty, `${doc} ${art}: opposite quantities`);
      assert.ok(legs[0].qty < 0, `${doc}: issuing leg first`);
      assert.notEqual(legs[0].magasin, legs[1].magasin);
      const flow = `${legs[0].magasin}>${legs[1].magasin}`;
      flows.set(flow, (flows.get(flow) || 0) + 1);
    }
    if (lines[0].label) {
      assert.equal(lines.length, 2);
      assert.match(lines[0].headerText, /^TA11P1\d{8}$/);
      assert.ok(lines.every(l => l.itemText === l.label && l.headerText === lines[0].headerText && l.label === lines[0].label));
      assert.ok(lines[0].headerText > prevTa, `TA numbers increase with time: ${prevTa} then ${lines[0].headerText}`);
      prevTa = lines[0].headerText;
      const d = declTs.get(lines[0].label);
      assert.ok(d, `label ${lines[0].label} was declared`);
      assert.equal(d.article, lines[0].article);
      assert.ok(d.ts < lines[0].ts, `declared before: ${d.ts} < ${lines[0].ts}`);
      assert.equal(Math.abs(lines[0].qty), d.qty, 'the whole label moves');
      if (Norm) assert.equal(Norm.labelOf(lines[0]), lines[0].label);
    } else {
      // Manual EXP2 -> EMRT move: no label, header 'Lot ddmmyyyy' (the day before the entry), an operator.
      assert.match(lines[0].headerText, /^Lot \d{8}$/);
      const lot = lines[0].headerText.slice(4);
      assert.equal(`${lot.slice(4)}-${lot.slice(2, 4)}-${lot.slice(0, 2)}`, addDays(lines[0].ts.slice(0, 10), -1));
      assert.ok(lines.every(l => /^OPERATEUR0[1-3]$/.test(l.user) && l.itemText === '' && l.label === ''));
      assert.ok(lines.every(l => (l.qty < 0 ? l.magasin === 'EXP2' : l.magasin === 'EMRT')));
    }
  }
  same([...flows.keys()].sort(), ['EXP2>EMRT', 'EXP2>PRD2', 'PRD2>EXP2']);
  const transfers = GEN.movements.filter(m => m.mvt === '311' && m.magasin === 'PRD2' && m.qty < 0);
  assert.ok(transfers.filter(m => m.user === 'BARFLOW_TA11').length / transfers.length > 0.97, 'scans');
});

test('PRD2 -> EXP2 lags: median ~35 min, 90 % under 2 h, ~2 % 4-6 h, ~1 % over 6 h; re-scans 10-60 s apart', () => {
  const l = lags(GEN.movements);
  const n = l.length;
  assert.ok(n > 2700, `transfers ${n}`);
  const median = quantile(l, 0.5);
  assert.ok(median >= 0.45 && median <= 0.75, `median ${median}`);
  assert.ok(l.filter(h => h < 2).length / n >= 0.9, '90 % under 2 h');
  const warn = l.filter(h => h >= 4 && h < 6).length / n, crit = l.filter(h => h >= 6).length / n;
  assert.ok(warn >= 0.012 && warn <= 0.03, `4-6 h: ${warn}`);
  assert.ok(crit >= 0.005 && crit <= 0.018, `over 6 h: ${crit}`);
  assert.ok(l[0] >= 5 / 60 - 1e-9 && l[n - 1] <= 12.01, `range ${l[0]} - ${l[n - 1]}`);
  // Re-scans: EXP2 -> PRD2 then PRD2 -> EXP2 10-60 s later, same label.
  const docs = [...byDoc(GEN.movements).values()];
  const back = docs.filter(d => d[0].mvt === '311' && d[0].magasin === 'EXP2' && d[1].magasin === 'PRD2' && d[0].label);
  const labels = GEN.movements.filter(m => m.mvt === '131').length;
  assert.ok(back.length / labels >= 0.008 && back.length / labels <= 0.025, `re-scans ${back.length} / ${labels}`);
  for (const d of back) {
    const again = docs.find(o => o[0].label === d[0].label && o[0].magasin === 'PRD2' && o[0].ts > d[0].ts);
    assert.ok(again, `label ${d[0].label} scanned again`);
    const gap = sec(again[0].ts) - sec(d[0].ts);
    assert.ok(gap >= 10 && gap <= 60, `re-scan gap ${gap} s`);
    assert.equal(again[0].qty, d[0].qty);
  }
  // Without edge cases: no long wait, no re-scan, no manual move, no partial label.
  const clean = Sim.generate({ days: 3, palletsPerDay: 200, edgeCases: false });
  const cl = lags(clean.movements);
  assert.ok(cl[cl.length - 1] < 4, `max lag ${cl[cl.length - 1]}`);
  assert.ok(!clean.movements.some(m => m.magasin === 'EMRT' || (m.mvt === '311' && m.magasin === 'EXP2' && m.qty < 0)));
  same([clean.facts.pendingOver6h.length, clean.facts.pending4to6h.length], [0, 0]);
  const cq = qppMap(clean.articles);
  assert.ok(clean.movements.filter(m => m.mvt === '131').every(m => milli(m.qty) === cq[m.article]));
});

test('exits per truck: whole labels of the oldest stock, clients and sales orders, ~14 trucks a day, EXP2 60-85 %', () => {
  const trucks = [...byDoc(GEN.movements).values()].filter(d => d[0].mvt === '601');
  const perDay = {};
  for (const t of trucks) {
    perDay[t[0].date] = (perDay[t[0].date] || 0) + 1;
    assert.equal(new Set(t.map(l => l.article)).size, t.length, 'one line per article');
    assert.ok(t.every(l => l.magasin === 'EXP2' && l.qty < 0 && l.label === '' && l.itemText === ''));
    assert.match(t[0].client, /^CLIENT [A-D]$/);
    assert.match(t[0].salesOrder, /^\d{10}$/);
    assert.match(t[0].reference, /^\d{10}$/);
    assert.ok(t.every(l => l.client === t[0].client && l.salesOrder === t[0].salesOrder && l.reference === t[0].reference));
    assert.ok(['ADMINJOB', 'OPERATEUR01', 'OPERATEUR02', 'OPERATEUR03'].includes(t[0].user));
    const pallets = t.reduce((s, l) => s + Math.round(-milli(l.qty) / QPP[l.article] + 0.49), 0);
    assert.ok(pallets <= 33 + t.length, `truck ${t[0].doc}: ${pallets} pallets`);
  }
  assert.equal(new Set(trucks.map(t => t[0].salesOrder)).size, trucks.length, 'one sales order per truck');
  const days = Object.keys(perDay).sort();
  assert.equal(days.length, 7);
  for (const d of days.slice(1)) assert.ok(perDay[d] >= 10 && perDay[d] <= 19, `${d}: ${perDay[d]} trucks`);
  // Replay: never more than the stock, 601 lines take whole labels, saturation in range every day.
  const sat = {};
  const ledger = new Ledger(GEN.opening, QPP);
  ledger.apply(engineOrder(GEN.movements), d => { sat[d] = ledger.pallets('EXP2') / CAPACITY; });
  assert.equal(ledger.cutLabels, 0, 'exits take whole labels');
  for (const d of days) assert.ok(sat[d] >= 0.6 && sat[d] <= 0.85, `${d}: saturation ${sat[d]}`);
  for (const params of [{ seed: 11, days: 20, palletsPerDay: 120 }, { seed: 'x', days: 3, palletsPerDay: 1500 },
    { seed: 'y', days: 10, palletsPerDay: 20 }]) {
    const data = Sim.generate(params);
    const lg = new Ledger(data.opening, qppMap(data.articles));
    const s = [];
    assert.doesNotThrow(() => lg.apply(engineOrder(data.movements), () => s.push(lg.pallets('EXP2') / CAPACITY)), json(params));
    assert.equal(lg.cutLabels, 0);
    assert.ok(Math.min(...s.slice(1)) >= 0.58 && Math.max(...s) <= 0.87, `${json(params)}: ${s.map(x => x.toFixed(2))}`);
  }
});

test('end of the period: 2-4 labels waiting over 6 h and 2-4 between 4 and 6 h, listed in facts', () => {
  const cases = [[GEN, LEDGER]];
  for (const params of [{ seed: 1 }, { seed: 'b', days: 2, palletsPerDay: 20 }, { seed: 'c', days: 1, palletsPerDay: 1500 },
    { seed: 'd', days: 4, palletsPerDay: 60, endDate: '2026-03-29' }]) {
    const data = Sim.generate(params);
    cases.push([data, replay(data)]);
  }
  for (const [data, ledger] of cases) {
    const f = data.facts;
    const name = json(data.params);
    assert.equal(f.asOfTs, maxTs(data.movements), name);
    assert.ok(f.asOfTs > data.asOf + ' 23:00:00' && f.asOfTs < addDays(data.asOf, 1) + ' 02:00:00', `${name}: ${f.asOfTs}`);
    const bands = pendingBands(ledger, f.asOfTs);
    same(f.pendingOver6h.map(p => p.label).sort(), bands.over, name);
    same(f.pending4to6h.map(p => p.label).sort(), bands.warn, name);
    assert.ok(bands.over.length >= 2 && bands.over.length <= 4, `${name}: over 6 h ${bands.over.length}`);
    assert.ok(bands.warn.length >= 2 && bands.warn.length <= 4, `${name}: 4-6 h ${bands.warn.length}`);
    for (const p of f.pendingOver6h.concat(f.pending4to6h)) {
      assert.equal(p.hours, Math.round(hoursBetween(p.ts, f.asOfTs) * 100) / 100);
      assert.ok(p.hours < 13, `${p.label} waits ${p.hours} h`);
      const d = data.movements.find(m => m.mvt === '131' && m.label === p.label);
      assert.ok(d && d.magasin === 'PRD2' && d.ts === p.ts && d.article === p.article, p.label);
      assert.equal(p.project, data.articles.find(a => a.article === p.article).project);
    }
    for (let i = 1; i < f.pendingOver6h.length; i++) assert.ok(f.pendingOver6h[i - 1].hours >= f.pendingOver6h[i].hours, 'oldest first');
    assert.equal(f.pendingLabels, ledger.labels('PRD2').length);
  }
});

test('facts are consistent with the lines', () => {
  const f = GEN.facts, mv = GEN.movements;
  const decl = mv.filter(m => m.mvt === '131');
  assert.equal(f.lines, mv.length);
  assert.equal(f.declared, decl.length);
  assert.equal(f.directExp2, decl.filter(m => m.magasin === 'EXP2').length);
  assert.equal(f.transfers + f.rescans, mv.filter(m => m.mvt === '311' && m.label && m.magasin === 'PRD2' && m.qty < 0).length);
  assert.equal(f.rescans, mv.filter(m => m.mvt === '311' && m.label && m.magasin === 'EXP2' && m.qty < 0).length);
  assert.equal(f.trucks, new Set(mv.filter(m => m.mvt === '601').map(m => m.doc)).size);
  assert.equal(f.exitLines, mv.filter(m => m.mvt === '601').length);
  assert.equal(f.manualMoves, new Set(mv.filter(m => /^Lot /.test(m.headerText)).map(m => m.doc)).size);
  same(f.labels, { first: '434500000', last: String(434500000 + decl.length - 1) });
  same(f.docs, { first: mv[0].doc, last: mv[mv.length - 1].doc });
  assert.equal(f.exp2Pallets, LEDGER.pallets('EXP2'));
  assert.equal(f.saturation, Math.round(f.exp2Pallets / CAPACITY * 10000) / 10000);
});

test('docks: 8 quais, trucks of the sketch, consistent pallet counts, varying with seed and day', () => {
  const seen = new Set();
  const days = [];
  for (let d = '2026-09-21'; d <= '2026-10-31'; d = addDays(d, 1)) days.push(d);
  for (const seed of [2026, 'quai']) {
    for (const d of days) {
      const docks = Sim.makeDocks(seed, d);
      seen.add(json(docks));
      assert.equal(docks.map(x => x.quai).join(','), 'Q01,Q02,Q03,Q04,Q05,Q06,Q07,Q08');
      for (const k of docks) {
        assert.ok(DOCK_STATUSES.has(k.status), k.status);
        assert.equal(k.capacity, 12);
        if (k.status === 'Libre') {
          assert.ok(k.staged === 0 && k.planned === null && k.loaded === null && k.truck === '' && k.color === '');
          continue;
        }
        assert.equal(k.color, DOCK_COLORS[k.quai], `${k.quai} truck color`);
        assert.ok(CFG.COLORS.cabs[k.color]);
        assert.match(k.truck, /^CAM-\d{2}$/);
        assert.ok(k.carrier);
        assert.ok(k.planned >= 1 && k.planned <= 33, `planned ${k.planned}`);
        assert.ok(k.loaded >= 0 && k.loaded <= k.planned, `loaded ${k.loaded}`);
        assert.ok(k.staged >= 0 && k.staged <= 12 && k.staged <= k.planned - k.loaded, `staged ${k.staged}`);
        if (k.status === 'Chargé') assert.ok(k.loaded === k.planned && k.staged === 0);
        if (k.status === 'En attente') assert.equal(k.loaded, 0);
        assert.match(k.arrival, /^\d{2}:\d{2}$/);
        assert.match(k.departure, /^\d{2}:\d{2}$/);
        assert.ok(k.departure > k.arrival);
      }
    }
  }
  assert.ok(seen.size > days.length, 'docks vary with the day and the seed');
  assert.equal(json(GEN.docks), json(Sim.makeDocks(2026, GEN.asOf)));
  const statuses = new Set();
  for (const s of seen) for (const k of JSON.parse(s)) statuses.add(k.status);
  assert.equal(statuses.size, 4, [...statuses].join(','));
});

// ---------------------------------------------------------------------------------------------
// nextDay
// ---------------------------------------------------------------------------------------------
test('nextDay continues dates, labels, documents and TA numbers; no duplicate key; pending labels released', () => {
  const { base, steps } = chain();
  let all = base.movements.slice();
  const keys = new Set(all.map(m => (Norm ? Norm.keyOf(m, 1) : m.key)));
  for (const { res, prevAsOf, prevMovements } of steps) {
    assert.equal(res.asOf, addDays(prevAsOf, 1), 'next calendar day (7 days a week)');
    assert.ok(res.movements.length > 500, `${res.asOf}: ${res.movements.length} lines`);
    const decl = res.movements.filter(m => m.mvt === '131');
    const prevLabels = prevMovements.filter(m => m.label).map(m => Number(m.label));
    const labels = decl.map(m => Number(m.label));
    assert.equal(Math.min(...labels), Math.max(...prevLabels) + 1, `${res.asOf}: labels continue`);
    assert.equal(Math.max(...labels), Math.max(...prevLabels) + labels.length, 'sequential');
    assert.ok(decl.length >= 0.9 * 300 && decl.length <= 1.1 * 300, `${res.asOf}: ${decl.length} labels (volume from the data)`);
    const prevDoc = prevMovements.reduce((m, l) => (l.doc > m ? l.doc : m), '');
    const prevTa = prevMovements.reduce((m, l) => (/^TA11P1/.test(l.headerText) && l.headerText > m ? l.headerText : m), '');
    for (const m of res.movements) {
      same(Object.keys(m), LINE_FIELDS);
      assert.equal(m.date, res.asOf);
      assert.equal(postingDate(m.ts), m.date, 'night posting rule');
      assert.ok(m.doc > prevDoc, `${m.doc} after ${prevDoc}`);
      if (/^TA11P1/.test(m.headerText)) assert.ok(m.headerText > prevTa);
      const k = Norm ? Norm.keyOf(m, 1) : m.key;
      assert.equal(k, m.key);
      assert.ok(!keys.has(k), `duplicate key ${k}`);
      keys.add(k);
    }
    // Labels waiting at the end of the previous day are transferred when due (overdue ones at the start of the day).
    const before = replay(base, prevMovements);
    const moved = new Set(res.movements.filter(m => m.mvt === '311' && m.magasin === 'PRD2' && m.qty < 0).map(m => m.label));
    const dayStart = res.asOf + ' 02:00:00';
    for (const p of before.labels('PRD2')) {
      if (hoursBetween(p.ts, dayStart) > 12.1) assert.ok(moved.has(p.label), `${res.asOf}: overdue label ${p.label} moved`);
    }
    all = all.concat(res.movements);
  }
  // The labels held at the end of generate (over 6 h, 4-6 h) are cleared in the first minutes of the next day.
  const first = steps[0].res.movements;
  for (const p of base.facts.pendingOver6h.concat(base.facts.pending4to6h)) {
    const x = first.find(m => m.mvt === '311' && m.magasin === 'PRD2' && m.label === p.label);
    assert.ok(x, `label ${p.label} transferred`);
    assert.ok(x.ts < steps[0].res.asOf + ' 03:00:00', `${p.label} at ${x.ts}`);
  }
});

test('nextDay keeps every invariant over 12 days: stock, whole labels, saturation, 6 h cases now and then', () => {
  const { base, steps } = chain();
  const ledger = new Ledger(base.opening, qppMap(base.articles));
  ledger.apply(engineOrder(base.movements));
  let daysWithCrit = 0;
  const sats = [];
  for (const { res } of steps) {
    assert.doesNotThrow(() => ledger.apply(engineOrder(res.movements)), res.asOf);
    assert.equal(ledger.cutLabels, 0, `${res.asOf}: exits take whole labels`);
    const sat = ledger.pallets('EXP2') / CAPACITY;
    sats.push(sat);
    assert.ok(sat >= 0.6 && sat <= 0.85, `${res.asOf}: EXP2 saturation ${sat}`);
    const asOfTs = maxTs(res.movements);
    assert.equal(res.facts.asOfTs, asOfTs);
    const bands = pendingBands(ledger, asOfTs);
    same(res.facts.pendingOver6h.map(p => p.label).sort(), bands.over);
    same(res.facts.pending4to6h.map(p => p.label).sort(), bands.warn);
    if (bands.over.length) daysWithCrit++;
    for (const p of ledger.labels('PRD2')) assert.ok(hoursBetween(p.ts, asOfTs) < 13, `${res.asOf}: ${p.label} waits too long`);
    assert.ok(ledger.labels('PRD2').length <= 0.15 * 300, `${res.asOf}: ${ledger.labels('PRD2').length} labels in PRD2`);
  }
  assert.ok(daysWithCrit >= 1 && daysWithCrit <= 9, `days ending with a label over 6 h: ${daysWithCrit}`);
  assert.ok(Math.max(...sats) - Math.min(...sats) > 0.02, 'saturation moves over time');
});

test('nextDay is deterministic and reads sheet values; errors in French', () => {
  const { base, steps } = chain();
  const first = steps[0].res;
  const args = { seed: 'chaîne', movements: base.movements, opening: base.opening, articles: base.articles };
  assert.equal(json(Sim.nextDay(args)), json(first), 'same inputs -> same day');
  assert.equal(json(Sim.nextDay(Object.assign({}, args, { asOf: base.asOf }))), json(first), 'explicit asOf');
  assert.equal(json(Sim.nextDay(Object.assign({}, args, { movements: base.movements.slice().reverse() }))), json(first),
    'row order does not matter');
  // As read back from the sheet: Date cells, numbers for documents and labels, text quantities with a trailing
  // minus, numeric articles with leading zeros.
  const asSheet = base.movements.map(m => Object.assign({}, m, {
    date: new Date(+m.date.slice(0, 4), +m.date.slice(5, 7) - 1, +m.date.slice(8, 10)),
    doc: Number(m.doc),
    label: m.label ? Number(m.label) : '',
    qty: m.qty < 0 ? String(-m.qty) + '-' : String(m.qty),
    article: /^\d+$/.test(m.article) ? '00' + m.article : m.article
  }));
  assert.equal(json(Sim.nextDay(Object.assign({}, args, { movements: asSheet }))), json(first), 'sheet values');
  // Entry times as Date objects (local wall clock) give the same day.
  const withDates = base.movements.map(m => Object.assign({}, m, {
    ts: new Date(+m.ts.slice(0, 4), +m.ts.slice(5, 7) - 1, +m.ts.slice(8, 10), +m.ts.slice(11, 13), +m.ts.slice(14, 16), +m.ts.slice(17, 19))
  }));
  assert.equal(json(Sim.nextDay(Object.assign({}, args, { movements: withDates }))), json(first), 'Date entry times');
  assert.equal(json(first.docks), json(Sim.makeDocks('chaîne', first.asOf)));
  assert.notEqual(json(Sim.nextDay(Object.assign({}, args, { seed: 'autre' })).movements), json(first.movements), 'the seed drives the day');
  const given = Sim.nextDay(Object.assign({}, args, { palletsPerDay: 100 }));
  const n = given.movements.filter(m => m.mvt === '131').length;
  assert.ok(n >= 90 && n <= 110, `palletsPerDay given: ${n}`);
  // ARTICLES without a quantity per pallet: learned from the labels (most frequent quantity).
  const noQpp = base.articles.map(a => Object.assign({}, a, { qpp: '' }));
  const learned = Sim.nextDay(Object.assign({}, args, { articles: noQpp }));
  const qpp = qppMap(base.articles);
  assert.ok(learned.movements.filter(m => m.mvt === '131').filter(m => milli(m.qty) === qpp[m.article]).length > 250);
  // Empty ARTICLES: the articles the simulation declared are produced again (quantity per label learned).
  const noArticles = Sim.nextDay(Object.assign({}, args, { articles: [] }));
  const made = new Set(noArticles.movements.filter(m => m.mvt === '131').map(m => m.article));
  assert.ok(made.size >= 20 && [...made].every(a => qpp[a]), `articles produced: ${made.size}`);
  assert.ok(noArticles.movements.filter(m => m.mvt === '131').every(m => m.designation && m.uqs === 'PCE'));
  // Without the label column (only the texts): the label numbers still continue, never restart.
  const noLabel = base.movements.map(m => Object.assign({}, m, { label: '' }));
  const fromTexts = Sim.nextDay(Object.assign({}, args, { movements: noLabel }));
  assert.equal(fromTexts.movements.find(m => m.mvt === '131').label, first.movements.find(m => m.mvt === '131').label);
  assert.throws(() => Sim.nextDay({ seed: 1, movements: [], opening: [], articles: base.articles }), /aucun mouvement/);
  assert.throws(() => Sim.nextDay({ seed: 1, movements: base.movements.filter(m => m.mvt === '601'), opening: base.opening,
    articles: [] }), /aucun article/);
});

test('nextDay tolerates odd sheet rows: blanks, other plant, ignored or unknown types, inherited names', () => {
  const { base, steps } = chain();
  const d = base.asOf;
  const odd = [null, {}, { article: '', magasin: 'EXP2', mvt: '601', qty: -1, date: d },
    { article: 'constructor', division: 'TA11', magasin: 'EXP2', mvt: '311', doc: '1', qty: 5, date: d, ts: d + ' 10:00:00', label: '__proto__' },
    { article: 'hasOwnProperty', division: 'TB22', magasin: 'EXP2', mvt: '131', doc: '2', qty: 5, date: d, ts: d + ' 10:00:00', label: 'toString' },
    { article: base.articles[0].article, division: 'TA11', magasin: 'PRD2', mvt: '261', doc: '3', qty: -5, date: d },
    { article: base.articles[0].article, division: 'TA11', magasin: 'PRD2', mvt: '999', doc: '4', qty: -5, date: d },
    { article: base.articles[0].article, division: 'TA11', magasin: 'PRD2', mvt: '131', doc: '5', qty: 'abc', date: d }];
  const articles = base.articles.concat([{ article: 'constructor', designation: 'PIECE ETRANGE', uqs: 'PCE', qpp: 5, project: 'hasOwnProperty' }]);
  const res = Sim.nextDay({ seed: 'chaîne', movements: base.movements.concat(odd), opening: base.opening, articles });
  assert.equal(res.asOf, steps[0].res.asOf);
  assert.ok(res.movements.length > 500);
  assert.equal(({}).designation, undefined, 'Object.prototype untouched');
  assert.equal(typeof Object.prototype.qppM, 'undefined');
  assert.ok(res.movements.every(m => m.article && /^69\d{8}$/.test(m.doc) && m.date === res.asOf));
});

test('nextDay on v1 data (no labels, no entry times): unlabeled PRD2 stock moves, labels start, no negative stock', () => {
  const opening = [{ article: '10001234', magasin: 'EXP2', qty: 4800, uqs: 'PC', designation: 'PF ANCIEN', date: '2026-09-20' },
    { article: '10001234', magasin: 'PRD2', qty: 480, uqs: 'PC', designation: 'PF ANCIEN', date: '2026-09-20' }];
  const movements = [{ article: '10001234', division: 'TA11', magasin: 'PRD2', mvt: '101', doc: '4901000001', date: '2026-09-21',
    qty: 240, uqs: 'PC', designation: 'PF ANCIEN', user: 'BARFLOW_TA11', source: 'SIMULATION' }];
  const articles = [{ article: '10001234', designation: 'PF ANCIEN', uqs: 'PC', qpp: 240, family: 'F1' }];
  const res = Sim.nextDay({ seed: 3, movements, opening, articles, palletsPerDay: 20 });
  assert.equal(res.asOf, '2026-09-22');
  const unl = res.movements.filter(m => m.mvt === '311' && !m.label);
  same(unl.map(m => m.magasin + ' ' + m.qty), ['PRD2 -720', 'EXP2 720']);
  assert.equal(res.movements.filter(m => m.mvt === '131')[0].label, '434500000');
  const ledger = new Ledger(opening, { 10001234: 240000 });
  assert.doesNotThrow(() => ledger.apply(engineOrder(movements.map(m => Object.assign({ ts: '', label: '' }, m)).concat(res.movements))));
});

// ---------------------------------------------------------------------------------------------
// mb51Rows
// ---------------------------------------------------------------------------------------------
test('mb51Rows: the 22 real headers, Excel-friendly values, same order without noise', () => {
  const header = fixtureHeader();
  if (header) same(Sim.MB51_HEADERS, header, 'exact headers of the real export');
  const rows = Sim.mb51Rows(GEN.movements);
  same(rows[0], Sim.MB51_HEADERS);
  assert.equal(rows.length, GEN.movements.length + 1);
  const col = name => Sim.MB51_HEADERS.indexOf(name);
  GEN.movements.forEach((m, i) => {
    const r = rows[i + 1];
    assert.equal(r.length, 22);
    assert.equal(r[col('Article')], m.article);
    assert.equal(r[col('Document article')], m.doc);
    assert.equal(r[col('Code mouvement')], m.mvt);
    assert.equal(r[col('Date comptable')], m.date.split('-').reverse().join('.'));
    assert.equal(r[col('Date de saisie')], m.ts.slice(0, 10).split('-').reverse().join('.'));
    assert.equal(r[col('Heure de saisie')], m.ts.slice(11));
    assert.equal(r[col('Qté en unité saisie')], m.qty);
    assert.equal(typeof r[col('Qté en unité saisie')], 'number');
    assert.equal(r[col("Nom de l'utilisateur")], m.user === 'BARFLOW_TA11' ? 'BARFLOWTA11' : m.user);
    assert.equal(r[col("Texte d'en-tête pièce")], m.headerText);
    assert.equal(r[col('Texte')], m.itemText);
    assert.equal(r[col('Montant DI')], 0);
    assert.equal(r[col('Motif du mouvement')], '0');
    assert.equal(r[col('Fournisseur')], '');
  });
  assert.equal(json(Sim.mb51Rows(GEN.movements, { noise: false })), json(rows));
});

test('mb51Rows with noise -> Norm.normalizeBatch(trackedOnly): the noise is dropped, the simulated lines come back',
  { skip: Norm ? false : 'apps-script/src/Normalize.gs not present' }, () => {
    const rows = Sim.mb51Rows(GEN.movements, { noise: true, seed: 7 });
    assert.equal(json(Sim.mb51Rows(GEN.movements, { noise: true, seed: 7 })), json(rows), 'deterministic');
    const noise = rows.length - 1 - GEN.movements.length;
    const decl = GEN.movements.filter(m => m.mvt === '131').length;
    assert.ok(noise >= 0.35 * decl, `noise rows ${noise}`);
    const simArts = new Set(GEN.articles.map(a => a.article));
    const noiseRows = rows.slice(1).filter(r => !simArts.has(r[0]));
    assert.equal(noiseRows.length, noise);
    assert.ok(noiseRows.every(r => r[2] !== 'EXP2'), 'noise never in EXP2');
    assert.ok(noiseRows.some(r => r[3] === '131' && r[2] === 'PRD2' && /^\d{9}\|\d{14}$/.test(r[15])), 'semi-finished declarations');
    assert.ok(noiseRows.some(r => r[3] === '311' && r[2] === 'EMRT') && noiseRows.some(r => r[3] === '311' && r[2] === 'PRD2'), 'raw materials');
    assert.ok(noiseRows.every(r => /^5[67]\d{6}$/.test(r[0])), 'noise codes');
    for (let i = 2; i < rows.length; i++) {
      const a = rows[i - 1][12].split('.').reverse().join('-') + ' ' + rows[i - 1][13];
      const b = rows[i][12].split('.').reverse().join('-') + ' ' + rows[i][13];
      assert.ok(a <= b, 'rows sorted by entry time');
    }

    function check(rows2d, label) {
      const out = Norm.normalizeBatch([{ name: 'MB51_simulation.xlsx', rows: rows2d }], { trackedOnly: true });
      assert.ok(out.ok, label);
      assert.equal(out.rejected.length, 0, label);
      assert.equal(out.untracked.lines, noise, `${label}: exactly the noise is dropped`);
      assert.equal(out.lines.length, GEN.movements.length, label);
      same(out.batchTracked, [...simArts].sort(), label);
      const byKey = new Map(out.lines.map(l => [l.key, l]));
      for (const m of GEN.movements) {
        const l = byKey.get(m.key);
        assert.ok(l, `${label}: line ${m.key}`);
        for (const f of NORM_FIELDS) assert.equal(l[f], m[f], `${label}: ${m.key} ${f}`);
      }
      assert.ok(out.summary.format.hasTime && out.summary.format.hasLabels && out.summary.format.columns === 22, label);
    }
    check(rows, 'rows');
    if (XLSX) {
      // Through a real .xlsx file, as the import page reads it.
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'MB51');
      const back = XLSX.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
      check(XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], Norm.SHEETJS_OPTIONS), 'xlsx');
    }
    // nextDay lines too (keys stay unique against the generated ones).
    const { base, steps } = chain();
    const out = Norm.normalizeBatch([{ name: 'j1.xlsx', rows: Sim.mb51Rows(steps[0].res.movements, { noise: true, seed: 1 }) }],
      { trackedOnly: true, tracked: base.articles.map(a => a.article), existingKeys: base.movements.map(m => m.key) });
    assert.equal(out.lines.length, steps[0].res.movements.length);
    assert.equal(out.duplicates.length, 0);
  });

// ---------------------------------------------------------------------------------------------
// Safety, performance, engine
// ---------------------------------------------------------------------------------------------
test('Simulation.gs: Apps Script safe syntax, browser copy without CFG, inputs not mutated', () => {
  const src = fs.readFileSync(path.join(SRC, 'Simulation.gs'), 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\?\?/);
  assert.doesNotMatch(src, /[\w\])]\?\.[A-Za-z_$]/);
  assert.doesNotMatch(src, /^\s*await\b/m);
  assert.doesNotMatch(src, /=>/, 'no arrow function');
  assert.doesNotMatch(src, /\b(let|const)\s/, 'var only');
  assert.doesNotMatch(src, /`/, 'no template literal');
  assert.doesNotMatch(src, new RegExp(['v', 'a', 'l', 'e', 'o'].join(''), 'i'));
  assert.match(src, /^function SimulationModule_\(\) \{/m);
  assert.match(src, /^var Sim = SimulationModule_\(\);/m);
  // The factory source alone (as injected in the browser, no Config.gs) gives the same data.
  const bare = vm.createContext({});
  const browserSim = vm.runInContext(`(${ctx.SimulationModule_.toString()})()`, bare);
  const small = { seed: 5, days: 2, palletsPerDay: 120 };
  const ref = Sim.generate(small);
  assert.equal(json(browserSim.generate(small)), json(ref));
  const nd = { seed: 5, movements: ref.movements, opening: ref.opening, articles: ref.articles };
  assert.equal(json(browserSim.nextDay(nd)), json(Sim.nextDay(nd)));
  assert.equal(json(browserSim.mb51Rows(ref.movements, { noise: true })), json(Sim.mb51Rows(ref.movements, { noise: true })));
  // Nothing modifies what it is given.
  const before = json([ref.movements, ref.opening, ref.articles]);
  Sim.nextDay(nd);
  Sim.mb51Rows(ref.movements, { noise: true, seed: 3 });
  assert.equal(json([ref.movements, ref.opening, ref.articles]), before);
});

test('performance: generate with the defaults takes less than 2 s of CPU', () => {
  Sim.generate({ seed: 'chauffe', days: 1 });
  const t0 = process.cpuUsage();
  Sim.generate({ seed: 'perf' });
  const used = process.cpuUsage(t0);
  const ms = (used.user + used.system) / 1000;
  assert.ok(ms < 2000, `generate: ${ms} ms`);
});

test('Engine.compute on simulated data: no negative stock, PRD2_CRIT at the end, saturation, dwell, projects',
  { skip: HAS_ENGINE ? false : 'apps-script/src/Engine.gs not present' }, () => {
    const result = Engine.compute(engineInput(GEN, GEN.movements, GEN.docks, GEN.asOf));
    const codes = result.alerts.map(a => a.code);
    for (const bad of ['NEGATIVE_STOCK', 'UNPAIRED_TRANSFER', 'UNKNOWN_MVT', 'INVALID_LINE', 'OTHER_PLANT', 'BEFORE_OPENING',
      'UNKNOWN_ARTICLE', 'PENDING_STUCK']) {
      assert.ok(!codes.includes(bad), `${bad}: ${result.alerts.filter(a => a.code === bad).map(a => a.text).join(' | ')}`);
    }
    assert.equal(codes[0], 'PRD2_CRIT', 'PRD2_CRIT first');
    assert.ok(codes.includes('PRD2_WARN'));
    assert.ok(codes.includes('NO_PROJECT'));
    const k = result.kpi;
    assert.equal(result.dataSource, 'SIMULATION');
    assert.equal(result.asOf, GEN.asOf);
    assert.equal(k.asOfTs, GEN.facts.asOfTs);
    assert.equal(k.pendingCrit, GEN.facts.pendingOver6h.length);
    assert.equal(k.pendingWarn, GEN.facts.pending4to6h.length);
    assert.equal(k.pendingLabels, GEN.facts.pendingLabels);
    assert.equal(k.exp2Pallets, GEN.facts.exp2Pallets);
    assert.equal(k.exp2Pallets, LEDGER.pallets('EXP2'), 'engine and replay agree on EXP2 pallets');
    assert.equal(k.pendingPallets, LEDGER.pallets('PRD2'));
    assert.ok(k.saturation >= 0.6 && k.saturation <= 0.85, `saturation ${k.saturation}`);
    assert.ok(k.dwellMedianH >= 0.3 && k.dwellMedianH <= 1, `dwell median ${k.dwellMedianH}`);
    assert.ok(k.dwellP90H >= k.dwellMedianH && k.dwellP90H <= 2.5, `dwell P90 ${k.dwellP90H}`);
    assert.ok(k.oldestPendingHours >= 6 && k.oldestPendingHours < 13, `oldest ${k.oldestPendingHours}`);
    assert.equal(k.noProjectArticles, 3);
    assert.equal(k.trackedArticles, 36);
    assert.equal(result.counts.processed, GEN.movements.length);
    assert.equal(result.counts.negative, 0);
    assert.equal(result.counts.preData, 0);
    assert.equal(result.counts.untracked, 0);
    assert.equal(result.counts.unpaired, 0);
    for (const d of result.daily) {
      assert.ok(d.saturation >= 0.6 && d.saturation <= 0.85, `${d.date} ${d.saturation}`);
      assert.ok(d.dwellMedianH >= 0.3 && d.dwellMedianH <= 1, `${d.date} dwell ${d.dwellMedianH}`);
      assert.ok(d.declared >= 0.9 * 450 && d.declared <= 1.1 * 450, `${d.date} declared ${d.declared}`);
    }
    for (const p of GEN.projects) assert.equal(result.projects[p.project], p.color, p.project);
    const titles = {};
    for (const b of result.blocks) titles[b.id] = b.title;
    for (const p of GEN.projects) for (const b of p.blocks) assert.equal(titles[b], p.project);
    for (const b of result.blocks) assert.ok(b.saturation <= 1, `${b.id} ${b.saturation}`);
    assert.ok(result.toPlace.pallets <= 60, `to place ${result.toPlace.pallets}`);

    // After 12 nextDay calls.
    const { base, steps, movements } = chain();
    const last = steps[steps.length - 1].res;
    const after = Engine.compute(engineInput(base, movements, last.docks, last.asOf));
    const afterCodes = after.alerts.map(a => a.code);
    assert.ok(!afterCodes.includes('NEGATIVE_STOCK') && !afterCodes.includes('UNPAIRED_TRANSFER'), afterCodes.join(','));
    assert.equal(after.counts.negative, 0);
    assert.equal(after.asOf, last.asOf);
    assert.equal(after.kpi.asOfTs, last.facts.asOfTs);
    assert.equal(after.kpi.pendingCrit, last.facts.pendingOver6h.length);
    assert.ok(after.kpi.saturation >= 0.6 && after.kpi.saturation <= 0.85);
    assert.ok(after.kpi.dwellMedianH >= 0.3 && after.kpi.dwellMedianH <= 1);
  });
