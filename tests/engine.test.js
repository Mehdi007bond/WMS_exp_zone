'use strict';
// Engine vs oracle: rebuilds the engine input from sample-data/csv and compares every CALC_* tab cell by cell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGs, readCsv } = require('./lib/load-gs');

const CSV_DIR = path.join(__dirname, '..', 'sample-data', 'csv');
const ctx = loadGs(['Config', 'Engine']);
const CFG = ctx.CFG;
const Engine = ctx.Engine;

const AS_OF = '2026-10-03';
const CALC_TABS = ['CALC_STOCK', 'CALC_EN_ATTENTE', 'CALC_FIFO_EXP2', 'CALC_SORTIES', 'CALC_JOURNALIER', 'CALC_BLOCS', 'CALC_KPI'];
const PALLET_EQUIV_COL = 'Palettes (équiv.)';
const TEXT_COLS = new Set(['Article', 'Doc.article', 'Doc.article entrée', 'Doc.article sortie', 'Date', 'Date entrée',
  'Date sortie', 'Date déclaration', 'Bloc', 'Origine', 'Destination', 'Indicateur', 'Unité', 'Définition']);

function csv(name) {
  return readCsv(path.join(CSV_DIR, name + '.csv'));
}

function csvHeader(name) {
  const first = fs.readFileSync(path.join(CSV_DIR, name + '.csv'), 'utf8').replace(/^﻿/, '').split('\n')[0];
  return first.replace(/\r$/, '').split(',');
}

function iso(ddmmyyyy) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(ddmmyyyy);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function numOrNull(v) {
  return v === '' ? null : Number(v);
}

function buildInput() {
  const movements = [];
  for (const tab of ['SAP_DECLARATIONS', 'SAP_TRANSFERTS', 'SAP_SORTIES_601']) {
    csv(tab).forEach((r, i) => movements.push({
      key: `${r['Doc.article']}|${tab}|${i}`,
      article: r['Article'],
      division: r['Division'],
      magasin: r['Magasin'],
      mvt: r['MvT'],
      text: r['Texte code mvt'],
      s: r['S'],
      doc: r['Doc.article'],
      poste: '',
      date: iso(r['Date cpt.']),
      qty: Number(r['Qté en UQS']),
      uqs: r['UQS'],
      designation: r['Désignation article'],
      user: r['Nom utilisateur'],
      source: 'SIMULATION'
    }));
  }
  const opening = csv('SAP_STOCK_INITIAL').map(r => ({
    article: r['Article'], magasin: r['Magasin'], qty: Number(r['Stock utilisation libre']), uqs: r['UQS'],
    designation: r['Désignation article'], date: iso(r['Date stock'])
  }));
  const articles = csv('ARTICLES').map(r => ({
    article: r['Article'], designation: r['Désignation article'], uqs: r['UQS'], qpp: Number(r['Qté par palette']),
    palletType: r['Type palette'], heightCm: Number(r['Hauteur palette (cm)']), levels: Number(r['Niveaux gerbage max']),
    family: r['Famille']
  }));
  const blocks = csv('LAYOUT').filter(r => r['Type'] === 'BLOC_STOCKAGE').map(r => ({
    id: r['ID'], label: r['Libellé (sketch)'], x: Number(r['X (m)']), y: Number(r['Y (m)']), w: Number(r['Largeur (m)']),
    h: Number(r['Profondeur (m)']), cols: Number(r['Colonnes']), rows: Number(r['Rangées']), levels: Number(r['Niveaux']),
    color: r['Couleur']
  }));
  const docks = csv('QUAIS_CAMIONS').map(r => ({
    quai: r['Quai'], status: r['Statut quai'], truck: r['Camion'], carrier: r['Transporteur'], color: r['Couleur cabine'],
    arrival: r['Arrivée'], departure: r['Départ prévu'], planned: numOrNull(r['Palettes prévues']),
    loaded: numOrNull(r['Palettes chargées']), staged: Number(r['Palettes en zone quai']),
    capacity: Number(r['Capacité zone quai (pal)'])
  }));
  return {
    asOf: AS_OF, plant: 'TA11', movements, opening, articles, blocks, docks,
    rules: CFG.DEFAULT_RULES, mvtKinds: CFG.MVT_KINDS, thresholds: CFG.THRESHOLDS,
    computedAt: '2026-10-03T18:00:00.000Z', version: 1
  };
}

const INPUT = buildInput();
const t0 = process.hrtime.bigint();
const RESULT = Engine.compute(INPUT);
const FIRST_COMPUTE_MS = Number(process.hrtime.bigint() - t0) / 1e6;
const TABLES = Engine.toTables(RESULT);

function cellEquals(expected, actual, col) {
  if (expected === '') return actual === '' || actual === null || actual === undefined;
  if (TEXT_COLS.has(col) && typeof actual !== 'string') return false;
  if (typeof actual === 'number') {
    const n = Number(expected);
    if (Number.isNaN(n)) return false;
    if (col === PALLET_EQUIV_COL) return Math.abs(actual - n) <= 0.011; // oracle: Python binary round; engine: half-up
    if (/^-?\d+$/.test(expected)) return actual === n; // counts and whole quantities: exact
    return Math.abs(actual - n) <= 1e-4; // fractions and KG quantities
  }
  return String(actual) === expected;
}

function compareTab(name) {
  const table = TABLES[name];
  assert.ok(Array.isArray(table), `${name} missing from toTables`);
  const header = csvHeader(name);
  assert.equal(JSON.stringify(table[0]), JSON.stringify(header), `${name}: headers`);
  assert.equal(JSON.stringify(CFG.HEADERS[name]), JSON.stringify(header), `${name}: CFG.HEADERS`);
  const expected = csv(name);
  assert.equal(table.length - 1, expected.length, `${name}: row count`);
  const diffs = [];
  expected.forEach((row, i) => {
    const got = table[i + 1];
    assert.equal(got.length, header.length, `${name} row ${i + 2}: width`);
    header.forEach((col, j) => {
      if (!cellEquals(row[col], got[j], col)) {
        diffs.push(`${name} row ${i + 2} '${col}': expected ${JSON.stringify(row[col])}, got ${JSON.stringify(got[j])}`);
      }
    });
  });
  assert.equal(diffs.length, 0, `${diffs.length} differing cells\n${diffs.slice(0, 25).join('\n')}`);
}

test('layerPallets reproduces the oracle self-tests', () => {
  const cases = [
    [[127000, 480000, 480000, 480000, 353000], 480000, [1, 1, 1, 1, 0]],
    [[100000, 300000], 480000, [1, 0]],
    [[500000, 100000], 480000, [2, 0]],
    [[120000, 480000, 5000], 480000, [1, 1, 0]],
    [[120000, 480000, 485000], 480000, [1, 1, 1]],
    [[480000, 480000], 480000, [1, 1]],
    [[250, 1000], 500000, [1, 0]]
  ];
  for (const [qtys, qpp, want] of cases) {
    assert.equal(JSON.stringify(Engine.layerPallets(qtys, qpp)), JSON.stringify(want), JSON.stringify(qtys));
  }
});

for (const name of CALC_TABS) {
  test(`${name} matches sample-data/csv cell by cell`, () => compareTab(name));
}

test('toTables returns exactly the 7 CALC_* tabs', () => {
  assert.equal(JSON.stringify(Object.keys(TABLES)), JSON.stringify(CALC_TABS));
});

test('state has the section 8 shape and consistent figures', () => {
  const s = RESULT.state;
  for (const key of ['version', 'asOf', 'computedAt', 'importedAt', 'source', 'layout', 'kpi', 'blocks', 'blockContents',
    'families', 'daily', 'pending', 'docks', 'alerts']) {
    assert.ok(key in s, `state.${key}`);
  }
  for (const key of ['building', 'blocks', 'truckZone', 'quais', 'quaiLine', 'roads', 'zones']) {
    assert.ok(key in s.layout, `state.layout.${key}`);
  }
  for (const key of ['exp2Pallets', 'capacity', 'saturation', 'pendingPallets', 'oldestPendingDays', 'stuckPendingLines',
    'entriesToday', 'exitsToday', 'emrtPallets', 'dockSaturation', 'docksOccupied', 'docksStaged', 'docksCapacity',
    'oldestExp2Days', 'unknownArticles', 'toPlacePallets', 'daysToSaturation', 'netPerDay']) {
    assert.ok(key in s.kpi, `state.kpi.${key}`);
  }
  assert.equal(s.asOf, AS_OF);
  assert.equal(s.version, 1);
  assert.equal(s.source, 'SIMULATION');
  assert.equal(s.computedAt, '2026-10-03T18:00:00.000Z');

  const k = s.kpi;
  assert.equal(k.exp2Pallets, 994);
  assert.equal(k.pendingPallets, 22);
  assert.equal(k.capacity, 1464);
  assert.ok(Math.abs(k.saturation - 0.679) <= 1e-4);
  assert.equal(k.emrtPallets, 381);
  assert.equal(k.oldestPendingDays, 9);
  assert.equal(k.stuckPendingLines, 5);
  assert.equal(k.entriesToday, 73);
  assert.equal(k.exitsToday, 65);
  assert.equal(k.oldestExp2Days, 13);
  assert.equal(k.unknownArticles, 1);
  assert.equal(k.toPlacePallets, 2);
  assert.equal(k.dockSaturation, 0.4375);
  assert.equal(k.docksOccupied, 5);
  assert.equal(k.docksStaged, 42);
  assert.equal(k.docksCapacity, 96);
  // netPerDay = (994 - 928 on 26.09) / 7; daysToSaturation = (1464 - 994) / netPerDay
  assert.equal(k.netPerDay, 9.43);
  assert.equal(k.daysToSaturation, 49.8);

  assert.equal(s.blocks.length, 8);
  for (const b of s.blocks) {
    const items = s.blockContents[b.id];
    assert.ok(Array.isArray(items), `blockContents.${b.id}`);
    assert.equal(items.reduce((t, e) => t + e.pallets, 0), b.pallets, `blockContents.${b.id} sum`);
    for (const e of items) {
      assert.ok(e.article && e.pallets > 0 && typeof e.ageMax === 'number', `blockContents.${b.id} entry`);
      assert.ok('designation' in e && 'family' in e);
    }
  }
  assert.equal(s.blockContents['À PLACER'].reduce((t, e) => t + e.pallets, 0), 2);
  const placed = Object.values(s.blockContents).flat().reduce((t, e) => t + e.pallets, 0);
  assert.equal(placed, 994, 'every known EXP2 pallet is in a block or in À PLACER');

  assert.equal(s.families.F1, CFG.COLORS.families.F1);
  assert.equal(Object.keys(s.families).length, 5);
  assert.equal(s.daily.length, 13);
  assert.equal(JSON.stringify(Object.keys(s.daily[0])),
    JSON.stringify(['date', 'declared', 'entries', 'exits', 'stockEnd', 'saturation', 'pendingEnd']));
  assert.equal(s.daily[12].date, AS_OF);
  assert.equal(s.daily[6].date, '2026-09-27');
  assert.equal(s.pending.length, 25);
  assert.equal(JSON.stringify(Object.keys(s.pending[0])),
    JSON.stringify(['article', 'designation', 'date', 'doc', 'qty', 'pallets', 'days']));
  assert.equal(s.docks.length, 8);
  assert.equal(s.layout.blocks.length, 8);
  assert.equal(s.layout.blocks[0].capacity, 260);

  // The state is plain JSON (stored in _STATE, sent to the browser).
  const round = JSON.parse(JSON.stringify(s));
  assert.equal(JSON.stringify(round), JSON.stringify(s));
});

test('lookup(1000812390) returns stock, FIFO layers, pending and exits', () => {
  const r = Engine.lookup(RESULT, '1000812390');
  assert.equal(r.article, '1000812390');
  assert.equal(r.stock.designation, 'PF CACHE MOTEUR REF 20');
  assert.equal(r.stock.EXP2.qty, 375);
  assert.equal(r.stock.EXP2.pallets, 16);
  assert.equal(r.stock.PRD2.pallets, 1);
  assert.equal(r.stock.EMRT.pallets, 12);
  assert.equal(r.fifo.length, 7);
  assert.equal(JSON.stringify(r.fifo[0]),
    JSON.stringify({ date: '2026-09-20', doc: '', origin: 'Stock initial', qty: 183, pallets: 8, age: 13 }));
  assert.equal(r.fifo[1].origin, 'EMRT');
  assert.equal(r.fifo.reduce((t, f) => t + f.pallets, 0), 16);
  assert.equal(r.pending.length, 1);
  assert.equal(JSON.stringify(r.pending[0]),
    JSON.stringify({ date: '2026-09-25', doc: '4901255583', qty: 24, pallets: 1, days: 8 }));
  assert.equal(r.exits.length, 9);
  assert.equal(r.exits[0].destination, 'EMRT (311)');
  assert.equal(r.exits[1].destination, 'Client (601)');
  assert.equal(r.locations.reduce((t, l) => t + l.pallets, 0), 16);
  assert.ok(r.locations.every(l => l.block === 'B4'));
  // leading zeros are ignored, unknown article gives empty lists
  assert.equal(Engine.lookup(RESULT, '001000812390').fifo.length, 7);
  const none = Engine.lookup(RESULT, '999');
  assert.equal(none.stock, null);
  assert.equal(none.fifo.length + none.pending.length + none.exits.length, 0);
});

test('lookupAll gives lookup() of every article in one pass', () => {
  const all = Engine.lookupAll(RESULT);
  const arts = Object.keys(all);
  assert.equal(arts.length, RESULT.stock.length, 'one entry per article of the stock');
  for (const a of arts) {
    assert.deepEqual(JSON.parse(JSON.stringify(all[a])), JSON.parse(JSON.stringify(Engine.lookup(RESULT, a))), 'lookupAll(' + a + ')');
  }
});

test('alerts cover stuck pending lines, block B6 at 100 %, unknown article and overflow', () => {
  const alerts = RESULT.state.alerts;
  for (const a of alerts) {
    assert.ok(a.level === 'warn' || a.level === 'crit', a.level);
    assert.ok(a.code && typeof a.text === 'string' && a.text.length > 0);
  }
  const stuck = alerts.filter(a => a.code === 'PENDING_STUCK');
  assert.equal(stuck.length, 5);
  for (const doc of ['4901255337', '4901255583', '4901256434', '4901256441', '4901256883']) {
    assert.ok(stuck.some(a => a.text.includes(doc)), `stuck line ${doc}`);
  }
  const b6 = alerts.find(a => a.code === 'BLOCK_SAT' && a.text.includes('B6'));
  assert.ok(b6, 'B6 alert');
  assert.equal(b6.level, 'crit');
  assert.ok(b6.text.includes('100\u00a0%'), b6.text);
  assert.equal(alerts.filter(a => a.code === 'BLOCK_SAT').length, 1, 'only B6 is above 85 %');
  const unknown = alerts.find(a => a.code === 'UNKNOWN_ARTICLE');
  assert.ok(unknown && unknown.text.includes('1000571497'));
  assert.ok(alerts.some(a => a.code === 'TO_PLACE' && a.text.includes('F5')));
  assert.ok(!alerts.some(a => a.code === 'NEGATIVE_STOCK' || a.code === 'UNPAIRED_TRANSFER' || a.code === 'UNKNOWN_MVT'));
  // critical alerts come first
  const firstWarn = alerts.findIndex(a => a.level === 'warn');
  assert.ok(alerts.slice(firstWarn).every(a => a.level === 'warn'));
});

test('compute of ~2,800 lines runs under 1.5 s', () => {
  assert.ok(INPUT.movements.length > 2800, `${INPUT.movements.length} lines`);
  const start = process.hrtime.bigint();
  Engine.compute(INPUT);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(FIRST_COMPUTE_MS < 1500, `first compute ${FIRST_COMPUTE_MS.toFixed(0)} ms`);
  assert.ok(ms < 1500, `compute ${ms.toFixed(0)} ms`);
});

test('the browser copy (EngineModule_.toString()) gives the same tables and the input is not mutated', () => {
  const before = JSON.stringify(INPUT);
  const browserEngine = vm.runInContext(`(${ctx.EngineModule_.toString()})()`, ctx);
  const again = browserEngine.toTables(browserEngine.compute(INPUT));
  assert.equal(JSON.stringify(again), JSON.stringify(TABLES));
  assert.equal(JSON.stringify(INPUT), before);
});

// ---------------------------------------------------------------------------------------------
// Small synthetic cases (rules not exercised by the sample data)
// ---------------------------------------------------------------------------------------------
function line(article, magasin, mvt, doc, date, qty) {
  return { article, division: 'TA11', magasin, mvt, doc, date, qty, uqs: 'PC', designation: 'ART ' + article, user: 'U1', source: 'IMPORT' };
}

function smallInput(movements, extra) {
  return Object.assign({
    asOf: null,
    plant: 'TA11',
    movements,
    opening: [{ article: 'A1', magasin: 'EXP2', qty: 150, uqs: 'PC', designation: 'ART A1', date: '2026-01-04' }],
    articles: [{ article: 'A1', designation: 'ART A1', uqs: 'PC', qpp: 100, family: 'F1' },
      { article: 'A2', designation: 'ART A2', uqs: 'PC', qpp: 0, family: 'F2' }],
    blocks: [{ id: 'B1', label: 'Bloc 1', cols: 1, rows: 1, levels: 2 }, { id: 'B7', label: 'Bloc 7', cols: 1, rows: 1, levels: 1 }],
    rules: CFG.DEFAULT_RULES,
    mvtKinds: CFG.MVT_KINDS,
    docks: [],
    computedAt: 'x'
  }, extra || {});
}

test('synthetic: FIFO exits, LIFO reversals, origins, destinations and pallets', () => {
  const r = Engine.compute(smallInput([
    line('A1', 'PRD2', '101', '10', '2026-01-05', 100),
    line('A1', 'PRD2', '311', '11', '2026-01-05', -100),
    line('A1', 'EXP2', '311', '11', '2026-01-05', 100),
    line('A1', 'EXP2', '601', '12', '2026-01-06', -120), // FIFO: 120 from the opening layer
    line('A1', 'EXP2', '311', '13', '2026-01-06', -30), // 30 more from the opening layer to EMRT
    line('A1', 'EMRT', '311', '13', '2026-01-06', 30),
    line('A1', 'EXP2', '602', '14', '2026-01-07', 20), // 602 creates a layer
    line('A1', 'EXP2', '602', '15', '2026-01-07', -5) // reversal consumes the newest layer (LIFO)
  ]));
  assert.equal(r.asOf, '2026-01-07', 'asOf null = last movement date');
  assert.equal(r.openDate, '2026-01-04');
  // 115 PC at 100 per pallet = 2 pallets: the partial one (15 PC) and the next one both start in the older layer
  const fifo = r.fifo.map(f => [f.date, f.doc, f.origin, f.qty, f.pallets]);
  assert.equal(JSON.stringify(fifo), JSON.stringify([
    ['2026-01-05', '11', 'PRD2', 100, 2],
    ['2026-01-07', '14', 'MvT 602', 15, 0]
  ]));
  assert.equal(JSON.stringify(r.exits.map(x => [x.dateIn, x.qty, x.pallets, x.destination, x.stay])), JSON.stringify([
    ['2026-01-04', 120, 1.2, 'Client (601)', 2],
    ['2026-01-04', 30, 0.3, 'EMRT (311)', 2]
  ]));
  // flows: ceil(line qty / qpp) per line (120 -> 2, 30 -> 1), reversals (602) are neither entries nor exits
  assert.equal(JSON.stringify(r.daily.map(d => [d.date, d.declared, d.entries, d.exits, d.stockEnd, d.pendingEnd])), JSON.stringify([
    ['2026-01-05', 1, 1, 0, 3, 0],
    ['2026-01-06', 0, 0, 3, 1, 0],
    ['2026-01-07', 0, 0, 0, 2, 0]
  ]));
  assert.equal(r.kpi.exp2Pallets, 2); // 115 PC at 100 per pallet
  // B1 (2 places) and B7 (1 place) share F1's 2 pallets in proportion to capacity
  assert.equal(JSON.stringify(r.blocks.map(b => [b.id, b.families, b.pallets])), JSON.stringify([['B1', 'F1', 1], ['B7', 'F1', 1]]));
  assert.equal(r.toPlace.pallets, 0);
  assert.equal(r.state.source, 'SAP');
});

test('synthetic: negative stock is clamped, unpaired legs, unknown MvT, other plant and missing qpp are reported', () => {
  const lines = [
    line('A1', 'EXP2', '601', '20', '2026-01-05', -400), // only 150 available
    line('A1', 'EXP2', '311', '21', '2026-01-05', 50), // no PRD2 leg
    line('A1', 'EXP2', '999', '22', '2026-01-05', 10),
    Object.assign(line('A1', 'EXP2', '101', '23', '2026-01-05', 10), { division: 'XX99' }),
    line('A2', 'PRD2', '101', '24', '2026-01-05', 10),
    line('A1', 'EXP2', '101', '25', '2026-01-03', 10), // before the opening stock date
    line('A1', 'EXP2', '101', '26', '2026-01-09', 10), // after asOf
    line('A1', 'QUAL', '101', '27', '2026-01-05', 10) // storage location outside the twin
  ];
  const r = Engine.compute(smallInput(lines, { asOf: '2026-01-06' }));
  const codes = r.alerts.map(a => a.code);
  for (const code of ['NEGATIVE_STOCK', 'UNPAIRED_TRANSFER', 'UNKNOWN_MVT', 'OTHER_PLANT', 'NO_QPP', 'BEFORE_OPENING',
    'OTHER_MAGASIN']) {
    assert.ok(codes.includes(code), code);
  }
  assert.equal(r.alerts[0].code, 'NEGATIVE_STOCK');
  assert.equal(r.alerts[0].level, 'crit');
  const a1 = r.stock.find(s => s.article === 'A1');
  assert.equal(a1.qty.EXP2, 50, 'clamped to 0, then +50');
  const a2 = r.stock.find(s => s.article === 'A2');
  assert.equal(a2.pallets.PRD2, null);
  const tables = Engine.toTables(r);
  const a2row = tables.CALC_STOCK.find(row => row[0] === 'A2');
  assert.equal(a2row[3], 'INCONNU');
  assert.equal(a2row[5], '');
  assert.equal(r.daily.length, 2, 'from the first movement to asOf');
  assert.equal(r.counts.afterAsOf, 1);
  assert.equal(r.kpi.netPerDay, null);
  assert.equal(r.kpi.daysToSaturation, null);
});
