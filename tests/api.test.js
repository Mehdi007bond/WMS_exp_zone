'use strict';
// API (apps-script/src/Api.gs) end to end, in one vm context with the pure modules:
//  1. against the in-memory Repo (tests/harness/repo-memory.js) with a fixture simulator built from sample-data/csv,
//     so the state must reproduce the oracle KPIs (994 pallets in EXP2 ...);
//  2. against the real Simulation.gs when it is present;
//  3. against the real Repo.gs and Main.gs with fake Google services (SpreadsheetApp, CacheService, ...), so the
//     sheet persistence, the state chunks and the ACCUEIL tab run without Google.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readCsv, SRC } = require('./lib/load-gs');

const ROOT = path.join(__dirname, '..');
const CSV_DIR = path.join(ROOT, 'sample-data', 'csv');
const REPO_MEMORY = path.join(__dirname, 'harness', 'repo-memory.js');
const has = (name) => fs.existsSync(path.join(SRC, name + '.gs'));
const plain = (x) => JSON.parse(JSON.stringify(x));
const KEY_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

const MISSING = ['Config', 'Engine', 'Normalize', 'Simulation', 'Api', 'Repo', 'Main'].filter((n) => !has(n));
if (MISSING.length) console.log('# api.test: modules absent, related tests skipped: ' + MISSING.join(', '));

// ---------------------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------------------
function runFile(ctx, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
}

/**
 * opts.sim: 'fixture' | 'real' | 'none'; opts.repo: 'memory' | 'sheets'; opts.main: load Main.gs; opts.globals: stubs.
 */
function makeContext(opts) {
  opts = opts || {};
  const ctx = vm.createContext(Object.assign({ console, Math, Date, JSON }, opts.globals || {}));
  for (const name of ['Config', 'Assets', 'Engine', 'Normalize']) if (has(name)) runFile(ctx, path.join(SRC, name + '.gs'));
  if (opts.sim === 'real' && has('Simulation')) runFile(ctx, path.join(SRC, 'Simulation.gs'));
  if (opts.sim === 'fixture') ctx.Sim = makeFixtureSim();
  runFile(ctx, path.join(SRC, 'Api.gs'));
  if (opts.main) runFile(ctx, path.join(SRC, 'Main.gs'));
  if (opts.repo === 'sheets') runFile(ctx, path.join(SRC, 'Repo.gs'));
  else runFile(ctx, REPO_MEMORY);
  return ctx;
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture simulator: the sample database (sample-data/csv) as Sim.generate, a small deterministic Sim.nextDay.
// ---------------------------------------------------------------------------------------------------------------
function iso(dotted) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(dotted);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function numOrNull(v) {
  return v === '' ? null : Number(v);
}

function sampleData() {
  const movements = [];
  for (const tab of ['SAP_DECLARATIONS', 'SAP_TRANSFERTS', 'SAP_SORTIES_601']) {
    readCsv(path.join(CSV_DIR, tab + '.csv')).forEach((r) => movements.push({
      article: r['Article'], division: r['Division'], magasin: r['Magasin'], mvt: r['MvT'], text: r['Texte code mvt'],
      s: r['S'], doc: r['Doc.article'], poste: '', date: iso(r['Date cpt.']), qty: Number(r['Qté en UQS']), uqs: r['UQS'],
      designation: r['Désignation article'], user: r['Nom utilisateur'], source: 'SIMULATION'
    }));
  }
  const opening = readCsv(path.join(CSV_DIR, 'SAP_STOCK_INITIAL.csv')).map((r) => ({
    article: r['Article'], division: r['Division'], magasin: r['Magasin'], designation: r['Désignation article'],
    qty: Number(r['Stock utilisation libre']), uqs: r['UQS'], date: iso(r['Date stock'])
  }));
  const articles = readCsv(path.join(CSV_DIR, 'ARTICLES.csv')).map((r) => ({
    article: r['Article'], designation: r['Désignation article'], uqs: r['UQS'], qpp: Number(r['Qté par palette']),
    palletType: r['Type palette'], heightCm: Number(r['Hauteur palette (cm)']), levels: Number(r['Niveaux gerbage max']),
    family: r['Famille']
  }));
  const docks = readCsv(path.join(CSV_DIR, 'QUAIS_CAMIONS.csv')).map((r) => ({
    quai: r['Quai'], status: r['Statut quai'], truck: r['Camion'], carrier: r['Transporteur'], color: r['Couleur cabine'],
    arrival: r['Arrivée'], departure: r['Départ prévu'], planned: numOrNull(r['Palettes prévues']),
    loaded: numOrNull(r['Palettes chargées']), staged: Number(r['Palettes en zone quai']),
    capacity: Number(r['Capacité zone quai (pal)'])
  }));
  return { movements, opening, articles, docks };
}

function makeFixtureSim() {
  const data = sampleData();
  const nextWorkingDay = (d) => {
    const t = new Date(d + 'T00:00:00Z');
    do t.setUTCDate(t.getUTCDate() + 1); while (t.getUTCDay() === 0);
    return t.toISOString().slice(0, 10);
  };
  return {
    calls: [],
    generate(params) {
      this.calls.push({ fn: 'generate', params: plain(params) });
      return plain(data);
    },
    nextDay(params) {
      this.calls.push({ fn: 'nextDay', asOf: params.asOf, lines: params.movements.length });
      const date = nextWorkingDay(params.asOf);
      const doc = String(4909000000 + params.movements.length);
      const base = { division: 'TA11', s: '', uqs: 'PC', designation: 'PF CONNECTEUR 4 VOIES REF 04', source: 'SIMULATION' };
      const mk = (o) => Object.assign({}, base, { article: '1000914295', date }, o);
      return {
        movements: [
          mk({ magasin: 'PRD2', mvt: '101', text: 'EM entrée en stock', doc: doc + '1', poste: '1', qty: 320, user: 'BARFLOW_TA11' }),
          mk({ magasin: 'PRD2', mvt: '101', text: 'EM entrée en stock', doc: doc + '2', poste: '1', qty: 320, user: 'BARFLOW_TA11' }),
          mk({ magasin: 'PRD2', mvt: '311', text: 'TR transf. dans div.', doc: doc + '3', poste: '1', qty: -320, user: 'BARFLOW_TA11' }),
          mk({ magasin: 'EXP2', mvt: '311', text: 'TR transf. dans div.', doc: doc + '3', poste: '2', qty: 320, user: 'BARFLOW_TA11' })
        ],
        docks: data.docks.map((d) => Object.assign({}, d, d.quai === 'Q03'
          ? { status: 'Occupé - en attente chargement', truck: 'CAM-06', carrier: 'Transporteur C', color: 'bleu', arrival: '08:10',
            departure: '10:30', planned: 20, loaded: 0, staged: 6 } : {}))
      };
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Shape of the compact state (docs/ARCHITECTURE.md section 8)
// ---------------------------------------------------------------------------------------------------------------
const STATE_KEYS = ['version', 'asOf', 'computedAt', 'importedAt', 'source', 'layout', 'kpi', 'blocks', 'blockContents',
  'families', 'daily', 'pending', 'docks', 'alerts'];
const KPI_KEYS = ['exp2Pallets', 'capacity', 'saturation', 'pendingPallets', 'oldestPendingDays', 'stuckPendingLines',
  'entriesToday', 'exitsToday', 'emrtPallets', 'dockSaturation', 'docksOccupied', 'docksStaged', 'docksCapacity',
  'oldestExp2Days', 'unknownArticles', 'toPlacePallets', 'daysToSaturation', 'netPerDay'];

function assertKeys(obj, keys, what) {
  assert.ok(obj && typeof obj === 'object', what + ' is an object');
  for (const k of keys) assert.ok(Object.prototype.hasOwnProperty.call(obj, k), `${what}.${k} present`);
}

function assertStateShape(state) {
  assertKeys(state, STATE_KEYS, 'state');
  assert.match(state.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(['SIMULATION', 'SAP'].includes(state.source), 'source');
  assert.ok(!Number.isNaN(Date.parse(state.computedAt)), 'computedAt is an ISO date');
  assert.equal(typeof state.version, 'number');
  assertKeys(state.layout, ['building', 'blocks', 'truckZone', 'quais', 'quaiLine', 'roads', 'zones'], 'state.layout');
  assert.ok(state.layout.blocks.length >= 1);
  assertKeys(state.layout.blocks[0], ['id', 'label', 'x', 'y', 'w', 'h', 'cols', 'rows', 'levels', 'color', 'capacity'], 'layout block');
  assertKeys(state.kpi, KPI_KEYS, 'state.kpi');
  assert.ok(Array.isArray(state.blocks) && state.blocks.length >= 1);
  assertKeys(state.blocks[0], ['id', 'label', 'families', 'capacity', 'pallets', 'saturation'], 'block');
  assert.equal(typeof state.blockContents, 'object');
  for (const id of Object.keys(state.blockContents)) {
    for (const e of state.blockContents[id]) assertKeys(e, ['article', 'designation', 'family', 'pallets', 'ageMax'], 'blockContents entry');
  }
  assert.equal(typeof state.families, 'object');
  assert.ok(Array.isArray(state.daily));
  if (state.daily.length) assertKeys(state.daily[0], ['date', 'declared', 'entries', 'exits', 'stockEnd', 'saturation', 'pendingEnd'], 'daily');
  assert.ok(Array.isArray(state.pending));
  if (state.pending.length) assertKeys(state.pending[0], ['article', 'designation', 'date', 'doc', 'qty', 'pallets', 'days'], 'pending');
  assert.ok(Array.isArray(state.docks) && state.docks.length === 8, '8 docks');
  assertKeys(state.docks[0], ['quai', 'status', 'truck', 'carrier', 'color', 'arrival', 'departure', 'planned', 'loaded', 'staged', 'capacity'], 'dock');
  assert.ok(Array.isArray(state.alerts));
  for (const a of state.alerts) {
    assertKeys(a, ['level', 'code', 'text'], 'alert');
    assert.ok(['warn', 'crit'].includes(a.level));
  }
}

function assertNoUserNames(payload, what) {
  const text = JSON.stringify(payload);
  for (const u of ['BARFLOW', 'CHEFQUAI', 'OPEXP0', 'PLANIF0']) assert.ok(!text.includes(u), `${what} contains no user name (${u})`);
}

// MB51 rows as the import page reads them (header + data), normalised by the same Norm code.
function importRows() {
  return [
    ['Article', 'Division', 'Magasin', 'MvT', 'Texte code mvt', 'S', 'Doc.article', 'Date cpt.', 'Qté en UQS', 'UQS', 'Désignation article', 'Nom utilisateur'],
    ['1000914295', 'TA11', 'PRD2', '101', 'EM entrée en stock', '', '4908000001', '03.10.2026', '320', 'PC', 'PF CONNECTEUR 4 VOIES REF 04', 'BAR FLOW TA11'],
    ['1000914295', 'TA11', 'PRD2', '311', 'TR transf. dans div.', '', '4908000002', '03.10.2026', '320-', 'PC', 'PF CONNECTEUR 4 VOIES REF 04', 'OPEXP01'],
    ['1000914295', 'TA11', 'EXP2', '311', 'TR transf. dans div.', '', '4908000002', '03.10.2026', '320', 'PC', 'PF CONNECTEUR 4 VOIES REF 04', 'OPEXP01'],
    ['1000914295', 'TA12', 'EXP2', '601', 'SM livraison', '', '4908000003', '03.10.2026', '-10', 'PC', 'PF CONNECTEUR 4 VOIES REF 04', 'CHEFQUAI1']
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Memory repo + fixture simulator: the whole API flow
// ---------------------------------------------------------------------------------------------------------------
const CORE_READY = has('Config') && has('Engine') && has('Normalize') && has('Api');

test('API flow on the in-memory repo (fixture simulation = sample database)', { skip: CORE_READY ? false : 'Config/Engine/Normalize/Api absent' }, async (t) => {
  const ctx = makeContext({ sim: 'fixture', repo: 'memory' });
  const { Repo } = ctx;
  let keys;

  await t.test('setup creates the default tabs, layout, rules, docks and keys', () => {
    assert.throws(() => ctx.api_getState(), /Base non installée/);
    const res = plain(Repo.setup());
    assert.ok(res.created.includes('MOUVEMENTS') && res.created.includes('_STATE'));
    keys = plain(Repo.getKeys());
    assert.match(keys.admin, KEY_RE);
    assert.match(keys.docks, KEY_RE);
    assert.notEqual(keys.admin, keys.docks);
    const db = Repo.dump();
    assert.equal(db.layout.blocks.length, 8);
    assert.equal(db.layout.roads.length, 5);
    assert.equal(db.layout.quais.length, 8);
    assert.equal(db.rules.length, 5);
    assert.ok(db.rules.every((r) => r.comment === 'provisoire'));
    assert.equal(db.docks.length, 8);
    assert.ok(db.docks.every((d) => d.status === 'Libre'));
    assert.deepEqual(plain(ctx.api_getVersion()), { data: 0, docks: 0 });
    // Same keys after a second setup.
    Repo.setup();
    assert.deepEqual(plain(Repo.getKeys()), keys);
  });

  await t.test('api_getState on an empty base computes an empty state', () => {
    const state = plain(ctx.api_getState());
    assertStateShape(state);
    assert.equal(state.kpi.exp2Pallets, 0);
    assert.equal(state.version, 1);
    assert.equal(ctx.api_getVersion().data, 1);
  });

  await t.test('api_checkKey checks a key before a form is filled in', () => {
    assert.equal(ctx.api_checkKey(keys.docks, 'docks'), true);
    assert.equal(ctx.api_checkKey(keys.admin, 'docks'), true, 'admin key opens the docks too');
    assert.equal(ctx.api_checkKey(keys.admin, 'admin'), true);
    assert.throws(() => ctx.api_checkKey(keys.docks, 'admin'), /^Error: Clé incorrecte$/);
    assert.throws(() => ctx.api_checkKey('AAAA-BBBB-CCCC', 'docks'), /Clé incorrecte/);
  });

  await t.test('write functions refuse a wrong or missing key', () => {
    assert.throws(() => ctx.api_simulate('WRONG-KEY0-0000', {}), /^Error: Clé incorrecte$/);
    assert.throws(() => ctx.api_simulate('', {}), /Clé incorrecte/);
    assert.throws(() => ctx.api_recompute(keys.docks), /Clé incorrecte/, 'docks key is not an admin key');
    assert.throws(() => ctx.api_importLines(null, {}, []), /Clé incorrecte/);
    assert.equal(ctx.api_getVersion().data, 1);
  });

  await t.test('api_simulate stores the sample database and reproduces the oracle KPIs', () => {
    const before = plain(ctx.api_getVersion());
    // Key typed in lower case without dashes still works.
    const r = plain(ctx.api_simulate(keys.admin.toLowerCase().replace(/-/g, ''), { days: 14, seed: 2026 }));
    assert.equal(r.ok, true);
    assert.equal(r.lines, 2814);
    assert.match(r.message, /Simulation générée/);
    assert.equal(r.versions.data, before.data + 1);
    assert.equal(r.versions.docks, before.docks + 1, 'simulated docks bump the docks version');
    const call = ctx.Sim.calls.find((c) => c.fn === 'generate');
    assert.equal(call.params.seed, 2026);
    assert.equal(call.params.days, 14);
    assert.match(call.params.startDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(call.params.blocks.length === 8, 'layout blocks passed to the simulator');

    const state = plain(ctx.api_getState());
    assertStateShape(state);
    assert.equal(state.source, 'SIMULATION');
    assert.equal(state.asOf, '2026-10-03');
    assert.equal(state.version, r.versions.data);
    assert.ok(state.importedAt, 'importedAt set');
    const k = state.kpi;
    assert.equal(k.exp2Pallets, 994);
    assert.equal(k.capacity, 1464);
    assert.ok(Math.abs(k.saturation - 0.679) <= 1e-4);
    assert.equal(k.pendingPallets, 22);
    assert.equal(k.emrtPallets, 381);
    assert.equal(k.entriesToday, 73);
    assert.equal(k.exitsToday, 65);
    assert.equal(k.docksOccupied, 5);
    assert.equal(k.unknownArticles, 1);
    assert.ok(Math.abs(k.dockSaturation - 0.4375) <= 1e-4);
    assertNoUserNames(state, 'state');

    // CALC_* tabs written, IMPORT_LOG row, MOUVEMENTS rows flagged SIMULATION with keys.
    const db = Repo.dump();
    const kpi = db.calc.CALC_KPI;
    assert.deepEqual(kpi[0], ['Indicateur', 'Valeur', 'Unité', 'Définition']);
    assert.equal(kpi.find((row) => row[0] === 'Palettes EXP2')[1], 994);
    assert.equal(db.calc.CALC_STOCK.length, 41);
    assert.equal(db.movements.length, 2814);
    assert.ok(db.movements.every((m) => m.source === 'SIMULATION' && m.key));
    assert.equal(new Set(db.movements.map((m) => m.key)).size, 2814, 'unique keys');
    assert.equal(db.importLog.length, 1);
    assert.equal(db.importLog[0].kind, 'SIMULATION');
    assert.equal(db.importLog[0].fresh, 2814);
  });

  await t.test('api_lookup returns one article with anonymised users', () => {
    const lk = plain(ctx.api_lookup('0001000914295'));
    assertKeys(lk, ['article', 'stock', 'fifo', 'pending', 'exits', 'movements'], 'lookup');
    assert.equal(lk.article, '1000914295');
    assert.equal(lk.found, true);
    assert.equal(lk.designation, 'PF CONNECTEUR 4 VOIES REF 04');
    const expected = readCsv(path.join(CSV_DIR, 'CALC_STOCK.csv')).find((r) => r['Article'] === '1000914295');
    assert.equal(lk.stock.EXP2.pallets, Number(expected['EXP2 palettes']));
    assert.equal(lk.stock.PRD2.qty, Number(expected['PRD2 qté']));
    assert.ok(lk.fifo.length > 0 && lk.movements.length > 0);
    assert.equal(lk.movementsTotal, lk.movements.length);
    assert.ok(lk.movements.every((m) => m.user === 'Auto' || m.user === 'Manuel'));
    assert.ok(lk.movements.some((m) => m.user === 'Auto'));
    for (let i = 1; i < lk.movements.length; i++) assert.ok(lk.movements[i - 1].date >= lk.movements[i].date, 'newest first');
    assertNoUserNames(lk, 'lookup');
    const none = plain(ctx.api_lookup('999999'));
    assert.equal(none.found, false);
    assert.equal(none.stock, null);
    assert.deepEqual(none.movements, []);
    assert.throws(() => ctx.api_lookup('  '), /article/);
    for (const bad of ['x'.repeat(41), 'ab cd', '<script>', '1000914295;DROP']) {
      assert.throws(() => ctx.api_lookup(bad), /Numéro d'article invalide/, bad);
    }
  });

  await t.test('api_lookup reads the prepared article pages and never recalculates', () => {
    const compute = ctx.Engine.compute;
    let computed = 0;
    ctx.Engine.compute = function () { computed++; return compute.apply(this, arguments); };
    try {
      Repo.restore(Repo.snapshot());          // new execution: empty cache
      const a = plain(ctx.api_lookup('1000914295'));
      const b = plain(ctx.api_lookup('1000914295'));
      assert.deepEqual(a, b, 'second answer from the cache');
      assert.equal(a.version, ctx.api_getVersion().data);
      assert.ok(a.movements.length > 0 && typeof a.movements[0].date === 'string' && a.movements[0].user, 'SAP lines expanded');
      assert.equal(plain(ctx.api_lookup('424242')).found, false);
      assert.ok(plain(ctx.api_searchArticles('connecteur')).length === 1, 'search index read without a calculation');
      assert.equal(computed, 0, 'no Engine.compute in a read');
      // Pages older than the data version (code updated, failed save): a clear French message, still no calculation.
      const snap = Repo.snapshot();
      Repo.saveLookups(ctx.api_getVersion().data - 1, []);
      Repo.restore(Repo.snapshot());
      assert.throws(() => ctx.api_lookup('1000914295'), /Recalculer/);
      assert.equal(computed, 0);
      Repo.restore(snap);
    } finally {
      ctx.Engine.compute = compute;
    }
  });

  await t.test('api_searchArticles matches numbers and designations', () => {
    const byText = plain(ctx.api_searchArticles('connecteur'));
    assert.deepEqual(byText, [{ article: '1000914295', designation: 'PF CONNECTEUR 4 VOIES REF 04' }]);
    const byAccents = plain(ctx.api_searchArticles('GRANULE pe'));
    assert.ok(byAccents.some((a) => a.article === '1000207622'));
    const byPrefix = plain(ctx.api_searchArticles('10009'));
    assert.ok(byPrefix.length > 1 && byPrefix.length <= 20);
    assert.ok(byPrefix.every((a) => a.article.startsWith('10009')));
    assert.ok(plain(ctx.api_searchArticles('1000')).length === 20, 'at most 20');
    assert.deepEqual(plain(ctx.api_searchArticles('')), []);
  });

  await t.test('api_saveDock needs the docks (or admin) key and bumps only the docks version', () => {
    const v0 = plain(ctx.api_getVersion());
    const dock = { quai: 'Q03', status: 'occupé - chargement en cours', truck: 'CAM-09', carrier: 'Transporteur D', color: 'rouge',
      arrival: '9:05', departure: '11:30', planned: 30, loaded: 4, staged: 11 };
    assert.throws(() => ctx.api_saveDock('BAD', dock), /^Error: Clé incorrecte$/);
    const r = plain(ctx.api_saveDock(keys.docks, dock));
    assert.equal(r.ok, true);
    assert.equal(r.dock.status, 'Occupé - chargement en cours', 'status canonicalised');
    assert.equal(r.dock.arrival, '09:05');
    assert.equal(r.versions.docks, v0.docks + 1);
    assert.equal(r.versions.data, v0.data, 'data version unchanged');
    const state = plain(ctx.api_getState());
    const q3 = state.docks.find((d) => d.quai === 'Q03');
    assert.equal(q3.truck, 'CAM-09');
    assert.equal(q3.capacity, 12, 'capacity kept');
    assert.equal(state.kpi.docksOccupied, 6);
    assert.equal(state.kpi.docksStaged, 42 + 11);
    assert.ok(state.alerts.some((a) => a.code === 'DOCK_STAGING' && /^Quai Q3 :/.test(a.text)), 'staging alert for Q3 (11 / 12)');
    assert.equal(r.message, 'Quai Q3 enregistré.');
    const db = Repo.dump();
    assert.equal(db.visits.length, 1);
    assert.equal(db.visits[0].quai, 'Q03');
    // Admin key also accepted; a free dock is cleared.
    const free = plain(ctx.api_saveDock(keys.admin, { quai: 'Q03', status: 'Libre', truck: 'X', staged: 0 }));
    assert.equal(free.dock.truck, '');
    assert.equal(free.dock.planned, null);
    assert.throws(() => ctx.api_saveDock(keys.docks, { quai: 'Q99', status: 'Libre' }), /Quai inconnu/);
    assert.throws(() => ctx.api_saveDock(keys.docks, { quai: 'Q01', status: 'Occupé - chargement en cours', arrival: '25:00' }), /HH:MM/);
    assert.throws(() => ctx.api_saveDock(keys.docks, { quai: 'Q01', status: 'Libre', staged: -3 }), /invalide/);
  });

  await t.test('api_getState overlays live docks on a state computed with older docks', () => {
    const stale = plain(Repo.loadState());
    stale.docksVersion = -1;
    stale.docks = stale.docks.map((d) => Object.assign({}, d, { status: 'Libre', staged: 0 }));
    Repo.saveState(stale);
    const state = plain(ctx.api_getState());
    assert.equal(state.docksVersion, ctx.api_getVersion().docks);
    assert.equal(state.kpi.docksOccupied, 5);
  });

  await t.test('api_importLines re-validates, deduplicates and recalculates on the final batch', () => {
    const norm = ctx.Norm.normalizeRows(importRows(), { file: 'MB51_test.xlsx' });
    assert.equal(norm.lines.length, 3);
    assert.equal(norm.rejected.length, 1, 'TA12 rejected by the client');
    // The server receives what the browser sends: the 3 valid lines plus a tampered one and a TA12 one.
    const lines = plain(norm.lines);
    lines[0].key = 'tampered|key';
    const sent = lines.concat([
      Object.assign({}, lines[0], { division: 'TA12', row: 99 }),
      Object.assign({}, lines[0], { qty: 'abc', row: 100 })
    ]);
    const v0 = ctx.api_getVersion().data;
    const meta = { importId: 'IMP-TEST-1', fileName: 'MB51_test.xlsx', kind: 'MB51', period: '03.10.2026', final: false };
    const r1 = plain(ctx.api_importLines(keys.admin, meta, sent));
    assert.equal(r1.received, 5);
    assert.equal(r1.added, 3);
    assert.equal(r1.duplicates, 0);
    assert.equal(r1.rejected, 2);
    assert.match(r1.rejectedLines[0].reason, /Division TA12/);
    assert.match(r1.rejectedLines[1].reason, /Quantité/);
    assert.equal(ctx.api_getVersion().data, v0, 'no recalculation before the final batch');
    const r2 = plain(ctx.api_importLines(keys.admin, meta, sent));
    assert.equal(r2.added, 0, 'second identical call adds 0');
    assert.equal(r2.duplicates, 3);
    assert.ok(Repo.getProp('IMPORT_IMP-TEST-1'), 'running totals kept in a Script Property');
    Repo.restore(Repo.snapshot());            // the cache may be emptied between two batches: totals survive
    const db = Repo.dump();
    const imported = db.movements.filter((m) => m.source === 'IMPORT');
    assert.equal(imported.length, 3);
    assert.ok(imported.every((m) => m.importId === 'IMP-TEST-1'));
    assert.ok(!imported.some((m) => m.key === 'tampered|key'), 'key rebuilt by the server');
    assert.ok(imported.every((m) => m.user === 'BARFLOW_TA11' || m.user === 'OPEXP01'), 'raw user kept in the sheet');

    const fin = plain(ctx.api_importLines(keys.admin, Object.assign({}, meta, { final: true }), []));
    assert.equal(fin.final, true);
    assert.equal(fin.versions.data, v0 + 1);
    assert.deepEqual(fin.totals, { read: 10, added: 3, duplicates: 3, rejected: 4 });
    assert.equal(Repo.getProp('IMPORT_IMP-TEST-1'), null, 'totals dropped after the final batch');
    assert.match(fin.warning, /simulées/);
    assertNoUserNames(fin, 'import response');
    const log = Repo.dump().importLog;
    assert.equal(log[log.length - 1].kind, 'MB51');
    assert.equal(log[log.length - 1].fresh, 3);
    assert.equal(log[log.length - 1].file, 'MB51_test.xlsx');
    const state = plain(ctx.api_getState());
    assert.equal(state.kpi.pendingPallets, 22, 'declared then transferred: PRD2 unchanged');
    assert.equal(state.kpi.exp2Pallets, 995, 'one more pallet of 320 in EXP2');
    assert.throws(() => ctx.api_importLines(keys.admin, meta, new Array(5001).fill(lines[1])), /Trop de lignes/);
  });

  await t.test('api_simulateNextDay appends the next working day and changes the data version', () => {
    const v0 = plain(ctx.api_getVersion());
    const n0 = Repo.dump().movements.length;
    const r = plain(ctx.api_simulateNextDay(keys.admin));
    assert.equal(r.ok, true);
    assert.equal(r.day, '2026-10-05', 'Saturday 03.10 -> Monday 05.10');
    assert.equal(r.lines, 4);
    assert.ok(r.versions.data > v0.data, 'data version changed');
    assert.equal(r.versions.docks, v0.docks + 1);
    assert.equal(Repo.dump().movements.length, n0 + 4);
    const state = plain(ctx.api_getState());
    assert.equal(state.asOf, '2026-10-05');
    assert.equal(state.docks.find((d) => d.quai === 'Q03').truck, 'CAM-06');
    assert.equal(ctx.Sim.calls.filter((c) => c.fn === 'nextDay').pop().asOf, '2026-10-03');
    assert.throws(() => ctx.api_simulateNextDay('nope'), /Clé incorrecte/);
  });

  await t.test('api_recompute bumps the data version; api_importOpening replaces the opening stock', () => {
    const v0 = ctx.api_getVersion().data;
    const r = plain(ctx.api_recompute(keys.admin));
    assert.equal(r.versions.data, v0 + 1);
    assert.match(r.message, /Recalcul terminé/);
    const o = plain(ctx.api_importOpening(keys.admin, [
      { article: '0001000914295', division: 'TA11', magasin: 'exp2', designation: 'PF CONNECTEUR 4 VOIES REF 04', qty: '640', uqs: 'PC', date: '20.09.2026' },
      { article: '1000914295', division: 'TA12', magasin: 'EXP2', qty: 10, date: '2026-09-20' },
      { article: '', magasin: 'EXP2', qty: 1, date: '2026-09-20' }
    ]));
    assert.equal(o.saved, 1);
    assert.equal(o.rejected, 2);
    assert.equal(o.versions.data, v0 + 2);
    const db = Repo.dump();
    assert.deepEqual(db.opening, [{ article: '1000914295', division: 'TA11', magasin: 'EXP2', designation: 'PF CONNECTEUR 4 VOIES REF 04', qty: 640, uqs: 'PC', date: '2026-09-20' }]);
    assert.throws(() => ctx.api_importOpening(keys.admin, []), /Aucune ligne/);
  });

  await t.test('clearing the simulation keeps the imported lines', () => {
    const r = plain(ctx.runClearSimulation_());
    assert.equal(r.ok, true);
    const db = Repo.dump();
    assert.equal(db.movements.length, 3);
    assert.ok(db.movements.every((m) => m.source === 'IMPORT'));
    assert.equal(db.opening.length, 1, 'imported opening kept');
    assert.equal(db.articles.length, 0, 'simulated articles removed');
    assert.ok(db.docks.every((d) => d.status === 'Libre'), 'docks written by +1 jour (simulated) are reset');
    const state = plain(ctx.api_getState());
    assert.equal(state.source, 'SAP');
    assert.throws(() => ctx.api_simulateNextDay(keys.admin), /Aucune simulation en cours/);
  });

  await t.test('simulation parameters are validated in French', () => {
    assert.throws(() => ctx.simParams_({ days: 0 }), /Nombre de jours invalide/);
    assert.throws(() => ctx.simParams_({ days: 'abc' }), /Nombre de jours invalide/);
    assert.throws(() => ctx.simParams_({ endDate: '2999-01-01' }), /futur/);
    const p = plain(ctx.simParams_({ days: 14, endDate: '2026-10-03' }));
    assert.equal(p.startDate, '2026-09-18', '14 working days Monday-Saturday ending on Saturday 03.10');
    assert.equal(p.seed, 2026);
    const sunday = plain(ctx.simParams_({ days: 1, endDate: '2026-09-27' }));
    assert.equal(sunday.endDate, '2026-09-26');
    assert.equal(ctx.lastWorkingDayBefore_('2026-09-28'), '2026-09-26', 'Monday -> Saturday');
  });
});

test('API without the Simulation module reports it in French', { skip: CORE_READY ? false : 'core modules absent' }, () => {
  const ctx = makeContext({ sim: 'none', repo: 'memory' });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  if (typeof ctx.Sim === 'undefined') {
    assert.throws(() => ctx.api_simulate(keys.admin, {}), /Module de simulation absent/);
  }
  assertStateShape(plain(ctx.api_getState()));
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Real simulator
// ---------------------------------------------------------------------------------------------------------------
test('API flow with the real Simulation.gs', { skip: CORE_READY && has('Simulation') ? false : 'Simulation.gs absent' }, () => {
  const ctx = makeContext({ sim: 'real', repo: 'memory' });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  const r = plain(ctx.api_simulate(keys.admin, { days: 14, endDate: '2026-10-03', seed: 2026 }));
  assert.equal(r.ok, true);
  assert.ok(r.lines > 500, 'realistic number of lines');
  const state = plain(ctx.api_getState());
  assertStateShape(state);
  assert.equal(state.source, 'SIMULATION');
  assert.equal(state.asOf, '2026-10-03');
  assert.ok(state.kpi.exp2Pallets > 0 && state.kpi.saturation > 0.3 && state.kpi.saturation < 1.2);
  assertNoUserNames(state, 'state');
  const db = ctx.Repo.dump();
  assert.equal(new Set(db.movements.map((m) => m.key)).size, db.movements.length, 'unique keys');
  assert.ok(db.articles.length >= 10);

  const v0 = ctx.api_getVersion().data;
  const next = plain(ctx.api_simulateNextDay(keys.admin));
  assert.ok(next.lines > 0);
  assert.equal(next.day, '2026-10-05');
  assert.ok(ctx.api_getVersion().data > v0, 'data version changed');
  assert.equal(plain(ctx.api_getState()).asOf, '2026-10-05');
  const lk = plain(ctx.api_lookup(state.pending.length ? state.pending[0].article : db.articles[0].article));
  assert.ok(lk.found);
  assertNoUserNames(lk, 'lookup');

  // Same parameters, same data: a second simulation replaces the first one.
  const again = plain(ctx.api_simulate(keys.admin, { days: 14, endDate: '2026-10-03', seed: 2026 }));
  assert.equal(again.lines, r.lines);
  assert.equal(ctx.Repo.dump().movements.length, r.lines);
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Main.gs: module sources, doGet, sheet-only guard
// ---------------------------------------------------------------------------------------------------------------
test('moduleSource_ gives the browser the same modules; include_ and moduleSource_ stay private', { skip: CORE_READY && has('Main') ? false : 'Main.gs absent' }, () => {
  const ctx = makeContext({ sim: 'real', repo: 'memory', main: true });
  const src = ctx.moduleSource_('Config') + ctx.moduleSource_('Normalize') + ctx.moduleSource_('Engine') + ctx.moduleSource_('Simulation');
  assert.match(ctx.moduleSource_('Engine'), /^var Engine = \(function EngineModule_\(\)/);
  assert.match(ctx.moduleSource_('Norm'), /^var Norm = \(function NormalizeModule_\(\)/);
  assert.ok(!/<\/script/i.test(src), 'no closing script tag inside');
  const browser = vm.createContext({ console, Math, Date, JSON });
  vm.runInContext(src, browser);
  assert.equal(browser.CFG.PLANT, 'TA11');
  assert.equal(typeof browser.Engine.compute, 'function');
  assert.equal(browser.Norm.parseNumber('320-'), -320);
  if (has('Simulation')) assert.equal(typeof browser.Sim.generate, 'function');
  assert.throws(() => ctx.moduleSource_('Repo'), /Module inconnu/);
  // google.script.run only reaches functions without a trailing underscore: the template helpers are not callable.
  assert.equal(typeof ctx.include, 'undefined');
  assert.equal(typeof ctx.moduleSource, 'undefined');
});

test('doGet serves Index with mode, page, title, viewport and ALLOWALL', { skip: CORE_READY && has('Main') ? false : 'Main.gs absent' }, () => {
  const calls = [];
  const output = {
    setTitle(t) { calls.push(['title', t]); return this; },
    addMetaTag(n, c) { calls.push(['meta', n, c]); return this; },
    setXFrameOptionsMode(m) { calls.push(['xframe', m]); return this; }
  };
  let template = null;
  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    createTemplateFromFile(name) {
      template = { file: name, evaluate() { return output; } };
      return template;
    }
  };
  const ctx = makeContext({ sim: 'none', repo: 'memory', main: true, globals: { HtmlService } });
  ctx.doGet({ parameter: { mode: 'tv', rotate: '1' } });
  assert.equal(template.file, 'Index');
  assert.equal(template.mode, 'tv');
  assert.equal(template.page, '');
  assert.deepEqual(calls, [['title', ctx.CFG.APP_NAME], ['meta', 'viewport', 'width=device-width, initial-scale=1'], ['xframe', 'ALLOWALL']]);
  ctx.doGet({ parameter: { page: 'docks' } });
  assert.equal(template.mode, 'pc');
  assert.equal(template.page, 'docks');
  ctx.doGet({ parameter: { page: '<script>' } });
  assert.equal(template.page, 'lookup');
  ctx.doGet(undefined);
  assert.equal(template.page, 'lookup');
});

test('sheet-only entry points refuse to run from the web app', { skip: CORE_READY && has('Main') ? false : 'Main.gs absent' }, () => {
  const SpreadsheetApp = { getUi() { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); } };
  const ctx = makeContext({ sim: 'fixture', repo: 'memory', main: true, globals: { SpreadsheetApp } });
  ctx.Repo.setup();
  for (const fn of ['sidebar_links', 'sidebar_status', 'sidebar_recompute', 'sidebar_nextDay', 'sidebar_setWebAppUrl', 'installerLaBase',
    'simulerDonnees', 'simulerJourSuivant', 'effacerSimulation', 'recalculer', 'ouvrirPanneau', 'ouvrirJumeau', 'regenererLesCles']) {
    assert.throws(() => ctx[fn](), /Action réservée au classeur/, fn);
  }
  assert.throws(() => ctx.sidebar_simulate({}), /Action réservée au classeur/);
  assert.equal(ctx.api_getVersion().data, 0, 'nothing ran');
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Repo.gs + Main.gs on fake Google services
// ---------------------------------------------------------------------------------------------------------------
function makeGoogle() {
  const calls = { getValues: {}, setValues: {}, find: {} };
  const count = (kind, sheet) => { calls[kind][sheet] = (calls[kind][sheet] || 0) + 1; };
  const scriptTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const looksNumber = /^-?\d+(\.\d+)?$/;
  const looksDate = /^\d{1,2}[./]\d{1,2}([./]\d{2,4})?$/;
  const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

  class Range {
    constructor(sheet, r, c, nr, nc) {
      if (!(r >= 1 && c >= 1 && nr >= 1 && nc >= 1)) throw new Error(`bad range ${r},${c},${nr},${nc}`);
      if (r + nr - 1 > sheet.maxRows || c + nc - 1 > sheet.maxCols) {
        throw new Error(`Range ${sheet.name}!R${r}C${c}:${nr}x${nc} outside the sheet (${sheet.maxRows}x${sheet.maxCols})`);
      }
      Object.assign(this, { sheet, r, c, nr, nc });
    }
    each(fn) {
      for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r - 1 + i, this.c - 1 + j, i, j);
    }
    getValues() {
      count('getValues', this.sheet.name);
      const out = [];
      for (let i = 0; i < this.nr; i++) {
        const row = [];
        for (let j = 0; j < this.nc; j++) {
          const v = this.sheet.get(this.r - 1 + i, this.c - 1 + j);
          row.push(isDate(v) ? new Date(v.getTime()) : v);
        }
        out.push(row);
      }
      return out;
    }
    setValues(values) {
      count('setValues', this.sheet.name);
      if (values.length !== this.nr || values.some((r) => r.length !== this.nc)) {
        throw new Error(`setValues: ${values.length}x${values[0] && values[0].length} into ${this.nr}x${this.nc} (${this.sheet.name})`);
      }
      this.each((ri, ci, i, j) => {
        let v = values[i][j];
        if (v === null || v === undefined) v = '';
        if (typeof v === 'string' && v.length > 50000) throw new Error('Cell over 50,000 characters');
        const fmt = this.sheet.fmt(ri, ci);
        // Sheets parses text typed into a non-text cell.
        if (typeof v === 'string' && fmt !== '@') {
          if (looksNumber.test(v)) v = Number(v);
          else if (looksDate.test(v)) v = new Date(2000, 0, 1);
          else if (/^=/.test(v)) throw new Error('formula written: ' + v);
        }
        this.sheet.set(ri, ci, isDate(v) ? new Date(v.getTime()) : v);
      });
      return this;
    }
    setNumberFormat(f) { this.each((ri, ci) => this.sheet.setFmt(ri, ci, f)); return this; }
    getNumberFormat() { return this.sheet.fmt(this.r - 1, this.c - 1) || '0.###############'; }
    clearContent() { this.each((ri, ci) => this.sheet.set(ri, ci, '')); return this; }
    getValue() { count('getValues', this.sheet.name); return this.sheet.get(this.r - 1, this.c - 1); }
    getRow() { return this.r; }
    createTextFinder(text) {
      const range = this;
      const f = { entire: false, matchCase: false };
      f.matchEntireCell = (b) => { f.entire = b; return f; };
      f.matchCase = (b) => { f.matchCase = b; return f; };
      f.findNext = () => {
        count('find', range.sheet.name);
        for (let i = 0; i < range.nr; i++) {
          for (let j = 0; j < range.nc; j++) {
            const v = String(range.sheet.get(range.r - 1 + i, range.c - 1 + j));
            if (f.entire ? v === text : v.includes(text)) return new Range(range.sheet, range.r + i, range.c + j, 1, 1);
          }
        }
        return null;
      };
      return f;
    }
    clearFormat() { this.each((ri, ci) => this.sheet.setFmt(ri, ci, undefined)); return this; }
    setRichTextValues(v) {
      count('setValues', this.sheet.name);
      this.each((ri, ci, i, j) => {
        this.sheet.set(ri, ci, v[i][j].text);
        this.sheet.links[`${ri},${ci}`] = v[i][j].link;
      });
      return this;
    }
  }
  for (const m of ['setFontWeight', 'setBackground', 'setFontColor', 'setFontFamily', 'setFontSize', 'setVerticalAlignment',
    'setBorder', 'setHorizontalAlignment', 'setWrap']) {
    Range.prototype[m] = function () { return this; };
  }

  class Sheet {
    constructor(ss, name) {
      Object.assign(this, { ss, name, maxRows: 1000, maxCols: 26, data: [], fmts: [], frozen: 0, hidden: false,
        protections: [], images: [], tabColor: null, links: {} });
    }
    get(r, c) { return (this.data[r] && this.data[r][c] !== undefined) ? this.data[r][c] : ''; }
    set(r, c, v) { (this.data[r] = this.data[r] || [])[c] = v; }
    fmt(r, c) { return this.fmts[r] ? this.fmts[r][c] : undefined; }
    setFmt(r, c, f) { (this.fmts[r] = this.fmts[r] || [])[c] = f; }
    getName() { return this.name; }
    getIndex() { return this.ss.sheets.indexOf(this) + 1; }
    getLastRow() {
      for (let r = this.data.length - 1; r >= 0; r--) if (this.data[r] && this.data[r].some((v) => v !== '' && v !== undefined)) return r + 1;
      return 0;
    }
    getLastColumn() {
      let last = 0;
      this.data.forEach((row) => row && row.forEach((v, c) => { if (v !== '' && v !== undefined) last = Math.max(last, c + 1); }));
      return last;
    }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    insertRowsAfter(after, n) {
      const fmt = this.fmts[after - 1] ? this.fmts[after - 1].slice() : undefined;
      this.data.splice(after, 0, ...new Array(n).fill(undefined));
      this.fmts.splice(after, 0, ...new Array(n).fill(undefined).map(() => (fmt ? fmt.slice() : undefined)));
      this.maxRows += n;
    }
    deleteRows(start, n) {
      if (this.maxRows - n <= this.frozen) throw new Error('You can\'t delete all the rows that are not frozen.');
      if (start + n - 1 > this.maxRows) throw new Error('deleteRows out of range');
      this.data.splice(start - 1, n);
      this.fmts.splice(start - 1, n);
      this.maxRows -= n;
    }
    insertColumnsAfter(after, n) { this.maxCols += n; }
    deleteColumns(start, n) {
      this.data.forEach((row) => row && row.splice(start - 1, n));
      this.fmts.forEach((row) => row && row.splice(start - 1, n));
      this.maxCols -= n;
    }
    getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
    getFrozenRows() { return this.frozen; }
    setFrozenRows(n) { this.frozen = n; }
    setTabColor(c) { this.tabColor = c; }
    hideSheet() { this.hidden = true; }
    isSheetHidden() { return this.hidden; }
    getProtections() { return this.protections.slice(); }
    protect() {
      const p = { warningOnly: false, description: '' };
      p.setDescription = (d) => { p.description = d; return p; };
      p.setWarningOnly = (w) => { p.warningOnly = w; return p; };
      this.protections.push(p);
      return p;
    }
    clearContents() { this.data = []; }
    clear() { this.data = []; this.fmts = []; this.links = {}; }
    getImages() { return this.images.slice(); }
    insertImage(blob, col, row) {
      const sheet = this;
      const img = { blob, col, row, script: '', remove() { sheet.images.splice(sheet.images.indexOf(img), 1); } };
      img.setWidth = (w) => { img.w = w; return img; };
      img.setHeight = (h) => { img.h = h; return img; };
      img.assignScript = (s) => { img.script = s; return img; };
      img.setAltTextTitle = (t) => { img.alt = t; return img; };
      this.images.push(img);
      return img;
    }
    setHiddenGridlines() { return this; }
    setColumnWidth() { return this; }
    setRowHeight() { return this; }
    setRowHeights() { return this; }
  }

  class Spreadsheet {
    constructor() {
      this.sheets = [];
      this.sheets.push(new Sheet(this, 'Feuille 1'));
      this.tz = 'America/New_York';
      this.active = this.sheets[0];
      this.toasts = [];
    }
    getId() { return 'fake-spreadsheet-id'; }
    getSpreadsheetTimeZone() { return this.tz; }
    setSpreadsheetTimeZone(tz) { this.tz = tz; }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    getSheets() { return this.sheets.slice(); }
    insertSheet(name, index) {
      if (this.getSheetByName(name)) throw new Error('Sheet exists: ' + name);
      const sh = new Sheet(this, name);
      if (index === undefined) this.sheets.push(sh); else this.sheets.splice(index, 0, sh);
      return sh;
    }
    deleteSheet(sh) { this.sheets.splice(this.sheets.indexOf(sh), 1); }
    setActiveSheet(sh) { this.active = sh; sh.hidden = false; return sh; }
    moveActiveSheet(pos) {
      this.sheets.splice(this.sheets.indexOf(this.active), 1);
      this.sheets.splice(pos - 1, 0, this.active);
    }
    toast(msg) { this.toasts.push(msg); }
  }

  const ss = new Spreadsheet();
  const ui = {
    alerts: [],
    ButtonSet: { OK: 'OK', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' },
    Button: { YES: 'YES', NO: 'NO', CANCEL: 'CANCEL', CLOSE: 'CLOSE', OK: 'OK' },
    answer: 'YES',
    alert(...args) { this.alerts.push(args); return this.answer; },
    showModalDialog(out, title) { this.dialog = { out, title }; },
    showSidebar(out) { this.sidebar = out; },
    createMenu() { const m = { addItem: () => m, addSubMenu: () => m, addSeparator: () => m, addToUi: () => m }; return m; }
  };
  const cacheStore = new Map();
  const propsStore = new Map();
  const SpreadsheetApp = {
    ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
    BorderStyle: { SOLID: 'SOLID' },
    getActiveSpreadsheet: () => ss,
    openById: () => ss,
    flush() {},
    getUi: () => ui,
    newRichTextValue() {
      const v = { text: '', link: null };
      const b = { setText(t) { v.text = t; return b; }, setLinkUrl(l) { v.link = l; return b; }, build() { return v; } };
      return b;
    }
  };
  const CacheService = {
    getScriptCache: () => ({
      get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
      put(k, v) { this.putAll({ [k]: v }); },
      getAll: (keys) => Object.fromEntries(keys.filter((k) => cacheStore.has(k)).map((k) => [k, cacheStore.get(k)])),
      putAll(obj, ttl) {
        assert.ok(!(ttl > 21600), 'cache TTL at most 6 h');
        for (const [k, v] of Object.entries(obj)) {
          assert.ok(k.length <= 250, 'cache key length');
          assert.ok(Buffer.byteLength(v, 'utf8') <= 100 * 1024, `cache value over 100 KB (${k})`);
          cacheStore.set(k, v);
        }
      },
      remove: (k) => cacheStore.delete(k),
      removeAll: (keys) => keys.forEach((k) => cacheStore.delete(k))
    })
  };
  const propsReads = { n: 0 };
  const scriptProps = {
    getProperty: (k) => { propsReads.n++; return propsStore.has(k) ? propsStore.get(k) : null; },
    setProperty(k, v) { assert.ok(String(v).length <= 9000, 'property value size'); propsStore.set(k, String(v)); return this; },
    setProperties(obj) { for (const [k, v] of Object.entries(obj)) this.setProperty(k, v); return this; },
    getProperties: () => { propsReads.n++; return Object.fromEntries(propsStore); },
    deleteProperty(k) { propsStore.delete(k); return this; }
  };
  const PropertiesService = { getScriptProperties: () => scriptProps };
  const lockLog = [];
  const makeLock = (kind) => ({
    waitLock(ms) { lockLog.push([kind, 'wait', ms]); },
    tryLock(ms) { lockLog.push([kind, 'try', ms]); return !lockState.busy; },
    releaseLock() { lockLog.push([kind, 'release']); }
  });
  const lockState = { busy: false };
  const LockService = { getScriptLock: () => makeLock('script'), getDocumentLock: () => makeLock('document') };
  const Session = { getScriptTimeZone: () => scriptTz };
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(String(s)).digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(),
    formatDate(d, tz, fmt) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
      return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute);
    },
    parseDate(s, tz) {
      assert.equal(tz, scriptTz, 'parseDate only used with the script time zone in this fake');
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      return new Date(+m[1], +m[2] - 1, +m[3]);
    },
    base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
    newBlob: (bytes, type, name) => ({ bytes, type, name })
  };
  const ScriptApp = { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }) };
  const HtmlService = {
    createHtmlOutputFromFile: (name) => ({ name, setTitle() { return this; } }),
    createHtmlOutput: (html) => ({ html, setWidth() { return this; }, setHeight() { return this; } })
  };
  return {
    ss, ui, calls, lockLog, lockState, cacheStore, propsStore, propsReads,
    globals: { SpreadsheetApp, CacheService, PropertiesService, LockService, Session, Utilities, ScriptApp, HtmlService }
  };
}

function sheetTable(sh) {
  const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), Math.max(sh.getLastColumn(), 1)).getValues();
  return { header: rows[0], rows: rows.slice(1) };
}

const SHEETS_READY = CORE_READY && has('Repo') && has('Main');

test('Repo.gs and Main.gs on fake Google services', { skip: SHEETS_READY ? false : 'Repo.gs / Main.gs absent' }, async (t) => {
  const g = makeGoogle();
  const ctx = makeContext({ sim: 'fixture', repo: 'sheets', main: true, globals: g.globals });
  const { Repo, CFG } = ctx;
  const T = CFG.TABS;
  let keys;

  await t.test('setup builds every tab with headers, formats, defaults and protections', () => {
    const res = plain(Repo.setup());
    assert.equal(res.created.length, 20);
    const names = g.ss.getSheets().map((s) => s.name);
    assert.deepEqual(names, [T.HOME, T.MOVEMENTS, T.OPENING, T.ARTICLES, T.LAYOUT, T.RULES, T.MVT, T.SETTINGS, T.DOCKS,
      T.VISITS, T.CALC_STOCK, T.CALC_PENDING, T.CALC_FIFO, T.CALC_EXITS, T.CALC_DAILY, T.CALC_BLOCKS, T.CALC_KPI,
      T.IMPORT_LOG, T.STATE, T.LOOKUP], 'tab order, default sheet removed');
    assert.ok(!g.propsStore.has('SPREADSHEET_ID'), 'bound script: no spreadsheet id property');
    assert.equal(g.ss.getSpreadsheetTimeZone(), g.globals.Session.getScriptTimeZone());
    for (const name of Object.keys(CFG.HEADERS)) {
      const sh = g.ss.getSheetByName(name);
      assert.deepEqual(sheetTable(sh).header, plain(CFG.HEADERS[name]), name + ' header');
      assert.equal(sh.getFrozenRows(), 1, name + ' frozen header');
      assert.equal(sh.getMaxColumns(), CFG.HEADERS[name].length, name + ' trimmed columns');
      assert.ok(sh.getMaxRows() <= sh.getLastRow() + 20, name + ' trimmed rows');
    }
    const mv = g.ss.getSheetByName(T.MOVEMENTS);
    const col = (label) => CFG.HEADERS.MOUVEMENTS.indexOf(label);
    for (const label of ['Clé', 'Article', 'MvT', 'Doc.article', 'Poste']) assert.equal(mv.fmt(1, col(label)), '@', label + ' as text');
    assert.equal(mv.fmt(1, col('Date cpt.')), 'dd.mm.yyyy');
    const layout = sheetTable(g.ss.getSheetByName(T.LAYOUT)).rows;
    const D = CFG.DEFAULT_LAYOUT;
    assert.equal(layout.length, 1 + D.blocks.length + 1 + D.quais.length + D.roads.length + D.zones.length);
    assert.equal(layout.length, readCsv(path.join(CSV_DIR, 'LAYOUT.csv')).length, 'same rows as the sample LAYOUT');
    assert.deepEqual(layout.find((r) => r[0] === 'B1').slice(0, 2), ['B1', 'BLOC_STOCKAGE']);
    assert.equal(layout.filter((r) => r[1] === 'BLOC_STOCKAGE').reduce((s, r) => s + r[10], 0), 1464);
    const rules = sheetTable(g.ss.getSheetByName(T.RULES)).rows;
    assert.equal(rules.length, 5);
    assert.ok(rules.every((r) => r[4] === 'provisoire'));
    assert.deepEqual(rules[0].slice(0, 4), [10, 'FAMILLE', 'F1', 'B1, B7']);
    const mvt = sheetTable(g.ss.getSheetByName(T.MVT)).rows;
    assert.equal(mvt.length, Object.keys(CFG.MVT_KINDS).length);
    assert.ok(mvt.every((r) => typeof r[0] === 'string'), 'MvT stays text');
    const settings = sheetTable(g.ss.getSheetByName(T.SETTINGS)).rows;
    assert.equal(settings.find((r) => r[1] === 'satWarn')[2], 0.85);
    const docks = sheetTable(g.ss.getSheetByName(T.DOCKS)).rows;
    assert.equal(docks.length, 8);
    assert.ok(docks.every((r) => r[1] === 'Libre' && r[10] === 12));
    for (const name of [T.CALC_STOCK, T.CALC_KPI]) {
      const p = g.ss.getSheetByName(name).getProtections();
      assert.equal(p.length, 1);
      assert.equal(p[0].warningOnly, true);
    }
    assert.equal(g.ss.getSheetByName(T.STATE).isSheetHidden(), true);
    assert.equal(g.ss.getSheetByName(T.LOOKUP).isSheetHidden(), true);
    keys = plain(Repo.getKeys());
    assert.match(keys.admin, KEY_RE);
    assert.match(keys.docks, KEY_RE);
    // Repair run keeps everything.
    Repo.setup();
    assert.deepEqual(plain(Repo.getKeys()), keys);
    assert.equal(sheetTable(g.ss.getSheetByName(T.LAYOUT)).rows.length, layout.length);
  });

  await t.test('readLayout rebuilds the CFG.DEFAULT_LAYOUT shape from the LAYOUT tab', () => {
    const L = plain(Repo.readLayout());
    const D = plain(CFG.DEFAULT_LAYOUT);
    assert.deepEqual(L.building, D.building);
    assert.deepEqual(L.blocks.map((b) => [b.id, b.x, b.cols, b.color, b.capacity]), D.blocks.map((b) => [b.id, b.x, b.cols, b.color, b.cols * b.rows * b.levels]));
    assert.deepEqual(L.truck_zone, D.truck_zone);
    assert.deepEqual(L.quais.map((q) => [q.id, q.x]), D.quais.map((q) => [q.id, q.x]));
    assert.deepEqual(L.quai_common, D.quai_common);
    assert.deepEqual(L.roads.map((r) => [r.id, r.x, r.y, r.w, r.h]), D.roads.map((r) => [r.id, r.x, r.y, r.w, r.h]));
    assert.deepEqual(L.zones.map((z) => [z.id, z.label, z.short, z.color || '']), D.zones.map((z) => [z.id, z.label, z.short, z.color || '']));
    assert.equal(L.zones.find((z) => z.id === 'CONV').type, 'CONVOYEUR');
  });

  await t.test('simulation through the sheet repo gives the oracle KPIs', () => {
    const writesBefore = Object.assign({}, g.calls.setValues);
    const readsBefore = Object.assign({}, g.calls.getValues);
    const r = plain(ctx.api_simulate(keys.admin, { days: 14, seed: 2026 }));
    const writes = (tab) => (g.calls.setValues[tab] || 0) - (writesBefore[tab] || 0);
    const reads = (tab) => (g.calls.getValues[tab] || 0) - (readsBefore[tab] || 0);
    for (const tab of [T.CALC_STOCK, T.CALC_PENDING, T.CALC_FIFO, T.CALC_EXITS, T.CALC_DAILY, T.CALC_BLOCKS, T.CALC_KPI, T.MOVEMENTS,
      T.OPENING, T.STATE]) {
      assert.equal(writes(tab), 1, 'one setValues for ' + tab);
    }
    assert.equal(reads(T.MOVEMENTS), 2, 'MOUVEMENTS read once to replace the simulation, once to calculate');
    assert.equal(reads(T.LAYOUT), 2, 'LAYOUT read for the generator and once for the calculation (state layout reused)');
    // Article pages: one row per article in the hidden _LOOKUP tab, cells within the Sheets limit.
    const lk = g.ss.getSheetByName(T.LOOKUP);
    assert.equal(writes(T.LOOKUP), 1, 'one setValues for _LOOKUP');
    const lkRows = lk.getRange(1, 1, lk.getLastRow(), lk.getLastColumn()).getValues();
    assert.equal(JSON.parse(lkRows[0][0]).version, r.versions.data);
    assert.ok(lkRows.length - 1 >= 40, 'one row per article');
    assert.ok(lkRows.every((row) => row.every((c) => String(c).length <= 45001)));
    assert.equal(r.lines, 2814);
    const state = plain(ctx.api_getState());
    assertStateShape(state);
    assert.equal(state.asOf, '2026-10-03');
    assert.equal(state.kpi.exp2Pallets, 994);
    assert.equal(state.kpi.pendingPallets, 22);
    assert.equal(state.kpi.emrtPallets, 381);
    assert.equal(state.kpi.docksOccupied, 5);
    // MOUVEMENTS: text codes, real dates, numbers.
    const mv = sheetTable(g.ss.getSheetByName(T.MOVEMENTS));
    assert.equal(mv.rows.length, 2814);
    const row = mv.rows[0];
    assert.equal(typeof row[1], 'string', 'Article text');
    assert.equal(typeof row[7], 'string', 'Doc.article text');
    assert.ok(row[9] instanceof Date, 'Date cpt. is a date');
    assert.equal(typeof row[10], 'number');
    assert.equal(row[14], 'SIMULATION');
    // CALC tabs: one setValues per tab, oracle values.
    const kpi = sheetTable(g.ss.getSheetByName(T.CALC_KPI));
    assert.equal(kpi.rows.find((x) => x[0] === 'Palettes EXP2')[1], 994);
    assert.equal(kpi.rows.find((x) => x[0] === 'Quais occupés')[1], '5/8', 'text kept, not parsed as a date');
    const stock = sheetTable(g.ss.getSheetByName(T.CALC_STOCK));
    assert.equal(stock.rows.length, 40);
    assert.ok(stock.rows.every((x) => typeof x[0] === 'string'));
    const daily = sheetTable(g.ss.getSheetByName(T.CALC_DAILY));
    assert.equal(daily.rows[daily.rows.length - 1][0], '03.10.2026');
    // The memory repo gives the same state for the same data.
    const mem = makeContext({ sim: 'fixture', repo: 'memory' });
    mem.Repo.setup();
    mem.api_simulate(plain(mem.Repo.getKeys()).admin, { days: 14, seed: 2026 });
    const memState = plain(mem.api_getState());
    for (const k of ['kpi', 'blocks', 'blockContents', 'daily', 'pending', 'docks', 'alerts', 'families', 'layout']) {
      assert.deepEqual(state[k], memState[k], 'same ' + k + ' with both repos');
    }
  });

  await t.test('state is stored in cache chunks and in the hidden _STATE tab', () => {
    const state = plain(Repo.loadState());
    const big = Object.assign({}, state, { padding: 'é'.repeat(130000) + 'x'.repeat(60000) });
    Repo.saveState(big);
    const cells = sheetTable(g.ss.getSheetByName(T.STATE));
    const meta = JSON.parse(cells.header[0]);
    assert.ok(meta.n >= 5);
    assert.ok(cells.rows.every((r) => r[0].length <= 45001 && r[0][0] === 'J'));
    // A new execution with an empty cache reads the tab back.
    g.cacheStore.clear();
    const ctx2 = makeContext({ sim: 'fixture', repo: 'sheets', globals: g.globals });
    assert.deepEqual(plain(ctx2.Repo.loadState()), big);
    assert.ok([...g.cacheStore.keys()].some((k) => k.startsWith('STATE:')), 'cache refilled');
    const ctx3 = makeContext({ sim: 'fixture', repo: 'sheets', globals: g.globals });
    assert.deepEqual(plain(ctx3.Repo.loadState()), big, 'from the cache chunks');
    Repo.saveState(state);
    const stateChunks = [...g.cacheStore.keys()].filter((k) => k.startsWith('STATE:'));
    const live = JSON.parse(g.cacheStore.get('STATE'));
    assert.equal(stateChunks.length, live.n, 'previous chunks dropped from the cache');
  });

  await t.test('api_lookup on the sheet: cache, else one row found with a TextFinder, never a recalculation', () => {
    const mem = makeContext({ sim: 'fixture', repo: 'memory' });
    mem.Repo.setup();
    mem.api_simulate(plain(mem.Repo.getKeys()).admin, { days: 14, seed: 2026 });
    const want = plain(mem.api_lookup('1000914295'));
    // A new execution with an empty cache.
    g.cacheStore.clear();
    const ctx2 = makeContext({ sim: 'fixture', repo: 'sheets', globals: g.globals });
    let computed = 0;
    const compute = ctx2.Engine.compute;
    ctx2.Engine.compute = function () { computed++; return compute.apply(this, arguments); };
    const finds = g.calls.find[T.LOOKUP] || 0;
    const moves = g.calls.getValues[T.MOVEMENTS] || 0;
    const got = plain(ctx2.api_lookup('0001000914295'));
    for (const k of ['article', 'found', 'designation', 'asOf', 'stock', 'fifo', 'pending', 'exits', 'locations', 'movements', 'movementsTotal']) {
      assert.deepEqual(got[k], want[k], 'same ' + k + ' as the memory repo');
    }
    assert.equal((g.calls.find[T.LOOKUP] || 0) - finds, 1, 'one TextFinder search');
    assert.equal((g.calls.getValues[T.MOVEMENTS] || 0) - moves, 0, 'MOUVEMENTS not read');
    assert.equal(computed, 0, 'no recalculation');
    assert.equal(plain(ctx2.api_lookup('424242')).found, false);
    const finds2 = g.calls.find[T.LOOKUP];
    assert.deepEqual(plain(ctx2.api_lookup('1000914295')), got, 'second call from the cache');
    assert.equal(g.calls.find[T.LOOKUP], finds2);
    assert.ok(plain(ctx2.api_searchArticles('connecteur')).some((a) => a.article === '1000914295'), 'search from _LOOKUP');
    assert.equal(computed, 0);
  });

  await t.test('api_getState never waits behind a write; versions are read from the cache', () => {
    const saved = plain(Repo.loadState());
    g.cacheStore.clear();
    const st = g.ss.getSheetByName(T.STATE);
    st.clearContents();
    g.lockState.busy = true;
    const ctx2 = makeContext({ sim: 'fixture', repo: 'sheets', globals: g.globals });
    assert.throws(() => ctx2.api_getState(), /État non calculé/);
    assert.ok(g.lockLog.some((l) => l[1] === 'try' && l[2] === 0), 'tryLock(0), no wait');
    g.lockState.busy = false;
    const again = plain(ctx2.api_getState());
    assert.equal(again.kpi.exp2Pallets, saved.kpi.exp2Pallets, 'calculated once the lock is free');
    // Polls: no Properties read while the cached copy of the versions is there.
    const ctx3 = makeContext({ sim: 'fixture', repo: 'sheets', globals: g.globals });
    ctx3.api_getVersion();
    const n0 = g.propsReads.n;
    for (let i = 0; i < 5; i++) assert.deepEqual(plain(ctx3.api_getVersion()), plain(ctx2.api_getVersion()));
    assert.equal(g.propsReads.n, n0, 'versions from the script cache');
    g.cacheStore.delete('VERSIONS');
    assert.deepEqual(plain(ctx3.api_getVersion()), plain(ctx2.api_getVersion()), 'falls back to the properties');
    assert.ok(g.propsReads.n > n0);
    const v = plain(ctx3.api_getVersion());
    ctx3.Repo.bumpVersion('docks');
    assert.equal(plain(ctx2.api_getVersion()).docks, v.docks + 1, 'a bump rewrites the cached copy');
  });

  await t.test('docks, import, next day and clear on the sheet repo', () => {
    const v0 = plain(ctx.api_getVersion());
    ctx.api_saveDock(keys.docks, { quai: 'Q03', status: 'Occupé - chargement en cours', truck: 'CAM-09', arrival: '09:05',
      departure: '11:30', planned: 30, loaded: 4, staged: 5, color: 'vert' });
    assert.equal(ctx.api_getVersion().docks, v0.docks + 1);
    const docks = sheetTable(g.ss.getSheetByName(T.DOCKS)).rows;
    assert.deepEqual(docks[2].slice(0, 8), ['Q03', 'Occupé - chargement en cours', 'CAM-09', '', 'vert', '09:05', '11:30', 30]);
    const visits = sheetTable(g.ss.getSheetByName(T.VISITS)).rows;
    assert.equal(visits.length, 1);
    assert.equal(visits[0][1], 'Q03');
    assert.equal(visits[0][10], 'Page Quais & camions');
    assert.ok(!g.lockLog.some((l) => l[0] === 'document'), 'docks use the script lock (no document lock in a web app)');
    assert.ok(g.lockLog.some((l) => l[0] === 'script' && l[1] === 'wait'));
    assert.equal(plain(ctx.api_getState()).kpi.docksOccupied, 6);

    const norm = ctx.Norm.normalizeRows(importRows(), { file: 'MB51_test.xlsx' });
    const meta = { importId: 'IMP-SHEET', fileName: 'MB51_test.xlsx', final: true };
    const r1 = plain(ctx.api_importLines(keys.admin, meta, plain(norm.lines)));
    assert.equal(r1.added, 3);
    const r2 = plain(ctx.api_importLines(keys.admin, Object.assign({}, meta, { importId: 'IMP-SHEET-2' }), plain(norm.lines)));
    assert.equal(r2.added, 0);
    assert.equal(r2.duplicates, 3);
    const log = sheetTable(g.ss.getSheetByName(T.IMPORT_LOG)).rows;
    assert.equal(log.length, 3);
    assert.ok(log[1][0] instanceof Date);
    assert.equal(log[1][1], 'MB51');
    assert.equal(plain(Repo.lastImport()).kind, 'MB51');

    const vData = ctx.api_getVersion().data;
    const readsBefore = Object.assign({}, g.calls.getValues);
    const next = plain(ctx.api_simulateNextDay(keys.admin));
    assert.equal(next.day, '2026-10-05');
    assert.ok(ctx.api_getVersion().data > vData);
    const nextState = plain(ctx.api_getState());
    assert.equal(nextState.asOf, '2026-10-05');
    for (const tab of [T.OPENING, T.ARTICLES, T.LAYOUT, T.SETTINGS]) {
      assert.equal((g.calls.getValues[tab] || 0) - (readsBefore[tab] || 0), 1, tab + ' read once for +1 jour');
    }
    // The input reused for the calculation gives exactly what a fresh read of the tabs gives.
    ctx.api_recompute(keys.admin);
    const fresh = plain(ctx.api_getState());
    for (const k of ['kpi', 'blocks', 'blockContents', 'daily', 'pending', 'docks', 'alerts']) {
      assert.deepEqual(nextState[k], fresh[k], 'same ' + k + ' after +1 jour and after Recalculer');
    }

    const cleared = plain(ctx.runClearSimulation_());
    assert.equal(cleared.cleared.removed, 2818);
    assert.equal(sheetTable(g.ss.getSheetByName(T.MOVEMENTS)).rows.length, 3);
    assert.equal(sheetTable(g.ss.getSheetByName(T.OPENING)).rows.length, 0);
    assert.equal(sheetTable(g.ss.getSheetByName(T.ARTICLES)).rows.length, 0);
    assert.equal(plain(ctx.api_getState()).source, 'SAP');
    assert.equal(plain(Repo.lastImport()).kind, 'SIMULATION +1 JOUR', 'clearing is not an import');
  });

  await t.test('a repair run keeps columns moved or added by hand', () => {
    ctx.api_simulate(keys.admin, { days: 14, seed: 2026 });
    const sh = g.ss.getSheetByName(T.ARTICLES);
    const before = sheetTable(sh);
    assert.ok(before.rows.length >= 10);
    // Swap the first two columns and add a column of comments.
    const w = before.header.length;
    sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    const swapped = [before.header.slice()].concat(before.rows).map((r, i) => [r[1], r[0]].concat(r.slice(2, w), [i === 0 ? 'Note atelier' : 'n' + i]));
    sh.getRange(1, 1, swapped.length, w + 1).setNumberFormat('@').setValues(swapped);
    const input = plain(Repo.readInput());
    assert.equal(input.articles[0].article, String(before.rows[0][0]), 'read by label whatever the order');
    Repo.setup();
    const after = sheetTable(sh);
    assert.deepEqual(after.header, plain(CFG.HEADERS.ARTICLES).concat(['Note atelier']));
    assert.equal(after.rows.length, before.rows.length);
    assert.equal(String(after.rows[0][0]), String(before.rows[0][0]));
    assert.equal(after.rows[0][1], before.rows[0][1]);
    assert.equal(after.rows[0][w], 'n1', 'extra column kept');
    const v = ctx.api_getVersion().data;
    ctx.api_recompute(keys.admin);
    assert.equal(ctx.api_getVersion().data, v + 1);
  });

  await t.test('ACCUEIL: menu actions, buttons and status block', () => {
    ctx.simulerDonnees();
    assert.equal(g.ui.alerts.length, 0, 'no error alert');
    assert.match(g.ss.toasts[g.ss.toasts.length - 1], /Simulation générée/);
    ctx.buildHome_();
    const home = g.ss.getSheetByName(T.HOME);
    assert.deepEqual(home.images.map((i) => i.script).sort(), ['ouvrirJumeau', 'recalculer', 'simulerDonnees', 'simulerJourSuivant']);
    assert.ok(home.images.every((i) => i.w === 300 && i.h === 58 && i.blob.type === 'image/png'));
    const values = sheetTable(home).rows.map((r) => r.join('|')).join('\n');
    assert.match(values, /Simulation \(données fictives\)/);
    assert.match(values, /995 palettes sur 1\u00a0464 places/, 'simulation + the 3 imported lines');
    assert.match(values, /\?mode=tv&rotate=1/);
    assert.ok(!values.includes(keys.admin) && !values.includes(keys.docks), 'keys never written in the sheet (viewers can read it)');
    assert.match(values, /Clé administrateur\|••••/);
    ctx.buildHome_();
    assert.equal(home.images.length, 4, 'buttons not duplicated on rebuild');
    ctx.recalculer();
    assert.match(g.ss.toasts[g.ss.toasts.length - 1], /Recalcul terminé/);
    g.ui.answer = 'YES';
    ctx.installerLaBase();
    assert.equal(g.ui.alerts.length, 1, 'reinstall asks first: ' + JSON.stringify(g.ui.alerts));
    assert.match(g.ss.toasts[g.ss.toasts.length - 1], /Base installée/);
    const status = plain(ctx.sidebar_status());
    assert.equal(status.installed, true);
    assert.equal(status.state.source, 'SIMULATION');
    assert.equal(status.simulation.seed, 2026);
    const links = plain(ctx.sidebar_links());
    assert.equal(links.keys.admin, keys.admin);
    assert.deepEqual(links.links.pages.map((p) => p.page), Array.from(ctx.WEB_PAGES_), 'one link per PC page of doGet');
    const sim = plain(ctx.sidebar_simulate({ days: '3', endDate: '2026-10-03', seed: '7', palletsPerDay: '' }));
    assert.match(sim.message, /Simulation générée/);
    assert.equal(sim.status.simulation.seed, 7);
    ctx.ouvrirJumeau();
    assert.match(g.ui.dialog.out.html, /Clé administrateur/);
    assert.ok(g.ui.dialog.out.html.includes(keys.admin));
    // Web app links: a /dev URL is never given; the /exec URL saved in the control panel wins.
    const getService = g.globals.ScriptApp.getService;
    g.globals.ScriptApp.getService = () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/dev' });
    let l = plain(ctx.sidebar_links()).links;
    assert.equal(l.deployed, false);
    assert.equal(l.dev, true);
    assert.equal(l.tv, '');
    assert.match(l.instructions, /\/exec/);
    ctx.buildHome_();
    assert.match(sheetTable(home).rows.map((r) => r.join('|')).join('\n'), /Lien \/dev/);
    assert.throws(() => ctx.sidebar_setWebAppUrl('https://script.google.com/macros/s/FAKE/dev'), /\/exec/);
    assert.throws(() => ctx.sidebar_setWebAppUrl('https://evil.example.com/exec'), /\/exec/);
    const execUrl = 'https://script.google.com/a/macros/example.com/s/AKfycb-x_1/exec';
    l = plain(ctx.sidebar_setWebAppUrl('  ' + execUrl + ' ')).links;
    assert.equal(l.deployed, true);
    assert.equal(l.tv, execUrl + '?mode=tv&rotate=1');
    assert.match(sheetTable(home).rows.map((r) => r.join('|')).join('\n'), /AKfycb-x_1\/exec\?mode=tv/);
    ctx.sidebar_setWebAppUrl('');
    g.globals.ScriptApp.getService = getService;
    assert.equal(plain(ctx.sidebar_links()).links.tv, 'https://script.google.com/macros/s/FAKE/exec?mode=tv&rotate=1');

    // A hand edit of QUAIS_CAMIONS bumps the docks version (simple trigger); other tabs do not.
    const edit = (name) => ({ range: { getSheet: () => ({ getName: () => name }) } });
    const d0 = ctx.api_getVersion().docks;
    ctx.onEdit(edit(T.DOCKS));
    assert.equal(ctx.api_getVersion().docks, d0 + 1);
    ctx.onEdit(edit(T.ARTICLES));
    ctx.onEdit(undefined);
    assert.equal(ctx.api_getVersion().docks, d0 + 1);

    // New keys after a leak: the old ones stop working.
    const before = plain(Repo.getKeys());
    g.ui.answer = 'NO';
    ctx.regenererLesCles();
    assert.deepEqual(plain(Repo.getKeys()), before, 'nothing changed without confirmation');
    g.ui.answer = 'YES';
    ctx.regenererLesCles();
    const after = plain(Repo.getKeys());
    assert.match(after.admin, KEY_RE);
    assert.notEqual(after.admin, before.admin);
    assert.notEqual(after.docks, before.docks);
    assert.ok(g.ui.dialog.out.html.includes(after.admin), 'new keys shown at once');
    assert.throws(() => ctx.api_recompute(before.admin), /Clé incorrecte/);
    ctx.api_recompute(after.admin);
    keys = after;

    ctx.ui = g.ui;
    // Errors from a button become a French alert, not a crash.
    g.ui.answer = 'YES';
    ctx.effacerSimulation();
    ctx.simulerJourSuivant();
    assert.match(g.ui.alerts[g.ui.alerts.length - 1][1], /Aucune simulation en cours/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Apps Script safe syntax and file contracts
// ---------------------------------------------------------------------------------------------------------------
test('Repo.gs, Api.gs, Main.gs, Sidebar.html and the memory repo follow the Apps Script rules', () => {
  const files = ['Repo.gs', 'Api.gs', 'Main.gs'].filter((f) => fs.existsSync(path.join(SRC, f)));
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.doesNotMatch(src, /^\s*(import|export)\b/m, f + ': no import/export');
    assert.doesNotMatch(src, /\brequire\s*\(/, f + ': no require');
    assert.doesNotMatch(src, /\?\?/, f + ': no ??');
    assert.doesNotMatch(src, /[\w\])]\?\.[A-Za-z_$]/, f + ': no ?.');
    assert.doesNotMatch(src, /^\s*await\b/m, f + ': no top-level await');
    new vm.Script(src, { filename: f });
  }
  if (files.includes('Main.gs')) assert.match(fs.readFileSync(path.join(SRC, 'Main.gs'), 'utf8'), /^\/\*\* @OnlyCurrentDoc \*\//);
  if (files.includes('Api.gs')) {
    // Api.gs never calls a Google service directly.
    const api = fs.readFileSync(path.join(SRC, 'Api.gs'), 'utf8');
    assert.doesNotMatch(api, /\b(SpreadsheetApp|CacheService|PropertiesService|LockService|HtmlService|ScriptApp|Utilities|Session)\./);
  }
  const mem = fs.readFileSync(REPO_MEMORY, 'utf8');
  assert.doesNotMatch(mem, /\brequire\s*\(/);
  assert.match(mem, /^if \(typeof module !== 'undefined'\) module\.exports = Repo;$/m);
  // Same public interface for both repos.
  if (has('Repo') && has('Config')) {
    const sheets = makeContext({ sim: 'none', repo: 'sheets' }).Repo;
    const memory = makeContext({ sim: 'none', repo: 'memory' }).Repo;
    const missing = Object.keys(sheets).filter((k) => typeof memory[k] !== 'function');
    assert.deepEqual(missing, [], 'memory repo implements every Repo.gs method');
  }
  const sidebar = path.join(SRC, 'Sidebar.html');
  if (fs.existsSync(sidebar)) {
    const html = fs.readFileSync(sidebar, 'utf8');
    assert.doesNotMatch(html, /\b(alert|confirm|prompt)\s*\(/, 'no alert/confirm/prompt');
    assert.match(html, /withSuccessHandler/);
    assert.match(html, /withFailureHandler/);
    for (const fn of ['sidebar_status', 'sidebar_simulate', 'sidebar_nextDay', 'sidebar_recompute', 'sidebar_links', 'sidebar_setWebAppUrl']) {
      assert.ok(html.includes("'" + fn + "'"), 'sidebar calls ' + fn);
    }
    assert.match(html, /lang="fr"/);
  }
  // clasp pushes rootDir: the manifest and every .gs / .html file sit at its top level, so the Apps Script file names
  // are 'Index', 'Styles', ... exactly as createTemplateFromFile / createHtmlOutputFromFile / include_ ask for them.
  const clasp = JSON.parse(fs.readFileSync(path.join(SRC, '..', '.clasp.json.example'), 'utf8'));
  assert.equal(clasp.rootDir, 'apps-script/src');
  assert.equal(path.resolve(ROOT, clasp.rootDir), SRC);
  assert.deepEqual(fs.readdirSync(SRC).filter((f) => fs.statSync(path.join(SRC, f)).isDirectory()), [], 'no sub-folder in rootDir');
  assert.ok(!fs.existsSync(path.join(SRC, '..', 'appsscript.json')), 'manifest inside rootDir only');
  for (const f of ['Main.gs', 'Index.html']) {
    if (!fs.existsSync(path.join(SRC, f))) continue;
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of src.matchAll(/(?:createTemplateFromFile|createHtmlOutputFromFile|include_)\('([^']+)'\)/g)) {
      assert.ok(fs.existsSync(path.join(SRC, m[1] + '.html')), f + ' asks for ' + m[1] + '.html at the top of rootDir');
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.timeZone, 'Europe/Paris');
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
});
