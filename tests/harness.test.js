'use strict';
// Local harness without a browser: the page build (doGet + Index.html scriptlets, as Apps Script renders them) and
// the google.script.run shim (in-page server on the in-memory Repo, store shared between pages).
// The browser run of the same pages is tests/harness/e2e.js (npm run e2e).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { build, makeServer, compileTemplate } = require('./harness/build.js');

const SRC = path.join(__dirname, '..', 'apps-script', 'src');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exp2-harness-'));
let built = null;
function getBuild() {
  if (!built) built = build({ out: tmp });
  return built;
}
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('template compiler: <?= ?> escapes, <?!= ?> prints raw, <? ?> runs code', () => {
  const ctx = vm.createContext({});
  const fn = vm.runInContext(compileTemplate('<p class="<?= cls ?>"><?!= html ?><? for (var i = 0; i < 2; i++) { ?>[<?= i ?>]<? } ?></p>', 't'), ctx);
  const out = fn({ cls: 'a"<b', html: '<b>ok</b>' }, (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), String);
  assert.equal(out, '<p class="a&quot;&lt;b"><b>ok</b>[0][1]</p>');
});

test('build: one page per doGet mode, scriptlets resolved like Apps Script, CDN replaced', () => {
  const r = getBuild();
  const server = makeServer();
  assert.deepEqual(r.pages.map((p) => p.file), ['tv.html'].concat(server.WEB_PAGES_.map((p) => 'pc-' + p + '.html')));
  for (const p of r.pages) {
    const html = fs.readFileSync(path.join(tmp, p.file), 'utf8');
    assert.ok(!/<\?/.test(html), p.file + ': no scriptlet left');
    assert.ok(!/cdnjs\.cloudflare\.com|cdn\.sheetjs\.com/.test(html), p.file + ': no CDN URL');
    if (fs.existsSync(path.join(__dirname, 'harness', 'vendor', 'three.min.js'))) {
      assert.ok(html.includes('src="../vendor/three.min.js"'), p.file + ': local three.js');
    } else {
      assert.ok(!/three(\.min)?\.js"/.test(html), p.file + ': no three.js request without the local copy');
    }
    assert.ok(html.includes("'../vendor/xlsx.full.min.js'"), p.file + ': local SheetJS');
    assert.equal(p.title, server.CFG.APP_NAME);
    assert.equal(p.xframe, 'ALLOWALL');
    // moduleSource_() output is in the page exactly as Main.gs returns it.
    assert.ok(html.includes(server.moduleSource_('Config')), p.file + ': Config module');
    assert.ok(html.includes(server.moduleSource_('Normalize')), p.file + ': Normalize module');
    // The Simulation page writes a simulated MB51 file in the browser (Sim.mb51Rows).
    assert.ok(html.includes(server.moduleSource_('Simulation')), p.file + ': Simulation module');
    assert.ok(html.indexOf('<meta charset="utf-8">') < 400, p.file + ': charset first');
    assert.ok(html.indexOf('backend/shim.js') < html.indexOf('<style>'), p.file + ': server before the app');
    assert.ok(/window\.App\.start\(\);/.test(html), p.file + ': app started');
  }
  const tv = r.pages[0];
  assert.equal(tv.mode, 'tv');
  assert.equal(tv.page, '');
  r.pages.slice(1).forEach((p) => assert.equal(p.mode, 'pc'));
  for (const f of ['Config.js', 'Normalize.js', 'Engine.js', 'Simulation.js', 'repo-memory.js', 'Api.js', 'shim.js']) {
    assert.ok(fs.existsSync(path.join(tmp, 'backend', f)), 'backend/' + f);
  }
  assert.ok(fs.existsSync(path.join(tmp, 'index.html')));
});

test('CDN scripts carry Subresource Integrity; the three.js hash matches r128', () => {
  const crypto = require('crypto');
  const twin = fs.readFileSync(path.join(SRC, 'Twin3d.html'), 'utf8');
  const tag = /<script src="(https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r128\/three\.min\.js)"([^>]*)><\/script>/.exec(twin);
  assert.ok(tag, 'three.js r128 script tag');
  const sri = /integrity="(sha(?:256|384|512))-([A-Za-z0-9+/=]+)"/.exec(tag[2]);
  assert.ok(sri, 'integrity attribute');
  assert.match(tag[2], /crossorigin="anonymous"/);
  const local = path.join(__dirname, 'harness', 'vendor', 'three.min.js');
  if (fs.existsSync(local)) {
    const digest = crypto.createHash(sri[1]).update(fs.readFileSync(local)).digest('base64');
    assert.equal(digest, sri[2], 'vendor/three.min.js (npm three@0.128.0 = cdnjs r128) matches the integrity hash');
  }
  // SheetJS: loaded by App.loadScript with SHEETJS_SRI (integrity + crossOrigin when set).
  const pc = fs.readFileSync(path.join(SRC, 'PagesPc.html'), 'utf8');
  assert.match(pc, /App\.loadScript\(SHEETJS_URL, 'XLSX', \d+, SHEETJS_SRI\)/);
  const client = fs.readFileSync(path.join(SRC, 'Client.html'), 'utf8');
  assert.match(client, /s\.integrity = integrity;\s*s\.crossOrigin = 'anonymous';/);
});

test('integration: the doGet pages are exactly the PC pages of PagesPc.html', () => {
  const server = makeServer();
  const pc = fs.readFileSync(path.join(SRC, 'PagesPc.html'), 'utf8');
  const block = /var PAGES = \[([\s\S]*?)\];/.exec(pc)[1];
  const ids = Array.from(block.matchAll(/id: '([a-z]+)'/g)).map((m) => m[1]);
  assert.deepEqual(ids.slice().sort(), Array.from(server.WEB_PAGES_).sort());
  // Index.html: only the scriptlets of docs/ARCHITECTURE.md section 9.
  const index = fs.readFileSync(path.join(SRC, 'Index.html'), 'utf8');
  for (const m of index.matchAll(/<\?(!=|=)?\s*([\s\S]*?)\s*\?>/g)) {
    assert.match(m[2], /^(include_\('[A-Za-z0-9]+'\)|moduleSource_\('(Config|Normalize|Engine|Simulation)'\)|mode|page)$/, 'scriptlet ' + m[0]);
    if (/^include_/.test(m[2])) assert.ok(fs.existsSync(path.join(SRC, /'(.*)'/.exec(m[2])[1] + '.html')), m[2] + ' exists');
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The shim in a Node vm: a "page" = one context with the backend scripts and shim.js, pages share a localStorage.
// ---------------------------------------------------------------------------------------------------------------
function makeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    get length() { return data.size; }
  };
}

function openPage(storage, search) {
  const sb = {
    console, Math, Date, JSON, setTimeout, clearTimeout,
    localStorage: storage,
    location: { search: search || '', hash: '', pathname: '/out/tv.html', origin: 'http://127.0.0.1' },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {}
  };
  sb.window = sb;
  const ctx = vm.createContext(sb);
  for (const f of ['Config.js', 'Normalize.js', 'Engine.js', 'Simulation.js', 'repo-memory.js', 'Api.js', 'shim.js']) {
    vm.runInContext(fs.readFileSync(path.join(tmp, 'backend', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

function call(page, name, ...args) {
  return new Promise((resolve, reject) => {
    page.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args);
  });
}

test('shim: google.script.run on the seeded in-memory server, store shared between pages', async () => {
  getBuild();
  const storage = makeStorage();
  const tv = openPage(storage, '?lat=0&poll=2');
  assert.equal(tv.EXP2_HARNESS.pollMs, 2000);
  const keys = tv.__keys;
  assert.match(keys.admin, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(tv.__harness.functions.includes('api_getState') && tv.__harness.functions.includes('api_importLines'));
  assert.equal(typeof tv.google.script.run.doGet, 'undefined', 'only the api_* functions are exposed');

  const state = await call(tv, 'api_getState');
  assert.equal(state.source, 'SIMULATION');
  assert.ok(state.kpi.exp2Pallets > 500);
  const v0 = await call(tv, 'api_getVersion');

  // A second page restores the same store (same keys, same version) instead of seeding again.
  const pc = openPage(storage, '?lat=0');
  assert.deepEqual({ ...pc.__keys }, { ...keys });
  assert.deepEqual(await call(pc, 'api_getVersion'), v0);

  // Wrong key: failure handler with the server message; nothing written.
  await assert.rejects(call(pc, 'api_simulateNextDay', 'AAAA-BBBB-CCCC'), /Clé incorrecte/);
  // A write on the PC page reaches the TV page at its next call.
  const next = await call(pc, 'api_simulateNextDay', keys.admin);
  assert.ok(next.ok && next.day > state.asOf);
  const v1 = await call(tv, 'api_getVersion');
  assert.equal(v1.data, v0.data + 1);
  assert.equal((await call(tv, 'api_getState')).asOf, next.day);

  // withUserObject, and arguments copied at call time (JSON, like Apps Script).
  const got = await new Promise((resolve) => {
    const arg = 'zz';
    tv.google.script.run.withUserObject({ tag: 7 }).withSuccessHandler((res, user) => resolve({ res, user })).api_searchArticles(arg);
  });
  assert.deepEqual(got.user, { tag: 7 });
  assert.ok(Array.isArray(got.res));
});

test('shim: ?empty=1 is an installed base without data, ?none=1 a base not installed', async () => {
  getBuild();
  const storage = makeStorage();
  const empty = openPage(storage, '?lat=0&empty=1');
  const s = await call(empty, 'api_getState');
  assert.equal(s.stats.movements, 0);
  assert.equal(s.kpi.exp2Pallets, 0);
  assert.ok(empty.__keys.admin);
  const none = openPage(storage, '?lat=0&none=1');
  assert.equal(none.__keys.admin, '');
  await assert.rejects(call(none, 'api_getState'), /non installée/);
  // The seeded store of the other pages is not touched by the empty one.
  const sim = openPage(storage, '?lat=0');
  assert.ok((await call(sim, 'api_getState')).kpi.exp2Pallets > 500);
});

// ---------------------------------------------------------------------------------------------------------------
// Client.html and PagesPc.html in a Node vm (no DOM needed for these): the Projets paste parser and the formatting
// and pending helpers the screens share.
// ---------------------------------------------------------------------------------------------------------------
function pageScripts(withConfig) {
  const sb = { console, Math, Date, JSON, setTimeout, clearTimeout, Promise };
  sb.window = sb;
  sb.document = { body: { getAttribute: () => 'pc' }, documentElement: {}, addEventListener() {} };
  const ctx = vm.createContext(sb);
  const scripts = (file) => Array.from(fs.readFileSync(path.join(SRC, file), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]).join('\n');
  if (withConfig) vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), ctx, { filename: 'Config.gs' });
  vm.runInContext(scripts('Client.html'), ctx, { filename: 'Client.html' });
  vm.runInContext(scripts('PagesPc.html'), ctx, { filename: 'PagesPc.html' });
  return ctx;
}

test('Projets page: references pasted from Excel (columns, header, blanks, duplicates, leading zeros, errors)', () => {
  const ctx = pageScripts(true);
  const parse = (text, project) => JSON.parse(JSON.stringify(ctx.PagesPc.parsePaste(text, project)));
  const brief = (r) => r.rows.map((x) => [x.article, x.remove ? '-' : x.project, x.source, x.error ? 'ERR' : ''].join('|'));

  // One column, the project from the field; Windows line ends, no-break spaces, BOM, blank lines, lower case.
  let r = parse('﻿AB12345\r\n\r\n  ab12346 \r\n\t\r\n', 'ATLAS');
  assert.deepEqual(brief(r), ['AB12345|ATLAS|champ|', 'AB12346|ATLAS|champ|']);
  assert.equal(r.blank, 2);
  assert.equal(r.lines, 2);
  assert.equal(r.header, false);

  // Two columns (tab from Excel, or ';'); a line without its own project takes the field; leading zeros of numeric codes
  // go (like the server), digits grouped by Excel are joined; alphanumeric codes keep their zeros.
  r = parse('0058232351\tBOREAL\n73 871 645;CORSO\nW000074963\n0AB12', 'ATLAS');
  assert.deepEqual(brief(r), ['58232351|BOREAL|colonne|', '73871645|CORSO|colonne|', 'W000074963|ATLAS|champ|', '0AB12|ATLAS|champ|']);

  // A header line is skipped; its titles place the columns (a designation column is ignored).
  r = parse('Référence article\tDésignation\tProjet\nAB1\tFEU ARRIERE\tETNA\nAB2\tPROJECTEUR\t', 'ATLAS');
  assert.equal(r.header, true);
  assert.deepEqual(brief(r), ['AB1|ETNA|colonne|', 'AB2|ATLAS|champ|']);
  r = parse('Article\nAB1\nAB2', '');
  assert.equal(r.header, true);
  assert.deepEqual(brief(r), ['AB1|||', 'AB2|||']);
  // Without a header, a third column is refused: a designation must never become a project.
  r = parse('AB1\tFEU ARRIERE\tETNA\nAB2;X;Y', 'ATLAS');
  assert.match(r.rows[0].error, /Plus de deux colonnes/);
  assert.match(r.rows[1].error, /Plus de deux colonnes/);

  // Duplicates are merged (count, last project wins, conflicts listed); 'Sans projet' removes the project.
  r = parse('AB1\tETNA\nAB1\nAB1\tDELTA\nAB2\tsans projet', 'ETNA');
  assert.equal(r.merged, 2);
  assert.deepEqual(brief(r), ['AB1|DELTA|colonne|', 'AB2|-|colonne|']);
  assert.equal(r.rows[0].count, 3);
  assert.deepEqual(r.rows[0].conflict, ['ETNA', 'DELTA']);

  // Errors are explained in French, the line stays in the preview.
  r = parse('AB 12\n7,39E+07\nAB1\tA;B\nAB2\t' + 'X'.repeat(41) + '\nAB3|X', '');
  assert.match(r.rows[0].error, /Espace dans la référence/);
  assert.match(r.rows[1].error, /notation scientifique/);
  assert.equal(r.rows[2].article, 'AB1');           // a tab line is split on tabs only: 'A;B' is the project name
  assert.match(r.rows[2].projectError, /point-virgule/);
  assert.match(r.rows[3].projectError, /trop long/);
  assert.match(r.rows[4].error, /Référence invalide/);
  assert.equal(r.rows.length, 5);

  // Codes and names as the server stores them.
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.PagesPc.normArticle(' 000123 '))), { code: '123', error: '' });
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.PagesPc.normProjectName('  Atlas   Nord '))), { name: 'Atlas Nord', given: true, remove: false, error: '' });
  assert.match(ctx.PagesPc.normProjectName('A, B').error, /virgule/);
});

test('client helpers: waits in hours, pending figures by level, freshness at the SAP entry time', () => {
  const ctx = pageScripts(true);
  const App = ctx.App;
  assert.equal(App.fmt.hm(44.04), '44 h 02');
  assert.equal(App.fmt.hm(0.58), '0 h 34');
  assert.equal(App.fmt.hm(6), '6 h 00');
  assert.equal(App.fmt.stamp('2026-10-05 22:09:10'), '05/10/2026 22:09');
  assert.equal(App.fmt.stampShort('2026-10-05 22:09:10'), '05/10 22:09');
  assert.equal(App.hText(4.5), '4,5');

  const state = {
    asOf: '2026-10-05', asOfTs: '2026-10-05 22:09:10', source: 'SAP', importedAt: new Date().toISOString(),
    thresholds: { pendingHoursWarn: 4, pendingHoursCrit: 6 }, pendingTotal: 6,
    pending: [
      { article: 'A', label: '434503024', hours: 44.04, level: 'crit', days: 1, pallets: 1 },
      { article: 'B', label: '', hours: 8, level: 'crit', days: 0, pallets: 3 },
      { article: 'C', label: '434503030', hours: 6, level: 'crit', days: 0, pallets: 1 },
      { article: 'D', label: '434503031', hours: 4.5, level: 'warn', days: 0, pallets: 1 },
      { article: 'E', label: '434503032', hours: 0.5, level: '', days: 0, pallets: 1 }
    ],
    projectsList: [{ project: 'Sans projet', exp2Pallets: 3, pendingPallets: 7 }],
    blockContents: { B1: [{ article: 'A', pallets: 3 }] }
  };
  const ps = App.pendingStats(state);
  assert.deepEqual({ labels: ps.labels, unlabeled: ps.unlabeled, crit: ps.crit, warn: ps.warn, critRows: ps.critRows, critUnlabeled: ps.critUnlabeled,
    oldest: ps.oldest.label, timed: ps.timed, truncated: ps.truncated, total: ps.total },
  { labels: 4, unlabeled: 1, crit: 2, warn: 1, critRows: 3, critUnlabeled: 1, oldest: '434503024', timed: true, truncated: true, total: 6 });
  // Labels by waiting bucket: < 1 h, 1-2 h, 2-4 h, 4-6 h (amber), 6-12 h (red), > 12 h (red); 6 h exactly is red;
  // the unlabeled row (8 h) is not a label.
  const buckets = JSON.parse(JSON.stringify(App.pendingBuckets(state.pending, state.thresholds)));
  assert.deepEqual(buckets.map((b) => [b.label, b.value, b.level]),
    [['< 1 h', 1, ''], ['1–2 h', 0, ''], ['2–4 h', 0, ''], ['4–6 h', 1, 'warn'], ['6–12 h', 1, 'crit'], ['> 12 h', 1, 'crit']]);
  // The oldest is the oldest label, even when an unlabeled row (stock moved into PRD2) waits longer.
  const older = JSON.parse(JSON.stringify(state));
  older.pending.push({ article: 'R', label: '', hours: 60, level: '', days: 2, pallets: 1 });
  assert.equal(App.pendingStats(older).oldest.label, '434503024');
  assert.equal(App.pendingStats({ pending: [{ article: 'R', label: '', hours: 60, level: '', days: 2 }] }).oldest.article, 'R');
  // v1 rows (no level, no hours): the day rule.
  assert.equal(App.pendingLevel({ days: 7 }, { pendingDaysWarn: 3 }), 'crit');
  assert.equal(App.pendingLevel({ days: 3 }, { pendingDaysWarn: 3 }), 'warn');

  const fr = App.freshness(state);
  assert.equal(fr.lead, 'Données SAP jusqu’au');
  assert.equal(fr.asOfLabel, '05/10/2026 22:09');
  assert.match(fr.text, /^Données SAP jusqu’au 05\/10\/2026 22:09 · importées à \d{2}:\d{2}$/);
  const v1 = App.freshness({ asOf: '2026-10-03', source: 'SIMULATION', computedAt: new Date().toISOString() });
  assert.equal(v1.text.slice(0, 32), 'Données simulées au 03.10.2026 ·');

  // No project and no family yet (first SAP import): grey pallets, the notes point to the Projets page.
  assert.equal(App.hasProjects(state), false);
  assert.equal(App.hasFamilies(state), false);
  assert.equal(App.placementText(state, true), 'aucun projet : page PC Projets');
  assert.equal(App.placementText({ blockContents: { B1: [{ family: 'F1' }] } }), 'placement par famille');
  assert.equal(App.placementText({ projectsList: [{ project: 'ATLAS' }] }), 'placement par projet');
  assert.equal(App.projectColor({ projects: { ATLAS: '#7fb3e0', 'Sans projet': '#c9ced6' } }, 'atlas'), '#7fb3e0');
  assert.equal(App.projectColor({ projects: { 'Sans projet': '#c9ced6' } }, 'X'), '#c9ced6');
  // Without Config (CFG absent) the client keeps its defaults.
  const bare = pageScripts(false);
  assert.equal(bare.App.thresholds(null).pendingHoursCrit, 6);
  assert.equal(bare.App.flag('0', true), false);
  assert.equal(bare.App.flag('', true), true);
});

test('Projets page colors follow the engine rule: rank in name order, never a color another project already has', () => {
  const ctx = pageScripts(true);
  const eng = vm.createContext({ console, Math, Date, JSON });
  for (const f of ['Config.gs', 'Engine.gs']) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), eng, { filename: f });
  const pal = JSON.parse(JSON.stringify(eng.CFG.COLORS.projects));
  // The simulated projects (colors of the palette) plus two new ones: ALPHA sorts first, ZEPHYR after FJORD.
  const projects = [
    { project: 'ATLAS', blocks: ['B1'], color: pal[0] }, { project: 'BOREAL', blocks: ['B2'], color: pal[2] },
    { project: 'CORSO', blocks: ['B3'], color: pal[1] }, { project: 'DELTA', blocks: ['B4'], color: pal[3] },
    { project: 'ETNA', blocks: ['B5'], color: pal[4] }, { project: 'FJORD', blocks: ['B6'], color: pal[6].toUpperCase() },
    { project: 'ZEPHYR', blocks: [], color: '' }, { project: 'ALPHA', blocks: [], color: '' }
  ];
  const r = eng.Engine.compute({ movements: [], opening: [], articles: [], projects, blocks: [], rules: [], docks: [] });
  const engine = JSON.parse(JSON.stringify(r.projects));
  assert.equal(engine.ALPHA, pal[5], 'rank 0 is taken by ATLAS: next free color');
  assert.equal(engine.ZEPHYR, pal[7], 'rank 6 is FJORD color: next free color');
  const page = JSON.parse(JSON.stringify(ctx.PagesPc.autoColors(projects)));
  for (const p of projects) assert.equal(page[p.project], engine[p.project].toLowerCase(), p.project);
  // Without explicit colors: the palette in name order (unchanged rule).
  const bare = ['B', 'a', 'C'].map((n) => ({ project: n, blocks: [], color: '' }));
  const e2 = JSON.parse(JSON.stringify(eng.Engine.compute({ movements: [], projects: bare, blocks: [], rules: [] }).projects));
  assert.deepEqual([e2.a, e2.B, e2.C], pal.slice(0, 3));
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.PagesPc.autoColors(bare))), { a: pal[0], B: pal[1], C: pal[2] });
});
