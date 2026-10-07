#!/usr/bin/env node
/**
 * EXP2 Digital Twin - end-to-end test of the web app on the local harness (npm run e2e).
 *
 * Builds tests/harness/out/ (build.js), serves tests/harness/ on 127.0.0.1 and drives Chromium with Playwright
 * (WebGL through SwiftShader). Every scenario opens the real pages (Index.html + every include, the real Api.gs on
 * the in-memory Repo) in a fresh browser profile, so each starts from the same seeded simulation; pages of one
 * scenario share their store, like screens share the Google Sheet.
 *
 * v2 scenarios (docs/SPEC_V2.md 7 and 8): pc-projects (paste, preview, save, zones, rename, the plan shows the project),
 * pc-pending-hours (red from pendingHoursCrit), tv-prd2-alert (ticker and tile), pc-import-real (the user's anonymised
 * MB51 export through the import page on an empty base: format line, filter counts, 86 labels over 6 h, TV layout of
 * SAP data), pc-simulation-mb51 (simulated MB51 file written in the browser, then imported), sheet-sidebars (the two
 * panels of the Google Sheet, SidebarProjets.html and Sidebar.html, at 300 px on the same in-memory server).
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
const REAL = path.join(ROOT, 'sample-data', 'mb51-reel');
const REAL_FILE = path.join(REAL, 'MB51_reel_anonymise.xlsx');
const REAL_EXPECTED = JSON.parse(fs.readFileSync(path.join(REAL, 'expected.json'), 'utf8'));
const PC_SMALL = { width: 1366, height: 768 };
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
    async shot(page, file, opts) {
      await page.screenshot(Object.assign({ path: path.join(SHOTS, file) }, opts || {}));
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
// Time of the data as the headers write it: SAP entry time 'dd/mm/yyyy hh:mm' (v2), else the date 'dd.mm.yyyy' (v1).
const dataStamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s.asOfTs || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] + ' ' + m[4] + ':' + m[5] : frDate(s.asOf);
};

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
    check(info.fresh.indexOf(dataStamp(s)) >= 0, 'TV : heure des données ' + dataStamp(s) + ' absente de l’en-tête « ' + info.fresh + ' »');
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
      fresh: document.querySelector('[data-r="fresh"]').textContent,
      freshCut: (() => { const e = document.querySelector('[data-r="fresh"]'); return e.scrollWidth > e.clientWidth + 1; })()
    }));
    if (info.kind === '3d') check(read.label >= 22, 'TV : étiquettes 3D de ' + read.label + ' px');
    check(read.sub >= 22, 'TV : sous-lignes des indicateurs de ' + read.sub + ' px');
    check(!read.cut.length, 'TV : texte coupé ' + JSON.stringify(read.cut));
    check(!read.blocksHidden, 'TV : barres de saturation coupées');
    check(read.ticker.length && read.ticker.every((x) => x.length <= 70), 'TV : bandeau trop long ' + JSON.stringify(read.ticker.filter((x) => x.length > 70)));
    check(!read.placeholders, 'TV : libellé provisoire « (?) » affiché');
    check(/^Données simulées jusqu’au \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/.test(read.fresh), 'TV : en-tête « ' + read.fresh + ' »');
    check(!read.freshCut, 'TV : en-tête coupé « ' + read.fresh + ' »');
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
    await page.click('.seg button[data-mode="project"]');
    await page.waitForTimeout(400);
    const legend = await page.$$eval('[data-r="side"] .legend span', (e) => e.map((x) => x.textContent.trim()));
    const projects = (await stateOf(page)).projectsList.filter((p) => p.project !== 'Sans projet').map((p) => p.project);
    check(projects.length && projects.every((p) => legend.includes(p)), 'jumeau : légende des projets ' + JSON.stringify(legend));
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
    const first = await page.$eval('tr[data-article]', (e) => e.getAttribute('data-article'));
    // v2 (entry times): one row per label, waits in hours, counts at the time of the data.
    const head = await page.textContent('.pend-sum');
    check(/étiquettes? en attente/.test(head) && /depuis plus de 6 h/.test(head) && head.indexOf(dataStamp(s).slice(0, 5)) >= 0,
      'attente : en-tête « ' + head.replace(/\s+/g, ' ') + ' »');
    check(/Étiquette/.test(await page.textContent('table.tbl thead')), 'attente : colonne Étiquette absente');
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
    // Total | Période | Lues | Valides | Hors PF | Doublons | Rejetées | Ignorées | Alertes
    const got = { read: +digits(total[2]), valid: +digits(total[3]), untracked: +digits(total[4]), dup: +digits(total[5]), rejected: +digits(total[6]),
      skipped: +digits(total[7]) };
    const want = { read: exp.data_rows, valid: exp.valid_parsed, untracked: 0, dup: 0, rejected: exp.rejected, skipped };
    check(JSON.stringify(got) === JSON.stringify(want), 'aperçu ' + JSON.stringify(got) + ' au lieu de ' + JSON.stringify(want));
    t.note('aperçu ' + got.read + ' lues / ' + got.valid + ' valides / ' + got.skipped + ' ignorées / ' + digits(total[8]) + ' alerte');
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
    check(ids.join(',') === 'twin,plan,lookup,pending,projects,docks,import,simulation', 'barre : ' + ids.join(','));
    for (const id of ids.concat(['lookup'])) {
      await page.click('.pc-nav button[data-page="' + id + '"]');
      await page.waitForFunction((i) => document.querySelector('.pc-nav button[aria-current="page"]').getAttribute('data-page') === i, id);
      check(new URL(page.url()).searchParams.get('page') === id, 'URL ' + page.url());
      await page.waitForTimeout(150);
      await noHorizontalScroll(page, 'page ' + id);
    }
    // A 1366 px laptop screen: no page scrolls sideways.
    await page.setViewportSize(PC_SMALL);
    for (const id of ids) {
      await page.click('.pc-nav button[data-page="' + id + '"]');
      await page.waitForFunction((i) => document.querySelector('.pc-nav button[aria-current="page"]').getAttribute('data-page') === i, id);
      await page.waitForTimeout(150);
      await noHorizontalScroll(page, 'page ' + id + ' (1366 px)');
    }
    await page.click('.pc-nav button[data-page="lookup"]');
    await page.setViewportSize(PC);
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
    await tv.waitForFunction((d) => document.querySelector('[data-r="fresh"]').textContent.indexOf(d) >= 0, dataStamp(await stateOf(pc)));
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

  // Projets page: paste references (header line, blank line, duplicate, leading zeros, invalid code), preview, save
  // with the admin key; zones per project (the 2D plan shows the project on the block); rename; references without
  // a project; all references.
  await scenario('pc-projects', async (t) => {
    const page = await t.open('out/pc-projects.html', PC);
    await page.waitForSelector('.tbl.zones tr[data-block]');
    const keys = await keysOf(page);
    const s = await stateOf(page);
    const noProj = s.articles.filter((a) => !a.p).map((a) => a.a);
    const numeric = s.articles.filter((a) => a.p && /^\d+$/.test(a.a)).map((a) => a.a)[0];
    check(noProj.length >= 3 && numeric, 'projets : simulation sans références sans projet ' + JSON.stringify(noProj));
    await t.shot(page, 'pc-projects.png');
    // The new project typed « ZEPHYR » in the field and « zephyr » in a cell is one project (first spelling); an Excel
    // row without its reference is skipped.
    const text = ['Référence\tProjet', '  ' + noProj[0] + '  ', noProj[1].toLowerCase(), '', '00' + numeric + '\tzephyr', noProj[0], 'AB CD',
      'NEWREF99', '\tORPHELIN'].join('\n');
    await page.fill('[data-r="pasteText"]', text);
    await page.fill('[data-r="pasteProject"]', 'ZEPHYR');
    // Keyboard: Ctrl+Entrée in the paste box shows the preview.
    await page.press('[data-r="pasteText"]', 'Control+Enter');
    await page.waitForSelector('[data-r="pasteTable"] tr[data-status]');
    const prev = await page.evaluate(() => ({
      rows: Array.from(document.querySelectorAll('[data-r="pasteTable"] tr[data-status]')).map((tr) => ({ a: tr.getAttribute('data-article'),
        st: tr.getAttribute('data-status'), text: tr.textContent })),
      sum: document.querySelector('[data-r="pasteSummary"]').textContent,
      save: document.querySelector('[data-save="paste"]').textContent
    }));
    const by = {};
    prev.rows.forEach((r) => { by[r.a] = r; });
    check(prev.rows.length === 5, 'aperçu : ' + prev.rows.length + ' lignes ' + JSON.stringify(prev.rows.map((r) => r.a)));
    check(by[numeric] && by[numeric].st === 'change', 'aperçu : 00' + numeric + ' non ramené à ' + numeric + ' (changement)');
    check(by[noProj[1]] && by[noProj[0]] && by[noProj[0]].st !== 'invalid', 'aperçu : références collées ' + JSON.stringify(Object.keys(by)));
    check(/collée 2 fois/.test(by[noProj[0]].text), 'aperçu : doublon non fusionné');
    check(by.NEWREF99 && by.NEWREF99.st === 'new' && /jamais vue/.test(by.NEWREF99.text), 'aperçu : référence nouvelle ' + JSON.stringify(by.NEWREF99));
    check(prev.rows.filter((r) => r.st === 'invalid').length === 1, 'aperçu : une ligne invalide attendue');
    check(/en-tête ignorée/.test(prev.sum) && /1 ligne vide ignorée/.test(prev.sum) && /1 doublon fusionné/.test(prev.sum) && /nouveau projet : ZEPHYR/.test(prev.sum) && !/nouveaux projets/.test(prev.sum) &&
      /1 ligne sans référence ignorée/.test(prev.sum) && !/ORPHELIN/.test(prev.rows.map((r) => r.text).join(' ')),
      'aperçu : résumé « ' + prev.sum.replace(/\s+/g, ' ') + ' »');
    check(prev.save.trim() === 'Enregistrer (4)', 'aperçu : bouton « ' + prev.save + ' »');
    await noHorizontalScroll(page, 'projets');
    await t.shot(page, 'pc-projects-preview.png');
    const v0 = await page.evaluate(() => App.store.versions.data);
    await page.click('[data-save="paste"]');
    await typeKey(page, keys.admin);
    await page.waitForSelector('.toast.ok');
    await page.waitForFunction((v) => App.store.versions.data > v, v0, { timeout: 15000 });
    let st = await stateOf(page);
    const projOf = (state, a) => (state.articles.find((x) => x.a === a) || {}).p;
    check([noProj[0], noProj[1], numeric, 'NEWREF99'].every((a) => projOf(st, a) === 'ZEPHYR'),
      'enregistrement : projets ' + JSON.stringify([noProj[0], noProj[1], numeric, 'NEWREF99'].map((a) => projOf(st, a))));
    await page.waitForSelector('[data-r="preview"] .info-box');
    check(/4 références? (ajoutée|modifiée)/.test(await page.textContent('[data-r="preview"]')) || /Enregistré/.test(await page.textContent('[data-r="preview"]')),
      'enregistrement : message absent');

    // Zones: ZEPHYR on block B5 (typed in lower case: the existing spelling is kept), then the 2D plan.
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#pj-names option')).some((o) => o.value === 'ZEPHYR'));
    await page.fill('[data-add="B5"]', 'zephyr');
    await page.press('[data-add="B5"]', 'Enter');
    await page.waitForSelector('tr[data-block="B5"] .chip >> text=ZEPHYR');
    check(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-add') === 'B5'), 'zones : focus perdu après Entrée');
    const preview = await page.$$eval('[data-r="zonePlan"] text', (e) => e.map((x) => x.textContent));
    check(preview.some((x) => /ZEPHYR/.test(x)), 'zones : aperçu du plan sans ZEPHYR ' + JSON.stringify(preview.slice(0, 12)));
    // A name typed without Entrée is kept and added by « Enregistrer les zones ».
    await page.fill('[data-add="B6"]', 'ZEPHYR');
    await page.waitForFunction(() => /pas encore ajouté/.test(document.querySelector('[data-r="zoneState"]').textContent));
    await t.shot(page, 'pc-projects-zones.png');
    const v1 = await page.evaluate(() => App.store.versions.data);
    await page.click('[data-save="zones"]');
    await page.waitForFunction((v) => App.store.versions.data > v, v1, { timeout: 15000 });
    check(!(await page.$('.modal')), 'zones : clé demandée deux fois');
    st = await stateOf(page);
    const b5 = st.blocks.find((b) => b.id === 'B5');
    check(b5.projects.includes('ZEPHYR') && /ZEPHYR/.test(b5.title), 'zones : bloc B5 ' + JSON.stringify(b5));
    const b6 = st.blocks.find((b) => b.id === 'B6');
    check(b6.projects.includes('ZEPHYR'), 'zones : nom saisi sans Entrée non enregistré ' + JSON.stringify(b6));
    await page.click('.pc-nav button[data-page="plan"]');
    await page.waitForSelector('svg [data-title="B5"]');
    const tag = await page.$$eval('svg [data-title="B5"]', (e) => e.map((x) => x.textContent).join(' / '));
    check(/ZEPHYR/.test(tag), 'plan 2D : bloc B5 « ' + tag + ' »');
    await t.shot(page, 'pc-projects-plan.png');

    // Rename (Enter submits), references without a project, all references.
    await page.click('.pc-nav button[data-page="projects"]');
    await page.waitForSelector('[data-rename="ZEPHYR"]');
    await page.click('[data-rename="ZEPHYR"]');
    await page.waitForSelector('.modal input');
    await page.fill('.modal input', 'ZEPHYR NORD');
    const v2 = await page.evaluate(() => App.store.versions.data);
    await page.press('.modal input', 'Enter');
    await page.waitForFunction((v) => App.store.versions.data > v, v2, { timeout: 15000 });
    st = await stateOf(page);
    check(projOf(st, numeric) === 'ZEPHYR NORD' && /ZEPHYR NORD/.test(st.blocks.find((b) => b.id === 'B5').title), 'renommage : ' + projOf(st, numeric));
    await page.waitForSelector('[data-r="none"] input[data-pick]');
    const picks = await page.$$eval('[data-r="none"] input[data-pick]', (e) => e.map((x) => x.getAttribute('data-pick')));
    check(picks.length === noProj.length - 2 && picks.includes(noProj[2]), 'sans projet : ' + JSON.stringify(picks));
    await page.check('[data-r="none"] input[data-pick="' + noProj[2] + '"]');
    await page.fill('[data-r="noneProject"]', 'ATLAS');
    const v3 = await page.evaluate(() => App.store.versions.data);
    await page.press('[data-r="noneProject"]', 'Enter');
    await page.waitForFunction((v) => App.store.versions.data > v, v3, { timeout: 15000 });
    check(projOf(await stateOf(page), noProj[2]) === 'ATLAS', 'sans projet : affectation');
    await page.fill('[data-r="allQ"]', numeric);
    await page.waitForFunction(() => document.querySelectorAll('[data-r="all"] tr[data-ref]').length === 1);
    await page.selectOption('[data-r="all"] select[data-ref-project]', 'BOREAL');
    await page.waitForSelector('[data-r="allSave"]:not([hidden])');
    const v4 = await page.evaluate(() => App.store.versions.data);
    await page.click('[data-r="allSave"]');
    await page.waitForFunction((v) => App.store.versions.data > v, v4, { timeout: 15000 });
    check(projOf(await stateOf(page), numeric) === 'BOREAL', 'toutes les références : changement de projet');
    // Narrow (1366 px) and wide (1920 px) screens.
    await page.fill('[data-r="allQ"]', '');
    await page.setViewportSize(PC_SMALL);
    await page.waitForTimeout(300);
    await noHorizontalScroll(page, 'projets 1366 px');
    await t.shot(page, 'pc-projects-1366.png');
    await page.setViewportSize(TV);
    await page.waitForTimeout(300);
    await noHorizontalScroll(page, 'projets 1920 px');
    await t.shot(page, 'pc-projects-1920.png');
    // The other screens of the same sheet: TV (3D labels, saturation bars, legend), isometric view, PC twin.
    const tv = await t.open('out/tv.html', TV);
    await tv.waitForSelector('.tv-blocks .tv-brow');
    await tv.waitForTimeout(1500);
    const onTv = await tv.evaluate(() => ({
      bars: Array.from(document.querySelectorAll('.tv-blocks .tv-brow .n')).map((e) => e.textContent + ' | ' + e.title),
      legend: document.querySelector('[data-r="legend"]').textContent,
      labels: Array.from(document.querySelectorAll('.t3d-label.t3d-block')).map((e) => e.textContent),
      kind: document.querySelector('.tv-twin-stage .t3d-canvas') ? '3d' : 'iso'
    }));
    const barOf = (id) => onTv.bars.filter((x) => x.indexOf(id + ' ') === 0)[0] || '';
    // Saturation bars: « B5 ETNA +1 » (two projects), every name in the tooltip.
    check(/^B5 ETNA \+1 \| Bloc B5 · ETNA \/ ZEPHYR NORD$/.test(barOf('B5')) && /^B6 FJORD \+1 \| Bloc B6 · FJORD \/ ZEPHYR NORD$/.test(barOf('B6')),
      'TV : barres B5 / B6 « ' + barOf('B5') + ' » « ' + barOf('B6') + ' »');
    check(/ZEPHYR NORD/.test(onTv.legend) && /BOREAL/.test(onTv.legend), 'TV : légende « ' + onTv.legend + ' »');
    if (onTv.kind === '3d') check(onTv.labels.some((x) => /ZEPHYR NORD/.test(x) && /B5/.test(x)), 'TV 3D : étiquettes ' + JSON.stringify(onTv.labels));
    await t.shot(tv, 'tv-projects.png');
    const iso = await t.open('out/tv.html?no3d=1', TV);
    await iso.waitForSelector('.tv-twin-stage .iso-canvas');
    check(/ZEPHYR NORD/.test(await iso.textContent('[data-r="legend"]')), 'TV isométrique : légende sans ZEPHYR NORD');
    await iso.waitForTimeout(800);
    await t.shot(iso, 'tv-projects-iso.png');
    const twin = await t.open('out/pc-twin.html', PC);
    await twin.waitForSelector('[data-r="side"] .legend span');
    const twinLegend = await twin.$$eval('[data-r="side"] .legend span', (e) => e.map((x) => x.textContent.trim()));
    check(twinLegend.includes('ZEPHYR NORD'), 'jumeau PC : légende ' + JSON.stringify(twinLegend));
    t.note('4 références enregistrées, B5 = ETNA / ZEPHYR NORD, renommage, affectation, changement, TV ' + onTv.kind + ' et isométrique à jour');
  });

  // Sheet sidebars (not in the web app): SidebarProjets.html and Sidebar.html at the 300 px of Google Sheets, their
  // google.script.run on the real sidebar_* functions of Main.gs (same in-memory store as the web pages). Paste with
  // the rules of the web page (header, blank line, spaces, duplicate, invalid code, one project whatever the case),
  // preview, save, blocks of the new project, then the 2D plan shows it; the control panel agrees with the screens.
  await scenario('sheet-sidebars', async (t) => {
    const SIDE = { width: 300, height: 1000 };
    const sp = await t.ctx.newPage();
    await sp.setViewportSize(SIDE);
    await sp.goto(base + 'out/sidebar-projets.html');
    await sp.waitForSelector('#projects .proj', { timeout: 30000 });
    await noHorizontalScroll(sp, 'panneau Projets');
    // The label of the project field is one line of text (not « 2 / e / colonne » stacked by the flex label).
    const label = await sp.evaluate(() => Math.round(document.querySelector('label span').getBoundingClientRect().height));
    check(label <= 22, 'panneau Projets : libellé du champ projet sur ' + label + ' px de haut');
    await t.shot(sp, 'sidebar-projets.png', { fullPage: true });
    const arts = await sp.evaluate(() => window.__harness.Repo.loadState().articles);
    const noProj = arts.filter((a) => !a.p).map((a) => a.a);
    const numeric = arts.filter((a) => a.p && /^\d+$/.test(a.a)).map((a) => a.a)[0];
    check(noProj.length >= 2 && numeric, 'panneau Projets : références de test ' + JSON.stringify(noProj));
    await sp.fill('#paste', ['Référence\tProjet', '  ' + noProj[0] + '  ', noProj[1].toLowerCase(), '', '00' + numeric + '\tzephyr', noProj[0], 'AB CD',
      'NEWREF98'].join('\n'));
    await sp.fill('#project', 'ZEPHYR');
    await sp.click('#btnPreview');
    await sp.waitForSelector('#preview .ref');
    const prev = await sp.evaluate(() => ({ counts: document.querySelector('#preview .counts').textContent, notes: document.querySelector('#preview .notes').textContent,
      rows: Array.from(document.querySelectorAll('#preview .ref')).map((e) => e.textContent), save: document.getElementById('btnSave').textContent }));
    check(prev.rows.length === 5 && /1 invalide/.test(prev.counts) && /AB CD/.test(prev.rows[0]) && /Espace dans la référence/.test(prev.rows[0]),
      'panneau Projets : aperçu ' + JSON.stringify(prev));
    check(/ligne d’en-tête ignorée/.test(prev.notes) && /1 ligne vide ignorée/.test(prev.notes) && /1 doublon fusionné/.test(prev.notes) &&
      /nouveau projet : ZEPHYR$/.test(prev.notes), 'panneau Projets : notes « ' + prev.notes + ' » (un seul nouveau projet attendu)');
    check(prev.save === 'Enregistrer (4)', 'panneau Projets : bouton « ' + prev.save + ' »');
    await t.shot(sp, 'sidebar-projets-preview.png', { fullPage: true });
    await sp.click('#btnSave');
    await sp.waitForFunction(() => /^Références enregistrées/.test(document.getElementById('msg').textContent), null, { timeout: 20000 });
    const saved = await sp.evaluate(() => ({ arts: window.__harness.Repo.readArticles().map((a) => [a.article, a.project]), toasts: window.__sheet.toasts }));
    const proj = {};
    saved.arts.forEach(([a, p]) => { proj[a] = p; });
    check([noProj[0], noProj[1], numeric, 'NEWREF98'].every((a) => proj[a] === 'ZEPHYR'),
      'panneau Projets : projets enregistrés ' + JSON.stringify([noProj[0], noProj[1], numeric, 'NEWREF98'].map((a) => proj[a])));
    check(saved.toasts.some((x) => /^Références enregistrées/.test(x)), 'panneau Projets : pas de message dans le classeur');
    // Blocks of the new project: B5, then « Enregistrer les zones ».
    const i = await sp.evaluate(() => Array.from(document.querySelectorAll('#projects .proj b')).map((b) => b.textContent).indexOf('ZEPHYR'));
    check(i >= 0, 'panneau Projets : ZEPHYR absent de la liste des projets');
    await sp.click('#projects .chip[data-p="' + i + '"][data-b="B5"]');
    await sp.click('#btnZones');
    await sp.waitForFunction(() => /^Projets enregistrés/.test(document.getElementById('msgZones').textContent), null, { timeout: 20000 });
    const z = await sp.evaluate(() => window.__harness.Repo.readProjects().filter((p) => p.project === 'ZEPHYR')[0]);
    check(z && z.blocks.join(',') === 'B5', 'panneau Projets : zones de ZEPHYR ' + JSON.stringify(z));
    await noHorizontalScroll(sp, 'panneau Projets après enregistrement');
    await t.shot(sp, 'sidebar-projets-saved.png', { fullPage: true });
    // The web page shows the project of the sidebar on its block.
    const plan = await t.open('out/pc-plan.html', PC);
    await plan.waitForSelector('svg [data-title="B5"]');
    const tag = await plan.$$eval('svg [data-title="B5"]', (e) => e.map((x) => x.textContent).join(' / '));
    check(/ZEPHYR/.test(tag), 'plan 2D après le panneau : bloc B5 « ' + tag + ' »');
    const want = await plan.evaluate(() => ({ crit: App.store.state.kpi.pendingCrit, oldest: App.fmt.hm(App.oldestWaitHours(App.store.state)) }));
    // Control panel: the PRD2 figures are those of the screens.
    const cp = await t.ctx.newPage();
    await cp.setViewportSize(SIDE);
    await cp.goto(base + 'out/sidebar.html');
    await cp.waitForSelector('#status dl', { timeout: 30000 });
    const rows = await cp.evaluate(() => {
      const out = {};
      const dts = document.querySelectorAll('#status dt');
      dts.forEach((dt) => { out[dt.textContent] = dt.nextElementSibling.textContent; });
      return out;
    });
    check(rows['PRD2 > 6 h'] === want.crit + ' pal', 'panneau de contrôle : PRD2 > 6 h « ' + rows['PRD2 > 6 h'] + ' » au lieu de ' + want.crit + ' pal');
    check((rows['En attente PRD2'] || '').indexOf('(' + want.oldest + ')') >= 0, 'panneau de contrôle : attente « ' + rows['En attente PRD2'] + ' » au lieu de ' + want.oldest);
    await noHorizontalScroll(cp, 'panneau de contrôle');
    await t.shot(cp, 'sidebar.png', { fullPage: true });
    t.note('4 références ZEPHYR, bloc B5, plan à jour, panneau de contrôle : ' + rows['PRD2 > 6 h'] + ' > 6 h, ' + want.oldest);
  });

  // Simulation page: « Télécharger un MB51 simulé (.xlsx) » writes the real 22-column format in the browser; the file
  // goes through the import page (empty base) and the finished-goods filter drops the noise lines.
  await scenario('pc-simulation-mb51', async (t) => {
    const page = await t.open('out/pc-simulation.html', PC);
    await page.waitForSelector('[data-dl]');
    check(/Étiquettes par jour/.test(await page.textContent('.sim-card')), 'simulation : paramètre « Étiquettes par jour » absent');
    await page.fill('[data-r="days"]', '2');
    await page.fill('[data-r="ppd"]', '100');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-dl]')]);
    const name = download.suggestedFilename();
    check(/^MB51_simule_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx$/.test(name), 'simulation : fichier « ' + name + ' »');
    const file = path.join(SHOTS, name);
    await download.saveAs(file);
    await page.waitForSelector('[data-r="dlMsg"] .ok-t');
    const msg = await page.textContent('[data-r="dlMsg"]');
    const rows = Number(digits(/· ([\d\s\u00a0\u202f]+) lignes/.exec(msg)[1]));
    const imp = await t.open('out/pc-import.html?empty=1', PC);
    await imp.waitForSelector('[data-r="lib"] .ok-t', { timeout: 30000 });
    await imp.setInputFiles('input[type=file]', file);
    await imp.waitForSelector('[data-save]:not([disabled])', { timeout: 60000 });
    const r = await imp.evaluate(() => ({ format: document.querySelector('[data-r="format"]').textContent, filter: document.querySelector('[data-r="filter"]').textContent }));
    check(/^Format MB51 reconnu : 22 colonnes · heure de saisie ✓ · étiquettes ✓ \(/.test(r.format.trim()), 'import du MB51 simulé : « ' + r.format + ' »');
    const m = /^([\d\s\u00a0]+) lignes gardées \(produits finis\) · ([\d\s\u00a0]+) ignorées/.exec(r.filter.trim());
    check(m && Number(digits(m[2])) > 0 && Number(digits(m[1])) + Number(digits(m[2])) === rows, 'import du MB51 simulé : « ' + r.filter + ' » pour ' + rows + ' lignes');
    fs.unlinkSync(file);
    await t.shot(imp, 'pc-import-simulated-mb51.png');
    // Round trip: save on the empty base, then every simulated line is stored as generated (the noise is not).
    const keys = await keysOf(imp);
    await imp.click('[data-save]');
    await typeKey(imp, keys.admin);
    await imp.waitForSelector('[data-r="result"] .stat', { timeout: 60000 });
    await imp.waitForFunction((n) => App.store.state && App.store.state.stats && App.store.state.stats.movements === n,
      Number(digits(m[1])), { timeout: 15000 });
    const [, start, end] = /^MB51_simule_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.xlsx$/.exec(name);
    const rt = await imp.evaluate(({ start, end }) => {
      const s = App.store.state;
      const gen = Sim.generate({ days: 2, endDate: end, seed: 2026, palletsPerDay: 100, blocks: s.layout.blocks });
      const stored = new Map(window.__harness.Repo.dump().movements.map((x) => [x.key, x]));
      const fields = ['article', 'division', 'magasin', 'mvt', 'text', 's', 'doc', 'date', 'qty', 'uqs', 'designation', 'user', 'ts', 'label',
        'headerText', 'itemText', 'reference', 'client', 'salesOrder'];
      const diffs = [];
      gen.movements.forEach((g) => {
        const x = stored.get(g.key);
        if (!x) return diffs.push(g.key + ' absent');
        fields.forEach((f) => {
          if (String(x[f] === undefined ? '' : x[f]) !== String(g[f] === undefined ? '' : g[f])) diffs.push(g.key + ' ' + f + ' ' + x[f] + ' != ' + g[f]);
        });
        if (x.source !== 'IMPORT') diffs.push(g.key + ' source ' + x.source);
      });
      return { start: gen.params.startDate, generated: gen.movements.length, stored: stored.size, diffs: diffs.slice(0, 5), nDiffs: diffs.length,
        asOf: s.asOf, source: s.source, pendingCrit: s.kpi.pendingCrit, over6h: gen.facts.pendingOver6h.length };
    }, { start, end });
    check(rt.start === start && rt.generated === Number(digits(m[1])) && rt.stored === rt.generated && !rt.nDiffs,
      'aller-retour MB51 simulé : ' + JSON.stringify(rt));
    check(rt.source === 'SAP' && rt.asOf === end && rt.pendingCrit === rt.over6h, 'aller-retour MB51 simulé : état ' + JSON.stringify(rt));
    await t.shot(imp, 'pc-import-simulated-mb51-result.png');
    t.note(name + ' : ' + rows + ' lignes, ' + r.filter.trim() + ', ' + rt.stored + ' enregistrées à l’identique');
  });

  // Simulation page « Générer » (confirmation, admin key), then « +1 jour »: after each, the TV, the pending page and
  // the alert text give the same PRD2 figures (pallets over 6 h, oldest wait to the minute).
  await scenario('pc-simulation-generate', async (t) => {
    const pc = await t.open('out/pc-simulation.html', PC);
    await pc.waitForSelector('.kv');
    const keys = await keysOf(pc);
    await pc.fill('[data-r="days"]', '3');
    await pc.fill('[data-r="ppd"]', '150');
    check((await pc.textContent('[data-act="simulate"]')).trim() === 'Générer 3 jours', 'simulation : bouton « ' + await pc.textContent('[data-act="simulate"]') + ' »');
    const v0 = await pc.evaluate(() => App.store.versions.data);
    await pc.click('[data-act="simulate"]');
    await pc.waitForSelector('.modal .btn.p');
    check(/Remplacer la simulation/.test(await pc.textContent('.modal')), 'simulation : pas de confirmation avant de remplacer');
    await pc.click('.modal .btn.p');
    await typeKey(pc, keys.admin);
    await pc.waitForFunction((v) => App.store.versions.data > v && App.store.state && App.store.state.stats, v0, { timeout: 60000 });
    async function same(label) {
      const s = await stateOf(pc);
      const crit = s.alerts.filter((a) => a.code === 'PRD2_CRIT')[0];
      const tv = await t.open('out/tv.html', TV);
      await tv.waitForSelector('.scene-overview .tv-kpi');
      const onTv = await tv.evaluate(() => ({ s: document.querySelector('[data-r="pendingCrit"]') ? document.querySelector('[data-r="pendingCrit"]').parentNode.querySelector('.s').textContent : '',
        tile: (document.querySelector('[data-r="pendingCrit"]') || {}).textContent || '', asOf: App.store.state.asOf }));
      const pend = await t.open('out/pc-pending.html', PC);
      await pend.waitForSelector('.pend-sum');
      const onPc = await pend.evaluate(() => ({ crit: document.querySelector('[data-r="critCount"]').textContent, oldest: document.querySelector('[data-r="oldest"]').textContent.trim(),
        first: (document.querySelector('tr[data-article] .chipd') || {}).textContent }));
      check(onTv.asOf === s.asOf, label + ' : TV au ' + onTv.asOf + ' au lieu du ' + s.asOf);
      check(onTv.tile.replace(/\s+/g, ' ') === 'dont > 6 h : ' + frNum(s.kpi.pendingCrit), label + ' : tuile TV « ' + onTv.tile + ' »');
      check(onTv.s === 'plus ancienne : ' + onPc.oldest && onPc.first.trim() === onPc.oldest, label + ' : attente TV « ' + onTv.s + ' », page « ' + onPc.oldest + ' », 1re ligne « ' + onPc.first + ' »');
      if (crit) check(crit.text.indexOf('depuis ' + onPc.oldest + ' ') > 0, label + ' : alerte « ' + crit.text + ' » au lieu de ' + onPc.oldest);
      check(Number(digits(onPc.crit)) === s.pending.filter((p) => p.label && p.level === 'crit').length, label + ' : ' + onPc.crit + ' étiquettes > 6 h');
      await tv.close();
      await pend.close();
      return s.asOf + ' · ' + s.kpi.pendingCrit + ' > 6 h · ' + onPc.oldest;
    }
    const a = await same('simulation générée');
    await t.shot(pc, 'pc-simulation-generated.png');
    const v1 = await pc.evaluate(() => App.store.versions.data);
    await pc.click('[data-act="next"]');
    await pc.waitForFunction((v) => App.store.versions.data > v, v1, { timeout: 30000 });
    check(!(await pc.$('.modal .key-input')), '+1 jour : clé demandée deux fois');
    const b = await same('+1 jour');
    t.note('3 jours : ' + a + ' ; +1 jour : ' + b);
  });

  // En attente: one row per label, red from pendingHoursCrit, amber from pendingHoursWarn, project filter.
  await scenario('pc-pending-hours', async (t) => {
    const page = await t.open('out/pc-pending.html', PC);
    await page.waitForSelector('tr[data-article]');
    const s = await stateOf(page);
    const thr = s.thresholds;
    const rows = await page.$$eval('tr[data-article]', (e) => e.map((tr) => ({ cls: tr.className, h: tr.getAttribute('data-hours'),
      chip: tr.querySelector('.chipd').className, ink: getComputedStyle(tr.querySelector('.chipd')).color,
      bg: getComputedStyle(tr.children[0]).backgroundColor, project: tr.children[3].textContent.trim() })));
    const timed = rows.filter((r) => r.h !== '');
    check(timed.length === rows.length && rows.length === s.pending.length, 'attente : ' + timed.length + ' lignes avec heure sur ' + rows.length);
    const bad = timed.filter((r) => {
      const h = Number(r.h);
      const want = h >= thr.pendingHoursCrit ? 'lv-crit' : h >= thr.pendingHoursWarn ? 'lv-warn' : '';
      return want ? r.cls.indexOf(want) < 0 : /lv-/.test(r.cls);
    });
    check(!bad.length, 'attente : couleur fausse ' + JSON.stringify(bad.slice(0, 3)));
    const crit = timed.filter((r) => Number(r.h) >= thr.pendingHoursCrit);
    check(crit.length >= 1, 'attente : aucune étiquette de plus de 6 h dans la simulation');
    const rgb = (c) => (/rgba?\((\d+), (\d+), (\d+)/.exec(c) || []).slice(1).map(Number);
    // Red: pale red row, dark red waiting time.
    const red = (r) => / c\b/.test(r.chip) && rgb(r.ink)[0] > rgb(r.ink)[1] + 80 && rgb(r.bg)[0] > rgb(r.bg)[1] + 8;
    check(crit.every(red), 'attente : lignes de plus de 6 h pas en rouge ' + JSON.stringify(crit.filter((r) => !red(r))[0]));
    check(!timed.filter((r) => Number(r.h) < thr.pendingHoursCrit).some(red), 'attente : ligne de moins de 6 h en rouge');
    const head = await page.evaluate(() => ({ crit: document.querySelector('[data-r="critCount"]').textContent, oldest: document.querySelector('[data-r="oldest"]').textContent }));
    const labeledCrit = s.pending.filter((p) => p.label && p.level === 'crit').length;
    check(Number(digits(head.crit)) === labeledCrit, 'attente : en-tête ' + head.crit + ' > 6 h au lieu de ' + labeledCrit);
    await t.shot(page, 'pc-pending-hours.png');
    // Filters: level, then project (and back).
    await page.selectOption('[data-r="fLevel"]', 'crit');
    await page.waitForFunction((n) => document.querySelectorAll('tr[data-article]').length === n, crit.length);
    await page.selectOption('[data-r="fLevel"]', '');
    const project = rows.map((r) => r.project).filter((p) => p && p !== '—')[0];
    await page.selectOption('[data-r="fProject"]', project);
    const shown = await page.$$eval('tr[data-article]', (e) => e.map((tr) => tr.children[3].textContent.trim()));
    check(shown.length >= 1 && shown.every((p) => p === project), 'filtre projet ' + project + ' : ' + JSON.stringify(shown));
    check(shown.length === rows.filter((r) => r.project === project).length, 'filtre projet : ' + shown.length + ' lignes');
    check(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-r') === 'fProject'), 'filtre : focus perdu');
    t.note(rows.length + ' étiquettes, ' + crit.length + ' > ' + thr.pendingHoursCrit + ' h, filtre ' + project + ' : ' + shown.length);
  });

  // TV: the > 6 h alert first in the ticker, « dont > 6 h : n » in the pending tile, red ghosts in the legend.
  await scenario('tv-prd2-alert', async (t) => {
    const page = await t.open('out/tv.html', TV);
    await page.waitForSelector('.tv-ticker-track span');
    await page.waitForSelector('[data-r="pendingCrit"]');
    const s = await stateOf(page);
    const k = s.kpi;
    check(k.pendingCrit > 0, 'TV : simulation sans palette de plus de 6 h');
    const r = await page.evaluate(() => ({
      first: (() => { const e = document.querySelector('.tv-ticker-track span'); return { code: e.getAttribute('data-code'), text: e.textContent, cls: e.className }; })(),
      tile: (() => { const e = document.querySelector('[data-r="pendingCrit"]'); return { text: e.textContent, cls: e.className, color: getComputedStyle(e).color }; })(),
      sub: document.querySelector('[data-r="pendingCrit"]').parentNode.querySelector('.s').textContent,
      legend: document.querySelector('[data-r="legend"]').textContent
    }));
    check(r.first.code === 'PRD2_CRIT' && r.first.cls === 'crit', 'TV : premier élément du bandeau ' + JSON.stringify(r.first));
    check(r.first.text.indexOf(frNum(k.pendingCrit) + ' palette') >= 0 && /depuis plus de 6 h/.test(r.first.text), 'TV : bandeau « ' + r.first.text + ' »');
    check(r.tile.text.replace(/\s+/g, ' ') === 'dont > 6 h : ' + frNum(k.pendingCrit) && /\bcrit\b/.test(r.tile.cls), 'TV : tuile « ' + r.tile.text + ' »');
    const rgb = (/rgba?\((\d+), (\d+), (\d+)/.exec(r.tile.color) || []).slice(1).map(Number);
    check(rgb[0] > rgb[1] + 60, 'TV : « dont > 6 h » pas en rouge (' + r.tile.color + ')');
    check(/plus ancienne : \d+ h \d{2}/.test(r.sub), 'TV : plus ancienne attente « ' + r.sub + ' »');
    check(/> 6 h/.test(r.legend) && s.projectsList.filter((p) => p.project !== 'Sans projet').every((p) => r.legend.indexOf(p.project) >= 0),
      'TV : légende « ' + r.legend + ' »');
    await page.goto(base + 'out/tv.html?scene=pending');
    await page.waitForSelector('.scene-pending.on .tv-table tbody tr');
    await page.waitForTimeout(300);
    const scene = await page.evaluate(() => ({ crit: document.querySelectorAll('.scene-pending tr.lv-crit').length,
      tiles: Array.from(document.querySelectorAll('.scene-pending .tv-kpi .v')).map((e) => e.textContent.trim()) }));
    check(scene.crit === s.pending.filter((p) => p.level === 'crit').length, 'TV attente : ' + scene.crit + ' lignes rouges');
    t.note(k.pendingCrit + ' pal > 6 h, plus ancienne ' + k.oldestPendingHours + ' h');
    await t.shot(page, 'tv-prd2-alert.png');
  });

  // The user's real MB51 export through the import page on an empty base: format line, finished-goods filter,
  // saved lines, then 86 labels over 6 h on the pending page and on the TV.
  await scenario('pc-import-real', async (t) => {
    const E = REAL_EXPECTED.normalize;
    const page = await t.open('out/pc-import.html?empty=1', PC);
    await page.waitForSelector('[data-r="lib"] .ok-t', { timeout: 30000 });
    const keys = await keysOf(page);
    check(!(await page.isChecked('[data-r="all"]')), 'import : case « hors produits finis » cochée par défaut');
    await page.setInputFiles('input[type=file]', REAL_FILE);
    await page.waitForSelector('[data-save]:not([disabled])', { timeout: 60000 });
    const r = await page.evaluate(() => ({ format: document.querySelector('[data-r="format"]').textContent,
      filter: document.querySelector('[data-r="filter"]').textContent, save: document.querySelector('[data-save]').textContent }));
    const wantFormat = 'Format MB51 reconnu : 22 colonnes · heure de saisie ✓ · étiquettes ✓ (' + frNum(E.withLabel) + ')';
    check(r.format.trim() === wantFormat, 'import : « ' + r.format + ' » au lieu de « ' + wantFormat + ' »');
    const wantFilter = frNum(E.kept) + ' lignes gardées (produits finis) · ' + frNum(E.dropped) + ' ignorées (' + frNum(E.droppedArticles) + ' articles hors produits finis)';
    check(r.filter.trim() === wantFilter, 'import : « ' + r.filter + ' » au lieu de « ' + wantFilter + ' »');
    const toSave = Number(digits(r.save));
    check(toSave > 0 && toSave <= E.kept, 'import : bouton « ' + r.save + ' »');
    await t.shot(page, 'pc-import-real.png');
    // The box changes the analysis at once (every article), and back.
    await page.check('[data-r="all"]');
    await page.waitForFunction(() => /désactivé/.test(document.querySelector('[data-r="filter"]').textContent));
    await page.uncheck('[data-r="all"]');
    await page.waitForFunction((w) => document.querySelector('[data-r="filter"]').textContent.trim() === w, wantFilter);
    await page.click('[data-save]');
    await typeKey(page, keys.admin);
    await page.waitForSelector('[data-r="result"] .stat', { timeout: 60000 });
    const stats = await page.$$eval('[data-r="result"] .stat .v', (e) => e.map((x) => x.textContent.trim()));
    check(Number(digits(stats[0])) === toSave && digits(stats[1]) === '0', 'import : résultat ' + JSON.stringify(stats));
    await page.waitForFunction(() => App.store.state && App.store.state.stats && App.store.state.stats.movements > 0, null, { timeout: 15000 });
    const s = await stateOf(page);
    check(s.asOfTs === REAL_EXPECTED.engine.asOfTs, 'import : heure des données ' + s.asOfTs);
    // The 6 h alert in the result, before the figures.
    const box = await page.textContent('[data-r="result"] [data-r="prd2"]');
    check(box.indexOf(REAL_EXPECTED.engine.pending.crit + ' palettes en PRD2 depuis plus de 6 h (la plus ancienne : 44 h 02)') === 0, 'import : encadré PRD2 « ' + box + ' »');
    await t.shot(page, 'pc-import-real-result.png');
    await page.click('[data-r="result"] [data-go="pending"]');
    await page.waitForSelector('[data-r="critCount"]');
    const head = await page.evaluate(() => ({ crit: document.querySelector('[data-r="critCount"]').textContent, oldest: document.querySelector('[data-r="oldest"]').textContent,
      sum: document.querySelector('.pend-sum').textContent, red: document.querySelectorAll('tr.lv-crit[data-hours]').length }));
    check(digits(head.crit) === String(REAL_EXPECTED.engine.pending.crit), 'attente : ' + head.crit + ' étiquettes > 6 h au lieu de ' + REAL_EXPECTED.engine.pending.crit);
    check(head.oldest.trim() === '44 h 02' && /05\/10 22:09/.test(head.sum), 'attente : « ' + head.sum.replace(/\s+/g, ' ') + ' »');
    check(head.red >= REAL_EXPECTED.engine.pending.crit, 'attente : ' + head.red + ' lignes rouges');
    // Labels: 86 red, 11 amber, the oldest first, every wait written « 44 h 02 ».
    const lines = await page.evaluate(() => Array.from(document.querySelectorAll('tr[data-article]')).map((tr) => ({ lvl: tr.getAttribute('data-level'),
      h: tr.getAttribute('data-hours'), label: !/sans étiquette/.test(tr.children[0].textContent), wait: tr.querySelector('.chipd').textContent.trim() })));
    const labeled = lines.filter((x) => x.label);
    check(labeled.filter((x) => x.lvl === 'crit').length === REAL_EXPECTED.engine.pending.crit && labeled.filter((x) => x.lvl === 'warn').length === REAL_EXPECTED.engine.pending.warn,
      'attente : ' + labeled.filter((x) => x.lvl === 'crit').length + ' rouges / ' + labeled.filter((x) => x.lvl === 'warn').length + ' orange');
    const hours = labeled.map((x) => Number(x.h));
    check(hours.every((h, i) => i === 0 || h <= hours[i - 1]), 'attente : étiquettes pas triées de la plus ancienne à la plus récente');
    check(labeled.every((x) => /^\d+ h \d{2}$/.test(x.wait)), 'attente : durée mal écrite ' + JSON.stringify(labeled.filter((x) => !/^\d+ h \d{2}$/.test(x.wait)).slice(0, 3)));
    await noHorizontalScroll(page, 'attente (données réelles)');
    await t.shot(page, 'pc-pending-real.png');
    // The oldest label opens its article: quantity per pallet learned from the labels, the label waiting 44 h 02 in red.
    const old = REAL_EXPECTED.engine.pending.oldest;
    await page.click('tr[data-article="' + old.article + '"]');
    await page.waitForSelector('.stats .stat');
    const lk = await page.evaluate((label) => ({
      desc: document.querySelector('[data-r="desc"]').textContent,
      row: (() => {
        const tr = Array.from(document.querySelectorAll('tr.lv-crit')).find((x) => x.textContent.indexOf(label) >= 0);
        return tr ? tr.textContent : '';
      })()
    }), old.label);
    const qpp = REAL_EXPECTED.engine.learnedQpp[old.article];
    check(lk.desc.indexOf(qpp + ' PCE / palette (apprise des étiquettes)') >= 0 && /sans projet/.test(lk.desc), 'fiche : « ' + lk.desc + ' »');
    check(/44 h 02/.test(lk.row), 'fiche : étiquette ' + old.label + ' en attente « ' + lk.row + ' »');
    await t.shot(page, 'pc-lookup-real.png');
    const tv = await t.open('out/tv.html?empty=1', TV);
    await tv.waitForSelector('.tv-ticker-track span[data-code="PRD2_CRIT"]');
    const first = await tv.$eval('.tv-ticker-track span', (e) => e.getAttribute('data-code'));
    check(first === 'PRD2_CRIT', 'TV (données réelles) : bandeau ' + first);
    const crit = frNum(REAL_EXPECTED.engine.pending.crit);
    const tvCrit = await tv.evaluate(() => ({ tile: document.querySelector('[data-r="pendingCrit"]').textContent.replace(/\s+/g, ' ').trim(),
      tick: document.querySelector('.tv-ticker-track span[data-code="PRD2_CRIT"]').textContent }));
    check(tvCrit.tile === 'dont > 6 h : ' + crit, 'TV (données réelles) : tuile « ' + tvCrit.tile + ' »');
    check(tvCrit.tick.replace(/^[^\d]+/, '').indexOf(crit + ' palettes en PRD2 depuis plus de 6 h · max 44 h 02') === 0,
      'TV (données réelles) : bandeau « ' + tvCrit.tick + ' »');
    check(/^Données SAP jusqu’au 05\/10\/2026 22:09/.test(await tv.textContent('[data-r="fresh"]')), 'TV (données réelles) : en-tête');
    // SAP data: no simulation strip, the scenes keep their rows (ticker at the bottom, 3D view full height).
    const lay = await tv.evaluate(() => ({
      sim: !document.querySelector('[data-r="sim"]').offsetParent,
      ticker: Math.round(document.querySelector('.tv-ticker').getBoundingClientRect().bottom),
      stage: Math.round(document.querySelector('.tv-twin-stage').getBoundingClientRect().height),
      cut: Array.from(document.querySelectorAll('.scene-overview .tv-kpi .s, .scene-overview .tv-kpi .l')).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
      ticks: Array.from(document.querySelectorAll('.tv-ticker-track span')).map((e) => e.textContent)
    }));
    check(lay.sim && lay.ticker === TV.height && lay.stage > 500, 'TV (données réelles) : mise en page ' + JSON.stringify(lay));
    check(!lay.cut.length, 'TV (données réelles) : texte coupé ' + JSON.stringify(lay.cut));
    check(lay.ticks.every((x) => x.length <= 70), 'TV (données réelles) : bandeau trop long ' + JSON.stringify(lay.ticks.filter((x) => x.length > 70)));
    await tv.waitForTimeout(1000);
    await t.shot(tv, 'tv-real.png');
    t.note(frNum(E.kept) + ' gardées / ' + frNum(E.dropped) + ' ignorées, ' + toSave + ' enregistrées, ' + digits(head.crit) + ' > 6 h');
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
    // --lang: native controls (input type=date) follow the browser language, not the context locale.
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--lang=fr-FR']
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
