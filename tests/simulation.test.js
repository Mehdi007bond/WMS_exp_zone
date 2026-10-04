'use strict';
// Simulation invariants: determinism, MB51 line shape, transfer pairs, no negative stock when replayed in the
// engine's order, daily volumes, edge cases, docks, nextDay continuity over 30 days, and Engine.compute on the
// simulated data (when Engine.gs exists).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGs, SRC } = require('./lib/load-gs');

const HAS_ENGINE = fs.existsSync(path.join(SRC, 'Engine.gs'));
const ctx = loadGs(HAS_ENGINE ? ['Config', 'Engine', 'Simulation'] : ['Config', 'Simulation']);
const CFG = ctx.CFG;
const Sim = ctx.Sim;
const Engine = HAS_ENGINE ? ctx.Engine : null;

const CAPACITY = CFG.DEFAULT_LAYOUT.blocks.reduce((s, b) => s + b.cols * b.rows * b.levels, 0);
const PC_QPP = new Set([24, 36, 48, 60, 72, 96, 120, 144, 200, 240, 320, 480]);
const KG_QPP = new Set([400, 500, 600, 750]);
const E_QPP = new Set([48, 60, 72]);
const DOCK_COLORS = { Q01: 'bleu', Q02: 'rouge', Q04: 'vert', Q05: 'gris', Q07: 'jaune' };
const DOCK_STATUSES = new Set(['Chargement', 'En attente', 'Chargé', 'Libre']);
const MAGS = new Set(['PRD2', 'EXP2', 'EMRT']);
const BASE = { seed: 2026, startDate: '2026-09-21', days: 14, palletsPerDay: 70 };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const json = v => JSON.stringify(v);
const milli = q => Math.round(Number(q) * 1000);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
const dayNum = iso => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
const weekday = iso => new Date(dayNum(iso) * 86400000).getUTCDay();
const isoOf = n => new Date(n * 86400000).toISOString().slice(0, 10);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function nextWorkingDay(iso) {
  let n = dayNum(iso) + 1;
  while (weekday(isoOf(n)) === 0) n++;
  return isoOf(n);
}

function workingDays(from, to) {
  const out = [];
  for (let n = dayNum(from); n <= dayNum(to); n++) if (weekday(isoOf(n)) !== 0) out.push(isoOf(n));
  return out;
}

// Engine processing order: date, Doc.article, issuing line before receiving line, file order.
function engineOrder(movements) {
  return movements.map((m, i) => ({ m, i }))
    .sort((a, b) => cmp(a.m.date, b.m.date) || cmp(a.m.doc, b.m.doc) || ((a.m.qty < 0 ? 0 : 1) - (b.m.qty < 0 ? 0 : 1)) || (a.i - b.i))
    .map(x => x.m);
}

function qppMap(articles) {
  const out = {};
  for (const a of articles) out[a.article] = milli(a.qpp);
  return out;
}

// Totals per (article, magasin) and PRD2 FIFO layers (reversals LIFO), replayed like the engine.
class Ledger {
  constructor(opening, qpp) {
    this.qpp = qpp;
    this.tot = new Map();
    this.prd2 = new Map();
    for (const o of opening) this.add(o.article, o.magasin, milli(o.qty), { doc: '', date: o.date, mvt: 'INIT' });
  }

  add(art, mag, q, layer) {
    const key = art + '|' + mag;
    const have = this.tot.get(key) || 0;
    const next = have + q;
    if (next < 0) throw new Error(`negative stock: ${art} ${mag} ${have / 1000} ${q / 1000} (doc ${layer.doc}, ${layer.date})`);
    this.tot.set(key, next);
    if (mag !== 'PRD2') return;
    const layers = this.prd2.get(art) || [];
    this.prd2.set(art, layers);
    if (q > 0) {
      layers.push(Object.assign({ qty: q }, layer));
      return;
    }
    let need = -q;
    const lifo = /_REV$/.test(CFG.MVT_KINDS[layer.mvt] || '');
    while (need > 0) {
      const L = lifo ? layers[layers.length - 1] : layers[0];
      const take = Math.min(need, L.qty);
      L.qty -= take;
      need -= take;
      if (L.qty === 0) (lifo ? layers.pop() : layers.shift());
    }
  }

  // Applies lines (already in engine order); calls onDayEnd(date) after the last line of each date.
  apply(lines, onDayEnd) {
    lines.forEach((l, i) => {
      this.add(l.article, l.magasin, milli(l.qty), { doc: l.doc, date: l.date, mvt: l.mvt });
      if (onDayEnd && (i === lines.length - 1 || lines[i + 1].date !== l.date)) onDayEnd(l.date);
    });
  }

  pallets(mag) {
    let n = 0;
    for (const [key, q] of this.tot) {
      const [art, m] = key.split('|');
      if (m === mag && q > 0 && this.qpp[art]) n += ceilDiv(q, this.qpp[art]);
    }
    return n;
  }
}

// Declared pallets per date: ceil(qty / qpp) per 101 line minus the 102 lines (unknown article: 1 per line).
function declaredByDate(movements, qpp) {
  const out = {};
  for (const m of movements) {
    if (m.mvt !== '101' && m.mvt !== '102') continue;
    const p = qpp[m.article] ? ceilDiv(Math.abs(milli(m.qty)), qpp[m.article]) : 1;
    out[m.date] = (out[m.date] || 0) + (m.mvt === '101' ? p : -p);
  }
  return out;
}

function sumByDate(movements, qpp, filter) {
  const out = {};
  for (const m of movements) {
    if (!filter(m)) continue;
    const p = qpp[m.article] ? ceilDiv(Math.abs(milli(m.qty)), qpp[m.article]) : 1;
    out[m.date] = (out[m.date] || 0) + p;
  }
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

function assertTransferPairs(movements) {
  const flows = new Set();
  for (const [doc, lines] of byDoc(movements)) {
    if (lines[0].mvt !== '311' && lines[0].mvt !== '312') continue;
    assert.equal(lines.length, 2, `transfer ${doc}: ${lines.length} lines`);
    const [a, b] = lines;
    assert.equal(a.article, b.article, `transfer ${doc}: same article`);
    assert.equal(a.mvt, b.mvt, `transfer ${doc}: same MvT`);
    assert.equal(a.date, b.date, `transfer ${doc}: same date`);
    assert.notEqual(a.magasin, b.magasin, `transfer ${doc}: different magasin`);
    assert.equal(milli(a.qty), -milli(b.qty), `transfer ${doc}: opposite quantities`);
    assert.ok(a.qty < 0 && b.qty > 0, `transfer ${doc}: issuing leg first`);
    assert.equal(a.poste + '/' + b.poste, '1/2', `transfer ${doc}: postes`);
    flows.add(`${a.mvt} ${a.magasin}>${b.magasin}`);
  }
  return flows;
}

function assertLineShape(m, articleInfo, from, to) {
  assert.equal(m.key, m.doc + '|' + m.poste, `key of ${m.doc}`);
  assert.equal(m.division, 'TA11');
  assert.equal(m.source, 'SIMULATION');
  assert.match(m.doc, /^49\d{8}$/);
  assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(weekday(m.date), 0, `Sunday line ${m.key}`);
  assert.ok(m.date >= from && m.date <= to, `date ${m.date} outside ${from}..${to}`);
  assert.ok(MAGS.has(m.magasin), m.magasin);
  assert.ok(['101', '102', '311', '312', '601'].includes(m.mvt), m.mvt);
  assert.equal(m.text, CFG.MVT_TEXTS[m.mvt]);
  assert.ok(m.s === '' || m.s === 'E', `S ${m.s}`);
  assert.equal(typeof m.qty, 'number');
  assert.ok(m.qty !== 0 && Number.isFinite(m.qty));
  assert.ok(m.user && m.designation, `user / designation of ${m.key}`);
  const info = articleInfo[m.article];
  if (info) {
    assert.equal(m.uqs, info.uqs, `UQS of ${m.article}`);
    assert.equal(m.designation, info.designation);
  }
  if (m.uqs === 'PC') assert.ok(Number.isInteger(m.qty), `PC quantity ${m.qty}`);
  else assert.equal(Math.abs(milli(m.qty)) % 250, 0, `KG granularity ${m.qty}`);
  if (m.mvt === '101') assert.ok(m.magasin === 'PRD2' && m.qty > 0 && m.poste === '1');
  if (m.mvt === '102') assert.ok(m.magasin === 'PRD2' && m.qty < 0 && m.poste === '1');
  if (m.mvt === '601') assert.ok(m.magasin === 'EXP2' && m.qty < 0);
}

function engineInput(data, movements, docks, asOf) {
  return {
    asOf, plant: 'TA11', movements, opening: data.opening, articles: data.articles,
    blocks: CFG.DEFAULT_LAYOUT.blocks, rules: CFG.DEFAULT_RULES, mvtKinds: CFG.MVT_KINDS, docks,
    thresholds: CFG.THRESHOLDS, computedAt: '2026-10-04T00:00:00.000Z', version: 1
  };
}

// ---------------------------------------------------------------------------------------------
// Shared datasets
// ---------------------------------------------------------------------------------------------
const GEN = Sim.generate(BASE);
const QPP = qppMap(GEN.articles);
const INFO = {};
for (const a of GEN.articles) INFO[a.article] = a;

let chainCache = null;
// generate (12 working days, ending on a Saturday) + 30 nextDay calls.
function chain() {
  if (chainCache) return chainCache;
  const base = Sim.generate({ seed: 'chaîne', startDate: '2026-09-21', days: 12 });
  const qpp = qppMap(base.articles);
  const ledger = new Ledger(base.opening, qpp);
  ledger.apply(engineOrder(base.movements));
  let movements = base.movements.slice();
  const steps = [];
  for (let i = 0; i < 30; i++) {
    const res = Sim.nextDay({ seed: 'chaîne', movements, opening: base.opening, articles: base.articles });
    steps.push({ res, prevAsOf: i ? steps[i - 1].res.asOf : base.asOf, prevMovements: movements });
    movements = movements.concat(res.movements);
  }
  chainCache = { base, qpp, steps, movements };
  return chainCache;
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------
test('generate is deterministic: same parameters -> identical output, another seed -> other data', () => {
  const again = Sim.generate(BASE);
  assert.equal(json(again), json(GEN));
  assert.equal(json(Sim.generate(Object.assign({}, BASE, { seed: '2026' }))), json(GEN), 'numeric and text seed are the same');
  const other = Sim.generate(Object.assign({}, BASE, { seed: 2027 }));
  assert.notEqual(json(other.movements), json(GEN.movements));
  assert.notEqual(json(other.articles), json(GEN.articles));
  assert.equal(json(Sim.generate()), json(Sim.generate({})), 'defaults');
});

test('result shape, calendar and parameters', () => {
  for (const k of ['movements', 'opening', 'articles', 'docks', 'asOf']) assert.ok(k in GEN, k);
  const days = workingDays('2026-09-21', GEN.asOf);
  assert.equal(days.length, 14, '14 working days');
  assert.equal(GEN.asOf, '2026-10-06');
  assert.equal(GEN.openingDate, '2026-09-20');
  assert.equal(GEN.params.capacity, CAPACITY);
  // A Sunday start moves to Monday; endDate gives the period backwards.
  assert.equal(Sim.generate({ startDate: '2026-09-27', days: 1 }).asOf, '2026-09-28');
  const back = Sim.generate({ endDate: '2026-10-04', days: 12 });
  assert.equal(back.asOf, '2026-10-03');
  assert.equal(back.params.startDate, '2026-09-21');
  assert.equal(Sim.nextWorkingDay('2026-10-03'), '2026-10-05');
  assert.equal(Sim.nextWorkingDay('2026-10-05'), '2026-10-06');
});

test('articles: 40 references (35 PC, 5 KG), families F1-F5, one of them missing from ARTICLES', () => {
  const arts = GEN.articles;
  assert.equal(arts.length, 39);
  const unknown = [...new Set(GEN.movements.map(m => m.article))].filter(a => !INFO[a]);
  assert.equal(unknown.length, 1, 'one unknown article in the movements');
  assert.equal(GEN.facts.unknownArticle, unknown[0]);
  const unknownLine = GEN.movements.find(m => m.article === unknown[0]);
  assert.equal(unknownLine.uqs, 'PC');
  assert.match(unknownLine.designation, /^PF /);
  assert.equal(arts.filter(a => a.uqs === 'PC').length + 1, 35);
  assert.equal(arts.filter(a => a.uqs === 'KG').length, 5);
  assert.equal(new Set(arts.map(a => a.article)).size, arts.length);
  assert.equal(json(arts.map(a => a.article)), json(arts.map(a => a.article).slice().sort()), 'sorted by article');
  for (const a of arts) {
    assert.match(a.article, /^1000\d{6}$/);
    assert.match(a.designation, /^PF /);
    assert.ok(a.designation.length <= 40);
    assert.ok(/^F[1-5]$/.test(a.family), a.family);
    assert.ok(a.uqs === 'KG' ? KG_QPP.has(a.qpp) : PC_QPP.has(a.qpp) || E_QPP.has(a.qpp), `${a.article} qpp ${a.qpp}`);
    assert.ok(['EUR 1200x800', 'ISO 1200x1000'].includes(a.palletType));
    assert.ok(a.heightCm >= 90 && a.heightCm <= 180 && [1, 2, 3].includes(a.levels));
  }
  const fams = new Set(arts.map(a => a.family));
  assert.equal(fams.size, 5);

  const clean = Sim.generate(Object.assign({}, BASE, { edgeCases: false }));
  assert.equal(clean.articles.length, 40);
  assert.equal(clean.articles.filter(a => a.uqs === 'PC').length, 35);
  const small = Sim.generate(Object.assign({}, BASE, { articles: 20 }));
  assert.equal(small.articles.length, 19);
});

test('opening stock: EXP2 ~60 % of the places, PRD2 ~20 pallets, EMRT ~350 pallets', () => {
  const ledger = new Ledger(GEN.opening, QPP);
  const exp2 = ledger.pallets('EXP2'), prd2 = ledger.pallets('PRD2'), emrt = ledger.pallets('EMRT');
  assert.ok(exp2 / CAPACITY >= 0.55 && exp2 / CAPACITY <= 0.66, `EXP2 ${exp2} / ${CAPACITY}`);
  assert.ok(prd2 >= 15 && prd2 <= 25, `PRD2 ${prd2}`);
  assert.ok(emrt >= 300 && emrt <= 400, `EMRT ${emrt}`);
  for (const o of GEN.opening) {
    assert.ok(INFO[o.article], 'opening only for known articles');
    assert.ok(o.qty > 0 && MAGS.has(o.magasin));
    assert.equal(o.date, GEN.openingDate);
    assert.equal(o.uqs, INFO[o.article].uqs);
  }
  const keys = GEN.opening.map(o => o.article + '|' + o.magasin);
  assert.equal(new Set(keys).size, keys.length, 'one row per article and magasin');
});

test('movement lines have the engine input shape, unique keys and increasing Doc.article', () => {
  const keys = new Set();
  let prevDoc = '', prevDate = '';
  for (const m of GEN.movements) {
    assertLineShape(m, INFO, GEN.params.startDate, GEN.asOf);
    assert.ok(!keys.has(m.key), `duplicate key ${m.key}`);
    keys.add(m.key);
    assert.ok(m.doc >= prevDoc, `Doc.article not increasing: ${prevDoc} then ${m.doc}`);
    assert.ok(m.date >= prevDate, 'dates follow the Doc.article order');
    prevDoc = m.doc;
    prevDate = m.date;
  }
  for (const [doc, lines] of byDoc(GEN.movements)) {
    assert.equal(new Set(lines.map(l => l.mvt)).size, 1, `${doc}: one MvT per document`);
    assert.equal(new Set(lines.map(l => l.date)).size, 1, `${doc}: one date per document`);
    if (lines[0].mvt === '601') {
      assert.equal(lines.map(l => l.poste).join(','), lines.map((l, i) => String(i + 1)).join(','), `${doc}: postes 1..n`);
      assert.equal(new Set(lines.map(l => l.article)).size, lines.length, `${doc}: one line per article`);
    } else if (lines[0].mvt === '101' || lines[0].mvt === '102') {
      assert.equal(lines.length, 1);
    }
  }
  const auto = GEN.movements.filter(m => m.mvt === '101' && m.user === 'BARFLOW_TA11').length;
  const decl = GEN.movements.filter(m => m.mvt === '101').length;
  assert.ok(auto / decl > 0.8, `automatic declarations ${auto}/${decl}`);
  const onePallet = GEN.movements.filter(m => m.mvt === '101' && QPP[m.article] && milli(m.qty) <= QPP[m.article]).length;
  assert.ok(onePallet / decl > 0.85, 'mostly one-pallet declarations');
});

test('every transfer document has exactly 2 lines: same article, opposite quantities, different magasin', () => {
  const flows = assertTransferPairs(GEN.movements);
  for (const f of ['311 PRD2>EXP2', '311 EXP2>EMRT', '311 EMRT>EXP2', '312 EXP2>PRD2', '312 EMRT>EXP2']) {
    assert.ok(flows.has(f), `flow ${f}`);
  }
  assert.equal(flows.size, 5, [...flows].join(', '));
});

test('replaying opening + movements in date / Doc.article order never makes a stock negative', () => {
  for (const params of [BASE, { seed: 11, days: 30, palletsPerDay: 120 }, { seed: 'x', days: 20, palletsPerDay: 25, edgeCases: false }]) {
    const data = params === BASE ? GEN : Sim.generate(params);
    const ledger = new Ledger(data.opening, qppMap(data.articles));
    assert.doesNotThrow(() => ledger.apply(engineOrder(data.movements)), json(params));
  }
});

test('daily volumes stay in range and EXP2 saturation stays realistic', () => {
  for (const ppd of [70, 40, 120]) {
    const data = ppd === 70 ? GEN : Sim.generate(Object.assign({}, BASE, { palletsPerDay: ppd, seed: 'v' + ppd }));
    const qpp = qppMap(data.articles);
    const decl = declaredByDate(data.movements, qpp);
    const ship = sumByDate(data.movements, qpp, m => m.mvt === '601');
    const toEmrt = sumByDate(data.movements, qpp, m => m.mvt === '311' && m.magasin === 'EXP2' && m.qty < 0 &&
      data.movements.some(o => o.doc === m.doc && o.magasin === 'EMRT'));
    const sat = {};
    const ledger = new Ledger(data.opening, qpp);
    ledger.apply(engineOrder(data.movements), d => { sat[d] = ledger.pallets('EXP2') / CAPACITY; });
    for (const d of workingDays(data.params.startDate, data.asOf)) {
      assert.ok(decl[d] >= 0.85 * ppd && decl[d] <= 1.15 * ppd, `ppd ${ppd} ${d}: declared ${decl[d]}`);
      assert.ok(ship[d] >= 0.4 * ppd && ship[d] <= 2 * ppd, `ppd ${ppd} ${d}: shipped ${ship[d]}`);
      assert.ok((toEmrt[d] || 0) <= Math.ceil(20 * ppd / 70), `ppd ${ppd} ${d}: to EMRT ${toEmrt[d]}`);
      assert.ok(sat[d] >= 0.55 && sat[d] <= 0.85, `ppd ${ppd} ${d}: saturation ${sat[d]}`);
    }
  }
});

test('edge cases: one 102, two 312, unknown article, special stock E, partial pallets, stuck pending lines', () => {
  const mv = GEN.movements;
  const r102 = mv.filter(m => m.mvt === '102');
  assert.equal(r102.length, 1);
  assert.notEqual(r102[0].user, 'BARFLOW_TA11');
  const cancelled = mv.find(m => m.doc === GEN.facts.reversal102.cancels);
  assert.ok(cancelled && cancelled.mvt === '101' && cancelled.article === r102[0].article);
  assert.equal(milli(cancelled.qty), -milli(r102[0].qty));
  assert.ok(cancelled.date === r102[0].date && cancelled.doc < r102[0].doc);
  assert.ok(!mv.some(m => m.mvt === '311' && m.article === r102[0].article && m.date === r102[0].date &&
    m.magasin === 'PRD2' && m.doc > cancelled.doc && m.doc < r102[0].doc && -milli(m.qty) === milli(cancelled.qty)),
  'the cancelled pallet is not transferred before its reversal');

  const docs = byDoc(mv);
  const rev312 = [...docs.values()].filter(l => l[0].mvt === '312');
  assert.equal(rev312.length, 2);
  assert.equal(GEN.facts.reversals312.length, 2);
  for (const r of GEN.facts.reversals312) {
    const orig = docs.get(r.cancels), rev = docs.get(r.doc);
    assert.equal(orig[0].mvt, '311');
    const sig = lines => lines.map(l => `${l.article} ${l.magasin} ${milli(l.qty)}`).sort().join(';');
    assert.equal(sig(rev), sig(orig.map(l => Object.assign({}, l, { qty: -l.qty }))), `312 ${r.doc} inverts ${r.cancels}`);
  }

  const eLines = mv.filter(m => m.s === 'E');
  assert.ok(eLines.length >= 3 && eLines.length <= 6, `E lines ${eLines.length}`);
  assert.deepEqual([...new Set(eLines.map(m => m.mvt))].sort(), ['101', '311', '601']);
  assert.equal(new Set(eLines.map(m => m.article)).size, 1);
  assert.ok(INFO[eLines[0].article], 'the special-stock article is in ARTICLES');

  const partialDecl = mv.filter(m => m.mvt === '101' && QPP[m.article] && milli(m.qty) % QPP[m.article] !== 0);
  assert.ok(partialDecl.length >= 3, `partial declarations ${partialDecl.length}`);
  const partialShip = mv.filter(m => m.mvt === '601' && milli(m.qty) % QPP[m.article] !== 0);
  assert.ok(partialShip.length >= 5, `partial shipments ${partialShip.length}`);
  assert.ok(mv.some(m => m.uqs === 'KG' && !Number.isInteger(m.qty)), 'fractional KG quantities');

  // Stuck: PRD2 layers of 101 lines still pending at as-of, declared 3 calendar days or more before.
  const ledger = new Ledger(GEN.opening, QPP);
  ledger.apply(engineOrder(mv));
  const stuck = [];
  for (const layers of ledger.prd2.values()) {
    for (const L of layers) if (L.mvt === '101' && dayNum(GEN.asOf) - dayNum(L.date) >= 3) stuck.push(L.doc);
  }
  assert.ok(stuck.length >= 3, `stuck pending lines ${stuck.length}`);
  assert.ok(GEN.facts.stuckDocs.length >= 3, 'forced stuck lines');
  for (const doc of GEN.facts.stuckDocs) assert.ok(stuck.includes(doc), `stuck line ${doc} still pending`);

  const clean = Sim.generate(Object.assign({}, BASE, { edgeCases: false }));
  const known = new Set(clean.articles.map(a => a.article));
  assert.ok(clean.movements.every(m => known.has(m.article)), 'no unknown article without edge cases');
  assert.ok(!clean.movements.some(m => m.mvt === '102' || m.mvt === '312' || m.s === 'E'), 'no reversal, no E');
});

test('docks: 8 quais, trucks of the sketch, consistent pallet counts, varying with seed and day', () => {
  const seen = new Set();
  const days = workingDays('2026-09-21', '2026-10-31');
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
  assert.equal(json(Sim.makeDocks(2026, '2026-10-01')), json(Sim.makeDocks(2026, '2026-10-01')));
  assert.equal(json(GEN.docks), json(Sim.makeDocks(2026, GEN.asOf)));
  const statuses = new Set();
  for (const s of seen) for (const k of JSON.parse(s)) statuses.add(k.status);
  assert.equal(statuses.size, 4, [...statuses].join(','));
});

test('nextDay continues Doc.article numbers and dates (skips Sunday), deterministically', () => {
  const { base, steps } = chain();
  assert.equal(base.asOf, '2026-10-03');
  assert.equal(weekday(base.asOf), 6, 'generated period ends on a Saturday');
  const first = steps[0].res;
  assert.equal(first.asOf, '2026-10-05', 'Sunday skipped');
  assert.ok(first.movements.length > 100);
  assert.ok(first.movements.every(m => m.date === first.asOf));
  const maxOld = base.movements.reduce((m, l) => (l.doc > m ? l.doc : m), '');
  assert.ok(first.movements.every(m => m.doc > maxOld), 'Doc.article continues after the last one');
  const again = Sim.nextDay({ seed: 'chaîne', movements: base.movements, opening: base.opening, articles: base.articles });
  assert.equal(json(again), json(first), 'same inputs -> same day');
  const withAsOf = Sim.nextDay({ seed: 'chaîne', asOf: base.asOf, movements: base.movements, opening: base.opening,
    articles: base.articles });
  assert.equal(json(withAsOf), json(first), 'explicit asOf');
  // Values as read back from the sheet: Date cells, text quantities with a trailing minus, leading zeros.
  const asSheet = base.movements.map(m => Object.assign({}, m, {
    date: new Date(+m.date.slice(0, 4), +m.date.slice(5, 7) - 1, +m.date.slice(8, 10)),
    qty: m.qty < 0 ? String(-m.qty).replace('.', ',') + '-' : m.qty,
    article: '00' + m.article
  }));
  assert.equal(json(Sim.nextDay({ seed: 'chaîne', movements: asSheet, opening: base.opening, articles: base.articles })),
    json(first), 'sheet values');
  const shuffled = base.movements.slice().reverse();
  assert.equal(json(Sim.nextDay({ seed: 'chaîne', movements: shuffled, opening: base.opening, articles: base.articles })),
    json(first), 'row order of the movements does not matter');
  assert.equal(json(first.docks), json(Sim.makeDocks('chaîne', first.asOf)));
  assert.notEqual(json(Sim.nextDay({ seed: 'autre', movements: base.movements, opening: base.opening, articles: base.articles })
    .movements), json(first.movements), 'the seed drives the day');
  assert.throws(() => Sim.nextDay({ seed: 1, movements: [], opening: [], articles: base.articles }), /aucun mouvement/);
});

test('30 consecutive nextDay calls keep every invariant and EXP2 saturation within 50-90 %', () => {
  const { base, qpp, steps } = chain();
  const info = {};
  for (const a of base.articles) info[a.article] = a;
  const ledger = new Ledger(base.opening, qpp);
  ledger.apply(engineOrder(base.movements));
  const keys = new Set(base.movements.map(m => m.key));
  let lastDoc = base.movements[base.movements.length - 1].doc;
  const sats = [];
  for (const { res, prevAsOf } of steps) {
    assert.equal(res.asOf, nextWorkingDay(prevAsOf), `date after ${prevAsOf}`);
    assert.notEqual(weekday(res.asOf), 0);
    for (const m of res.movements) {
      assertLineShape(m, info, res.asOf, res.asOf);
      assert.ok(!keys.has(m.key), `duplicate key ${m.key}`);
      keys.add(m.key);
      assert.ok(m.doc >= lastDoc, `Doc.article ${m.doc} after ${lastDoc}`);
      lastDoc = m.doc;
    }
    assertTransferPairs(res.movements);
    assert.doesNotThrow(() => ledger.apply(engineOrder(res.movements)), res.asOf);
    const decl = declaredByDate(res.movements, qpp)[res.asOf];
    assert.ok(decl >= 0.85 * 70 && decl <= 1.15 * 70, `${res.asOf}: declared ${decl}`);
    const shipped = sumByDate(res.movements, qpp, m => m.mvt === '601')[res.asOf];
    assert.ok(shipped >= 0.4 * 70 && shipped <= 2 * 70, `${res.asOf}: shipped ${shipped}`);
    const sat = ledger.pallets('EXP2') / CAPACITY;
    sats.push(sat);
    assert.ok(sat >= 0.5 && sat <= 0.9, `${res.asOf}: EXP2 saturation ${sat}`);
    const pending = ledger.pallets('PRD2');
    assert.ok(pending <= 60, `${res.asOf}: ${pending} pallets pending`);
    const emrt = ledger.pallets('EMRT');
    assert.ok(emrt >= 250 && emrt <= 450, `${res.asOf}: EMRT ${emrt}`);
  }
  assert.ok(Math.max(...sats) - Math.min(...sats) > 0.01, 'saturation moves over time');
});

test('Simulation.gs: Apps Script safe syntax, browser copy without CFG, inputs not mutated', () => {
  const src = fs.readFileSync(path.join(SRC, 'Simulation.gs'), 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\?\?/);
  assert.doesNotMatch(src, /[\w\])]\?\.[A-Za-z_$]/);
  assert.doesNotMatch(src, /^\s*await\b/m);
  assert.match(src, /^function SimulationModule_\(\) \{/m);
  assert.match(src, /^var Sim = SimulationModule_\(\);/m);
  // The factory source alone (as injected in the browser, no Config.gs) gives the same data.
  const bare = vm.createContext({});
  const browserSim = vm.runInContext(`(${ctx.SimulationModule_.toString()})()`, bare);
  const small = { seed: 5, days: 4 };
  assert.equal(json(browserSim.generate(small)), json(Sim.generate(small)));
  // nextDay does not modify what it is given.
  const { base } = chain();
  const before = json([base.movements, base.opening, base.articles]);
  Sim.nextDay({ seed: 'chaîne', movements: base.movements, opening: base.opening, articles: base.articles });
  assert.equal(json([base.movements, base.opening, base.articles]), before);
});

test('Engine.compute on simulated data: no negative stock, paired transfers, realistic KPIs',
  { skip: HAS_ENGINE ? false : 'apps-script/src/Engine.gs not present' }, () => {
    const result = Engine.compute(engineInput(GEN, GEN.movements, GEN.docks, GEN.asOf));
    const codes = result.alerts.map(a => a.code);
    for (const bad of ['NEGATIVE_STOCK', 'UNPAIRED_TRANSFER', 'UNKNOWN_MVT', 'INVALID_LINE', 'OTHER_PLANT', 'BEFORE_OPENING']) {
      assert.ok(!codes.includes(bad), `${bad}: ${result.alerts.filter(a => a.code === bad).map(a => a.text).join(' | ')}`);
    }
    assert.ok(codes.includes('UNKNOWN_ARTICLE'));
    assert.equal(result.kpi.unknownArticles, 1);
    assert.ok(result.kpi.stuckPendingLines >= 3, `stuck ${result.kpi.stuckPendingLines}`);
    assert.ok(result.kpi.saturation >= 0.55 && result.kpi.saturation <= 0.85, `saturation ${result.kpi.saturation}`);
    assert.equal(result.dataSource, 'SIMULATION');
    assert.equal(result.counts.processed, GEN.movements.length);
    assert.equal(result.counts.negative, 0);
    assert.equal(result.kpi.docksOccupied, GEN.docks.filter(d => d.status !== 'Libre').length);
    const ledger = new Ledger(GEN.opening, QPP);
    ledger.apply(engineOrder(GEN.movements));
    assert.equal(result.kpi.exp2Pallets, ledger.pallets('EXP2'), 'engine and replay agree on EXP2 pallets');
    assert.equal(result.kpi.pendingPallets, ledger.pallets('PRD2'));
    for (const d of result.daily) assert.ok(d.saturation >= 0.5 && d.saturation <= 0.9, `${d.date} ${d.saturation}`);

    const { base, steps, movements } = chain();
    const last = steps[steps.length - 1].res;
    const after = Engine.compute(engineInput(base, movements, last.docks, last.asOf));
    const afterCodes = after.alerts.map(a => a.code);
    assert.ok(!afterCodes.includes('NEGATIVE_STOCK') && !afterCodes.includes('UNPAIRED_TRANSFER'), afterCodes.join(','));
    assert.equal(after.counts.negative, 0);
    assert.ok(after.kpi.saturation >= 0.5 && after.kpi.saturation <= 0.9);
    assert.equal(after.asOf, last.asOf);
  });
