'use strict';
// Engine tests:
//  - v1 oracle: rebuilds the engine input from sample-data/csv and compares every v1 column of every CALC_* tab
//    cell by cell (the v2 columns are appended and must be blank or consistent on v1 data);
//  - real-format oracle (docs/SPEC_V2.md 4.10): sample-data/mb51-reel through Norm, against expected.json;
//  - synthetic cases for the v2 rules (labels, hours, dwell, projects, placement, state) and a 100k-line timing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadGs, readCsv } = require('./lib/load-gs');

const CSV_DIR = path.join(__dirname, '..', 'sample-data', 'csv');
const REEL_DIR = path.join(__dirname, '..', 'sample-data', 'mb51-reel');
const REEL_FILE = 'MB51_reel_anonymise.xlsx';
const ctx = loadGs(['Config', 'Engine']);
const CFG = ctx.CFG;
const Engine = ctx.Engine;

const AS_OF = '2026-10-03';
const CALC_TABS = ['CALC_STOCK', 'CALC_EN_ATTENTE', 'CALC_FIFO_EXP2', 'CALC_SORTIES', 'CALC_JOURNALIER', 'CALC_BLOCS', 'CALC_KPI'];
const PALLET_EQUIV_COL = 'Palettes (équiv.)';
const TEXT_COLS = new Set(['Article', 'Doc.article', 'Doc.article entrée', 'Doc.article sortie', 'Date', 'Date entrée',
  'Date sortie', 'Date déclaration', 'Bloc', 'Origine', 'Destination', 'Indicateur', 'Unité', 'Définition']);
// The oracle's placement: the v1 placeholder rules (family -> blocks of the same sketch color). CFG.DEFAULT_RULES is
// empty since v2 and sample-data/csv/REGLES_PLACEMENT.csv only holds a "(à définir)" row, so they are passed explicitly.
const V1_RULES = [
  { priority: 10, criterion: 'FAMILLE', value: 'F1', blocks: ['B1', 'B7'] },
  { priority: 10, criterion: 'FAMILLE', value: 'F2', blocks: ['B2', 'B8'] },
  { priority: 10, criterion: 'FAMILLE', value: 'F3', blocks: ['B3', 'B5'] },
  { priority: 10, criterion: 'FAMILLE', value: 'F4', blocks: ['B4'] },
  { priority: 10, criterion: 'FAMILLE', value: 'F5', blocks: ['B6'] }
];
const V2_KPI_LABELS = ['Heure des données', 'Palettes en attente > 6 h', 'Palettes en attente 4 à 6 h', 'Plus ancienne attente (h)',
  'Étiquettes en attente', 'Délai PRD2→EXP2 médian', 'Délai PRD2→EXP2 P90', 'Articles suivis', 'Références sans projet', 'Projets'];

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

function plain(x) {
  return JSON.parse(JSON.stringify(x));
}

// Deep equality of JSON values (engine objects come from the vm context: other prototypes).
function eq(actual, expected, what) {
  assert.deepStrictEqual(plain(actual), plain(expected), what);
}

function near(actual, expected, tol, what) {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= tol, `${what}: expected ${expected}, got ${actual}`);
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
    rules: V1_RULES, mvtKinds: CFG.MVT_KINDS, thresholds: CFG.THRESHOLDS,
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

// v2 columns on v1 data (no entry time, no label, no project): blank, or derived from the v1 columns.
function v2CellOk(name, col, got, row, header) {
  const v1 = (c) => row[header.indexOf(c)];
  if (name === 'CALC_STOCK' && col === 'Source qté/pal') return got === (v1('Qté par palette') === 'INCONNU' ? '' : 'ARTICLES');
  if (name === 'CALC_EN_ATTENTE' && col === 'Niveau') {
    // day rule (rows without entry time): alerte (crit) from pendingDaysCrit = 2 x pendingDaysWarn, pré-alerte (warn)
    // from pendingDaysWarn
    const days = Number(v1('Attente (jours)'));
    return got === (days >= 2 * CFG.THRESHOLDS.pendingDaysWarn ? 'alerte' : (days >= CFG.THRESHOLDS.pendingDaysWarn ? 'pré-alerte' : ''));
  }
  if (name === 'CALC_BLOCS' && col === 'Projet(s)') return got === (v1('Bloc') === 'À PLACER' ? 'Sans projet' : '');
  return got === '';
}

function compareTab(name) {
  const table = TABLES[name];
  assert.ok(Array.isArray(table), `${name} missing from toTables`);
  const header = csvHeader(name);
  const full = CFG.HEADERS[name];
  assert.equal(JSON.stringify(table[0]), JSON.stringify(full), `${name}: headers = CFG.HEADERS`);
  assert.equal(JSON.stringify(full.slice(0, header.length)), JSON.stringify(header), `${name}: v1 columns first, unchanged`);
  const expected = csv(name);
  if (name === 'CALC_KPI') {
    // v2 indicators are appended after the 12 v1 rows
    assert.equal(table.length - 1, expected.length + V2_KPI_LABELS.length, `${name}: row count`);
  } else {
    assert.equal(table.length - 1, expected.length, `${name}: row count`);
  }
  const diffs = [];
  expected.forEach((row, i) => {
    const got = table[i + 1];
    assert.equal(got.length, full.length, `${name} row ${i + 2}: width`);
    header.forEach((col, j) => {
      if (!cellEquals(row[col], got[j], col)) {
        diffs.push(`${name} row ${i + 2} '${col}': expected ${JSON.stringify(row[col])}, got ${JSON.stringify(got[j])}`);
      }
    });
    full.slice(header.length).forEach((col, k) => {
      const v = got[header.length + k];
      if (!v2CellOk(name, col, v, got, full)) diffs.push(`${name} row ${i + 2} v2 '${col}': got ${JSON.stringify(v)}`);
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
  test(`${name} matches sample-data/csv cell by cell (v1 columns; v2 columns blank or consistent)`, () => compareTab(name));
}

test('toTables returns exactly the 7 CALC_* tabs', () => {
  assert.equal(JSON.stringify(Object.keys(TABLES)), JSON.stringify(CALC_TABS));
});

test('CALC_KPI: the v2 indicators follow the 12 v1 rows', () => {
  const rows = TABLES.CALC_KPI.slice(1 + 12);
  eq(rows.map(r => r[0]), V2_KPI_LABELS);
  const byLabel = Object.fromEntries(rows.map(r => [r[0], r[1]]));
  const k = RESULT.kpi;
  assert.equal(byLabel['Heure des données'], '', 'no entry time in v1 data');
  assert.equal(byLabel['Palettes en attente > 6 h'], k.pendingCrit);
  assert.equal(byLabel['Palettes en attente 4 à 6 h'], k.pendingWarn);
  assert.equal(byLabel['Plus ancienne attente (h)'], '');
  assert.equal(byLabel['Étiquettes en attente'], 0);
  assert.equal(byLabel['Délai PRD2→EXP2 médian'], '');
  assert.equal(byLabel['Articles suivis'], 40);
  assert.equal(byLabel['Références sans projet'], 40);
  assert.equal(byLabel['Projets'], 0);
  for (const r of rows) assert.equal(r.length, 4);
});

test('state has the section 8 shape, the v2 additions and consistent figures', () => {
  const s = RESULT.state;
  for (const key of ['version', 'asOf', 'computedAt', 'importedAt', 'source', 'layout', 'kpi', 'blocks', 'blockContents',
    'families', 'daily', 'pending', 'docks', 'alerts', 'asOfTs', 'projects', 'projectsList', 'pendingTotal', 'articles']) {
    assert.ok(key in s, `state.${key}`);
  }
  for (const key of ['building', 'blocks', 'truckZone', 'quais', 'quaiLine', 'roads', 'zones']) {
    assert.ok(key in s.layout, `state.layout.${key}`);
  }
  for (const key of ['exp2Pallets', 'capacity', 'saturation', 'pendingPallets', 'oldestPendingDays', 'stuckPendingLines',
    'entriesToday', 'exitsToday', 'emrtPallets', 'dockSaturation', 'docksOccupied', 'docksStaged', 'docksCapacity',
    'oldestExp2Days', 'unknownArticles', 'toPlacePallets', 'daysToSaturation', 'netPerDay',
    'asOfTs', 'pendingLabels', 'pendingWarn', 'pendingCrit', 'oldestPendingHours', 'dwellMedianH', 'dwellP90H',
    'trackedArticles', 'noProjectArticles', 'projects']) {
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
  // v2 KPIs on v1 data: no entry time, no label, no project; pending levels by the day rule
  assert.equal(k.asOfTs, '');
  assert.equal(k.pendingLabels, 0);
  assert.equal(k.oldestPendingHours, null);
  assert.equal(k.dwellMedianH, null);
  assert.equal(k.dwellP90H, null);
  assert.equal(k.trackedArticles, 40);
  assert.equal(k.noProjectArticles, 40);
  assert.equal(k.projects, 0);
  const byLevel = { crit: 0, warn: 0 };
  RESULT.pending.forEach(x => { if (x.level) byLevel[x.level] += x.pallets || 0; });
  assert.equal(k.pendingCrit, byLevel.crit);
  assert.equal(k.pendingWarn, byLevel.warn);
  assert.ok(k.pendingCrit > 0, 'rows of 6 days and more are crit by the day rule');
  assert.equal(s.asOfTs, '');
  assert.equal(s.pendingTotal, 25);

  assert.equal(s.blocks.length, 8);
  for (const b of s.blocks) {
    const items = s.blockContents[b.id];
    assert.ok(Array.isArray(items), `blockContents.${b.id}`);
    assert.equal(items.reduce((t, e) => t + e.pallets, 0), b.pallets, `blockContents.${b.id} sum`);
    for (const e of items) {
      assert.ok(e.article && e.pallets > 0 && typeof e.ageMax === 'number', `blockContents.${b.id} entry`);
      assert.ok('designation' in e && 'family' in e);
      assert.equal(e.project, '');
    }
    eq(b.projects, []);
    assert.equal(b.title, 'Famille ' + b.families, 'v1 blocks are titled by family');
  }
  assert.equal(s.blockContents['À PLACER'].reduce((t, e) => t + e.pallets, 0), 2);
  const placed = Object.values(s.blockContents).flat().reduce((t, e) => t + e.pallets, 0);
  assert.equal(placed, 994, 'every known EXP2 pallet is in a block or in À PLACER');

  assert.equal(s.families.F1, CFG.COLORS.families.F1);
  assert.equal(Object.keys(s.families).length, 5);
  eq(s.projects, { 'Sans projet': CFG.COLORS.noProject });
  assert.equal(s.projectsList.length, 1);
  eq(s.projectsList[0], { project: 'Sans projet', color: CFG.COLORS.noProject, blocks: [], articles: 40,
    exp2Pallets: 994, pendingPallets: 22, pendingCrit: k.pendingCrit });
  assert.equal(s.daily.length, 13);
  const v1Daily = ['date', 'declared', 'entries', 'exits', 'stockEnd', 'saturation', 'pendingEnd'];
  assert.equal(JSON.stringify(Object.keys(s.daily[0])), JSON.stringify(v1Daily.concat(['dwellMedianH', 'dwellP90H'])));
  assert.ok(s.daily.every(d => d.dwellMedianH === null && d.dwellP90H === null));
  assert.equal(s.daily[12].date, AS_OF);
  assert.equal(s.daily[6].date, '2026-09-27');
  assert.equal(s.pending.length, 25);
  const v1Pending = ['article', 'designation', 'date', 'doc', 'qty', 'pallets', 'days'];
  assert.equal(JSON.stringify(Object.keys(s.pending[0])),
    JSON.stringify(v1Pending.concat(['label', 'ts', 'hours', 'level', 'project', 'origin', 'user'])));
  assert.ok(s.pending.every(x => x.label === '' && x.ts === '' && x.hours === null && x.project === '' &&
    (x.user === 'Auto' || x.user === 'Manuel')));
  assert.equal(s.articles.length, 40);
  eq(Object.keys(s.articles[0]), ['a', 'd', 'p', 'e', 'w', 'm', 'q', 'qs', 't']);
  const a0 = s.articles.find(a => a.a === '1000812390');
  eq(a0, { a: '1000812390', d: 'PF CACHE MOTEUR REF 20', p: '', e: 16, w: 1, m: 12, q: a0.q, qs: 'ARTICLES', t: a0.t });
  assert.match(a0.t, /^\d{4}-\d{2}-\d{2}$/, 'no entry time: last posting date');
  assert.equal(s.docks.length, 8);
  assert.equal(s.layout.blocks.length, 8);
  assert.equal(s.layout.blocks[0].capacity, 260);
  assert.equal(s.layout.blocks[0].title, 'Famille F1');
  eq(s.layout.blocks[0].projects, []);

  // The state is plain JSON (stored in _STATE, sent to the browser).
  const round = JSON.parse(JSON.stringify(s));
  assert.equal(JSON.stringify(round), JSON.stringify(s));
});

test('lookup(1000812390) returns stock, FIFO layers, pending and exits', () => {
  const r = Engine.lookup(RESULT, '1000812390');
  assert.equal(r.article, '1000812390');
  assert.equal(r.project, '');
  assert.equal(r.stock.designation, 'PF CACHE MOTEUR REF 20');
  assert.equal(r.stock.qppSource, 'ARTICLES');
  assert.equal(r.stock.project, '');
  assert.equal(r.stock.EXP2.qty, 375);
  assert.equal(r.stock.EXP2.pallets, 16);
  assert.equal(r.stock.PRD2.pallets, 1);
  assert.equal(r.stock.EMRT.pallets, 12);
  assert.equal(r.fifo.length, 7);
  // v1 fields unchanged, v2 fields appended (blank on v1 data)
  assert.equal(JSON.stringify(r.fifo[0]),
    JSON.stringify({ date: '2026-09-20', doc: '', origin: 'Stock initial', qty: 183, pallets: 8, age: 13, label: '', ts: '', ageHours: null }));
  assert.equal(r.fifo[1].origin, 'EMRT');
  assert.equal(r.fifo.reduce((t, f) => t + f.pallets, 0), 16);
  assert.equal(r.pending.length, 1);
  assert.equal(JSON.stringify(r.pending[0]),
    JSON.stringify({ date: '2026-09-25', doc: '4901255583', qty: 24, pallets: 1, days: 8, label: '', ts: '', hours: null,
      level: 'crit', user: 'Auto' }));
  assert.equal(r.exits.length, 9);
  assert.equal(r.exits[0].destination, 'EMRT (311)');
  assert.equal(r.exits[1].destination, 'Client (601)');
  assert.ok(r.exits.every(x => x.label === '' && x.tsIn === '' && x.tsOut === '' && x.stayHours === null));
  assert.equal(r.locations.reduce((t, l) => t + l.pallets, 0), 16);
  assert.ok(r.locations.every(l => l.block === 'B4'));
  // leading zeros are ignored, unknown article gives empty lists
  assert.equal(Engine.lookup(RESULT, '001000812390').fifo.length, 7);
  const none = Engine.lookup(RESULT, '999');
  assert.equal(none.stock, null);
  assert.equal(none.project, '');
  assert.equal(none.fifo.length + none.pending.length + none.exits.length, 0);
});

test('lookupAll gives lookup() of every article in one pass', () => {
  const all = Engine.lookupAll(RESULT);
  const arts = Object.keys(all);
  assert.equal(arts.length, RESULT.stock.length, 'one entry per article of the stock');
  for (const a of arts) {
    eq(plain(all[a]), plain(Engine.lookup(RESULT, a)), 'lookupAll(' + a + ')');
  }
});

test('alerts cover stuck pending lines, block B6 at 100 %, unknown article, overflow and articles without project', () => {
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
  assert.ok(alerts.some(a => a.code === 'TO_PLACE' && a.text.includes('(famille F5)')));
  assert.ok(!alerts.some(a => a.code === 'NEGATIVE_STOCK' || a.code === 'UNPAIRED_TRANSFER' || a.code === 'UNKNOWN_MVT'));
  // v2: no entry time -> no hour alerts (PENDING_STUCK covers these rows); every tracked article lacks a project
  assert.ok(!alerts.some(a => a.code === 'PRD2_CRIT' || a.code === 'PRD2_WARN'));
  const noProject = alerts.filter(a => a.code === 'NO_PROJECT');
  assert.equal(noProject.length, 1);
  assert.equal(noProject[0].level, 'warn');
  assert.equal(noProject[0].text, '40 références suivies sans projet : affectez-les dans la page Projets');
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
// Small synthetic cases (v1 rules not exercised by the sample data)
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
    rules: [V1_RULES[0]],
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
  assert.equal(a2row[10], '', 'no qpp source');
  assert.equal(r.daily.length, 2, 'from the first movement to asOf');
  assert.equal(r.counts.afterAsOf, 1);
  assert.equal(r.kpi.netPerDay, null);
  assert.equal(r.kpi.daysToSaturation, null);
});

// ---------------------------------------------------------------------------------------------
// Real-format oracle (docs/SPEC_V2.md 4.10): the anonymised MB51 export through Norm, then the engine with no
// opening stock, no ARTICLES, no projects and the default thresholds, against tools/mb51_reference.py.
// ---------------------------------------------------------------------------------------------
const EXPECTED_REEL = JSON.parse(fs.readFileSync(path.join(REEL_DIR, 'expected.json'), 'utf8'));
let reelCache = null;

function reelRows(Norm) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(path.join(REEL_DIR, REEL_FILE));
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], Norm.SHEETJS_OPTIONS);
}

function reelInput(movements) {
  return {
    asOf: null, plant: 'TA11', movements, opening: [], articles: [], projects: [], blocks: CFG.DEFAULT_LAYOUT.blocks,
    rules: [], mvtKinds: CFG.MVT_KINDS, thresholds: CFG.THRESHOLDS, docks: [], computedAt: '2026-10-05T22:30:00.000Z', version: 1
  };
}

function reel() {
  if (reelCache) return reelCache;
  // Norm in its own context: the engine tests above do not depend on the normaliser.
  const nctx = loadGs(['Config', 'Normalize']);
  const rows = reelRows(nctx.Norm);
  const batch = nctx.Norm.normalizeBatch([{ name: REEL_FILE, rows }], { trackedOnly: true });
  assert.ok(batch.ok, JSON.stringify(batch.errors));
  const lines = plain(batch.lines);
  const result = Engine.compute(reelInput(lines));
  reelCache = { rows, lines, result, Norm: nctx.Norm };
  return reelCache;
}

test('real MB51 export: Norm keeps the finished goods with entry time and label', () => {
  const { lines } = reel();
  const n = EXPECTED_REEL.normalize;
  assert.equal(lines.length, n.kept);
  assert.ok(lines.every(l => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(l.ts)), 'every line has an entry time');
  assert.equal(new Set(lines.map(l => l.article)).size, n.trackedArticles);
});

test('real MB51 export: engine matches expected.json (asOf, learned qpp, pending, EXP2, EMRT, dwell, daily, diag)', () => {
  const { result: r } = reel();
  const e = EXPECTED_REEL.engine;
  assert.equal(r.asOf, e.asOf);
  assert.equal(r.asOfTs, e.asOfTs);
  assert.equal(r.kpi.asOfTs, e.asOfTs);
  assert.equal(r.counts.untracked, 0, 'Norm already dropped the semi-finished goods');
  assert.equal(r.kpi.trackedArticles, EXPECTED_REEL.normalize.trackedArticles);

  // Learned quantity per pallet (no ARTICLES): mode of the labeled positive quantities, ties -> larger.
  eq(r.learnedQpp, e.learnedQpp);
  for (const s of r.stock) {
    if (Object.prototype.hasOwnProperty.call(e.learnedQpp, s.article)) {
      assert.equal(s.qpp, e.learnedQpp[s.article], s.article);
      assert.equal(s.qppSource, 'ÉTIQUETTES', s.article);
      assert.equal(s.known, true);
    } else {
      assert.equal(s.qpp, null, s.article);
      assert.equal(s.qppSource, '', s.article);
    }
  }

  // Pending (PRD2): one row per labeled layer, unlabeled remainders by article.
  const labeled = r.pending.filter(x => x.label);
  assert.equal(labeled.length, e.pending.labeled);
  assert.equal(r.kpi.pendingLabels, e.pending.labeled);
  const unl = {};
  r.pending.filter(x => !x.label).forEach(x => { unl[x.article] = (unl[x.article] || 0) + x.qty; });
  eq(unl, e.pending.unlabeledQty);
  assert.equal(r.kpi.pendingPallets, e.pending.pallets);
  assert.equal(r.pending.reduce((t, x) => t + (x.pallets || 0), 0), e.pending.pallets, 'row pallets add up to the KPI');
  // The reference counts LABELS by level; the KPIs count PALLETS of every pending row by level (SPEC 4.8), so the
  // unlabeled PRD2 remainders (bulk moved into PRD2 at 10:55, returns from EMRT), all older than 6 h, add to crit.
  assert.equal(labeled.filter(x => x.level === 'crit').length, e.pending.crit);
  assert.equal(labeled.filter(x => x.level === 'warn').length, e.pending.warn);
  const unlabeledCrit = r.pending.filter(x => !x.label && x.level === 'crit').reduce((t, x) => t + (x.pallets || 0), 0);
  assert.equal(unlabeledCrit, 17);
  assert.equal(r.kpi.pendingCrit, e.pending.crit + unlabeledCrit);
  assert.equal(r.kpi.pendingWarn, e.pending.warn, 'no unlabeled row between 4 and 6 h');
  near(r.kpi.oldestPendingHours, e.pending.oldestHours, 0.0101, 'oldest pending hours');
  const oldest = r.pending.reduce((m, x) => (x.hours !== null && (!m || x.hours > m.hours) ? x : m), null);
  assert.equal(oldest.article, e.pending.oldest.article);
  assert.equal(oldest.label, e.pending.oldest.label);

  // EXP2 and EMRT.
  const fifoLabeled = r.fifo.filter(x => x.label);
  assert.equal(fifoLabeled.length, e.exp2.labeled);
  const exp2Unl = {};
  r.fifo.filter(x => !x.label).forEach(x => { exp2Unl[x.article] = (exp2Unl[x.article] || 0) + x.qty; });
  eq(exp2Unl, e.exp2.unlabeledQty);
  assert.equal(r.kpi.exp2Pallets, e.exp2.pallets);
  assert.equal(e.emrt.labeled, 0);
  const emrt = {};
  r.stock.filter(s => s.qty.EMRT > 0).forEach(s => { emrt[s.article] = s.qty.EMRT; });
  eq(emrt, e.emrt.unlabeledQty);
  assert.equal(r.kpi.emrtPallets, e.emrt.pallets);

  // Dwell PRD2 -> EXP2, of asOf and per posting date.
  assert.equal(r.kpi.dwellCount, e.dwellAsOf.count);
  near(r.kpi.dwellMedianH, e.dwellAsOf.medianH, 0.0101, 'dwell median of asOf');
  near(r.kpi.dwellP90H, e.dwellAsOf.p90H, 0.0101, 'dwell P90 of asOf');
  for (const [date, d] of Object.entries(e.dwellByDate)) {
    const day = r.daily.find(x => x.date === date);
    assert.ok(day, date);
    assert.equal(day.dwellCount, d.count, date);
    near(day.dwellMedianH, d.medianH, 0.0101, date + ' median');
    near(day.dwellP90H, d.p90H, 0.0101, date + ' P90');
  }

  // Daily flows: 1 pallet per labeled line, ceil(qty / qpp) per unlabeled line.
  eq(r.daily.map(d => d.date), Object.keys(e.daily));
  for (const d of r.daily) eq({ declared: d.declared, entries: d.entries, exits: d.exits }, e.daily[d.date], d.date);

  assert.equal(r.counts.preData, e.diag.preData);
  assert.equal(r.counts.negative, e.diag.negative);
  assert.equal(r.counts.unpaired, EXPECTED_REEL.normalize.unpairedUnlabeled);
  assert.equal(r.counts.unpairedLabeled, EXPECTED_REEL.normalize.unpairedLabeled);
});

test('real MB51 export: calm alerts (one critical: PRD2 > 6 h), compact state', () => {
  const { result: r } = reel();
  const a = r.alerts;
  assert.equal(a[0].code, 'PRD2_CRIT');
  assert.equal(a[0].level, 'crit');
  assert.equal(a[0].text, r.kpi.pendingCrit + ' palettes en PRD2 depuis plus de 6 h · la plus ancienne : LB73297 depuis 44 h 02 ' +
    '(étiquette 434503024)');
  assert.equal(a.filter(x => x.level === 'crit').length, 1, 'no wall of critical alerts');
  assert.equal(a.find(x => x.code === 'PRD2_WARN').text, '11 palettes en PRD2 depuis 4 à 6 h');
  const neg = a.filter(x => x.code === 'NEGATIVE_STOCK');
  assert.equal(neg.length, 1);
  assert.equal(neg[0].level, 'warn');
  assert.equal(neg[0].text, '27 sorties sans stock connu : importez le stock initial (MB52)');
  assert.equal(a.find(x => x.code === 'UNPAIRED_TRANSFER').text.indexOf('3 lignes de transfert'), 0, 'unlabeled legs only');
  assert.equal(a.filter(x => x.code === 'UNKNOWN_ARTICLE').length, 1, 'articles without qpp grouped in one alert');
  assert.ok(a.length <= 8, a.map(x => x.code).join(', '));

  const s = r.state;
  assert.equal(s.asOfTs, '2026-10-05 22:09:10');
  assert.equal(s.pending.length, s.pendingTotal);
  assert.equal(s.pending[0].label, '434503024', 'oldest first');
  assert.ok(s.pending.every(x => x.user === 'Auto' || x.user === 'Manuel'));
  assert.equal(s.articles.length, 93);
  assert.ok(s.articles.every(x => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x.t)), 'last entry time per article');
  eq(s.articles.map(x => x.a), s.articles.map(x => x.a).slice().sort());
  assert.equal(s.kpi.noProjectArticles, 81);
  assert.ok(JSON.stringify(s).length < 400000, 'compact state');
  // every block is free (no rules, no projects): EXP2 pallets of known articles are spread over the 8 blocks
  assert.equal(s.blocks.reduce((t, b) => t + b.pallets, 0) + r.toPlace.pallets, r.kpi.exp2Pallets);
  assert.ok(s.blocks.every(b => b.title === 'Libre'));
  const tables = Engine.toTables(r);
  for (const name of CALC_TABS) for (const row of tables[name]) assert.equal(row.length, CFG.HEADERS[name].length, name);
});

test('real MB51 export: without the import filter, the engine keeps the same finished goods (tracked articles)', () => {
  const { rows, Norm, result: filtered } = reel();
  const all = plain(Norm.normalizeBatch([{ name: REEL_FILE, rows }]).lines);
  assert.equal(all.length, EXPECTED_REEL.normalize.read);
  const r = Engine.compute(reelInput(all));
  assert.equal(r.counts.untracked, EXPECTED_REEL.normalize.dropped);
  assert.equal(r.counts.untrackedArticles, EXPECTED_REEL.normalize.droppedArticles);
  assert.equal(JSON.stringify(Engine.toTables(r)), JSON.stringify(Engine.toTables(filtered)));
  assert.equal(JSON.stringify(r.kpi), JSON.stringify(filtered.kpi));
});

// ---------------------------------------------------------------------------------------------
// Synthetic v2 cases: labels, hours, dwell, projects and placement, state
// ---------------------------------------------------------------------------------------------
const D5 = '2026-10-05';
const lbl = (n) => String(434500000 + n);

// One MB51 line in the real format (entry time + label).
function mv(article, magasin, mvt, doc, date, qty, ts, label, extra) {
  return Object.assign({ article, division: 'TA11', magasin, mvt, doc, date, qty, uqs: 'PCE', designation: 'ART ' + article,
    user: 'BARFLOW_TA11', source: 'IMPORT', ts: ts || '', label: label || '' }, extra || {});
}

// 131 declaration of label n (null: no label) at ts, into PRD2 unless mag is given.
function decl(art, n, qty, ts, mag, extra) {
  return mv(art, mag || 'PRD2', '131', 'D' + (n === null ? 'U' + ts.replace(/\D/g, '') : n), ts.slice(0, 10), qty, ts,
    n === null ? '' : lbl(n), extra);
}

// 311 transfer of label n (null: no label): issuing leg, then receiving leg, same document.
function xfer(art, n, qty, ts, from, to, doc, date) {
  const d = date || ts.slice(0, 10), l = n === null ? '' : lbl(n);
  return [mv(art, from, '311', doc, d, -qty, ts, l), mv(art, to, '311', doc, d, qty, ts, l)];
}

function v2Input(movements, extra) {
  return Object.assign({
    asOf: null, plant: 'TA11', movements, opening: [], articles: [], projects: [],
    blocks: [{ id: 'B1', label: 'Bloc 1', cols: 5, rows: 1, levels: 2 }, { id: 'B2', label: 'Bloc 2', cols: 5, rows: 1, levels: 2 }],
    rules: [], mvtKinds: CFG.MVT_KINDS, thresholds: CFG.THRESHOLDS, docks: [], computedAt: 'x', version: 1
  }, extra || {});
}

test('v2: an issue with a label takes its own layer; without a label it takes the oldest one (FIFO)', () => {
  const base = [decl('A', 1, 10, D5 + ' 08:00:00'), decl('A', 2, 10, D5 + ' 08:10:00')];
  const r = Engine.compute(v2Input(base.concat(xfer('A', 2, 10, D5 + ' 08:40:00', 'PRD2', 'EXP2', 'T1'))));
  eq(r.pending.map(x => x.label), [lbl(1)]);
  eq(r.fifo.map(x => x.label), [lbl(2)]);
  assert.equal(r.asOfTs, D5 + ' 08:40:00');
  assert.equal(r.pending[0].hours, 0.67, '40 min');
  assert.equal(r.pending[0].level, '');
  assert.equal(r.pending[0].pallets, 1);
  assert.equal(r.kpi.dwellCount, 1);
  assert.equal(r.kpi.dwellMedianH, 0.5, 'declared 08:10, transferred 08:40');
  assert.equal(r.counts.preData + r.counts.negative, 0);

  const u = Engine.compute(v2Input(base.concat(xfer('A', null, 10, D5 + ' 08:40:00', 'PRD2', 'EXP2', 'T1'))));
  eq(u.pending.map(x => x.label), [lbl(2)], 'FIFO took label 1');
  eq(u.fifo.map(x => x.label), ['']);
  // SPEC 4.6: the dwell is measured when the first layer taken is labeled, whatever the line: label 1, 08:00 -> 08:40
  eq([u.kpi.dwellCount, u.kpi.dwellMedianH], [1, 0.67]);
  // the first layer taken is unlabeled: no dwell
  const v = Engine.compute(v2Input([decl('A', null, 10, D5 + ' 07:00:00')].concat(base,
    xfer('A', null, 10, D5 + ' 08:40:00', 'PRD2', 'EXP2', 'T1'))));
  eq(v.pending.map(x => x.label), [lbl(1), lbl(2)]);
  assert.equal(v.kpi.dwellCount, 0);
});

test('v2: a label never stored here is stock from before the data; a label already gone is negative; never another label', () => {
  const lines = [
    decl('A', 1, 10, D5 + ' 08:00:00'),
    ...xfer('A', 9, 10, D5 + ' 09:00:00', 'PRD2', 'EXP2', 'T1'), // label 9 was never declared in PRD2
    decl('A', 3, 10, D5 + ' 09:30:00'),
    ...xfer('A', 3, 10, D5 + ' 10:00:00', 'PRD2', 'EXP2', 'T2'),
    ...xfer('A', 3, 10, D5 + ' 11:00:00', 'PRD2', 'EXP2', 'T3') // label 3 already left PRD2
  ];
  const r = Engine.compute(v2Input(lines));
  eq(r.pending.map(x => [x.label, x.qty]), [[lbl(1), 10]], 'label 1 untouched');
  assert.equal(r.counts.preData, 1);
  assert.equal(r.counts.negative, 1);
  eq(r.fifo.map(x => x.label), [lbl(9), lbl(3), lbl(3)]);
  // A labeled exit of a label never seen in EXP2 takes the unlabeled layers: the exit row keeps the line's label.
  const x = Engine.compute(v2Input([mv('A', 'EXP2', '131', 'U1', D5, 20, D5 + ' 08:00:00', ''),
    mv('A', 'EXP2', '601', 'L1', D5, -10, D5 + ' 10:00:00', lbl(7))], { articles: [{ article: 'A', qpp: 10 }] }));
  eq(x.exits.map(e => [e.label, e.qty, e.tsIn, e.stayHours]), [[lbl(7), 10, D5 + ' 08:00:00', 2]]);
  assert.equal(x.counts.preData, 0);
  // No opening stock: one calm warning, preData never alerts.
  const neg = r.alerts.filter(a => a.code === 'NEGATIVE_STOCK');
  eq(plain(neg), [{ level: 'warn', code: 'NEGATIVE_STOCK', text: '1 sortie sans stock connu : importez le stock initial (MB52)' }]);
  assert.ok(!r.alerts.some(a => a.level === 'crit' && a.code !== 'PRD2_CRIT'));

  // With an opening stock: v1 behavior, one critical alert per line.
  const o = Engine.compute(v2Input(lines, { opening: [{ article: 'A', magasin: 'EMRT', qty: 5, uqs: 'PCE', date: '2026-10-04' }] }));
  const crit = o.alerts.filter(a => a.code === 'NEGATIVE_STOCK');
  assert.equal(crit.length, 1);
  assert.equal(crit[0].level, 'crit');
  assert.ok(crit[0].text.startsWith('Stock négatif ramené à 0 : article A en PRD2 (Doc.article T3 du 05.10.2026, manque 10'), crit[0].text);
  assert.equal(o.counts.preData, 1);
});

test('v2: a labeled issue takes its label, then the unlabeled layers FIFO, never another label', () => {
  const r = Engine.compute(v2Input([
    decl('A', null, 5, D5 + ' 08:00:00'),
    decl('A', 1, 10, D5 + ' 08:10:00'),
    decl('A', 2, 10, D5 + ' 08:20:00'),
    ...xfer('A', 1, 12, D5 + ' 09:00:00', 'PRD2', 'EXP2', 'T1') // 10 of label 1 + 2 unlabeled
  ]));
  eq(r.pending.map(x => [x.label, x.qty, x.pallets]), [['', 3, 1], [lbl(2), 10, 1]]);
  assert.equal(r.counts.preData + r.counts.negative, 0);
  eq(r.fifo.map(x => [x.label, x.qty]), [[lbl(1), 12]]);
  assert.equal(r.kpi.dwellMedianH, 0.83, 'from its own label: 08:10 -> 09:00');
  assert.equal(r.learnedQpp.A, 10, '10, 10, 12 -> 10');
});

test('v2: an unlabeled issue takes labeled layers FIFO (v1 rule), an unlabeled reversal the newest layer', () => {
  const r = Engine.compute(v2Input([
    decl('A', 1, 10, D5 + ' 08:00:00'),
    decl('A', null, 5, D5 + ' 08:30:00'),
    decl('A', 2, 10, D5 + ' 09:00:00'),
    ...xfer('A', null, 12, D5 + ' 10:00:00', 'PRD2', 'EXP2', 'T1'), // label 1 (10) + 2 of the unlabeled layer
    mv('A', 'PRD2', '132', 'R1', D5, -4, D5 + ' 10:30:00', '') // newest layer: label 2
  ]));
  eq(r.pending.map(x => [x.label, x.qty]), [['', 3], [lbl(2), 6]]);
  eq([r.kpi.dwellCount, r.kpi.dwellMedianH], [1, 2], 'its first layer is label 1, declared at 08:00');
  assert.equal(r.daily[0].declared, 2, '1 + ceil(5/10) + 1 - ceil(4/10)');
  assert.equal(r.kpi.pendingPallets, 2, 'label 2 (1) + 3 unlabeled units (1)');
});

test('v2: a reversal with a label cancels that label, not the newest layer', () => {
  const r = Engine.compute(v2Input([
    decl('A', 1, 10, D5 + ' 08:00:00'),
    decl('A', 2, 10, D5 + ' 09:00:00'),
    decl('A', 3, 10, D5 + ' 10:00:00'),
    mv('A', 'PRD2', '132', 'R1', D5, -10, D5 + ' 11:00:00', lbl(1))
  ], { articles: [{ article: 'A' }] }));
  eq(r.pending.map(x => x.label), [lbl(2), lbl(3)]);
  assert.equal(r.daily[0].declared, 2, 'a labeled line is 1 pallet, reversal included');
});

test('v2: pallets = 1 per label + the unlabeled rest by qpp (labelIsPallet); v1 rule with labelIsPallet = 0', () => {
  const lines = [
    mv('A', 'EXP2', '131', 'U1', D5, 7, D5 + ' 08:00:00', ''),
    decl('A', 1, 10, D5 + ' 08:10:00', 'EXP2'),
    decl('A', 2, 10, D5 + ' 08:20:00', 'EXP2'),
    mv('A', 'EXP2', '131', 'U2', D5, 18, D5 + ' 08:30:00', ''),
    mv('A', 'EXP2', '601', 'S1', D5, -4, D5 + ' 09:00:00', ''), // unlabeled: oldest layer (U1 -> 3)
    mv('A', 'EXP2', '601', 'S2', D5, -4, D5 + ' 09:10:00', lbl(2)) // labeled: label 2 -> 6, still 1 pallet
  ];
  const articles = [{ article: 'A', designation: 'ART A', uqs: 'PCE', qpp: 10 }];
  const r = Engine.compute(v2Input(lines, { articles }));
  assert.equal(r.kpi.exp2Pallets, 5, '2 labels + ceil((3 + 18) / 10)');
  assert.equal(r.stock[0].pallets.EXP2, 5);
  eq(r.fifo.map(x => [x.doc, x.label, x.qty, x.pallets]),
    [['U1', '', 3, 2], ['D1', lbl(1), 10, 1], ['D2', lbl(2), 6, 1], ['U2', '', 18, 1]]);
  eq(r.daily.map(d => [d.declared, d.entries, d.exits, d.stockEnd]), [[5, 5, 2, 5]]);
  eq(r.exits.map(x => [x.doc, x.label, x.qty, x.tsIn, x.tsOut, x.stayHours]), [
    ['S1', '', 4, D5 + ' 08:00:00', D5 + ' 09:00:00', 1],
    ['S2', lbl(2), 4, D5 + ' 08:20:00', D5 + ' 09:10:00', 0.83]
  ]);
  // An article without labels keeps the v1 rule.
  const b = Engine.compute(v2Input([mv('B', 'EXP2', '131', 'U3', D5, 25, D5 + ' 08:00:00', '')],
    { articles: [{ article: 'B', qpp: 10 }] }));
  assert.equal(b.kpi.exp2Pallets, 3);

  const v1 = Engine.compute(v2Input(lines, { articles, thresholds: Object.assign({}, CFG.THRESHOLDS, { labelIsPallet: 0 }) }));
  assert.equal(v1.kpi.exp2Pallets, 4, 'ceil(37 / 10)');
  eq(v1.fifo.map(x => x.pallets), [1, 1, 1, 1]);
  eq(v1.daily.map(d => [d.declared, d.entries, d.exits]), [[5, 5, 2]], 'ceil(qty / qpp) per line');
  assert.equal(v1.thresholds.labelIsPallet, 0);
});

test('v2: learned quantity per pallet (mode, ties -> larger), ARTICLES first, qppSource', () => {
  const lines = [
    ...[15, 15, 18, 18, 6].map((q, i) => decl('B', 10 + i, q, D5 + ' 08:0' + i + ':00', 'EXP2')),
    ...[20, 20, 20].map((q, i) => mv('B', 'EXP2', '131', 'BU' + i, D5, q, D5 + ' 09:0' + i + ':00', '')), // unlabeled: ignored
    mv('B', 'EXP2', '601', 'S1', D5, -20, D5 + ' 10:00:00', lbl(99)), // negative: ignored
    decl('C', 20, 15, D5 + ' 08:00:00', 'EXP2'),
    mv('D', 'EXP2', '131', 'DU', D5, 9, D5 + ' 08:00:00', ''),
    ...[12.5, 12.5, 7.25].map((q, i) => decl('E', 30 + i, q, D5 + ' 08:1' + i + ':00', 'EXP2', { uqs: 'KG' }))
  ];
  const r = Engine.compute(v2Input(lines, { articles: [{ article: 'C', qpp: 12 }] }));
  const by = Object.fromEntries(r.stock.map(s => [s.article, s]));
  eq([by.B.qpp, by.B.qppSource, by.B.known], [18, 'ÉTIQUETTES', true]);
  eq([by.C.qpp, by.C.qppSource], [12, 'ARTICLES']);
  eq([by.D.qpp, by.D.qppSource, by.D.known, by.D.pallets.EXP2], [null, '', false, null]);
  eq([by.E.qpp, by.E.qppSource], [12.5, 'ÉTIQUETTES']);
  eq(r.learnedQpp, { B: 18, C: 15, E: 12.5 });
  // the labeled exit of an unknown label takes the unlabeled layers: 5 labels + ceil(40 / 18) pallets
  assert.equal(by.B.pallets.EXP2, 8);
  assert.equal(r.counts.preData, 0, 'the units were found in the unlabeled layers');
  const row = Engine.toTables(r).CALC_STOCK.find(x => x[0] === 'B');
  eq(row.slice(10), ['ÉTIQUETTES', '']);
});

test('v2: pending hours and levels at the 4 h and 6 h boundaries; rows without entry time keep the day rule', () => {
  const lines = [
    mv('A', 'PRD2', '131', 'D0', '2026-10-01', 5, '', ''), // no entry time: 4 days
    decl('A', 6, 10, D5 + ' 14:00:00'), // 6 h 00 at 20:00
    decl('A', 5, 10, D5 + ' 14:00:30'), // 5 h 59 min 30
    decl('A', 4, 10, D5 + ' 16:00:00'), // 4 h 00
    decl('A', 3, 10, D5 + ' 16:00:30'), // 3 h 59 min 30
    decl('Z', 9, 10, D5 + ' 20:00:00') // the time of the data
  ];
  const articles = [{ article: 'A' }, { article: 'Z' }];
  const r = Engine.compute(v2Input(lines, { articles }));
  assert.equal(r.asOfTs, D5 + ' 20:00:00');
  eq(r.pending.map(x => [x.article, x.label, x.hours, x.level, x.days, x.pallets]), [
    ['A', '', null, 'warn', 4, 1],
    ['A', lbl(6), 6, 'crit', 0, 1],
    ['A', lbl(5), 5.99, 'warn', 0, 1],
    ['A', lbl(4), 4, 'warn', 0, 1],
    ['A', lbl(3), 3.99, '', 0, 1],
    ['Z', lbl(9), 0, '', 0, 1]
  ]);
  const k = r.kpi;
  eq([k.pendingCrit, k.pendingWarn, k.pendingLabels, k.oldestPendingHours, k.stuckPendingLines, k.pendingPallets],
    [1, 3, 5, 6, 1, 6]);
  assert.equal(r.alerts[0].code, 'PRD2_CRIT');
  assert.equal(r.alerts[0].text, '1 palette en PRD2 depuis plus de 6 h · la plus ancienne : A depuis 6 h 00 (étiquette ' + lbl(6) + ')');
  const warn = r.alerts.find(a => a.code === 'PRD2_WARN');
  assert.equal(warn.text, '2 palettes en PRD2 depuis 4 à 6 h', 'timed rows only');
  assert.equal(r.alerts.filter(a => a.level === 'warn')[0].code, 'PRD2_WARN', 'first warning');
  const stuck = r.alerts.filter(a => a.code === 'PENDING_STUCK');
  assert.equal(stuck.length, 1);
  assert.ok(stuck[0].text.includes('Doc.article D0'), stuck[0].text);
  const t = Engine.toTables(r).CALC_EN_ATTENTE;
  // the sheet writes the level in French: alerte (crit), pré-alerte (warn)
  eq(t[2], ['A', 'ART A', '05.10.2026', 'D6', 10, 1, 0, lbl(6), '05.10.2026 14:00:00', 6, 'alerte', '']);
  eq(t[1].slice(7), ['', '', '', 'pré-alerte', '']);
  eq(t.slice(3).map(x => x[10]), ['pré-alerte', 'pré-alerte', '', '']);

  // Thresholds and project in the texts.
  const c = Engine.compute(v2Input(lines, {
    articles: [{ article: 'A', project: 'ATLAS' }, { article: 'Z' }],
    thresholds: Object.assign({}, CFG.THRESHOLDS, { pendingHoursWarn: 2, pendingHoursCrit: 5.5 })
  }));
  eq(c.pending.map(x => x.level), ['warn', 'crit', 'crit', 'warn', 'warn', '']);
  assert.equal(c.alerts[0].text, '2 palettes en PRD2 depuis plus de 5,5 h · la plus ancienne : A ATLAS depuis 6 h 00 (étiquette ' +
    lbl(6) + ')');
  assert.equal(c.alerts.find(a => a.code === 'PRD2_WARN').text, '2 palettes en PRD2 depuis 2 à 5,5 h');
  assert.equal(c.projectsList.find(p => p.project === 'ATLAS').pendingCrit, 2);
  assert.ok(Engine.toTables(c).CALC_KPI.some(row => row[0] === 'Palettes en attente > 5,5 h' && row[1] === 2));
});

test('v2: dwell median / P90 (even and odd counts), per posting date, night entries on the previous day', () => {
  const H = 3600;
  eq(plain(Engine.dwellStats([])), { count: 0, medianH: null, p90H: null });
  eq(plain(Engine.dwellStats([1234])), { count: 1, medianH: 0.34, p90H: 0.34 });
  // odd: median = middle value; P90 = sorted[ceil(4.5) - 1] = 5th
  eq(plain(Engine.dwellStats([600, 1800, 3600, 900, 7200])), { count: 5, medianH: 0.5, p90H: 2 });
  // even: median = mean of the two middle values; P90 = sorted[ceil(3.6) - 1] = 4th
  eq(plain(Engine.dwellStats([5400, 1800, 7200, 3600])), { count: 4, medianH: 1.25, p90H: 2 });
  // half-up on the exact value: (400 + 500) / 2 s = 0.125 h -> 0.13; 500 s = 0.1389 h -> 0.14
  eq(plain(Engine.dwellStats([400, 500])), { count: 2, medianH: 0.13, p90H: 0.14 });
  // ten values: P90 = sorted[8]
  assert.equal(Engine.dwellStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(x => x * H)).p90H, 9);

  const D4 = '2026-10-04';
  const lines = [
    decl('A', 1, 10, D4 + ' 10:00:00'), ...xfer('A', 1, 10, D4 + ' 11:00:00', 'PRD2', 'EXP2', 'T1'), // 60 min
    decl('A', 2, 10, D4 + ' 12:00:00'), ...xfer('A', 2, 10, D4 + ' 13:30:00', 'PRD2', 'EXP2', 'T2'), // 90 min
    // night: entered on the 5th at 00:40 / 01:10, posted on the 4th
    Object.assign(decl('A', 3, 10, D5 + ' 00:40:00'), { date: D4 }), ...xfer('A', 3, 10, D5 + ' 01:10:00', 'PRD2', 'EXP2', 'T3', D4),
    decl('A', 4, 10, D5 + ' 08:00:00'), ...xfer('A', 4, 10, D5 + ' 08:10:00', 'PRD2', 'EXP2', 'T4'), // 10 min
    decl('A', 5, 10, D5 + ' 09:00:00'), ...xfer('A', 5, 10, D5 + ' 09:20:00', 'PRD2', 'EXP2', 'T5'), // 20 min
    decl('A', 6, 10, D5 + ' 10:00:00'), ...xfer('A', 6, 10, D5 + ' 10:50:00', 'PRD2', 'EXP2', 'T6'), // 50 min
    // re-scan of label 4: EXP2 -> PRD2 -> EXP2 30 s later (a 30 s dwell, as the reference counts it)
    ...xfer('A', 4, 10, D5 + ' 11:00:00', 'EXP2', 'PRD2', 'T7'), ...xfer('A', 4, 10, D5 + ' 11:00:30', 'PRD2', 'EXP2', 'T8')
  ];
  const r = Engine.compute(v2Input(lines));
  eq(r.daily.map(d => [d.date, d.dwellCount, d.dwellMedianH, d.dwellP90H]), [
    [D4, 3, 1, 1.5],
    [D5, 4, 0.25, 0.83]
  ]);
  eq([r.kpi.dwellCount, r.kpi.dwellMedianH, r.kpi.dwellP90H], [4, 0.25, 0.83]);
  eq(Engine.toTables(r).CALC_JOURNALIER.map(x => x.slice(7)), [
    ['Délai PRD2→EXP2 médian (h)', 'Délai PRD2→EXP2 P90 (h)'], [1, 1.5], [0.25, 0.83]]);
  eq(r.state.daily.map(d => [d.dwellMedianH, d.dwellP90H]), [[1, 1.5], [0.25, 0.83]]);
  assert.equal(r.pending.length, 0);
  assert.equal(r.kpi.exp2Pallets, 6);

  // asOf on the 4th: its night lines (entered on the 5th) belong to it
  const past = Engine.compute(v2Input(lines, { asOf: D4 }));
  assert.equal(past.asOfTs, D5 + ' 01:10:00');
  assert.equal(past.counts.afterAsOf, 13);
  eq([past.kpi.dwellCount, past.kpi.dwellMedianH], [3, 1]);
});

test('v2: lines are ordered by date, then entry time, then document', () => {
  // Document numbers decreasing with time: by document only, the transfer would come before the declaration.
  const r = Engine.compute(v2Input([
    mv('A', 'PRD2', '131', '900', D5, 10, D5 + ' 08:00:00', lbl(1)),
    ...xfer('A', 1, 10, D5 + ' 09:00:00', 'PRD2', 'EXP2', '100'),
    mv('B', 'PRD2', '131', '950', D5, 5, '', ''), // no entry time: first of its date
    ...xfer('B', null, 5, D5 + ' 07:00:00', 'PRD2', 'EXP2', '200')
  ]));
  assert.equal(r.counts.preData, 0);
  assert.equal(r.counts.negative, 0);
  assert.equal(r.pending.length, 0);
  assert.equal(r.kpi.dwellMedianH, 1);
});

test('v2: tracked articles only (ARTICLES + articles seen in EXP2); trackAll = 1 computes everything', () => {
  const lines = [
    decl('F', 1, 10, D5 + ' 08:00:00'), ...xfer('F', 1, 10, D5 + ' 09:00:00', 'PRD2', 'EXP2', 'T1'),
    mv('S', 'PRD2', '131', 'S1', D5, 100, D5 + ' 08:00:00', ''), // semi-finished part: never in EXP2
    mv('S', 'PRD2', '261', 'S2', D5, -40, D5 + ' 08:30:00', ''),
    ...xfer('S', null, 20, D5 + ' 09:00:00', 'EMRT', 'PRD2', 'S3'),
    mv('S', 'PRD2', '999', 'S5', D5, 5, D5 + ' 09:30:00', ''),
    mv('M', 'PRD2', '131', 'M1', D5, 10, D5 + ' 08:00:00', '') // listed in ARTICLES
  ];
  const opening = [{ article: 'S', magasin: 'PRD2', qty: 50, uqs: 'PCE', date: '2026-10-04' },
    { article: 'F', magasin: 'EXP2', qty: 20, uqs: 'PCE', date: '2026-10-04' }];
  const articles = [{ article: 'M', qpp: 5 }];
  const r = Engine.compute(v2Input(lines, { opening, articles }));
  eq(r.stock.map(s => s.article), ['F', 'M']);
  assert.equal(r.counts.untracked, 6, '5 lines + 1 opening row');
  assert.equal(r.counts.untrackedArticles, 1);
  assert.equal(r.counts.ignored, 0);
  assert.ok(!r.alerts.some(a => a.code === 'UNKNOWN_MVT' || a.code === 'UNPAIRED_TRANSFER'), 'skipped lines raise nothing');
  assert.equal(r.kpi.trackedArticles, 2);
  assert.equal(r.stock[0].qty.EXP2, 30, 'opening 20 + label 1');

  const all = Engine.compute(v2Input(lines, { opening, articles, thresholds: Object.assign({}, CFG.THRESHOLDS, { trackAll: 1 }) }));
  eq(all.stock.map(s => s.article), ['F', 'M', 'S']);
  assert.equal(all.counts.untracked, 0);
  assert.equal(all.counts.ignored, 1);
  assert.ok(all.alerts.some(a => a.code === 'UNKNOWN_MVT' && a.text.includes('999')));
  assert.equal(all.stock[2].qty.PRD2, 170, '50 + 100 + 20 (261 is IGNORE in PARAM_MOUVEMENTS)');
});

test('v2: UNPAIRED_TRANSFER counts unlabeled legs only (a labeled leg pairs outside the export)', () => {
  const r = Engine.compute(v2Input([
    decl('A', 1, 10, D5 + ' 08:00:00'),
    mv('A', 'PRD2', '311', 'T1', D5, -10, D5 + ' 09:00:00', lbl(1)), // other leg in PRD5, outside the export
    mv('A', 'EXP2', '311', 'T2', D5, 5, D5 + ' 09:30:00', '')
  ]));
  assert.equal(r.counts.unpaired, 1);
  assert.equal(r.counts.unpairedLabeled, 1);
  const u = r.alerts.filter(a => a.code === 'UNPAIRED_TRANSFER');
  assert.equal(u.length, 1);
  assert.equal(u[0].text, '1 ligne de transfert sans ligne opposée dans le même Doc.article (ex. Doc.article T2, article A, EXP2)');
});

// Placement fixture: B1 (10 places), B2 (10), B3 (6), B4 (4); qpp 1, one unlabeled EXP2 declaration per article.
const PLACE_BLOCKS = [
  { id: 'B1', label: 'Allée 1', cols: 5, rows: 1, levels: 2 }, { id: 'B2', label: 'Allée 2', cols: 5, rows: 1, levels: 2 },
  { id: 'B3', label: 'Allée 3', cols: 3, rows: 1, levels: 2 }, { id: 'B4', label: 'Allée 4', cols: 2, rows: 1, levels: 2 }];
const PLACE_ARTICLES = [['A1', 'ATLAS', 12], ['A2', 'boreal', 5], ['A3', 'CORSO', 4], ['A4', '', 3], ['A5', 'ATLAS', 3], ['A6', 'ATLAS', 2]];

function placeInput(extra) {
  return v2Input(PLACE_ARTICLES.map(([a, , n], i) => mv(a, 'EXP2', '131', 'P' + i, D5, n, D5 + ' 08:0' + i + ':00', '')), Object.assign({
    blocks: PLACE_BLOCKS,
    articles: PLACE_ARTICLES.map(([a, p]) => ({ article: a, designation: 'ART ' + a, uqs: 'PCE', qpp: 1, project: p }))
  }, extra || {}));
}

test('v2: placement by project: project blocks, a shared block, free blocks, an ARTICLE rule beating a project', () => {
  const r = Engine.compute(placeInput({
    projects: [{ project: 'ATLAS', blocks: ['B1', 'B2'], color: '#123456', comment: '' },
      { project: 'BOREAL', blocks: 'B2', color: '' }, { project: 'CORSO', blocks: '', color: 'rouge' }],
    rules: [{ priority: 5, criterion: 'ARTICLE', value: 'A5', blocks: ['B4'] }, // equal priority: ARTICLE before PROJET
      { priority: 10, criterion: 'ARTICLE', value: 'A6', blocks: 'B4' }] // lower priority: the project wins
  }));
  eq(r.blocks.map(b => [b.id, b.pallets, b.projects, b.title, b.families]), [
    ['B1', 7, ['ATLAS'], 'ATLAS', ''],
    ['B2', 10, ['ATLAS', 'BOREAL'], 'ATLAS / BOREAL', ''],
    ['B3', 6, [], 'Libre', ''],
    ['B4', 3, [], 'Articles A5, A6', 'A5, A6']
  ]);
  const c = r.blockContents;
  const ent = (id) => c[id].map(e => [e.article, e.pallets, e.project]);
  eq(ent('B1'), [['A1', 7, 'ATLAS']]);
  eq(ent('B2'), [['A1', 5, 'ATLAS'], ['A6', 2, 'ATLAS'], ['A2', 3, 'BOREAL']]);
  eq(ent('B3'), [['A3', 4, 'CORSO'], ['A4', 2, '']], 'no rule (CORSO has no block, A4 no project): free block');
  eq(ent('B4'), [['A5', 3, 'ATLAS']]);
  eq(ent('À PLACER'), [['A2', 2, 'BOREAL'], ['A4', 1, '']]);
  eq(r.toPlace.projects, ['BOREAL', 'Sans projet']);
  assert.equal(r.toPlace.pallets, 3);
  assert.equal(r.alerts.find(a => a.code === 'TO_PLACE').text, '3 palettes hors capacité des blocs (projet BOREAL, Sans projet) : à placer');
  // Colors: PROJETS first, else the palette by rank in sorted names; invalid colors are ignored.
  eq(r.projects, { ATLAS: '#123456', BOREAL: CFG.COLORS.projects[1], CORSO: CFG.COLORS.projects[2],
    'Sans projet': CFG.COLORS.noProject });
  eq(plain(r.projectsList), [
    { project: 'ATLAS', color: '#123456', blocks: ['B1', 'B2'], articles: 3, exp2Pallets: 17, pendingPallets: 0, pendingCrit: 0 },
    { project: 'BOREAL', color: CFG.COLORS.projects[1], blocks: ['B2'], articles: 1, exp2Pallets: 5, pendingPallets: 0, pendingCrit: 0 },
    { project: 'CORSO', color: CFG.COLORS.projects[2], blocks: [], articles: 1, exp2Pallets: 4, pendingPallets: 0, pendingCrit: 0 },
    { project: 'Sans projet', color: CFG.COLORS.noProject, blocks: [], articles: 1, exp2Pallets: 3, pendingPallets: 0, pendingCrit: 0 }
  ]);
  assert.equal(r.stock.find(s => s.article === 'A2').project, 'BOREAL', 'displayed as written in PROJETS');
  eq([r.kpi.projects, r.kpi.noProjectArticles], [3, 1]);
  assert.equal(r.alerts.find(a => a.code === 'NO_PROJECT').text, '1 référence suivie sans projet : affectez-la dans la page Projets');

  const s = r.state;
  eq(s.blocks.map(b => b.title), ['ATLAS', 'ATLAS / BOREAL', 'Libre', 'Articles A5, A6']);
  eq(s.layout.blocks.map(b => [b.id, b.projects, b.title]),
    [['B1', ['ATLAS'], 'ATLAS'], ['B2', ['ATLAS', 'BOREAL'], 'ATLAS / BOREAL'], ['B3', [], 'Libre'], ['B4', [], 'Articles A5, A6']]);
  eq(s.projects, r.projects);
  eq(s.projectsList, r.projectsList);
  eq(s.articles[1], { a: 'A2', d: 'ART A2', p: 'BOREAL', e: 5, w: 0, m: 0, q: 1, qs: 'ARTICLES', t: D5 + ' 08:01:00' });
  eq(s.articles.map(x => [x.a, x.p]), PLACE_ARTICLES.map(([a, p]) => [a, p === 'boreal' ? 'BOREAL' : p]));
  const blocs = Engine.toTables(r).CALC_BLOCS;
  eq(blocs.map(x => x[6]), ['Projet(s)', 'ATLAS', 'ATLAS, BOREAL', '', '', 'BOREAL, Sans projet']);
  eq(Engine.toTables(r).CALC_STOCK.slice(1).map(x => x[11]), ['ATLAS', 'BOREAL', 'CORSO', '', 'ATLAS', 'ATLAS']);
  assert.equal(Engine.lookup(r, 'A2').project, 'BOREAL');

  // The same project twice in PROJETS (any case): one project, blocks united, first spelling and color kept.
  const dup = Engine.compute(placeInput({ projects: [{ project: 'ATLAS', blocks: 'B1', color: '#123456' },
    { project: 'atlas', blocks: 'B3', color: '#654321' }] }));
  eq(dup.projectsList[0], { project: 'ATLAS', color: '#123456', blocks: ['B1', 'B3'], articles: 3, exp2Pallets: 17, pendingPallets: 0,
    pendingCrit: 0 });
  // ATLAS: 17 pallets over B1 + B3 (16 places, 1 to place); the others (12) over the free B2 + B4 (14 places): 9 + 3
  eq(dup.blocks.map(b => [b.id, b.title, b.pallets]), [['B1', 'ATLAS', 10], ['B2', 'Libre', 9], ['B3', 'ATLAS', 6], ['B4', 'Libre', 3]]);
  eq(dup.blockContents.B3.map(e => [e.article, e.pallets]), [['A1', 2], ['A5', 3], ['A6', 1]]);
  eq(dup.blockContents['À PLACER'].map(e => [e.article, e.pallets]), [['A6', 1]]);
});

test('v2: placement without any rule or project block spreads every article over all the blocks (no family fallback)', () => {
  const r = Engine.compute(placeInput());
  // 29 pallets over 30 places in proportion to capacity (largest remainder): 10, 9, 6, 4
  eq(r.blocks.map(b => [b.id, b.pallets, b.title]), [['B1', 10, 'Libre'], ['B2', 9, 'Libre'], ['B3', 6, 'Libre'],
    ['B4', 4, 'Libre']]);
  assert.equal(r.toPlace.pallets, 0);
  eq(r.toPlace.projects, []);
  // project names come from ARTICLES only, displayed as written there
  eq(r.projects, { ATLAS: CFG.COLORS.projects[0], boreal: CFG.COLORS.projects[1], CORSO: CFG.COLORS.projects[2],
    'Sans projet': CFG.COLORS.noProject });
  eq(r.projectsList.map(p => [p.project, p.blocks, p.articles]),
    [['ATLAS', [], 3], ['boreal', [], 1], ['CORSO', [], 1], ['Sans projet', [], 1]]);

  // A project whose blocks are no longer in the layout is a project without blocks: free blocks, no À PLACER.
  const ghost = Engine.compute(placeInput({ projects: [{ project: 'ATLAS', blocks: ['B9'] }] }));
  eq(ghost.blocks.map(b => [b.id, b.pallets, b.title]), r.blocks.map(b => [b.id, b.pallets, b.title]));
  assert.equal(ghost.toPlace.pallets, 0);
  eq(ghost.projectsList[0].blocks, []);

  // Every block targeted and an article without a rule: it goes to À PLACER (v1).
  const full = Engine.compute(placeInput({ rules: [{ priority: 1, criterion: 'PROJET', value: 'atlas', blocks: 'B1 B2 B3 B4' }] }));
  eq(full.blocks.map(b => b.title), ['ATLAS', 'ATLAS', 'ATLAS', 'ATLAS'], 'a PROJET rule of REGLES_PLACEMENT');
  eq(full.blockContents['À PLACER'].map(e => e.article), ['A2', 'A3', 'A4']);
  eq(full.toPlace.projects, ['boreal', 'CORSO', 'Sans projet']);
});

test('v2: the state keeps the 500 oldest pending rows; the KPIs carry the totals', () => {
  const lines = [];
  for (let i = 0; i < 620; i++) {
    const ts = new Date(Date.UTC(2026, 9, 5, 0, i)).toISOString().replace('T', ' ').slice(0, 19);
    lines.push(decl('A', i, 10, ts, 'PRD2', { user: i % 2 ? 'OPERATEUR01' : 'BARFLOW_TA11' }));
  }
  const r = Engine.compute(v2Input(lines, { articles: [{ article: 'A', qpp: 10 }] }));
  const s = r.state;
  assert.equal(s.pending.length, 500);
  assert.equal(s.pendingTotal, 620);
  assert.equal(s.pending[0].label, lbl(0), 'oldest first');
  assert.equal(s.pending[499].label, lbl(499));
  // asOfTs = 10:19; 6 h or more: entered up to 04:19 (260 labels); 4 to 6 h: 04:20 to 06:19 (120 labels)
  eq([s.kpi.pendingTotal, s.kpi.pendingPallets, s.kpi.pendingLabels, s.kpi.pendingCrit, s.kpi.pendingWarn],
    [620, 620, 620, 260, 120]);
  assert.equal(s.kpi.oldestPendingHours, 10.32);
  eq([s.pending[0].user, s.pending[1].user], ['Auto', 'Manuel']);
  assert.ok(!JSON.stringify(s).includes('OPERATEUR'), 'no user name in the state');
  assert.equal(r.alerts[0].text, '260 palettes en PRD2 depuis plus de 6 h · la plus ancienne : A depuis 10 h 19 (étiquette ' + lbl(0) + ')');
  assert.equal(Engine.toTables(r).CALC_EN_ATTENTE.length, 621, 'the sheet keeps every row');
});

test('v2: lookup and toTables carry labels and times; lookupAll = lookup', () => {
  const r = Engine.compute(v2Input([
    decl('A', 1, 10, D5 + ' 08:00:00'),
    decl('A', 2, 10, D5 + ' 08:30:00', 'PRD2', { user: 'OPERATEUR02' }),
    ...xfer('A', 1, 10, D5 + ' 09:00:00', 'PRD2', 'EXP2', 'T1'),
    mv('A', 'EXP2', '601', 'L1', D5, -4, D5 + ' 11:00:00', '', { client: 'CLIENT A', salesOrder: '1000000001' })
  ], { articles: [{ article: 'A', project: 'DELTA' }], projects: [{ project: 'Delta', blocks: ['B2'], color: '#00aa00' }] }));
  const lk = Engine.lookup(r, 'A');
  assert.equal(lk.project, 'Delta', 'as written in PROJETS');
  eq([lk.stock.qppSource, lk.stock.project, lk.stock.qpp], ['ÉTIQUETTES', 'Delta', 10]);
  eq(plain(lk.pending), [{ date: D5, doc: 'D2', qty: 10, pallets: 1, days: 0, label: lbl(2), ts: D5 + ' 08:30:00',
    hours: 2.5, level: '', user: 'Manuel' }]);
  eq(plain(lk.fifo), [{ date: D5, doc: 'T1', origin: 'PRD2', qty: 6, pallets: 1, age: 0, label: lbl(1),
    ts: D5 + ' 09:00:00', ageHours: 2 }]);
  eq(plain(lk.exits), [{ dateIn: D5, dateOut: D5, qty: 4, pallets: 0.4, destination: 'Client (601)', stay: 0, doc: 'L1',
    label: lbl(1), tsIn: D5 + ' 09:00:00', tsOut: D5 + ' 11:00:00', stayHours: 2 }]);
  eq(lk.locations, [{ block: 'B2', pallets: 1, ageMax: 0 }]);
  const all = Engine.lookupAll(r);
  eq(plain(all.A), plain(lk));

  const t = Engine.toTables(r);
  for (const name of CALC_TABS) {
    eq(t[name][0], CFG.HEADERS[name], name + ' headers');
    for (const row of t[name]) assert.equal(row.length, CFG.HEADERS[name].length, name + ' width');
  }
  eq(t.CALC_EN_ATTENTE[1].slice(7), [lbl(2), '05.10.2026 08:30:00', 2.5, '', 'Delta']);
  eq(t.CALC_FIFO_EXP2[1].slice(8), [lbl(1), '05.10.2026 09:00:00', 2, 'Delta']);
  eq(t.CALC_SORTIES[1].slice(8), [lbl(1), '05.10.2026 09:00:00', '05.10.2026 11:00:00', 2]);
  eq(t.CALC_STOCK[1].slice(10), ['ÉTIQUETTES', 'Delta']);
  const kpi = Object.fromEntries(t.CALC_KPI.slice(1).map(x => [x[0], x[1]]));
  assert.equal(kpi['Heure des données'], '05.10.2026 11:00:00');
  assert.equal(kpi['Plus ancienne attente (h)'], 2.5);
  assert.equal(kpi['Projets'], 1);
});

test('v2: the browser copy without CFG gives the same state (built-in palette, users and thresholds match CFG)', () => {
  const bare = vm.createContext({ Math, Date, JSON });
  const engine = vm.runInContext(`(${ctx.EngineModule_.toString()})()`, bare);
  const input = placeInput({ projects: [{ project: 'ATLAS', blocks: ['B1'] }] });
  input.movements.push(decl('A1', 7, 1, D5 + ' 09:00:00', 'PRD2', { user: 'ADMINJOB' }));
  input.movements.push(decl('A1', 8, 1, D5 + ' 09:10:00', 'PRD2', { user: 'Barflow TA11' }));
  const a = engine.compute(input), b = Engine.compute(input);
  assert.equal(JSON.stringify(a.state.projects), JSON.stringify(b.state.projects));
  // same state except what only CFG holds: the default layout drawing and the family colors
  const strip = (st) => JSON.stringify(Object.assign({}, st, { computedAt: '', families: null,
    layout: Object.assign({}, st.layout, { building: null, truckZone: null, quais: null, quaiLine: null, roads: null, zones: null }) }));
  assert.equal(strip(a.state), strip(b.state));
  eq(a.state.families, {});
  eq(b.state.pending.map(x => x.user), ['Auto', 'Auto']);
  // defaults without CFG (no thresholds in the input) are CFG's
  const noThr = Object.assign({}, input, { thresholds: undefined });
  const t = engine.compute(noThr).thresholds;
  for (const k of ['satWarn', 'satCrit', 'pendingDaysWarn', 'dockStagingWarn', 'pendingHoursWarn', 'pendingHoursCrit', 'labelIsPallet', 'trackAll']) {
    assert.equal(t[k], CFG.THRESHOLDS[k], k);
  }
});

test('v2: thresholds read from PARAM_SEUILS as text (decimal comma, 1 / 0, empty = default)', () => {
  const lines = [decl('A', 1, 10, D5 + ' 08:00:00'), decl('A', 2, 10, D5 + ' 10:00:00'), decl('Z', 3, 10, D5 + ' 13:45:00')];
  const r = Engine.compute(v2Input(lines, { articles: [{ article: 'A' }, { article: 'Z' }],
    thresholds: Object.assign({}, CFG.THRESHOLDS, { pendingHoursWarn: '3,5', pendingHoursCrit: '5,75', labelIsPallet: '0', trackAll: '' }) }));
  eq([r.thresholds.pendingHoursWarn, r.thresholds.pendingHoursCrit, r.thresholds.labelIsPallet, r.thresholds.trackAll], [3.5, 5.75, 0, 0]);
  eq(r.pending.map(x => [x.label, x.hours, x.level]), [[lbl(1), 5.75, 'crit'], [lbl(2), 3.75, 'warn'], [lbl(3), 0, '']]);
  assert.equal(r.alerts[0].text, '1 palette en PRD2 depuis plus de 5,75 h · la plus ancienne : A depuis 5 h 45 (étiquette ' + lbl(1) + ')');
});

// Differential check of the label-aware layers (label index, unlabeled queue, compaction) against a naive model of
// SPEC 4.4-4.6 written with plain arrays: random lines with reused labels, re-scans, reversals, unpaired legs, gaps.
function randomLines(seed, n) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const out = [];
  let t = Date.UTC(2026, 9, 1) / 1000, doc = 1000;
  const fmt = (sec) => new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const post = (sec) => { // entries between 00:00 and 01:59 are posted on the previous day
    const d = new Date(sec * 1000);
    if (d.getUTCHours() < 2) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const add = (a, mag, mvt, d, qty, sec, label) => out.push(mv(a, mag, mvt, String(d), post(sec), qty, fmt(sec), label));
  while (out.length < n) {
    t += Math.floor(rnd() * 900) + (rnd() < 0.01 ? 30 * 3600 : 0);
    const a = pick(['A', 'B', 'C']), q = pick([6, 6, 6, 8, 12, 12, 3]), r = rnd(), d = ++doc;
    const label = rnd() < 0.25 ? '' : lbl(Math.floor(rnd() * 40));
    if (r < 0.35) add(a, rnd() < 0.85 ? 'PRD2' : 'EXP2', '131', d, q, t, label);
    else if (r < 0.70) {
      const from = rnd() < 0.8 ? 'PRD2' : pick(['EXP2', 'EMRT']);
      let to = rnd() < 0.8 ? 'EXP2' : pick(['PRD2', 'EMRT']);
      if (to === from) to = from === 'EXP2' ? 'PRD2' : 'EXP2';
      add(a, from, '311', d, -q, t, label);
      if (rnd() < 0.97) add(a, to, '311', d, q, t, label);
    } else if (r < 0.80) add(a, 'EXP2', '601', d, -q * (1 + Math.floor(rnd() * 3)), t, rnd() < 0.5 ? '' : label);
    else if (r < 0.85) add(a, 'PRD2', '132', d, -q, t, label);
    else if (r < 0.90) { add(a, 'EXP2', '312', d, -q, t, label); add(a, 'PRD2', '312', d, q, t, label); }
    else if (r < 0.93) add(a, 'EXP2', '602', d, q, t, '');
    else if (r < 0.96) add(a, 'EMRT', '311', d, q, t, '');
    else add(a, 'PRD2', '311', d, -q, t, label);
  }
  return out;
}

function naiveModel(lines, labelIsPallet) {
  const ls = lines.map((l, i) => Object.assign({}, l, { i, q: Math.round(l.qty * 1000), kind: CFG.MVT_KINDS[l.mvt] }));
  const c = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
  ls.sort((a, b) => c(a.date, b.date) || c(a.ts, b.ts) || c(a.doc, b.doc) || ((a.q < 0 ? 0 : 1) - (b.q < 0 ? 0 : 1)) || (a.i - b.i));
  const other = (l) => {
    const o = ls.find(x => x !== l && x.doc === l.doc && x.article === l.article && (x.q > 0) !== (l.q > 0));
    return o ? o.magasin : '';
  };
  const counts = {};
  for (const l of ls) if (l.label && l.q > 0) (counts[l.article] = counts[l.article] || []).push(l.q);
  const qpp = {};
  for (const a of Object.keys(counts).sort()) {
    const n = {};
    counts[a].forEach(q => { n[q] = (n[q] || 0) + 1; });
    qpp[a] = Object.keys(n).map(Number).sort((x, y) => (n[y] - n[x]) || (y - x))[0];
  }
  const buckets = {}, seen = {}, daily = {}, dwell = {};
  let seq = 0, preData = 0, negative = 0;
  const sec = (ts) => Date.parse(ts.replace(' ', 'T') + 'Z') / 1000;
  for (const l of ls) {
    const key = l.article + '|' + l.magasin, layers = buckets[key] = buckets[key] || [];
    const day = daily[l.date] = daily[l.date] || { declared: 0, entries: 0, exits: 0 };
    const q = qpp[l.article] || 0, pal = labelIsPallet && l.label ? 1 : (q ? Math.ceil(Math.abs(l.q) / q) : 0);
    const rev = /_REV$/.test(l.kind);
    if (l.q > 0) {
      layers.push({ qty: l.q, label: l.label, ts: l.ts, seq: seq++ });
      if (l.label) (seen[key] = seen[key] || new Set()).add(l.label);
      if (l.magasin === 'EXP2' && !rev) day.entries += pal;
    } else {
      let need = -l.q;
      const taken = [];
      const takeFrom = (list) => list.forEach(L => {
        if (need <= 0 || L.qty <= 0) return;
        const t = Math.min(need, L.qty);
        L.qty -= t;
        need -= t;
        taken.push(L);
      });
      if (l.label) {
        takeFrom(layers.filter(L => L.label === l.label));
        takeFrom(layers.filter(L => !L.label));
        if (need > 0) seen[key] && seen[key].has(l.label) ? negative++ : preData++;
      } else {
        takeFrom(rev ? layers.slice().reverse() : layers);
        if (need > 0) negative++;
      }
      if (l.magasin === 'EXP2' && !rev) day.exits += pal;
      if (l.magasin === 'PRD2' && other(l) === 'EXP2' && taken.length && taken[0].label) {
        (dwell[l.date] = dwell[l.date] || []).push(sec(l.ts) - sec(taken[0].ts));
      }
    }
    if (l.kind === 'DECL') day.declared += pal;
    else if (l.kind === 'DECL_REV') day.declared -= pal;
  }
  return { buckets, qpp, daily, dwell, preData, negative };
}

test('v2: label-aware layers match a naive model of SPEC 4.4-4.6 on random data (labelIsPallet 1 and 0)', () => {
  for (const seed of [3, 9, 11]) {
    const lines = randomLines(seed, 2500);
    for (const lip of [1, 0]) {
      const m = naiveModel(lines, lip);
      const r = Engine.compute(v2Input(lines, { blocks: [], thresholds: Object.assign({}, CFG.THRESHOLDS, { labelIsPallet: lip }) }));
      const what = `seed ${seed} labelIsPallet ${lip}`;
      eq([r.counts.preData, r.counts.negative], [m.preData, m.negative], what + ' preData, negative');
      eq(r.learnedQpp, Object.fromEntries(Object.entries(m.qpp).map(([a, q]) => [a, q / 1000])), what + ' learned qpp');
      // live layers in seq order: PRD2 = pending rows, EXP2 = FIFO rows (each row carries its seq)
      const rows = {};
      r.pending.forEach(x => (rows[x.article + '|PRD2'] = rows[x.article + '|PRD2'] || []).push(x));
      r.fifo.forEach(x => (rows[x.article + '|EXP2'] = rows[x.article + '|EXP2'] || []).push(x));
      const pallets = { PRD2: 0, EXP2: 0, EMRT: 0 };
      for (const [key, layers] of Object.entries(m.buckets)) {
        const [art, mag] = key.split('|'), live = layers.filter(L => L.qty > 0), q = m.qpp[art] || 0;
        const nLab = live.filter(L => L.label).length, unl = live.filter(L => !L.label).reduce((t, L) => t + L.qty, 0);
        const tot = live.reduce((t, L) => t + L.qty, 0);
        pallets[mag] += !q ? 0 : (lip && nLab ? nLab + Math.ceil(unl / q) : Math.ceil(tot / q));
        if (mag === 'EMRT') {
          assert.equal(r.stock.find(s => s.article === art).qty.EMRT, tot / 1000, what + ' ' + key);
          continue;
        }
        eq((rows[key] || []).sort((a, b) => a.seq - b.seq).map(x => [x.qty, x.label, x.ts]),
          live.map(L => [L.qty / 1000, L.label, L.ts]), what + ' ' + key);
      }
      eq([r.kpi.pendingPallets, r.kpi.exp2Pallets, r.kpi.emrtPallets], [pallets.PRD2, pallets.EXP2, pallets.EMRT], what + ' pallets');
      assert.equal(r.pending.reduce((t, x) => t + (x.pallets || 0), 0), r.kpi.pendingPallets, what + ' pending rows');
      assert.equal(r.fifo.reduce((t, x) => t + (x.pallets || 0), 0), r.kpi.exp2Pallets, what + ' FIFO rows');
      for (const d of r.daily) {
        eq({ declared: d.declared, entries: d.entries, exits: d.exits }, m.daily[d.date] || { declared: 0, entries: 0, exits: 0 }, what + ' ' + d.date);
        const s = plain(Engine.dwellStats(m.dwell[d.date] || []));
        eq([d.dwellCount, d.dwellMedianH, d.dwellP90H], [s.count, s.medianH, s.p90H], what + ' dwell ' + d.date);
      }
      assert.ok(r.counts.preData > 0 && r.counts.negative > 0 && r.kpi.dwellCount >= 0, what);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Performance: about 1,400 lines a day; 100,000 movements must compute in a few seconds.
// ---------------------------------------------------------------------------------------------
function bigInput(target) {
  let seed = 2026;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const arts = Array.from({ length: 60 }, (_, i) => ({ code: 'PF' + (10000 + i), qty: [6, 8, 12, 15, 18, 24][i % 6] }));
  const stockLabels = new Map(arts.map(a => [a.code, 0]));
  const out = [];
  let label = 434500000, doc = 6900000000, day = 0;
  const at = (d, sec) => new Date(Date.UTC(2026, 0, 1 + d) + sec * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const push = (a, mag, mvt, d, qty, sec, lab, docNo) => out.push({ article: a.code, division: 'TA11', magasin: mag, mvt,
    doc: String(docNo), date: at(d, 0).slice(0, 10), qty, uqs: 'PCE', designation: 'PROJECTEUR ' + a.code, user: 'BARFLOW_TA11',
    ts: at(d, sec), label: lab ? String(lab) : '', source: 'IMPORT' });
  while (out.length < target) {
    for (let k = 0; k < 450 && out.length < target; k++) {
      const a = arts[Math.floor(rnd() * arts.length)], sec = Math.floor(rnd() * 80000), lab = ++label;
      push(a, 'PRD2', '131', day, a.qty, sec, lab, ++doc);
      if (rnd() < 0.97) {
        const t = ++doc, lag = 600 + Math.floor(rnd() * 5000);
        push(a, 'PRD2', '311', day, -a.qty, sec + lag, lab, t);
        push(a, 'EXP2', '311', day, a.qty, sec + lag, lab, t);
        stockLabels.set(a.code, stockLabels.get(a.code) + 1);
      }
    }
    for (let truck = 0; truck < 14 && out.length < target; truck++) {
      const t = ++doc;
      for (let j = 0; j < 10; j++) {
        const a = arts[Math.floor(rnd() * arts.length)], n = Math.min(stockLabels.get(a.code), 3);
        if (!n) continue;
        stockLabels.set(a.code, stockLabels.get(a.code) - n);
        push(a, 'EXP2', '601', day + 1, -n * a.qty, 3600 + truck * 3000 + j, '', t);
      }
    }
    day++;
  }
  return out;
}

test('compute of 100,000 movements (labels, entry times) runs under 8 s', () => {
  const movements = bigInput(100000);
  assert.ok(movements.length >= 100000);
  const input = v2Input(movements, { blocks: CFG.DEFAULT_LAYOUT.blocks });
  const start = process.hrtime.bigint();
  const r = Engine.compute(input);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 8000, `compute ${ms.toFixed(0)} ms`);
  assert.equal(r.counts.processed, movements.length);
  assert.ok(r.kpi.exp2Pallets > 0 && r.kpi.dwellCount > 0);
  assert.equal(r.state.pending.length, Math.min(500, r.pending.length));
  const t1 = process.hrtime.bigint();
  Engine.toTables(r);
  Engine.lookupAll(r);
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(ms2 < 8000, `toTables + lookupAll ${ms2.toFixed(0)} ms`);
});
