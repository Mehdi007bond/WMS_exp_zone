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
    // SPEC_V2 3: no placeholder placement rules any more (projects place the articles), PROJETS starts empty,
    // PARAM_SEUILS carries the v2 keys.
    assert.equal(db.rules.length, 0);
    assert.deepEqual(db.projects, []);
    assert.ok(res.created.includes('PROJETS'));
    for (const k of ['pendingHoursWarn', 'pendingHoursCrit', 'labelIsPallet', 'importTrackedOnly']) {
      assert.ok(db.settings.some((s) => s.key === k), 'setting ' + k);
    }
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
    assert.deepEqual(fin.totals, { read: 10, added: 3, duplicates: 3, rejected: 4, untracked: 0 });
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
    assert.throws(() => ctx.simParams_({ days: 61 }), /Nombre de jours invalide \(1 à 60\)/);
    assert.throws(() => ctx.simParams_({ endDate: '2999-01-01' }), /futur/);
    assert.throws(() => ctx.simParams_({ endDate: '31/02/2026x' }), /Date de fin invalide/);
    // SPEC_V2 6: every day is a working day (v1: Monday to Saturday), labels a day 20-1,500.
    const p = plain(ctx.simParams_({ days: 14, endDate: '2026-10-03' }));
    assert.equal(p.startDate, '2026-09-20', '14 calendar days ending on 03.10');
    assert.equal(p.seed, 2026);
    assert.equal(p.palletsPerDay, undefined, 'empty: the simulator default');
    assert.ok(!('articles' in p), 'no v1 articles parameter');
    const sunday = plain(ctx.simParams_({ days: 1, endDate: '2026-09-27' }));
    assert.equal(sunday.endDate, '2026-09-27', 'a Sunday is a working day');
    const def = plain(ctx.simParams_({}));
    assert.equal(def.days, 7, 'default 7 days');
    assert.equal(def.endDate, ctx.simEndDefault_(), 'ending yesterday');
    assert.equal(ctx.addDays_(def.endDate, 1), ctx.isoToday_());
    const both = plain(ctx.simParams_({ startDate: '2026-09-01', endDate: '2026-09-10', days: 3 }));
    assert.deepEqual([both.startDate, both.endDate, both.days], ['2026-09-01', '2026-09-10', 10], 'start and end set the days');
    const start = plain(ctx.simParams_({ startDate: '2026-09-01', days: 5 }));
    assert.deepEqual([start.startDate, start.endDate], ['2026-09-01', '2026-09-05']);
    assert.throws(() => ctx.simParams_({ startDate: '2026-09-10', endDate: '2026-09-01' }), /précéder/);
    assert.throws(() => ctx.simParams_({ palletsPerDay: 10 }), /Étiquettes par jour invalide \(20 à 1\u00a0500\)/);
    assert.equal(plain(ctx.simParams_({ palletsPerDay: '1500' })).palletsPerDay, 1500);
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
  // Small volume keeps the test fast (SPEC_V2 6: 450 labels a day by default).
  const params = { days: 4, endDate: '2026-10-03', seed: 2026, palletsPerDay: 200 };
  const r = plain(ctx.api_simulate(keys.admin, params));
  assert.equal(r.ok, true);
  assert.ok(r.lines > 500, 'realistic number of lines');
  assert.match(r.message, /Simulation générée : 4 jours du 30\.09\.2026 au 03\.10\.2026/);
  const state = plain(ctx.api_getState());
  assertStateShape(state);
  assert.equal(state.source, 'SIMULATION');
  assert.equal(state.asOf, '2026-10-03');
  assert.match(state.asOfTs, /^2026-10-0[34] \d{2}:\d{2}:\d{2}$/, 'time of the data');
  assert.ok(state.kpi.exp2Pallets > 0 && state.kpi.saturation > 0.3 && state.kpi.saturation < 1.2);
  assertNoUserNames(state, 'state');
  const db = ctx.Repo.dump();
  assert.equal(new Set(db.movements.map((m) => m.key)).size, db.movements.length, 'unique keys');
  assert.ok(db.articles.length >= 10);
  assert.ok(db.movements.some((m) => m.label && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.ts)), 'labels and entry times stored');
  // Projects written by the simulation (PROJECTS_SOURCE = SIMULATION) and shown as block titles.
  assert.deepEqual(db.projects.map((p) => p.project), ['ATLAS', 'BOREAL', 'CORSO', 'DELTA', 'ETNA', 'FJORD']);
  assert.equal(db.projects[0].blocks, 'B1, B7');
  assert.equal(ctx.Repo.getProp('PROJECTS_SOURCE'), 'SIMULATION');
  assert.equal(state.blocks.find((b) => b.id === 'B1').title, 'ATLAS');
  assert.ok(state.pending.some((x) => x.label && x.hours !== null), 'pending labels with hours');
  assert.ok(state.alerts.some((a) => a.code === 'PRD2_CRIT'), 'labels waiting over 6 h at the end of the period');
  assert.match(r.summary.text, /dont \d+ depuis plus de 6 h/);

  const v0 = ctx.api_getVersion().data;
  const next = plain(ctx.api_simulateNextDay(keys.admin));
  assert.ok(next.lines > 0);
  assert.equal(next.day, '2026-10-04', 'SPEC_V2 6: every day is a working day (v1 skipped Sunday)');
  assert.ok(ctx.api_getVersion().data > v0, 'data version changed');
  const after = plain(ctx.api_getState());
  assert.equal(after.asOf, '2026-10-04');
  // Time of the data = the latest entry: after midnight it is on the next calendar day (posted on the day before).
  assert.match(after.asOfTs, /^2026-10-0[45] /);
  assert.ok(plain(ctx.summary_(after)).text.startsWith('Au ' + ctx.frDate_(after.asOfTs.slice(0, 10)) + ' ' + after.asOfTs.slice(11, 16) + ' : '));
  assert.match(plain(ctx.summary_({ asOf: '2026-10-04', asOfTs: '2026-10-05 01:53:10', kpi: {}, alerts: [] })).text, /^Au 05\.10\.2026 01:53 : /);
  assert.match(plain(ctx.summary_({ asOf: '2026-10-04', asOfTs: '', kpi: {}, alerts: [] })).text, /^Au 04\.10\.2026 : 0 palettes/);
  // The lines of +1 jour continue the labels of the data (no label reused).
  const labels = ctx.Repo.dump().movements.filter((m) => m.mvt === '131').map((m) => m.label);
  assert.equal(new Set(labels).size, labels.length, 'one declaration per label');
  // The input reused for the calculation of +1 jour gives what a fresh read gives (v2 fields kept by engineLine_).
  ctx.api_recompute(keys.admin);
  const fresh = plain(ctx.api_getState());
  for (const k of ['kpi', 'blocks', 'blockContents', 'daily', 'pending', 'alerts', 'projectsList', 'articles']) {
    assert.deepEqual(after[k], fresh[k], 'same ' + k + ' after +1 jour and after Recalculer');
  }
  const lk = plain(ctx.api_lookup(state.pending.length ? state.pending[0].article : db.articles[0].article));
  assert.ok(lk.found);
  assert.ok(lk.project, 'article page carries the project');
  assert.ok(lk.movements.some((m) => m.label && m.ts), 'SAP lines with label and entry time');
  assertNoUserNames(lk, 'lookup');

  // Same parameters, same data: a second simulation replaces the first one.
  const again = plain(ctx.api_simulate(keys.admin, params));
  assert.equal(again.lines, r.lines);
  assert.equal(ctx.Repo.dump().movements.length, r.lines);
  assert.equal(ctx.Repo.dump().projects.length, 6, 'simulated projects replaced, not duplicated');
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
    'simulerDonnees', 'simulerJourSuivant', 'effacerSimulation', 'recalculer', 'ouvrirPanneau', 'ouvrirJumeau', 'regenererLesCles',
    'ouvrirProjets', 'sidebar_getProjects', 'sidebar_saveReferences', 'sidebar_saveProjects']) {
    assert.throws(() => ctx[fn](), /Action réservée au classeur/, fn);
  }
  assert.throws(() => ctx.sidebar_saveReferences([{ article: 'A1', project: 'X' }]), /Action réservée au classeur/);
  assert.deepEqual(ctx.Repo.dump().articles, [], 'no key-less write from the web app');
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
      this.active = sh;
      return sh;
    }
    deleteSheet(sh) { this.sheets.splice(this.sheets.indexOf(sh), 1); }
    setActiveSheet(sh) { this.active = sh; sh.hidden = false; return sh; }
    getActiveSheet() { return this.active; }
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
    assert.equal(res.created.length, 21);
    const names = g.ss.getSheets().map((s) => s.name);
    assert.deepEqual(names, [T.HOME, T.MOVEMENTS, T.OPENING, T.ARTICLES, T.PROJECTS, T.LAYOUT, T.RULES, T.MVT, T.SETTINGS,
      T.DOCKS, T.VISITS, T.CALC_STOCK, T.CALC_PENDING, T.CALC_FIFO, T.CALC_EXITS, T.CALC_DAILY, T.CALC_BLOCKS, T.CALC_KPI,
      T.IMPORT_LOG, T.STATE, T.LOOKUP], 'tab order (PROJETS after ARTICLES), default sheet removed');
    assert.equal(g.propsStore.get('SCHEMA_VERSION'), '2', 'schema version stored');
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
    for (const label of ['Clé', 'Article', 'MvT', 'Doc.article', 'Poste', 'Saisie le', 'Étiquette', 'Texte en-tête', 'Texte',
      'Référence', 'Client', 'Commande client']) {
      assert.equal(mv.fmt(1, col(label)), '@', label + ' as text');
    }
    assert.equal(mv.fmt(1, col('Date cpt.')), 'dd.mm.yyyy');
    const pj = g.ss.getSheetByName(T.PROJECTS);
    assert.deepEqual(sheetTable(pj).header, ['Projet', 'Blocs', 'Couleur', 'Commentaire']);
    assert.equal(sheetTable(pj).rows.length, 0, 'no project at setup');
    assert.ok(pj.getMaxRows() >= 21 && pj.fmt(5, 2) === '@', 'spare formatted rows (Couleur as text)');
    assert.equal(pj.tabColor, '#5b8def');
    const layout = sheetTable(g.ss.getSheetByName(T.LAYOUT)).rows;
    const D = CFG.DEFAULT_LAYOUT;
    assert.equal(layout.length, 1 + D.blocks.length + 1 + D.quais.length + D.roads.length + D.zones.length);
    assert.equal(layout.length, readCsv(path.join(CSV_DIR, 'LAYOUT.csv')).length, 'same rows as the sample LAYOUT');
    assert.deepEqual(layout.find((r) => r[0] === 'B1').slice(0, 2), ['B1', 'BLOC_STOCKAGE']);
    assert.equal(layout.filter((r) => r[1] === 'BLOC_STOCKAGE').reduce((s, r) => s + r[10], 0), 1464);
    // SPEC_V2 3: no placeholder rules (the F1-F5 families were placeholders).
    assert.equal(sheetTable(g.ss.getSheetByName(T.RULES)).rows.length, 0);
    const mvt = sheetTable(g.ss.getSheetByName(T.MVT)).rows;
    assert.equal(mvt.length, Object.keys(CFG.MVT_KINDS).length);
    assert.ok(mvt.every((r) => typeof r[0] === 'string'), 'MvT stays text');
    const settings = sheetTable(g.ss.getSheetByName(T.SETTINGS)).rows;
    assert.equal(settings.find((r) => r[1] === 'satWarn')[2], 0.85);
    const setting = (k) => settings.find((r) => r[1] === k);
    assert.deepEqual(setting('pendingHoursWarn').slice(0, 4), ['Seuil attente PRD2 - pré-alerte', 'pendingHoursWarn', 4, 'heures']);
    assert.deepEqual(setting('pendingHoursCrit').slice(0, 4), ['Seuil attente PRD2 - alerte', 'pendingHoursCrit', 6, 'heures']);
    assert.match(setting('pendingHoursCrit')[4], /plus de 6 h est un vrai problème/);
    assert.deepEqual(setting('labelIsPallet').slice(0, 4), ['1 étiquette = 1 palette', 'labelIsPallet', 1, '1/0']);
    assert.deepEqual(setting('importTrackedOnly').slice(0, 4), ['Import : produits finis seulement', 'importTrackedOnly', 1, '1/0']);
    assert.equal(new Set(settings.map((r) => r[0])).size, settings.length, 'French labels unique');
    const mem = makeContext({ sim: 'none', repo: 'memory' });
    mem.Repo.setup();
    assert.deepEqual(plain(mem.Repo.dump().settings).map((s) => [s.label, s.key, s.value, s.unit, s.comment]), settings,
      'the in-memory repo writes the same PARAM_SEUILS rows');
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
// 6. v2 (docs/SPEC_V2.md): real MB51 fixture through the import API, projects APIs, simulation ownership
// ---------------------------------------------------------------------------------------------------------------
const FIXTURE = path.join(ROOT, 'sample-data', 'mb51-reel', 'MB51_reel_anonymise.xlsx');
const EXPECTED_FILE = path.join(ROOT, 'sample-data', 'mb51-reel', 'expected.json');
let XLSX = null;
try {
  XLSX = require('xlsx');
} catch (e) {
  XLSX = null;
}
const FIXTURE_READY = CORE_READY && !!XLSX && fs.existsSync(FIXTURE) && fs.existsSync(EXPECTED_FILE);
let fixtureRows = null;

// The import page: SheetJS rows -> Norm.normalizeBatch with the finished-goods filter (no tracked article known yet).
function fixtureBatch(ctx) {
  if (!fixtureRows) {
    const wb = XLSX.readFile(FIXTURE);
    fixtureRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], ctx.Norm.SHEETJS_OPTIONS);
  }
  return plain(ctx.Norm.normalizeBatch([{ name: 'MB51_reel_anonymise.xlsx', rows: fixtureRows }], { trackedOnly: true, tracked: [] }));
}

// Batches of 500 lines like the import page; meta.final on the last one.
function importBatches(ctx, key, lines, meta) {
  let res = null;
  for (let i = 0; i === 0 || i < lines.length; i += 500) {
    const final = i + 500 >= lines.length;
    res = plain(ctx.api_importLines(key, Object.assign({}, meta, { final }), lines.slice(i, i + 500)));
  }
  return res;
}

test('v2 import of the real MB51 fixture through api_importLines', { skip: FIXTURE_READY ? false : 'fixture or xlsx absent' }, async (t) => {
  const expected = JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8'));
  const ctx = makeContext({ sim: 'none', repo: 'memory' });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  const batch = fixtureBatch(ctx);
  assert.equal(batch.lines.length, expected.normalize.kept);
  assert.equal(batch.untracked.lines, expected.normalize.dropped);

  await t.test('batches stored with the v2 fields, then one calculation', () => {
    const meta = { importId: 'IMP-REEL', fileName: 'MB51_reel_anonymise.xlsx', kind: 'MB51', untracked: batch.untracked.lines };
    const res = importBatches(ctx, keys.admin, batch.lines, meta);
    assert.deepEqual(res.totals, { read: 2800, added: 2800, duplicates: 0, rejected: 0, untracked: 1357 });
    const db = ctx.Repo.dump();
    assert.equal(db.movements.length, 2800);
    assert.ok(db.movements.every((m) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(m.ts)), 'every line has its entry time');
    assert.equal(db.movements.filter((m) => m.label).length, batch.lines.filter((l) => l.label).length, 'labels kept');
    const first = db.movements.find((m) => m.key === batch.lines[0].key);
    for (const k of ['ts', 'label', 'headerText', 'itemText', 'reference', 'client', 'salesOrder']) {
      assert.equal(first[k], batch.lines[0][k], 'stored ' + k);
    }
    assert.equal(db.importLog[db.importLog.length - 1].result, 'OK (1 357 lignes hors produits finis ignorées)');
  });

  await t.test('state: time of the data and the 6-hour alert match expected.json', () => {
    const state = plain(ctx.api_getState());
    const e = expected.engine;
    assert.equal(state.source, 'SAP');
    assert.equal(state.asOf, e.asOf);
    assert.equal(state.asOfTs, e.asOfTs);
    const k = state.kpi;
    assert.equal(k.pendingLabels, e.pending.labeled);
    assert.equal(k.exp2Pallets, e.exp2.pallets);
    assert.ok(state.pending.length === state.pendingTotal && state.pendingTotal < 500, 'every pending row in the state');
    // expected.json counts the declared labels by level (crit 86, warn 11); the KPI counts the pallets of the pending
    // rows by level, and the unlabeled stock moved into PRD2 (judged in days, posted on asOf) has no level.
    assert.equal(state.pending.filter((x) => x.label && x.level === 'crit').length, e.pending.crit);
    assert.equal(state.pending.filter((x) => x.label && x.level === 'warn').length, e.pending.warn);
    const pallets = (level) => state.pending.filter((x) => x.level === level).reduce((s, x) => s + (Number(x.pallets) || 0), 0);
    assert.equal(k.pendingCrit, pallets('crit'));
    assert.equal(k.pendingWarn, pallets('warn'));
    assert.equal(k.pendingCrit, 86);
    assert.equal(k.pendingWarn, 11);
    assert.equal(k.pendingCrit, e.pending.crit);
    assert.equal(k.pendingWarn, e.pending.warn);
    assert.equal(k.oldestPendingHours, e.pending.oldestHours);
    assert.equal(state.alerts[0].text, '86 palettes en PRD2 depuis plus de 6 h · la plus ancienne : ' + e.pending.oldest.article +
      ' depuis 44 h 02 (étiquette ' + e.pending.oldest.label + ')');
    assert.equal(state.alerts[0].code, 'PRD2_CRIT', 'critical PRD2 alert first');
    assert.match(state.alerts[0].text, new RegExp(e.pending.oldest.article + ' .*\\(étiquette ' + e.pending.oldest.label + '\\)'));
    assert.equal(state.thresholds.importTrackedOnly, 1, 'import filter setting for the import page');
    assert.ok(state.articles.length >= expected.normalize.trackedArticles, 'tracked articles for the projects page');
    assertNoUserNames(state, 'state');
    const sum = plain(ctx.summary_(state));
    assert.equal(sum.pendingCrit, k.pendingCrit);
    assert.match(sum.text, /^Au 05\.10\.2026 22:09 : 1 023 palettes en EXP2 .* dont 86 depuis plus de 6 h, \d+ alertes\.$/);
  });

  await t.test('article page: project, labels and times', () => {
    const lk = plain(ctx.api_lookup(expected.engine.pending.oldest.article));
    assert.equal(lk.found, true);
    assert.equal(lk.project, '');
    assert.equal(lk.asOfTs, expected.engine.asOfTs);
    const oldest = lk.pending.find((x) => x.label === expected.engine.pending.oldest.label);
    assert.ok(oldest, 'pending label on the article page');
    assert.equal(oldest.hours, expected.engine.pending.oldestHours);
    assert.equal(oldest.level, 'crit');
    assert.ok(lk.movements.every((m) => m.ts && 'label' in m && 'client' in m && 'salesOrder' in m));
    for (let i = 1; i < lk.movements.length; i++) {
      const a = lk.movements[i - 1], b = lk.movements[i];
      assert.ok(a.date > b.date || (a.date === b.date && a.ts >= b.ts), 'newest first by date and entry time');
    }
    assert.ok(!lk.movements.some((m) => 'headerText' in m || 'itemText' in m), 'free texts never sent to the screens');
    assertNoUserNames(lk, 'lookup');
  });

  await t.test('a second import of the same lines adds nothing', () => {
    const v = ctx.api_getVersion().data;
    const res = importBatches(ctx, keys.admin, batch.lines.slice(0, 700), { importId: 'IMP-REEL-2', fileName: 'x.xlsx' });
    assert.deepEqual(res.totals, { read: 700, added: 0, duplicates: 700, rejected: 0, untracked: 0 });
    assert.equal(ctx.api_getVersion().data, v + 1);
  });

  await t.test('the server re-validates the v2 fields', () => {
    const base = batch.lines.find((l) => l.mvt === '311' && l.label);
    const mk = (o, i) => Object.assign({}, base, { doc: '7000000' + i, row: 9000 + i, key: 'x' }, o);
    const sent = [
      mk({ ts: '2026-13-05 10:00:00' }, 1),
      mk({ ts: '05/10/2026 10:00' }, 2),
      mk({ label: 'ABC' }, 3),
      mk({ label: '999', itemText: '434999001' }, 4),
      mk({ label: '434999002', itemText: '', headerText: '' }, 5),
      mk({ itemText: 'x'.repeat(300), headerText: 'TA11P1' + '9'.repeat(300), client: '0001234', salesOrder: '00045', reference: '0700011312' }, 6),
      mk({ ts: '' }, 7)
    ];
    const res = plain(ctx.api_importLines(keys.admin, { importId: 'IMP-V2', fileName: 'v2.xlsx', final: true }, sent));
    assert.equal(res.rejected, 3);
    assert.match(res.rejectedLines[0].reason, /Heure de saisie illisible/);
    assert.match(res.rejectedLines[1].reason, /Heure de saisie illisible/);
    assert.match(res.rejectedLines[2].reason, /Étiquette illisible/);
    assert.equal(res.added, 4);
    const db = ctx.Repo.dump();
    const by = (doc) => db.movements.find((m) => m.doc === doc);
    assert.equal(by('70000004').label, '434999001', 'label rebuilt from the item text');
    assert.equal(by('70000005').label, '434999002', 'digit label sent without texts kept');
    const long = by('70000006');
    assert.equal(long.itemText.length, 200);
    assert.equal(long.headerText.length, 200);
    assert.equal(long.label, '', 'a 300-character text is no label');
    assert.equal(long.client, '1234');
    assert.equal(long.salesOrder, '45');
    assert.equal(long.reference, '0700011312', 'reference keeps its zeros');
    assert.equal(by('70000007').ts, '', 'no entry time: accepted without one');
  });
});

test('v2 projects APIs: references, projects, rename, ownership, keys', { skip: FIXTURE_READY ? false : 'fixture or xlsx absent' }, async (t) => {
  const ctx = makeContext({ sim: 'real', repo: 'memory' });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  const batch = fixtureBatch(ctx);
  importBatches(ctx, keys.admin, batch.lines, { importId: 'IMP-P', fileName: 'MB51.xlsx' });
  const state0 = plain(ctx.api_getState());
  const designation = (a) => state0.articles.find((x) => x.a === a).d;

  await t.test('api_getProjects reads PROJETS, ARTICLES, LAYOUT and the thresholds without a key', () => {
    const p = plain(ctx.api_getProjects());
    assert.deepEqual(Object.keys(p).sort(), ['blocks', 'projects', 'references', 'settings', 'version']);
    assert.deepEqual(p.projects, []);
    assert.deepEqual(p.references, []);
    assert.equal(p.blocks.length, 8);
    assert.deepEqual(p.blocks[0], { id: 'B1', label: 'Allée 26', capacity: 260 });
    assert.deepEqual(p.settings, { pendingHoursWarn: 4, pendingHoursCrit: 6 });
    assert.equal(p.version, ctx.api_getVersion().data);
    assert.ok(state0.blocks.every((b) => b.title === 'Libre' && b.projects.length === 0), 'no project yet');
  });

  await t.test('write APIs need the admin key', () => {
    const v = ctx.api_getVersion().data;
    assert.throws(() => ctx.api_saveReferences('BAD', [{ article: 'LB73297', project: 'X' }]), /^Error: Clé incorrecte$/);
    assert.throws(() => ctx.api_saveReferences(keys.docks, [{ article: 'LB73297', project: 'X' }]), /Clé incorrecte/);
    assert.throws(() => ctx.api_saveProjects('', []), /Clé incorrecte/);
    assert.throws(() => ctx.api_renameProject(keys.docks, 'A', 'B'), /Clé incorrecte/);
    assert.equal(ctx.api_getVersion().data, v);
    assert.deepEqual(ctx.Repo.dump().articles, []);
  });

  await t.test('api_saveReferences validates, upserts, spells and creates projects', () => {
    const v = ctx.api_getVersion().data;
    const r = plain(ctx.api_saveReferences(keys.admin, [
      { article: ' lb73297 ', project: '  Atlas   Nord ' },
      { article: '0073871645', project: 'ATLAS NORD' },
      { article: 'bad code!', project: 'X' },
      { article: 'LF23855', project: 'A;B' },
      { article: 'LF23857', project: 'x'.repeat(41) },
      { article: 'LF23862', project: 'sans PROJET' },
      { article: '', project: 'X' },
      { article: 'LD31553', project: 'P1' },
      { article: 'ld31553', project: 'P2' },
      { article: 'LD38035', project: 'Delta' },
      { article: 'LD38035', project: 'delta' }
    ]));
    assert.equal(r.ok, true);
    assert.deepEqual([r.created, r.updated, r.unchanged], [3, 0, 0]);
    assert.deepEqual(r.newProjects, ['Atlas Nord', 'Delta']);
    const reasons = Object.fromEntries(r.invalid.map((x) => [x.article, x.reason]));
    assert.deepEqual(Object.keys(reasons).sort(), ['', 'LD31553', 'LF23855', 'LF23857', 'LF23862', 'bad code!'].sort());
    assert.match(reasons['bad code!'], /Référence invalide/);
    assert.match(reasons.LF23855, /sans virgule, point-virgule ni barre verticale/);
    assert.match(reasons.LF23857, /trop long \(40 caractères au plus\)/);
    assert.match(reasons.LF23862, /Nom réservé : « Sans projet »/);
    assert.match(reasons[''], /Référence manquante/);
    assert.match(reasons.LD31553, /en double avec des projets différents/);
    assert.equal(r.versions.data, v + 1, 'recalculated');
    assert.match(r.message, /^Références enregistrées : 3 nouvelles, 0 modifiée, 0 inchangée, 6 invalides\. Nouveaux projets : Atlas Nord, Delta\. Au /);
    const db = ctx.Repo.dump();
    const art = (a) => db.articles.find((x) => x.article === a);
    assert.equal(art('LB73297').project, 'Atlas Nord');
    assert.equal(art('73871645').project, 'Atlas Nord', 'first spelling of the request for a new project');
    assert.equal(art('LB73297').designation, designation('LB73297'), 'designation from the last state');
    assert.equal(art('LD38035').project, 'Delta', 'the same project twice in any case is no conflict');
    assert.equal(art('LB73297').qpp, null, 'quantity per pallet left empty (learned from the labels)');
    assert.deepEqual(db.projects, [{ project: 'Atlas Nord', blocks: '', color: '', comment: '' },
      { project: 'Delta', blocks: '', color: '', comment: '' }]);
    const st = plain(ctx.api_getState());
    assert.equal(st.articles.find((x) => x.a === 'LB73297').p, 'Atlas Nord');
    assert.equal(st.kpi.projects, 2);
    assert.equal(st.pending.find((x) => x.article === 'LB73297').project, 'Atlas Nord');
  });

  await t.test('spelling of PROJETS wins; update, unchanged, removal; never-seen article', () => {
    const r = plain(ctx.api_saveReferences(keys.admin, [
      { article: 'LF23855', project: 'ATLAS NORD' },
      { article: 'LB73297', project: 'Boreal' },
      { article: '73871645', project: 'atlas nord' },
      { article: 'LD38035', project: '' },
      { article: 'ZZ99999', project: 'delta' },
      { article: 'NEVER01', project: '' }
    ]));
    assert.deepEqual([r.created, r.updated, r.unchanged], [2, 2, 2]);
    assert.ok(!ctx.Repo.dump().articles.some((x) => x.article === 'NEVER01'), 'no empty row for an article without a project');
    assert.deepEqual(r.newProjects, ['Boreal']);
    const db = ctx.Repo.dump();
    const art = (a) => db.articles.find((x) => x.article === a);
    assert.equal(art('LF23855').project, 'Atlas Nord');
    assert.equal(art('73871645').project, 'Atlas Nord', 'same name in another case: unchanged');
    assert.equal(art('LB73297').project, 'Boreal');
    assert.equal(art('LD38035').project, '', "'' removes the project");
    assert.equal(art('ZZ99999').project, 'Delta');
    assert.equal(art('ZZ99999').designation, '', 'never seen in the data');
    assert.deepEqual(db.projects.map((p) => p.project), ['Atlas Nord', 'Delta', 'Boreal']);
    // Nothing to change: no recalculation, no new version.
    const v = ctx.api_getVersion().data;
    const same = plain(ctx.api_saveReferences(keys.admin, [{ article: 'lf23855', project: 'Atlas Nord' }]));
    assert.match(same.message, /^Aucun changement : 0 nouvelle, 0 modifiée, 1 inchangée\.$/);
    assert.equal(ctx.api_getVersion().data, v);
    const bad = plain(ctx.api_saveReferences(keys.admin, [{ article: '???', project: 'X' }]));
    assert.equal(bad.ok, false);
    assert.match(bad.message, /Aucune référence enregistrée : 1 ligne invalide/);
    assert.equal(ctx.api_getVersion().data, v);
    assert.throws(() => ctx.api_saveReferences(keys.admin, []), /Aucune référence reçue/);
    assert.throws(() => ctx.api_saveReferences(keys.admin, 'LB73297'), /Aucune référence reçue/);
    const many = Array.from({ length: 2001 }, (x, i) => ({ article: 'A' + i, project: 'P' }));
    assert.throws(() => ctx.api_saveReferences(keys.admin, many), /maximum 2 000/);
    // Project names typed only in ARTICLES are listed after the PROJETS rows.
    const p = plain(ctx.api_getProjects());
    assert.deepEqual(p.projects.map((x) => [x.project, x.listed]), [['Atlas Nord', true], ['Delta', true], ['Boreal', true]]);
    assert.deepEqual(p.references.find((x) => x.article === 'LB73297'), { article: 'LB73297', designation: designation('LB73297'), project: 'Boreal' });
  });

  await t.test('api_saveProjects: blocks and colors become block titles; bad input refused, nothing written', () => {
    const before = ctx.Repo.dump().projects;
    const v = ctx.api_getVersion().data;
    const bad = [
      [[{ project: 'Atlas Nord', blocks: ['B9'] }], /bloc inconnu pour « Atlas Nord » : « B9 » \(blocs : B1, B2, B3, B4, B5, B6, B7, B8\)/],
      [[{ project: 'Atlas Nord', blocks: ['B1'] }, { project: 'atlas nord', blocks: ['B2'] }], /projet en double : « atlas nord »/],
      [[{ project: 'Atlas Nord', blocks: [], color: 'red' }], /couleur invalide pour « Atlas Nord » : « red » \(format #rrggbb\)/],
      [[{ project: '', blocks: ['B1'] }], /ligne 1 : nom de projet manquant/],
      [[{ project: 'A|B', blocks: [] }], /barre verticale/],
      [Array.from({ length: 101 }, (x, i) => ({ project: 'P' + i })), /Trop de projets \(101, maximum 100\)/]
    ];
    for (const [rows, re] of bad) assert.throws(() => ctx.api_saveProjects(keys.admin, rows), re);
    assert.throws(() => ctx.api_saveProjects(keys.admin, 'x'), /illisible/);
    assert.deepEqual(ctx.Repo.dump().projects, before, 'PROJETS unchanged after a refusal');
    assert.equal(ctx.api_getVersion().data, v);

    const r = plain(ctx.api_saveProjects(keys.admin, [
      { project: 'Atlas Nord', blocks: ['b1', 'B7', 'B1'], color: '#ABCDEF', comment: 'Ligne 1' },
      { project: 'Boreal', blocks: 'B2, B8' },
      { project: 'Delta', blocks: [] },
      { project: '', blocks: [], color: '' }
    ]));
    assert.equal(r.saved, 3);
    assert.equal(r.versions.data, v + 1);
    assert.match(r.message, /^Projets enregistrés : 3 projets\. Au /);
    assert.deepEqual(ctx.Repo.dump().projects, [
      { project: 'Atlas Nord', blocks: 'B1, B7', color: '#abcdef', comment: 'Ligne 1' },
      { project: 'Boreal', blocks: 'B2, B8', color: '', comment: '' },
      { project: 'Delta', blocks: '', color: '', comment: '' }
    ]);
    const st = plain(ctx.api_getState());
    const title = (id) => st.blocks.find((b) => b.id === id).title;
    assert.equal(title('B1'), 'Atlas Nord');
    assert.equal(title('B7'), 'Atlas Nord');
    assert.equal(title('B2'), 'Boreal');
    assert.equal(title('B3'), 'Libre');
    assert.equal(st.layout.blocks.find((b) => b.id === 'B8').title, 'Boreal');
    assert.equal(st.projects['Atlas Nord'], '#abcdef');
    assert.ok(/^#[0-9a-f]{6}$/.test(st.projects.Boreal), 'automatic color');
    assert.ok(st.projectsList.some((p) => p.project === 'Atlas Nord' && p.blocks.join() === 'B1,B7'));
    // CALC_BLOCS carries the projects of each block.
    const blocs = ctx.Repo.dump().calc.CALC_BLOCS;
    assert.equal(blocs.find((row) => row[0] === 'B1')[6], 'Atlas Nord');
  });

  await t.test('api_renameProject renames, merges (blocks united) and follows the PROJET rules', () => {
    assert.throws(() => ctx.api_renameProject(keys.admin, 'Inconnu', 'X'), /Projet introuvable : « Inconnu »/);
    assert.throws(() => ctx.api_renameProject(keys.admin, 'Boreal', 'Boreal'), /identique/);
    assert.throws(() => ctx.api_renameProject(keys.admin, 'Boreal', 'A,B'), /virgule/);
    assert.throws(() => ctx.api_renameProject(keys.admin, '', 'X'), /projet à renommer/);
    assert.throws(() => ctx.api_renameProject(keys.admin, 'Boreal', '  '), /nouveau nom/);
    // A hand-written PROJET rule follows the project.
    const snap = JSON.parse(ctx.Repo.snapshot());
    snap.rules.push({ priority: 1, criterion: 'PROJET', value: 'boreal', blocks: 'B3', comment: '' });
    ctx.Repo.restore(snap);
    const r = plain(ctx.api_renameProject(keys.admin, 'BOREAL', 'atlas NORD'));
    assert.equal(r.merged, true);
    assert.equal(r.project, 'Atlas Nord', 'spelling of the existing project');
    assert.equal(r.renamed, 1);
    assert.equal(r.rules, 1);
    assert.match(r.message, /^Projet « BOREAL » fusionné dans « Atlas Nord » : 1 référence\. Au /);
    const db = ctx.Repo.dump();
    assert.deepEqual(db.projects, [
      { project: 'Atlas Nord', blocks: 'B1, B7, B2, B8', color: '#abcdef', comment: 'Ligne 1' },
      { project: 'Delta', blocks: '', color: '', comment: '' }
    ]);
    assert.equal(db.articles.find((x) => x.article === 'LB73297').project, 'Atlas Nord');
    assert.equal(db.rules.find((x) => x.criterion === 'PROJET').value, 'Atlas Nord');
    const st = plain(ctx.api_getState());
    assert.equal(st.blocks.find((b) => b.id === 'B8').title, 'Atlas Nord');
    // Plain rename, then a new spelling of the same name.
    const r2 = plain(ctx.api_renameProject(keys.admin, 'delta', 'Delta Sud'));
    assert.deepEqual([r2.merged, r2.project, r2.renamed], [false, 'Delta Sud', 1]);
    const r3 = plain(ctx.api_renameProject(keys.admin, 'delta sud', 'DELTA SUD'));
    assert.deepEqual([r3.project, r3.renamed], ['DELTA SUD', 1]);
    assert.deepEqual(ctx.Repo.dump().projects.map((p) => p.project), ['Atlas Nord', 'DELTA SUD']);
    assert.equal(ctx.Repo.dump().articles.find((x) => x.article === 'ZZ99999').project, 'DELTA SUD');
  });

  await t.test('the recalculation after a save moves the pallets of the references into the blocks of their project', () => {
    const contents = (st, id) => (st.blockContents[id] || []).map((x) => [x.article, x.project]);
    let st = plain(ctx.api_getState());
    // The hand-written PROJET rule renamed above (priority 1, B3) wins over the PROJETS blocks (priority 5): every
    // Atlas Nord reference is placed in B3 only (SPEC_V2 4.7, first matching rule).
    assert.deepEqual(st.projectsList.find((p) => p.project === 'Atlas Nord').blocks, ['B3', 'B1', 'B7', 'B2', 'B8']);
    assert.ok(contents(st, 'B3').some(([a, p]) => a === 'LF23855' && p === 'Atlas Nord'));
    assert.ok(['B1', 'B7', 'B2', 'B8'].every((id) => !contents(st, id).length));
    // The rule removed by hand, then « Recalculer »: the PROJETS blocks apply.
    const snap = JSON.parse(ctx.Repo.snapshot());
    snap.rules = [];
    ctx.Repo.restore(snap);
    ctx.api_recompute(keys.admin);
    st = plain(ctx.api_getState());
    const atlas = st.projectsList.find((p) => p.project === 'Atlas Nord').blocks;
    assert.deepEqual(atlas, ['B1', 'B7', 'B2', 'B8']);
    assert.ok(atlas.some((id) => contents(st, id).some(([a, p]) => a === 'LF23855' && p === 'Atlas Nord')), 'Atlas Nord references in its blocks');
    assert.ok(atlas.every((id) => contents(st, id).every(([, p]) => p === 'Atlas Nord')), 'its blocks hold Atlas Nord only');
    assert.equal(st.blocks.find((b) => b.id === 'B3').title, 'Libre');
    // A project without blocks: its references share the free blocks (or À PLACER when they are full).
    const r = plain(ctx.api_saveReferences(keys.admin, [{ article: 'lf23857', project: 'delta sud' }]));
    assert.deepEqual([r.created, r.newProjects], [1, []]);
    st = plain(ctx.api_getState());
    assert.deepEqual(st.blocks.filter((b) => !b.projects.length).map((b) => b.id), ['B3', 'B4', 'B5', 'B6']);
    assert.ok(!atlas.some((id) => contents(st, id).some(([a]) => a === 'LF23857')), 'never in the blocks of another project');
    // Blocks given to that project: the block title and its contents follow.
    const rows = plain(ctx.api_getProjects()).projects.map((p) => (p.project === 'DELTA SUD' ? Object.assign(p, { blocks: ['B4'] }) : p));
    ctx.api_saveProjects(keys.admin, rows);
    st = plain(ctx.api_getState());
    assert.equal(st.blocks.find((b) => b.id === 'B4').title, 'DELTA SUD');
    assert.ok(contents(st, 'B4').length > 0 && contents(st, 'B4').every(([, p]) => p === 'DELTA SUD'), 'B4 holds DELTA SUD only');
    assert.ok(contents(st, 'B4').some(([a]) => a === 'LF23857'));
    assert.equal(st.projectsList.find((p) => p.project === 'DELTA SUD').blocks.join(), 'B4');
    // A block may belong to several projects (SPEC_V2 5.2): both names on it.
    const shared = plain(ctx.api_getProjects()).projects.map((p) => (p.project === 'Atlas Nord' ? Object.assign(p, { blocks: p.blocks.concat(['B4']) }) : p));
    assert.equal(plain(ctx.api_saveProjects(keys.admin, shared)).saved, 2);
    st = plain(ctx.api_getState());
    const b4 = st.blocks.find((b) => b.id === 'B4');
    assert.deepEqual(b4.projects.slice().sort(), ['Atlas Nord', 'DELTA SUD']);
    assert.equal(b4.title, b4.projects.join(' / '));
  });
});

test('v2 in-memory repo: a v1 store (old harness snapshot) is migrated like the sheet', { skip: CORE_READY ? false : 'core modules absent' }, () => {
  const ctx = makeContext({ sim: 'fixture', repo: 'memory' });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  ctx.api_simulate(keys.admin, { days: 14, seed: 2026 });
  // v1 shape: no projects, no v2 settings, no schema version, movements and articles without the v2 fields.
  const v1 = JSON.parse(ctx.Repo.snapshot());
  delete v1.projects;
  delete v1.tabs.PROJETS;
  v1.settings = v1.settings.filter((x) => !['pendingHoursWarn', 'pendingHoursCrit', 'labelIsPallet', 'importTrackedOnly', 'trackAll'].includes(x.key));
  delete v1.props.SCHEMA_VERSION;
  v1.movements.forEach((m) => { ['ts', 'label', 'headerText', 'itemText', 'reference', 'client', 'salesOrder'].forEach((k) => delete m[k]); });
  v1.articles.forEach((a) => delete a.project);
  ctx.Repo.restore(v1);
  const before = plain(ctx.api_getState());
  const m = plain(ctx.Repo.migrate());
  assert.deepEqual(m.settings, ['pendingHoursWarn', 'pendingHoursCrit', 'labelIsPallet', 'importTrackedOnly', 'trackAll']);
  assert.deepEqual(m.changed, ['PROJETS', 'PARAM_SEUILS']);
  assert.deepEqual(plain(ctx.Repo.migrate()), { version: 2, changed: [], settings: [] }, 'idempotent');
  const input = plain(ctx.Repo.readInput());
  assert.deepEqual(input.projects, []);
  assert.ok(input.movements.every((x) => x.ts === '' && x.label === ''));
  assert.ok(input.articles.every((x) => x.project === ''));
  ctx.api_recompute(keys.admin);
  const after = plain(ctx.api_getState());
  for (const k of ['kpi', 'blocks', 'pending', 'daily']) assert.deepEqual(after[k], before[k], 'same ' + k + ' after the migration');
  assert.ok(plain(ctx.api_saveReferences(keys.admin, [{ article: '1000914295', project: 'Atlas' }])).ok);
});

// The 5 rows a v1 setup wrote in REGLES_PLACEMENT (the migration never deletes them).
const V1_PLACEHOLDER_RULES = [['F1', 'B1, B7'], ['F2', 'B2, B8'], ['F3', 'B3, B5'], ['F4', 'B4'], ['F5', 'B6']]
  .map(([value, blocks]) => ({ priority: 10, criterion: 'FAMILLE', value, blocks, comment: 'provisoire' }));

test('v2: the v1 placeholder rules (F1-F5, provisoire) kept by the migration do not hold the blocks of real data', { skip: CORE_READY && FIXTURE_READY ? false : 'core modules or fixture absent' }, async (t) => {
  const ctx = makeContext({ sim: 'none', repo: 'memory' });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  importBatches(ctx, keys.admin, fixtureBatch(ctx).lines, { importId: 'IMP-V1R', fileName: 'MB51.xlsx' });
  const clean = plain(ctx.api_getState());
  assert.equal(clean.kpi.toPlacePallets, 0, 'no rule: the articles spread over the free blocks');

  await t.test('no article of family F1-F5: the placeholders are left out, the rows stay in the sheet', () => {
    const db = JSON.parse(ctx.Repo.snapshot());
    db.rules = JSON.parse(JSON.stringify(V1_PLACEHOLDER_RULES));
    ctx.Repo.restore(db);
    ctx.api_recompute(keys.admin);
    const s = plain(ctx.api_getState());
    assert.deepEqual(s.blocks.map((b) => [b.id, b.title, b.pallets]), clean.blocks.map((b) => [b.id, b.title, b.pallets]));
    assert.ok(s.blocks.every((b) => b.title === 'Libre'), 'no « Famille F1 » title');
    assert.equal(s.kpi.toPlacePallets, 0);
    assert.equal(ctx.Repo.dump().rules.length, 5, 'rows kept');
    assert.deepEqual(plain(ctx.Repo.readInput()).rules, []);
  });

  await t.test('an article of family F1 keeps the F1 placeholder; a user FAMILLE rule always counts', () => {
    const db = JSON.parse(ctx.Repo.snapshot());
    const art = db.articles.length ? db.articles[0] : null;
    assert.equal(art, null, 'the import wrote no ARTICLES row');
    db.articles = [{ article: 'LB73297', designation: '', uqs: '', qpp: null, palletType: '', heightCm: null, levels: null, family: 'f1', project: '' }];
    db.rules = JSON.parse(JSON.stringify(V1_PLACEHOLDER_RULES)).concat([{ priority: 1, criterion: 'FAMILLE', value: 'F4', blocks: 'B4', comment: '' }]);
    ctx.Repo.restore(db);
    const rules = plain(ctx.Repo.readInput()).rules;
    assert.deepEqual(rules.map((r) => r.value + ':' + (r.comment || '')), ['F1:provisoire', 'F4:']);
    ctx.api_recompute(keys.admin);
    const s = plain(ctx.api_getState());
    assert.equal(s.blocks.find((b) => b.id === 'B1').title, 'Famille F1');
    assert.equal(s.blocks.find((b) => b.id === 'B4').title, 'Famille F4');
    assert.equal(s.blocks.find((b) => b.id === 'B3').title, 'Libre');
  });

  await t.test('same rule on the Google Sheet (Repo.gs)', () => {
    const g = makeGoogle();
    const sheet = makeContext({ sim: 'none', repo: 'sheets', globals: g.globals });
    sheet.Repo.setup();
    const T = plain(sheet.CFG.TABS);
    const rows = V1_PLACEHOLDER_RULES.map((r) => [r.priority, r.criterion, r.value, r.blocks, r.comment]);
    g.ss.getSheetByName(T.RULES).getRange(2, 1, rows.length, 5).setValues(rows);
    assert.deepEqual(plain(sheet.Repo.readInput()).rules, []);
    g.ss.getSheetByName(T.RULES).getRange(3, 5, 1, 1).setValues([['mes familles']]);
    assert.deepEqual(plain(sheet.Repo.readInput()).rules.map((r) => r.value), ['F2'], 'a row the user re-labelled counts');
  });
});

test('v2 simulation ownership of ARTICLES and PROJETS', { skip: CORE_READY && has('Simulation') ? false : 'Simulation.gs absent' }, async (t) => {
  const ctx = makeContext({ sim: 'real', repo: 'memory' });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  const params = { days: 2, endDate: '2026-10-03', seed: 7, palletsPerDay: 60 };
  let simArticle = null;

  await t.test('the user rows written before a simulation survive it and its clearing', () => {
    ctx.api_saveProjects(keys.admin, [{ project: 'REEL A', blocks: ['B3'] }]);
    ctx.api_saveReferences(keys.admin, [{ article: 'USER001', project: 'REEL A' }]);
    ctx.api_simulate(keys.admin, params);
    let db = ctx.Repo.dump();
    assert.deepEqual(db.projects.map((p) => p.project), ['REEL A', 'ATLAS', 'BOREAL', 'CORSO', 'DELTA', 'ETNA', 'FJORD']);
    assert.ok(db.articles.some((a) => a.article === 'USER001'));
    const cleared = plain(ctx.runClearSimulation_());
    assert.equal(cleared.cleared.projects, 6);
    db = ctx.Repo.dump();
    assert.deepEqual(db.projects, [{ project: 'REEL A', blocks: 'B3', color: '', comment: '' }]);
    assert.deepEqual(db.articles.map((a) => a.article), ['USER001']);
    assert.equal(ctx.Repo.getProp('PROJECTS_SOURCE'), null);
  });

  await t.test('simulation, then a save from the projects panel, then clearing keeps the user-owned rows and PROJETS', () => {
    ctx.api_simulate(keys.admin, params);
    let db = ctx.Repo.dump();
    simArticle = db.articles.find((a) => a.project === 'ATLAS').article;
    const other = db.articles.find((a) => a.project === 'BOREAL').article;
    assert.equal(ctx.Repo.getProp('PROJECTS_SOURCE'), 'SIMULATION');
    const r = plain(ctx.api_saveReferences(keys.admin, [{ article: simArticle.toLowerCase(), project: 'Mon projet' }]));
    assert.deepEqual([r.updated, r.created], [1, 0]);
    assert.equal(ctx.Repo.getProp('PROJECTS_SOURCE'), null, 'the user owns PROJETS now');
    assert.ok(!ctx.Repo.getProp('SIM_ARTICLES').includes(simArticle), 'the user owns this ARTICLES row now');
    ctx.runClearSimulation_();
    db = ctx.Repo.dump();
    assert.deepEqual(db.articles.map((a) => a.article).sort(), ['USER001', simArticle].sort());
    assert.ok(!db.articles.some((a) => a.article === other), 'other simulated articles removed');
    assert.deepEqual(db.projects.map((p) => p.project), ['REEL A', 'ATLAS', 'BOREAL', 'CORSO', 'DELTA', 'ETNA', 'FJORD', 'Mon projet']);
    assert.equal(db.movements.length, 0);
  });

  await t.test('a new simulation replaces its own projects and articles, not the user ones', () => {
    ctx.api_simulate(keys.admin, params);
    const names = ctx.Repo.dump().projects.map((p) => p.project);
    assert.equal(names.length, 8, 'same names replaced in place, no duplicate');
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
    // Same seed: the simulator generates the article the user moved to « Mon projet » again; the user's row wins.
    let rows = ctx.Repo.dump().articles.filter((a) => a.article === simArticle);
    assert.deepEqual(rows.map((a) => a.project), ['Mon projet'], 'one row, the user one');
    assert.ok(!ctx.Repo.getProp('SIM_ARTICLES').includes(simArticle), 'still owned by the user');
    assert.ok(plain(ctx.api_getState()).articles.some((a) => a.a === simArticle && a.p === 'Mon projet'));
    ctx.runClearSimulation_();
    assert.deepEqual(ctx.Repo.dump().projects.map((p) => p.project), ['REEL A', 'Mon projet']);
    rows = ctx.Repo.dump().articles.filter((a) => a.article === simArticle);
    assert.deepEqual(rows.map((a) => a.project), ['Mon projet'], 'kept by the clearing');
  });
});

test('v2 on fake Google services: migration of a v1 sheet, label-aware writes, real lines, projects panel', { skip: SHEETS_READY && FIXTURE_READY ? false : 'Repo.gs / Main.gs / fixture absent' }, async (t) => {
  const g = makeGoogle();
  const ctxA = makeContext({ sim: 'fixture', repo: 'sheets', main: true, globals: g.globals });
  const { CFG } = ctxA;
  const T = plain(CFG.TABS), H = plain(CFG.HEADERS);
  const sh = (name) => g.ss.getSheetByName(name);
  const table = (name) => plain(sheetTable(sh(name)));
  ctxA.Repo.setup();
  const keys = plain(ctxA.Repo.getKeys());
  ctxA.api_simulate(keys.admin, { days: 14, seed: 2026 });
  const batch = fixtureBatch(ctxA);
  const V2_SETTINGS = ['pendingHoursWarn', 'pendingHoursCrit', 'labelIsPallet', 'importTrackedOnly', 'trackAll'];

  // Back to the shape of a sheet installed with v1: no v2 column, a column added by hand after the v1 ones,
  // no PROJETS tab, no v2 PARAM_SEUILS row, no SCHEMA_VERSION.
  function downgrade() {
    const handColumn = (name, at, label) => {
      const s0 = sh(name);
      s0.insertColumnsAfter(at - 1, 1);
      const n = Math.max(s0.getLastRow(), 1);
      s0.getRange(1, at, n, 1).setValues(Array.from({ length: n }, (x, i) => [i === 0 ? label : 'n' + i]));
    };
    sh(T.MOVEMENTS).deleteColumns(18, H.MOUVEMENTS.length - 17);
    handColumn(T.MOVEMENTS, 18, 'Note');
    sh(T.ARTICLES).deleteColumns(9, 1);
    handColumn(T.ARTICLES, 9, 'Note atelier');
    sh(T.CALC_STOCK).deleteColumns(11, 2);
    g.ss.deleteSheet(sh(T.PROJECTS));
    const st = sh(T.SETTINGS);
    const keysCol = st.getRange(1, 2, st.getLastRow(), 1).getValues().map((r) => r[0]);
    for (let i = keysCol.length - 1; i >= 1; i--) if (V2_SETTINGS.includes(keysCol[i])) st.deleteRows(i + 1, 1);
    g.propsStore.delete('SCHEMA_VERSION');
  }

  await t.test('the first write after the upgrade migrates the v1 sheet without moving data', () => {
    downgrade();
    const v1 = { mv: table(T.MOVEMENTS), art: table(T.ARTICLES), set: table(T.SETTINGS), stock: table(T.CALC_STOCK) };
    assert.equal(v1.mv.header.length, 18);
    assert.ok(!v1.set.rows.some((r) => V2_SETTINGS.includes(r[1])));
    g.ss.setActiveSheet(sh(T.LAYOUT));
    // New execution with the v2 code: an import batch (not final) is the first write.
    const ctxB = makeContext({ sim: 'fixture', repo: 'sheets', main: true, globals: g.globals });
    const lines = batch.lines.slice(0, 50);
    const res = plain(ctxB.api_importLines(keys.admin, { importId: 'IMP-MIG', fileName: 'MB51.xlsx', final: false }, lines));
    assert.equal(res.added, 50);
    assert.equal(g.propsStore.get('SCHEMA_VERSION'), '2');
    // MOUVEMENTS: v2 headers after the hand column, old cells untouched, new columns as text.
    const mv = table(T.MOVEMENTS);
    assert.deepEqual(mv.header, H.MOUVEMENTS.slice(0, 17).concat(['Note'], H.MOUVEMENTS.slice(17)));
    v1.mv.rows.forEach((r, i) => assert.deepEqual(mv.rows[i].slice(0, 18), r, 'row ' + (i + 2) + ' untouched'));
    assert.ok(mv.rows.slice(0, v1.mv.rows.length).every((r) => r.slice(18).every((c) => c === '')), 'old rows: v2 cells empty');
    for (let c = 18; c < 25; c++) assert.equal(sh(T.MOVEMENTS).fmt(1, c), '@', mv.header[c] + ' as text');
    // The appended lines: each value under its own header (the hand column stays empty).
    const col = (label) => mv.header.indexOf(label);
    const added = mv.rows.slice(v1.mv.rows.length);
    assert.equal(added.length, 50);
    added.forEach((r, i) => {
      assert.equal(r[col('Clé')], lines[i].key);
      assert.equal(r[col('Note')], '');
      assert.equal(r[col('Saisie le')], lines[i].ts, 'entry time stored as text');
      assert.equal(r[col('Étiquette')], lines[i].label, 'label stored as text');
      assert.equal(r[col('Source')], 'IMPORT');
    });
    assert.ok(added.some((r) => r[col('Étiquette')] !== ''), 'some labels');
    // ARTICLES: Projet appended after the hand column; CALC_STOCK: v2 headers appended.
    assert.deepEqual(table(T.ARTICLES).header, H.ARTICLES.slice(0, 8).concat(['Note atelier', 'Projet']));
    assert.deepEqual(table(T.ARTICLES).rows.map((r) => r.slice(0, 9)), v1.art.rows);
    assert.deepEqual(table(T.CALC_STOCK).header, H.CALC_STOCK);
    assert.deepEqual(table(T.CALC_STOCK).rows.map((r) => r.slice(0, 10)), v1.stock.rows);
    // PROJETS created after ARTICLES, empty and formatted; the person keeps the tab they were on.
    const names = g.ss.getSheets().map((x) => x.name);
    assert.equal(names.indexOf(T.PROJECTS), names.indexOf(T.ARTICLES) + 1);
    assert.deepEqual(table(T.PROJECTS), { header: H.PROJETS, rows: [] });
    assert.equal(sh(T.PROJECTS).fmt(3, 1), '@');
    assert.equal(g.ss.getActiveSheet().name, T.LAYOUT, 'active tab restored');
    // PARAM_SEUILS: the v1 rows as they were, the v2 keys added after them.
    const set = table(T.SETTINGS);
    assert.deepEqual(set.rows.slice(0, v1.set.rows.length), v1.set.rows);
    assert.deepEqual(set.rows.slice(v1.set.rows.length).map((r) => r[1]), V2_SETTINGS);
    assert.equal(set.rows.find((r) => r[1] === 'pendingHoursCrit')[2], 6);
  });

  await t.test('migration is idempotent and cheap once done', () => {
    const all = () => Object.fromEntries(g.ss.getSheets().filter((x) => !['_STATE', '_LOOKUP', T.HOME].includes(x.name))
      .map((x) => [x.name, table(x.name)]));
    const before = all();
    const ctxC = makeContext({ sim: 'fixture', repo: 'sheets', globals: g.globals });
    assert.deepEqual(plain(ctxC.Repo.migrate(true)), { version: 2, changed: [], settings: [] });
    const reads = Object.assign({}, g.calls.getValues);
    const ctxD = makeContext({ sim: 'fixture', repo: 'sheets', globals: g.globals });
    assert.deepEqual(plain(ctxD.Repo.migrate()), { version: 2, changed: [], settings: [] });
    assert.deepEqual(g.calls.getValues, reads, 'no cell read once SCHEMA_VERSION is 2');
    assert.deepEqual(all(), before, 'nothing changed');
  });

  await t.test('references and projects on the migrated sheet: values under their headers', () => {
    const ctx = makeContext({ sim: 'fixture', repo: 'sheets', main: true, globals: g.globals });
    ctx.api_importLines(keys.admin, { importId: 'IMP-MIG', fileName: 'MB51.xlsx', final: true }, []);
    const art0 = table(T.ARTICLES);
    const target = art0.rows[3][0];
    const r = plain(ctx.api_saveReferences(keys.admin, [{ article: target, project: 'Atlas' }, { article: 'NEW001', project: 'atlas' }]));
    assert.deepEqual([r.created, r.updated], [1, 1]);
    const art = table(T.ARTICLES);
    const pc = art.header.indexOf('Projet');
    assert.equal(pc, 9);
    assert.equal(art.rows[3][pc], 'Atlas');
    assert.deepEqual(art.rows.slice(0, art0.rows.length).map((row) => row[8]), art0.rows.map((row) => row[8]), 'hand column untouched');
    const fresh = art.rows[art.rows.length - 1];
    assert.deepEqual([fresh[0], fresh[8], fresh[pc]], ['NEW001', '', 'Atlas']);
    assert.deepEqual(table(T.PROJECTS).rows, [['Atlas', '', '', '']]);
    const p = plain(ctx.api_saveProjects(keys.admin, [{ project: 'Atlas', blocks: ['B1', 'B7'], color: '#112233' }]));
    assert.equal(p.saved, 1);
    assert.deepEqual(table(T.PROJECTS).rows, [['Atlas', 'B1, B7', '#112233', '']]);
    const st = plain(ctx.api_getState());
    assert.equal(st.blocks.find((b) => b.id === 'B7').title, 'Atlas');
    const gp = plain(ctx.api_getProjects());
    assert.deepEqual(gp.projects, [{ project: 'Atlas', blocks: ['B1', 'B7'], color: '#112233', comment: '', listed: true }]);
    assert.ok(gp.references.some((x) => x.article === 'NEW001' && x.project === 'Atlas'));
    // A rename writes the Projet column only.
    const rn = plain(ctx.api_renameProject(keys.admin, 'atlas', 'Atlas Nord'));
    assert.equal(rn.renamed, 2);
    assert.equal(table(T.ARTICLES).rows[3][pc], 'Atlas Nord');
    assert.deepEqual(table(T.PROJECTS).rows, [['Atlas Nord', 'B1, B7', '#112233', '']]);
  });

  await t.test('the real lines on the sheet give the same state as the in-memory repo', () => {
    const g2 = makeGoogle();
    const sheet = makeContext({ sim: 'none', repo: 'sheets', main: true, globals: g2.globals });
    sheet.Repo.setup();
    const k2 = plain(sheet.Repo.getKeys());
    importBatches(sheet, k2.admin, batch.lines, { importId: 'IMP-S', fileName: 'MB51.xlsx' });
    const mem = makeContext({ sim: 'none', repo: 'memory' });
    mem.Repo.setup();
    importBatches(mem, plain(mem.Repo.getKeys()).admin, batch.lines, { importId: 'IMP-S', fileName: 'MB51.xlsx' });
    const a = plain(sheet.api_getState()), b = plain(mem.api_getState());
    for (const k of ['asOf', 'asOfTs', 'kpi', 'blocks', 'pending', 'pendingTotal', 'daily', 'alerts', 'articles', 'projectsList']) {
      assert.deepEqual(a[k], b[k], 'same ' + k + ' with both repos');
    }
    // The MOUVEMENTS text columns read back exactly (no time-zone shift, no number conversion).
    const input = plain(sheet.Repo.readInput());
    const byKey = new Map(input.movements.map((m) => [m.key, m]));
    for (const l of batch.lines) {
      const m = byKey.get(l.key);
      assert.equal(m.ts, l.ts);
      assert.equal(m.label, l.label);
      assert.equal(m.headerText, l.headerText);
    }
    const mv = g2.ss.getSheetByName(T.MOVEMENTS);
    const header = sheetTable(mv).header;
    assert.equal(typeof mv.get(1, header.indexOf('Saisie le')), 'string');
    assert.equal(typeof mv.get(1, header.indexOf('Étiquette')), 'string');
    // CALC_EN_ATTENTE: the level in French.
    const pending = sheetTable(g2.ss.getSheetByName(T.CALC_PENDING));
    const lv = pending.header.indexOf('Niveau');
    assert.ok(pending.rows.some((r) => r[lv] === 'alerte'));

    // ACCUEIL and the control panel show « PRD2 > 6 h : n » and the time of the data.
    const home = sheet.homeStatus_().map((v) => v.text);
    const crit = a.kpi.pendingCrit;
    assert.equal(home[1], '05.10.2026 22:09');
    assert.match(home[7], new RegExp('^145 palettes · PRD2 > 6 h : ' + crit + ' \\(plus ancienne : 44 h 02\\)$'));
    const status = plain(sheet.sidebar_status());
    assert.equal(status.state.pendingCrit, crit);
    assert.equal(status.state.pendingHoursCrit, 6);
    assert.equal(status.state.asOfTs, '2026-10-05 22:09:10');
    assert.equal(status.defaults.days, 7);
    assert.deepEqual(status.limits, { days: [1, 60], palletsPerDay: [20, 1500] });

    // Projects panel (editors, no key).
    sheet.ouvrirProjets();
    assert.equal(g2.ui.sidebar.name, 'SidebarProjets');
    const d0 = plain(sheet.sidebar_getProjects());
    assert.equal(d0.installed, true);
    assert.ok(d0.articles.length >= 93 && d0.articles.every((x) => 'designation' in x && 'exp2' in x));
    assert.match(d0.link, /\?page=projects$/);
    const s1 = plain(sheet.sidebar_saveReferences([{ article: 'LB73297', project: 'Panneau' }]));
    assert.match(s1.message, /^Références enregistrées : 1 nouvelle/);
    assert.ok(s1.data.references.some((x) => x.article === 'LB73297' && x.project === 'Panneau'));
    assert.match(g2.ss.toasts[g2.ss.toasts.length - 1], /Références enregistrées/);
    const s2 = plain(sheet.sidebar_saveProjects([{ project: 'Panneau', blocks: ['B4'] }]));
    assert.deepEqual(s2.data.projects, [{ project: 'Panneau', blocks: ['B4'], color: '', comment: '', listed: true }]);
    assert.ok(s2.data.colors.Panneau, 'automatic color from the state');
    assert.throws(() => sheet.sidebar_saveProjects([{ project: 'Panneau', blocks: ['B42'] }]), /bloc inconnu/);
  });

  await t.test('a simulated article moved to a project stays the user one on the sheet (new simulation, clearing)', () => {
    const g3 = makeGoogle();
    const c = makeContext({ sim: 'fixture', repo: 'sheets', main: true, globals: g3.globals });
    c.Repo.setup();
    const k3 = plain(c.Repo.getKeys());
    c.api_simulate(k3.admin, { days: 14, seed: 2026 });
    const pc = H.ARTICLES.indexOf('Projet');
    const art0 = plain(sheetTable(g3.ss.getSheetByName(T.ARTICLES)));
    const code = art0.rows[2][0];
    c.api_saveReferences(k3.admin, [{ article: code, project: 'Mon projet' }]);
    c.api_simulate(k3.admin, { days: 14, seed: 2026 });
    let rows = plain(sheetTable(g3.ss.getSheetByName(T.ARTICLES)).rows);
    assert.equal(rows.length, art0.rows.length, 'no second row for the generated code');
    assert.deepEqual(rows.filter((r) => r[0] === code).map((r) => r[pc]), ['Mon projet']);
    assert.ok(!JSON.parse(g3.propsStore.get('P_SIM_ARTICLES')).includes(code), 'not given back to the simulation');
    c.runClearSimulation_();
    rows = plain(sheetTable(g3.ss.getSheetByName(T.ARTICLES)).rows);
    assert.deepEqual(rows.map((r) => [r[0], r[pc]]), [[code, 'Mon projet']], 'kept by the clearing, the simulated rows removed');
  });
});

// The sheet panel SidebarProjets.html run against the in-memory server: a tiny DOM (ids, values, innerHTML text,
// listeners) and a synchronous google.script.run that calls the Main.gs functions.
function panelPage(ctx) {
  const html = fs.readFileSync(path.join(SRC, 'SidebarProjets.html'), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const els = {};
  const el = (id) => {
    if (!els[id]) {
      const listeners = {};
      const attrs = {};
      els[id] = {
        id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, listeners,
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
        fire(type, target) { (listeners[type] || []).forEach((fn) => fn({ target: target || els[id], preventDefault() {} })); }
      };
    }
    return els[id];
  };
  for (const m of html.matchAll(/id="([A-Za-z]+)"/g)) el(m[1]);
  const calls = [];
  function Runner(ok, ko) { this.ok = ok; this.ko = ko; }
  Runner.prototype.withSuccessHandler = function (fn) { return new Runner(fn, this.ko); };
  Runner.prototype.withFailureHandler = function (fn) { return new Runner(this.ok, fn); };
  for (const name of ['sidebar_getProjects', 'sidebar_saveReferences', 'sidebar_saveProjects', 'ouvrirPanneau']) {
    Runner.prototype[name] = function (...args) {
      calls.push(name);
      let out;
      try {
        out = plain(ctx[name](...plain(args)));
      } catch (e) {
        this.ko(new Error(e.message));
        return;
      }
      this.ok(out);
    };
  }
  const page = vm.createContext({ console, document: { getElementById: el }, google: { script: { run: new Runner() } } });
  vm.runInContext(script, page);
  return { el, calls, click: (id) => el(id).fire('click') };
}

test('projects panel (SidebarProjets.html) on the in-memory server: paste, preview, save, blocks', { skip: CORE_READY && has('Main') && FIXTURE_READY ? false : 'Main.gs / fixture absent' }, () => {
  const SpreadsheetApp = { getUi: () => ({ showSidebar() {} }), getActiveSpreadsheet: () => ({ toast() {} }) };
  const HtmlService = { createHtmlOutputFromFile: () => ({ setTitle() { return this; } }) };
  const ctx = makeContext({ sim: 'none', repo: 'memory', main: true, globals: { SpreadsheetApp, HtmlService } });
  ctx.Repo.setup();
  const keys = plain(ctx.Repo.getKeys());
  importBatches(ctx, keys.admin, fixtureBatch(ctx).lines, { importId: 'IMP-PANEL', fileName: 'MB51.xlsx' });
  ctx.api_saveReferences(keys.admin, [{ article: 'LF23857', project: 'ATLAS' }]);

  const page = panelPage(ctx);
  const { el } = page;
  assert.equal(page.calls[0], 'sidebar_getProjects');
  assert.equal(el('projCount').textContent, '1');
  assert.match(el('projectList').innerHTML, /<option value="ATLAS">/);
  assert.match(el('projects').innerHTML, /data-b="B1" aria-pressed="false"/);
  assert.match(el('link').textContent, /Application Web non déployée|Déployer/);

  // Two columns from Excel (header line skipped, a row without reference ignored), then one reference per line with
  // the project field.
  el('paste').value = 'Référence\tProjet\nlf23855\tatlas\n0073871645\tBOREAL\n\tORPHAN\nLF23857\tATLAS\nbad code!\tX\nLD31553\t';
  el('project').value = 'Delta';
  page.click('btnPreview');
  let pv = el('preview').innerHTML;
  const des = (a) => plain(ctx.api_getState()).articles.find((x) => x.a === a).d;
  assert.match(pv, /3 nouvelles<\/b> · 0 changement · 1 inchangée · .*1 invalide/);
  assert.doesNotMatch(pv, /ORPHAN/, 'the project of a row without reference is not a reference');
  assert.ok(pv.includes('LF23855</span><span class="st st-new">Nouvelle</span></div><span class="des">' + des('LF23855') + '</span><div><b>ATLAS</b>'),
    'designation from the state, spelling of the existing project');
  assert.match(pv, /73871645<\/span><span class="st st-new">Nouvelle/);
  assert.match(pv, /LF23857<\/span><span class="st st-same">Inchangée/);
  assert.match(pv, /LD31553<\/span><span class="st st-new">Nouvelle.*<b>Delta<\/b>/);
  assert.match(pv, /bad code!<\/span><span class="st st-bad">Invalide<\/span><\/div><span class="des">Référence invalide/);
  // One reference per line: the project field; never-seen references flagged. Two codes on one line are refused with
  // the reason, as on the web page « Projets » (« LF23855 ATLAS » must never create a reference named ATLAS).
  el('paste').value = 'ZZ00001\nZZ00002 ZZ00003\nLB73297';
  el('project').value = 'Delta';
  page.click('btnPreview');
  pv = el('preview').innerHTML;
  assert.match(pv, /2 nouvelles<\/b> · 0 changement · 0 inchangée · .*1 invalide/);
  assert.match(pv, /ZZ00001<\/span><span class="st st-new">Nouvelle<\/span><\/div><span class="des">jamais vue dans les données/);
  assert.match(pv, /ZZ00002 ZZ00003<\/span><span class="st st-bad">Invalide<\/span><\/div><span class="des">Espace dans la référence/);
  assert.doesNotMatch(pv, /ZZ00003<\/span><span class="st st-new"/, 'no reference made of the second word');
  el('paste').value = 'Référence\tProjet\nlf23855\tatlas\n0073871645\tBOREAL\nLF23857\tATLAS\nbad code!\tX\nLD31553\t';
  page.click('btnPreview');
  assert.equal(el('btnSave').disabled, false);
  assert.match(el('btnSave').textContent, /^Enregistrer \(\d\)$/);
  page.click('btnSave');
  assert.ok(page.calls.includes('sidebar_saveReferences'));
  assert.match(el('msg').textContent, /^Références enregistrées : /);
  assert.equal(el('msg').className, 'msg ok');
  assert.equal(el('paste').value, '');
  const db = ctx.Repo.dump();
  const art = (a) => db.articles.find((x) => x.article === a);
  assert.equal(art('LF23855').project, 'ATLAS');
  assert.equal(art('73871645').project, 'BOREAL');
  assert.equal(art('LD31553').project, 'Delta', 'empty second column: the project field');
  assert.deepEqual(db.projects.map((x) => x.project), ['ATLAS', 'BOREAL', 'Delta']);
  assert.equal(el('projCount').textContent, '3', 'panel refreshed from the answer');

  // Blocks: toggle B1 and B7 for ATLAS, add a project, save the zones.
  const chip = (p, b) => ({ attrs: { 'data-p': String(p), 'data-b': b }, getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; } });
  assert.equal(el('btnZones').disabled, true);
  el('projects').fire('click', chip(0, 'B1'));
  el('projects').fire('click', chip(0, 'B7'));
  el('newProject').value = 'Etna';
  page.click('btnAdd');
  assert.equal(el('projCount').textContent, '4');
  el('newProject').value = 'sans projet';
  page.click('btnAdd');
  assert.match(el('msgZones').textContent, /Nom réservé/);
  assert.equal(el('btnZones').disabled, false);
  page.click('btnZones');
  assert.match(el('msgZones').textContent, /^Projets enregistrés : 4 projets\./);
  assert.deepEqual(ctx.Repo.dump().projects.map((x) => [x.project, x.blocks]), [['ATLAS', 'B1, B7'], ['BOREAL', ''], ['Delta', ''], ['Etna', '']]);
  assert.equal(plain(ctx.api_getState()).blocks.find((b) => b.id === 'B7').title, 'ATLAS');
  assert.match(el('projects').innerHTML, /data-p="0" data-b="B7" aria-pressed="true"/);

  // A server refusal (B7 removed from LAYOUT since the panel loaded) shows the French message; nothing written.
  el('projects').fire('click', chip(1, 'B2'));
  const snap = JSON.parse(ctx.Repo.snapshot());
  snap.layout.blocks = snap.layout.blocks.filter((b) => b.id !== 'B7');
  ctx.Repo.restore(snap);
  const before = ctx.Repo.dump().projects;
  page.click('btnZones');
  assert.equal(el('msgZones').className, 'msg err');
  assert.match(el('msgZones').textContent, /bloc inconnu pour « ATLAS » : « B7 »/);
  assert.deepEqual(ctx.Repo.dump().projects, before);
  assert.equal(el('btnZones').disabled, false, 'the changes can be fixed and saved again');
});

// ---------------------------------------------------------------------------------------------------------------
// 5. Apps Script safe syntax and file contracts
// ---------------------------------------------------------------------------------------------------------------
test('Repo.gs, Api.gs, Main.gs, Sidebar.html, SidebarProjets.html and the memory repo follow the Apps Script rules', () => {
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
  // Apps Script runs every .gs file in one global scope: a top-level name defined twice silently wins by file order.
  const seen = new Map();
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.gs'))) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of src.matchAll(/^(?:function|var)\s+([A-Za-z0-9_$]+)/gm)) {
      assert.ok(!seen.has(m[1]), m[1] + ' defined in ' + f + ' and ' + seen.get(m[1]));
      seen.set(m[1], f);
    }
  }
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
    for (const fn of ['sidebar_status', 'sidebar_simulate', 'sidebar_nextDay', 'sidebar_recompute', 'sidebar_links', 'sidebar_setWebAppUrl',
      'ouvrirProjets']) {
      assert.ok(html.includes("'" + fn + "'"), 'sidebar calls ' + fn);
    }
    assert.match(html, /lang="fr"/);
    assert.doesNotMatch(html, /14 jours|Jours ouvrés|max="500"/, 'v2 simulation defaults (7 days, 20-1,500 labels a day)');
  }
  // Projects panel (docs/SPEC_V2.md 5.3): same rules, its three server functions, no key, ES5 only.
  const projects = path.join(SRC, 'SidebarProjets.html');
  if (fs.existsSync(projects)) {
    const html = fs.readFileSync(projects, 'utf8');
    assert.doesNotMatch(html, /\b(alert|confirm|prompt)\s*\(/, 'no alert/confirm/prompt');
    assert.match(html, /withSuccessHandler/);
    assert.match(html, /withFailureHandler/);
    for (const fn of ['sidebar_getProjects', 'sidebar_saveReferences', 'sidebar_saveProjects']) {
      assert.ok(html.includes("'" + fn + "'"), 'panel calls ' + fn);
    }
    assert.match(html, /lang="fr"/);
    assert.match(html, /<datalist id="projectList">/);
    assert.match(html, /Aperçu/);
    assert.doesNotMatch(html, /api_|sessionStorage|localStorage/, 'no key and no web app API from the sheet panel');
    const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
    assert.doesNotMatch(script, /=>|\blet\b|\bconst\b|`|\?\.|\?\?/, 'ES5 like the rest of the app');
    new vm.Script(script, { filename: 'SidebarProjets.html' });
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
