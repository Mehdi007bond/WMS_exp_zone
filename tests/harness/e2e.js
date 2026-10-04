#!/usr/bin/env node
/**
 * EXP2 Digital Twin - end-to-end test of the web app on the local harness (npm run e2e).
 *
 * Builds tests/harness/out/ (build.js), serves tests/harness/ on 127.0.0.1 and drives Chromium with Playwright
 * (WebGL through SwiftShader). Every scenario opens the real pages (Index.html + every include, the real Api.gs on
 * the in-memory Repo) in a fresh browser profile, so each starts from the same seeded simulation; pages of one
 * scenario share their store, like screens share the Google Sheet.
 *
 * A scenario fails on any console error, uncaught page error or failed request, or on a failed check.
 * Screenshots: tests/harness/out/shots/ (PC pages 1440 x 900, TV 1920 x 1080); report: out/shots/e2e-report.json.
 *
 * Environment: PLAYWRIGHT (module path), CHROMIUM (browser executable), E2E_ONLY (regex on scenario names),
 * E2E_HEADED=1. Google Fonts are served from tests/harness/vendor/fonts when cached there, else left empty.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { build } = require('./build.js');

const HARNESS = __dirname;
const ROOT = path.resolve(HARNESS, '..', '..');
const OUT = path.join(HARNESS, 'out');
const SHOTS = path.join(OUT, 'shots');
const FONTS = path.join(HARNESS, 'vendor', 'fonts');
const MESSY = path.join(ROOT, 'sample-data', 'messy');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(MESSY, 'expected.json'), 'utf8'));
const PC = { width: 1440, height: 900 };
const TV = { width: 1920, height: 1080 };
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT, 'playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) { /* next */ }
  }
  throw new Error('Playwright introuvable (variable PLAYWRIGHT ou npm i -D playwright).');
}

function chromiumPath() {
  const candidates = [process.env.CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Static server for tests/harness/ (out/ pages, out/backend, vendor/)
// ---------------------------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    const file = path.join(HARNESS, rel);
    if (!file.startsWith(HARNESS + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------------------------------------------
const results = [];
let browser, base;

async function routeFonts(ctx) {
  const css = path.join(FONTS, 'css2.css');
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => {
    const u = route.request().url();
    if (/fonts\.googleapis\.com\/css/.test(u)) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: fs.existsSync(css) ? fs.readFileSync(css) : '' });
    }
    const f = path.join(FONTS, u.replace('https://fonts.gstatic.com/', '').replace(/\//g, '_'));
    if (fs.existsSync(f)) {
      return route.fulfill({ status: 200, contentType: 'font/woff2', body: fs.readFileSync(f), headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return route.fulfill({ status: 200, contentType: 'font/woff2', body: '', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
}

async function scenario(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  const t0 = Date.now();
  const errors = [];
  const notes = [];
  const shots = [];
  const ctx = await browser.newContext({ viewport: PC, deviceScaleFactor: 1, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  await routeFonts(ctx);
  function watch(page) {
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('console.error [' + label(page) + '] ' + m.text());
    });
    page.on('pageerror', (e) => errors.push('pageerror [' + label(page) + '] ' + (e && e.message)));
    page.on('requestfailed', (r) => errors.push('requestfailed [' + label(page) + '] ' + r.url() + ' ' + ((r.failure() || {}).errorText || '')));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push('HTTP ' + r.status() + ' [' + label(page) + '] ' + r.url());
    });
  }
  function label(page) {
    try {
      return page.url().replace(base, '');
    } catch (e) {
      return '?';
    }
  }
  ctx.on('page', watch);
  const t = {
    ctx,
    note: (s) => notes.push(s),
    async open(file, viewport) {
      const page = await ctx.newPage();
      if (viewport) await page.setViewportSize(viewport);
      await page.goto(base + file, { waitUntil: 'load' });
      await page.waitForFunction(() => window.App && window.App.store && window.App.store.status !== 'loading', null, { timeout: 30000 });
      return page;
    },
    async shot(page, file) {
      await page.screenshot({ path: path.join(SHOTS, file) });
      shots.push(file);
    }
  };
  let failure = null;
  try {
    await fn(t);
  } catch (e) {
    failure = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e);
    // Keep what the pages showed when the check failed.
    const pages = ctx.pages();
    for (let i = 0; i < pages.length; i++) {
      try {
        const f = 'FAIL-' + name + (pages.length > 1 ? '-' + (i + 1) : '') + '.png';
        await pages[i].screenshot({ path: path.join(SHOTS, f) });
        shots.push(f);
      } catch (e2) { /* page already gone */ }
    }
  }
  await ctx.close();
  const problems = (failure ? ['ÉCHEC : ' + failure] : []).concat(errors);
  results.push({ name, ok: !problems.length, ms: Date.now() - t0, problems, notes, shots });
  console.log((problems.length ? 'FAIL ' : 'ok   ') + name.padEnd(28) + String(Date.now() - t0).padStart(6) + ' ms' +
    (notes.length ? '  · ' + notes.join(' · ') : '') + (problems.length ? '\n       ' + problems.join('\n       ') : ''));
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function noHorizontalScroll(page, what) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check(r.sw <= r.w + 1, what + ' : défilement horizontal (' + r.sw + ' > ' + r.w + ')');
}

async function typeKey(page, key) {
  await page.waitForSelector('.modal .key-input', { timeout: 10000 });
  await page.fill('.modal .key-input', key);
  await page.keyboard.press('Enter');
}

const keysOf = (page) => page.evaluate(() => window.__keys);
const stateOf = (page) => page.evaluate(() => window.App.store.state);
const frNum = (n) => Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
const digits = (s) => String(s).replace(/[^\d-]/g, '');
const frDate = (iso) => iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4);

// ---------------------------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------------------------
async function run() {
  await scenario('tv-overview', async (t) => {
    const page = await t.open('out/tv.html', TV);
    check(await page.evaluate(() => App.store.status) === 'ok', 'état non chargé');
    await page.waitForSelector('.scene-overview .tv-kpi');
    await page.waitForSelector('.tv-twin-stage canvas');
    await page.waitForTimeout(2000);
    const s = await stateOf(page);
    const info = await page.evaluate(() => ({
      kpis: Array.from(document.querySelectorAll('.scene-overview .tv-kpi')).map((e) => ({
        l: e.querySelector('.l').textContent, v: e.querySelector('.v').textContent.trim() })),
      kind: document.querySelector('.tv-twin-stage .t3d-canvas') ? '3d' : document.querySelector('.tv-twin-stage .iso-canvas') ? 'iso' : 'none',
      canvas: (() => { const c = document.querySelector('.tv-twin-stage canvas'); return c ? [c.width, c.height] : null; })(),
      docks: Array.from(document.querySelectorAll('.tv-docks .tv-q .h')).map((e) => e.firstChild.textContent.trim()),
      trucks: document.querySelectorAll('.tv-docks .tv-q:not(.free)').length,
      fresh: document.querySelector('[data-r="fresh"]').textContent,
      blocks: document.querySelectorAll('.tv-blocks .tv-brow').length
    }));
    check(info.kpis.length === 6, 'TV : ' + info.kpis.length + ' indicateurs au lieu de 6');
    check(info.kpis.every((k) => k.v && k.v !== '–'), 'TV : indicateur vide ' + JSON.stringify(info.kpis));
    check(digits(info.kpis[0].v) === String(s.kpi.exp2Pallets), 'TV : stock EXP2 affiché ' + info.kpis[0].v + ' au lieu de ' + s.kpi.exp2Pallets);
    check(info.kind !== 'none' && info.canvas && info.canvas[0] > 300 && info.canvas[1] > 200, 'TV : pas de vue 3D ni isométrique');
    check(info.docks.join(',') === 'Q1,Q2,Q3,Q4,Q5,Q6,Q7,Q8', 'TV : quais ' + info.docks.join(','));
    check(info.trucks === s.kpi.docksOccupied, 'TV : ' + info.trucks + ' camions affichés pour ' + s.kpi.docksOccupied + ' quais occupés');
    check(info.fresh.indexOf(frDate(s.asOf)) >= 0, 'TV : date des données absente de l’en-tête');
    check(info.blocks === s.blocks.length, 'TV : barres de saturation ' + info.blocks);
    const period = await page.evaluate(() => App.pollPeriodMs());
    check(period === s.thresholds.tvRefreshS * 1000, 'TV : période de vérification ' + period + ' ms');
    // Readable from 5 m: labels of the 3D view at 1.5 rem, KPI sub-lines without an ellipsis, short ticker items.
    const read = await page.evaluate(() => ({
      label: (() => { const o = document.querySelector('.t3d-overlay'); return o ? parseFloat(getComputedStyle(o).fontSize) : null; })(),
      cut: Array.from(document.querySelectorAll('.scene-overview .tv-kpi .s, .scene-overview .tv-kpi .l')).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
      sub: parseFloat(getComputedStyle(document.querySelector('.scene-overview .tv-kpi .s')).fontSize),
      ticker: Array.from(document.querySelectorAll('.tv-ticker-track span')).map((e) => e.textContent),
      blocksHidden: (() => { const b = document.querySelector('.tv-blocks'); return b.scrollHeight > b.clientHeight + 1; })(),
      placeholders: /\(\?\)|sans libellé/.test(document.body.textContent),
      fresh: document.querySelector('[data-r="fresh"]').textContent
    }));
    if (info.kind === '3d') check(read.label >= 22, 'TV : étiquettes 3D de ' + read.label + ' px');
    check(read.sub >= 22, 'TV : sous-lignes des indicateurs de ' + read.sub + ' px');
    check(!read.cut.length, 'TV : texte coupé ' + JSON.stringify(read.cut));
    check(!read.blocksHidden, 'TV : barres de saturation coupées');
    check(read.ticker.length && read.ticker.every((x) => x.length <= 70), 'TV : bandeau trop long ' + JSON.stringify(read.ticker.filter((x) => x.length > 70)));
    check(!read.placeholders, 'TV : libellé provisoire « (?) » affiché');
    check(/^Données simulées au \d{2}\.\d{2}\.\d{4}/.test(read.fresh), 'TV : en-tête « ' + read.fresh + ' »');
    t.note('vue ' + info.kind + ', ' + s.kpi.exp2Pallets + ' pal, ' + info.trucks + ' camions');
    await t.shot(page, 'tv-overview.png');
  });

  await scenario('tv-scenes', async (t) => {
    const page = await t.open('out/tv.html?scene=plan', TV);
    await page.waitForSelector('.scene-plan.on svg [data-block]');
    const s = await stateOf(page);
    const blocks = await page.$$eval('.scene-plan [data-block]', (e) => new Set(e.map((x) => x.getAttribute('data-block'))).size);
    check(blocks === s.blocks.length, 'scène plan : ' + blocks + ' blocs');
    // Every saturation tag stays inside its block (narrow blocks get a two-line tag).
    const spill = await page.evaluate(() => {
      const svg = document.querySelector('.scene-plan svg');
      const blocks = Array.from(svg.querySelectorAll('g[data-block] > rect:first-of-type')).map((r) => r.getBBox());
      return Array.from(svg.querySelectorAll('rect.p-tag')).map((t) => t.getBBox()).filter((t) => {
        const cx = t.x + t.width / 2, cy = t.y + t.height / 2;
        const b = blocks.find((k) => cx >= k.x && cx <= k.x + k.width && cy >= k.y && cy <= k.y + k.height);
        return !b || t.x < b.x - 0.5 || t.x + t.width > b.x + b.width + 0.5;
      }).length;
    });
    check(spill === 0, 'scène plan : ' + spill + ' étiquette(s) plus large(s) que leur bloc');
    check(/Étiquette/.test(await page.textContent('.scene-plan .tv-plan-box')), 'scène plan : légende des étiquettes absente');
    await page.waitForTimeout(500);
    await t.shot(page, 'tv-plan.png');
    await page.goto(base + 'out/tv.html?scene=pending');
    await page.waitForSelector('.scene-pending.on .tv-table tbody tr');
    const rows = await page.$$eval('.scene-pending .tv-table tbody tr', (e) => e.length);
    check(rows === s.pending.length, 'scène attente : ' + rows + ' lignes pour ' + s.pending.length);
    await page.waitForTimeout(500);
    await t.shot(page, 'tv-pending.png');
    await page.goto(base + 'out/tv.html?scene=docks');
    await page.waitForSelector('.scene-docks.on .tv-dock');
    const cards = await page.$$eval('.scene-docks .tv-dock', (e) => e.length);
    check(cards === 8, 'scène quais : ' + cards + ' quais');
    await page.waitForTimeout(500);
    await t.shot(page, 'tv-docks.png');
  });

  await scenario('tv-iso-fallback', async (t) => {
    const page = await t.open('out/tv.html?no3d=1', TV);
    await page.waitForSelector('.tv-twin-stage .iso-canvas');
    check(!(await page.$('.t3d-canvas')), 'canvas 3D présent malgré no3d');
    await page.waitForTimeout(800);
    await t.shot(page, 'tv-iso.png');
  });

  await scenario('empty-state', async (t) => {
    const tv = await t.open('out/tv.html?empty=1', TV);
    await tv.waitForSelector('.tv-empty:not([hidden]) h2');
    const txt = await tv.textContent('.tv-empty h2');
    check(/Aucune donnée/.test(txt), 'TV vide : ' + txt);
    check(await tv.evaluate(() => App.store.status) === 'empty', 'TV vide : statut ' + await tv.evaluate(() => App.store.status));
    await t.shot(tv, 'tv-empty.png');
    const pc = await t.open('out/pc-plan.html?empty=1', PC);
    await pc.waitForSelector('.empty-card h2');
    check(/Aucune donnée/.test(await pc.textContent('.empty-card h2')), 'PC vide : message');
    await t.shot(pc, 'pc-empty.png');
    const none = await t.open('out/pc-lookup.html?none=1', PC);
    await none.waitForFunction(() => App.store.status === 'notInstalled');
    await none.click('.pc-nav button[data-page="pending"]');
    await none.waitForSelector('.empty-card h2');
    check(/non installée/.test(await none.textContent('.empty-card h2')), 'PC non installée : message');
    await t.shot(none, 'pc-not-installed.png');
  });

  await scenario('pc-twin', async (t) => {
    const page = await t.open('out/pc-twin.html', PC);
    await page.waitForSelector('.twin-stage canvas');
    await page.waitForTimeout(1500);
    const kind = await page.textContent('[data-r="kind"]');
    check(/3D|isométrique/.test(kind), 'jumeau : ' + kind);
    await page.click('.seg button[data-mode="age"]');
    await page.waitForTimeout(500);
    check(/âge/.test(await page.textContent('[data-r="side"] h2 small')), 'jumeau : légende âge absente');
    await page.click('.seg button[data-mode="family"]');
    await page.waitForTimeout(600);
    await noHorizontalScroll(page, 'jumeau');
    t.note(kind.trim());
    await t.shot(page, 'pc-twin.png');
  });

  await scenario('pc-lookup', async (t) => {
    const page = await t.open('out/pc-lookup.html', PC);
    await page.waitForSelector('.hint-list button');
    const s = await stateOf(page);
    // The article with the most pallets placed in blocks.
    const per = {};
    Object.keys(s.blockContents).forEach((b) => (s.blockContents[b] || []).forEach((e) => {
      per[e.article] = per[e.article] || { pallets: 0, designation: e.designation };
      per[e.article].pallets += e.pallets;
    }));
    const art = Object.keys(per).sort((a, b) => per[b].pallets - per[a].pallets)[0];
    const word = per[art].designation.split(/\s+/).filter((w) => w.length >= 5)[0] || per[art].designation.slice(0, 5);
    await page.fill('#lk-q', word.toLowerCase());
    await page.waitForSelector('#lk-sugg:not([hidden]) li[data-i]');
    const sugg = await page.$$eval('#lk-sugg li[data-i]', (e) => e.length);
    check(sugg >= 1, 'suggestions vides pour « ' + word + ' »');
    await page.fill('#lk-q', art);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.stats .stat');
    await page.waitForSelector('[data-r="mini"] .p-hl', { state: 'attached' });
    await page.waitForTimeout(400);       // a late suggestion request must not reopen the list
    check(await page.$eval('#lk-sugg', (e) => e.hidden), 'fiche : liste de suggestions restée ouverte');
    const r = await page.evaluate(() => ({
      exp2: document.querySelector('.stats .stat .v').textContent,
      fifoRows: document.querySelectorAll('.cols .col:first-child .panel:first-child tbody tr').length,
      fifoTitle: document.querySelector('.cols .col:first-child .panel:first-child h2').textContent,
      desc: document.querySelector('[data-r="desc"]').textContent,
      lines: document.querySelectorAll('.cols .col:last-child .panel:last-child tbody tr').length,
      url: location.search
    }));
    check(digits(r.exp2) === String(per[art].pallets), 'fiche : EXP2 ' + r.exp2 + ' au lieu de ' + per[art].pallets + ' pal');
    check(/FIFO/.test(r.fifoTitle) && r.fifoRows >= 1, 'fiche : aucune entrée FIFO');
    check(r.desc.indexOf(per[art].designation) >= 0, 'fiche : désignation absente');
    check(r.lines >= 1, 'fiche : aucune ligne SAP');
    check(/article=/.test(r.url), 'URL non mise à jour : ' + r.url);
    t.note(art + ' : ' + per[art].pallets + ' pal, ' + r.fifoRows + ' entrées FIFO, ' + r.lines + ' lignes SAP');
    await noHorizontalScroll(page, 'recherche');
    await t.shot(page, 'pc-lookup.png');
    const unknown = await t.open('out/pc-lookup.html?page=lookup&article=999999', PC);
    await unknown.waitForSelector('.empty-card h2');
    check(/introuvable/.test(await unknown.textContent('.empty-card h2')), 'article inconnu : message');
    // Quantities with decimals (KG articles) keep their decimals: '729,25', not '729'.
    const kg = await unknown.evaluate(async () => {
      const s = App.store.state;
      const arts = Array.from(new Set(Object.keys(s.blockContents).reduce((a, b) => a.concat(s.blockContents[b].map((e) => e.article)), [])
        .concat(s.pending.map((p) => p.article))));
      for (const a of arts) {
        const r = await App.call('api_lookup', a);
        const m = (r.movements || []).find((x) => Math.round(x.qty) !== x.qty);
        if (m) return { article: a, qty: m.qty };
      }
      return null;
    });
    if (kg) {
      await unknown.evaluate((a) => App.go('lookup', { article: a }), kg.article);
      await unknown.waitForSelector('.stats .stat');
      const cells = await unknown.$$eval('.cols .col:last-child .panel:last-child tbody td.num', (e) => e.map((x) => x.textContent.trim()));
      const want = kg.qty.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/[\u202f\u2009]/g, '\u00a0');
      check(cells.includes(want), 'quantité décimale arrondie : ' + want + ' absente de ' + JSON.stringify(cells.slice(0, 8)));
      t.note('KG ' + kg.article + ' : ' + want);
    }
  });

  await scenario('pc-pending', async (t) => {
    const page = await t.open('out/pc-pending.html', PC);
    await page.waitForSelector('tr[data-article]');
    const s = await stateOf(page);
    const rows = await page.$$eval('tr[data-article]', (e) => e.length);
    check(s.pending.length > 0 && rows === s.pending.length, 'attente : ' + rows + ' lignes pour ' + s.pending.length);
    const first = await page.$eval('tr[data-article] td.mono', (e) => e.textContent.trim());
    check(/Pal\*/.test(await page.textContent('table.tbl thead')) && /palette entamée/.test(await page.textContent('.panel')), 'attente : note « Pal* » absente');
    t.note(rows + ' lignes, ' + s.kpi.pendingPallets + ' pal');
    await noHorizontalScroll(page, 'attente');
    await t.shot(page, 'pc-pending.png');
    await page.click('tr[data-article]');
    await page.waitForSelector('.stats .stat');
    check(new URL(page.url()).searchParams.get('article') === first, 'clic ligne : fiche de ' + new URL(page.url()).searchParams.get('article'));
  });

  await scenario('pc-plan', async (t) => {
    const page = await t.open('out/pc-plan.html', PC);
    await page.waitForSelector('svg [data-block]');
    const s = await stateOf(page);
    const id = s.blocks.slice().sort((a, b) => (s.blockContents[b.id] || []).length - (s.blockContents[a.id] || []).length)[0].id;
    await page.click('svg g[data-block="' + id + '"]');
    await page.waitForFunction((b) => {
      const h = document.querySelector('[data-r="side"] h2');
      return h && h.textContent.indexOf('Bloc ' + b) === 0;
    }, id);
    const rows = await page.$$eval('[data-r="side"] tr[data-article]', (e) => e.length);
    const expect = (s.blockContents[id] || []).length;
    check(expect > 0 && rows === expect, 'bloc ' + id + ' : ' + rows + ' articles affichés pour ' + expect);
    const big = await page.textContent('[data-r="side"] .blk-head .big');
    const b = s.blocks.filter((x) => x.id === id)[0];
    check(digits(big) === String(b.pallets), 'bloc ' + id + ' : ' + big + ' pal au lieu de ' + b.pallets);
    const planText = await page.$$eval('svg.plan text', (e) => e.map((x) => x.textContent));
    check(['Q1', 'Q8', 'Zone camion', 'Convoyeur'].every((x) => planText.includes(x)), 'plan PC : repères absents (quais, zone camion, convoyeur)');
    t.note('bloc ' + id + ' : ' + rows + ' articles, ' + b.pallets + ' pal');
    await noHorizontalScroll(page, 'plan');
    await t.shot(page, 'pc-plan.png');
  });

  await scenario('pc-docks', async (t) => {
    const page = await t.open('out/pc-docks.html', PC);
    await page.waitForSelector('.dock');
    await t.shot(page, 'pc-docks.png');
    const keys = await keysOf(page);
    const before = await page.evaluate(() => App.store.versions.docks);
    // First occupied dock: 12 pallets loaded, 11 staged.
    const s = await stateOf(page);
    const i = s.docks.findIndex((d) => !/^libre$/i.test(d.status));
    const d = s.docks[i];
    const planned = Math.max(12, Number(d.planned) || 0);
    // The key is asked (and checked) before the form: a wrong key never costs a filled-in form.
    await page.click('.dock button[data-i="' + i + '"]');
    await typeKey(page, 'AAAA-BBBB-CCCC');
    await page.waitForSelector('.modal .modal-error:not([hidden])');
    const msg = await page.$$eval('.modal .modal-error:not([hidden])', (e) => e[e.length - 1].textContent);
    check(/Clé incorrecte/.test(msg), 'mauvaise clé : message « ' + msg + ' »');
    check(!(await page.$('.modal select[name="status"]')), 'mauvaise clé : formulaire ouvert quand même');
    check(await page.$$eval('.modal-backdrop:not(.under)', (e) => e.length) === 1, 'plusieurs fenêtres visibles');
    check(await page.evaluate(() => App.store.versions.docks) === before, 'mauvaise clé : quai enregistré quand même');
    await t.shot(page, 'pc-docks-wrong-key.png');
    await typeKey(page, keys.docks);
    await page.waitForSelector('.modal select[name="status"]');
    const options = await page.$$eval('.modal select[name="status"] option', (e) => e.map((o) => o.textContent));
    check(options.join(',') === 'Libre,Camion arrivé,En chargement,Prêt à partir', 'statuts : ' + options.join(','));
    check(await page.getAttribute('.modal input[name="arrival"]', 'type') !== 'time', 'heure : champ time (AM/PM en anglais)');
    await page.fill('.modal input[name="planned"]', String(planned));
    await page.fill('.modal input[name="loaded"]', '12');
    await page.fill('.modal input[name="staged"]', '11');
    await page.fill('.modal input[name="arrival"]', '9h30');
    await page.click('.modal .btn.p');
    await page.waitForSelector('.modal .modal-error:not([hidden])');
    check(/hh:mm/.test(await page.textContent('.modal .modal-error:not([hidden])')), 'heure invalide acceptée');
    await page.fill('.modal input[name="arrival"]', '09:30');
    await t.shot(page, 'pc-docks-form.png');
    await page.click('.modal .btn.p');
    await page.waitForSelector('.toast.ok');
    check(/^Quai Q\d enregistré\.$/.test(await page.textContent('.toast.ok span')), 'message : ' + await page.textContent('.toast.ok span'));
    await page.waitForFunction((n) => App.store.versions.docks > n, before, { timeout: 10000 });
    const text = await page.evaluate((k) => document.querySelectorAll('.dock')[k].textContent, i);
    check(/Palettes\s*12\s*\//.test(text) && /11\s*\/\s*\d+/.test(text), 'quai non mis à jour : ' + text.replace(/\s+/g, ' '));
    const saved = (await stateOf(page)).docks[i];
    check(saved.loaded === 12 && saved.staged === 11, 'état : quai ' + JSON.stringify(saved));
    t.note('quai ' + d.quai + ' enregistré avec la clé quais');
    await t.shot(page, 'pc-docks-saved.png');
  });

  await scenario('pc-import', async (t) => {
    const file = 'MB51_transferts_messy.xlsx';
    const exp = EXPECTED.per_file[file];
    const skipped = exp.skipped.subtotal + exp.skipped.header + exp.skipped.blank;
    const page = await t.open('out/pc-import.html', PC);
    await page.waitForSelector('[data-r="lib"] .ok-t', { timeout: 30000 });
    const keys = await keysOf(page);
    const before = await page.evaluate(() => App.store.state.version);
    await page.setInputFiles('input[type=file]', path.join(MESSY, file));
    await page.waitForSelector('[data-save]:not([disabled])', { timeout: 30000 });
    const total = await page.evaluate(() => {
      const rows = document.querySelectorAll('[data-r="preview"] table.tbl')[0].querySelectorAll('tbody tr');
      return Array.from(rows[rows.length - 1].children).map((td) => td.textContent.trim());
    });
    // Total | Période | Lues | Valides | Doublons | Rejetées | Ignorées | Alertes
    const got = { read: +digits(total[2]), valid: +digits(total[3]), dup: +digits(total[4]), rejected: +digits(total[5]), skipped: +digits(total[6]) };
    const want = { read: exp.data_rows, valid: exp.valid_parsed, dup: 0, rejected: exp.rejected, skipped };
    check(JSON.stringify(got) === JSON.stringify(want), 'aperçu ' + JSON.stringify(got) + ' au lieu de ' + JSON.stringify(want));
    t.note('aperçu ' + got.read + ' lues / ' + got.valid + ' valides / ' + got.skipped + ' ignorées / ' + digits(total[7]) + ' alerte');
    await t.shot(page, 'pc-import-preview.png');
    await page.click('[data-save]');
    await typeKey(page, keys.admin);
    await page.waitForSelector('[data-r="result"] .stat', { timeout: 30000 });
    let stats = await page.$$eval('[data-r="result"] .stat .v', (e) => e.map((x) => x.textContent.trim()));
    check(digits(stats[0]) === String(exp.valid_parsed) && digits(stats[1]) === '0', 'premier import : ' + JSON.stringify(stats));
    const layout = await page.evaluate(() => {
      const r = document.querySelector('[data-r="result"]'), p = document.querySelector('[data-r="preview"]');
      return { previewEmpty: !p.children.length, resultFirst: !!(r.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING),
        top: r.getBoundingClientRect().top, warn: !!r.querySelector('.alert-box') };
    });
    check(layout.previewEmpty && layout.resultFirst, 'import : l’analyse reste affichée au-dessus du résultat');
    check(layout.top < 900, 'import : résultat hors de l’écran (' + Math.round(layout.top) + ' px)');
    check(layout.warn, 'import : avertissement « données simulées » absent du résultat');
    await page.waitForFunction((v) => App.store.state.version > v, before, { timeout: 10000 });
    await t.shot(page, 'pc-import-result.png');
    await page.click('[data-new]');
    await page.setInputFiles('input[type=file]', path.join(MESSY, file));
    await page.waitForSelector('[data-save]:not([disabled])', { timeout: 30000 });
    await page.click('[data-save]');
    await page.waitForSelector('[data-r="result"] .stat', { timeout: 30000 });
    check(!(await page.$('.modal')), 'clé demandée deux fois');
    stats = await page.$$eval('[data-r="result"] .stat .v', (e) => e.map((x) => x.textContent.trim()));
    check(digits(stats[0]) === '0' && digits(stats[1]) === String(exp.valid_parsed), 'second import : ' + JSON.stringify(stats));
    const toasts = await page.$$eval('.toast.ok span', (e) => e.map((x) => x.textContent));
    check(toasts.some((x) => /0 nouvelle ligne, \d+ déjà connues/.test(x)), 'second import : message sans les lignes déjà connues ' + JSON.stringify(toasts));
    t.note('import ' + exp.valid_parsed + ' nouvelles, réimport 0 nouvelle / ' + digits(stats[1]) + ' connues');
    await t.shot(page, 'pc-import-again.png');
  });

  await scenario('tv-offline', async (t) => {
    const page = await t.open('out/tv.html', TV);
    await page.waitForSelector('.scene-overview .tv-kpi');
    await page.evaluate(() => { window.__harness.setOffline(true); return App.refresh(false); });
    await page.waitForSelector('.tv-badge.off');
    const r = await page.evaluate(() => ({ kpis: document.querySelectorAll('.scene-overview .tv-kpi').length,
      badge: document.querySelector('.tv-badge').textContent, state: !!App.store.state }));
    check(r.kpis === 6 && r.state, 'TV hors ligne : état perdu');
    check(/Connexion perdue/.test(r.badge), 'TV hors ligne : badge « ' + r.badge + ' »');
    await t.shot(page, 'tv-offline.png');
    await page.evaluate(() => { window.__harness.setOffline(false); return App.refresh(false); });
    await page.waitForSelector('.tv-badge:not(.off)');
  });

  await scenario('pc-navigation', async (t) => {
    const page = await t.open('out/pc-lookup.html', PC);
    await page.evaluate(() => { window.__marker = 42; });
    const ids = await page.$$eval('.pc-nav button[data-page]', (e) => e.map((x) => x.getAttribute('data-page')));
    check(ids.length === 7, 'barre : ' + ids.join(','));
    for (const id of ids.concat(['lookup'])) {
      await page.click('.pc-nav button[data-page="' + id + '"]');
      await page.waitForFunction((i) => document.querySelector('.pc-nav button[aria-current="page"]').getAttribute('data-page') === i, id);
      check(new URL(page.url()).searchParams.get('page') === id, 'URL ' + page.url());
      await page.waitForTimeout(150);
      await noHorizontalScroll(page, 'page ' + id);
    }
    check(await page.evaluate(() => window.__marker) === 42, 'la navigation a rechargé la page');
    check(!(await page.$('.t3d-canvas')), 'canvas 3D non détruit en quittant le jumeau');
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.pc-nav button[aria-current="page"]').getAttribute('data-page') === 'simulation');
    t.note(ids.length + ' pages sans rechargement, retour arrière ok');
  });

  await scenario('file-protocol', async (t) => {
    const page = await t.ctx.newPage();
    await page.goto('file://' + path.join(OUT, 'pc-import.html'));
    await page.waitForFunction(() => window.App && App.store.status === 'ok', null, { timeout: 30000 });
    await page.waitForSelector('[data-r="lib"] .ok-t', { timeout: 30000 });
    const tv = await t.ctx.newPage();
    await tv.goto('file://' + path.join(OUT, 'tv.html'));
    await tv.waitForSelector('.scene-overview .tv-kpi');
    check(JSON.stringify(await keysOf(tv)) === JSON.stringify(await keysOf(page)), 'file:// : magasin non partagé');
    t.note('pages ouvertes en file://, magasin partagé');
  });

  await scenario('simulation-tv-sync', async (t) => {
    const tv = await t.open('out/tv.html?poll=2', TV);
    await tv.waitForSelector('.scene-overview .tv-kpi');
    const tv0 = await tv.evaluate(() => ({ asOf: App.store.state.asOf, version: App.store.versions.data, period: App.pollPeriodMs() }));
    check(tv0.period === 2000, 'TV : ?poll=2 ignoré (' + tv0.period + ' ms)');
    const pc = await t.open('out/pc-simulation.html', PC);
    await pc.waitForSelector('.kv');
    check(await pc.evaluate(() => App.store.state.asOf) === tv0.asOf, 'les deux pages ne voient pas les mêmes données');
    await t.shot(pc, 'pc-simulation.png');
    const keys = await keysOf(pc);
    const polls = () => tv.evaluate(() => window.__harness.calls.filter((c) => c.name === 'api_getVersion').length);
    const polls0 = await polls();
    await pc.click('[data-act="next"]');
    await typeKey(pc, keys.admin);
    await pc.waitForFunction((d) => App.store.state && App.store.state.asOf > d, tv0.asOf, { timeout: 20000 });
    await pc.waitForFunction(() => /simulée/.test(document.querySelector('[data-r="msg"]').textContent));
    const pc1 = await pc.evaluate(() => ({ asOf: App.store.state.asOf, version: App.store.versions.data }));
    await t.shot(pc, 'pc-simulation-next.png');
    const t0 = Date.now();
    await tv.waitForFunction((d) => App.store.state && App.store.state.asOf === d, pc1.asOf, { timeout: 15000 });
    await tv.waitForFunction((d) => document.querySelector('[data-r="fresh"]').textContent.indexOf(d) >= 0, frDate(pc1.asOf));
    const tv1 = await tv.evaluate(() => ({ asOf: App.store.state.asOf, version: App.store.versions.data,
      kpi: document.querySelector('.scene-overview .tv-kpi .v').textContent, exp2: App.store.state.kpi.exp2Pallets }));
    check(tv1.version === pc1.version, 'TV : version ' + tv1.version + ' au lieu de ' + pc1.version);
    check(digits(tv1.kpi) === String(tv1.exp2), 'TV : indicateur non redessiné');
    check(await polls() > polls0, 'TV : mise à jour sans interrogation de version');
    check(await tv.evaluate(() => !!window.__harness && performance.getEntriesByType('navigation').length === 1), 'TV rechargée');
    t.note('+1 jour ' + frDate(tv0.asOf) + ' -> ' + frDate(pc1.asOf) + ', TV à jour en ' + (Date.now() - t0) + ' ms');
    await tv.waitForTimeout(800);
    await t.shot(tv, 'tv-after-next-day.png');
  });
}

async function main() {
  console.log('Construction du harness…');
  const b = build();
  b.warnings.forEach((w) => console.warn('  attention : ' + w));
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.readdirSync(SHOTS).forEach((f) => { if (/\.png$/.test(f)) fs.unlinkSync(path.join(SHOTS, f)); });
  const server = await startServer();
  base = 'http://127.0.0.1:' + server.address().port + '/';
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({
    executablePath: chromiumPath(),
    headless: !process.env.E2E_HEADED,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  const t0 = Date.now();
  try {
    await run();
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  const shots = results.reduce((a, r) => a.concat(r.shots), []);
  fs.writeFileSync(path.join(SHOTS, 'e2e-report.json'), JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - t0, results }, null, 2));
  console.log('\n' + results.length + ' scénarios, ' + (results.length - failed.length) + ' réussis, ' + failed.length + ' en échec · ' +
    shots.length + ' captures dans ' + path.relative(process.cwd(), SHOTS) + '/ · ' + Math.round((Date.now() - t0) / 1000) + ' s');
  process.exit(failed.length || !results.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(2);
});
