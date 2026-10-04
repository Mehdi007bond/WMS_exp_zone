#!/usr/bin/env node
/**
 * EXP2 Digital Twin - local harness builder (npm run harness).
 *
 * Builds tests/harness/out/: every screen of the web app as a static page that runs without Google.
 *   tv.html             doGet({ mode: 'tv' })
 *   pc-<page>.html      doGet({ page }) for every page of WEB_PAGES_ (Main.gs)
 *   index.html          links to the pages and the harness query flags
 *   backend/*.js        Config, Normalize, Engine, Simulation, Api (copies of the .gs files), repo-memory.js, shim.js
 *
 * The pages are rendered the way Apps Script renders them: the .gs files are loaded in one Node vm context
 * (one global scope, like Apps Script) with a stand-in HtmlService, and the real doGet() is called. Its
 * createTemplateFromFile('Index') evaluates the Index.html scriptlets (<? ?>, <?= ?>, <?!= ?>) with the template
 * variables set by doGet, so include_() returns the HTML file content and moduleSource_() the same string as in
 * Apps Script. Then, for the harness only:
 *   - the CDN URLs (three.js, SheetJS) point to ../vendor/three.min.js and ../vendor/xlsx.full.min.js;
 *   - the <head> gets the title and viewport meta that doGet sets on the HtmlOutput, and the in-browser server:
 *     the server modules plus tests/harness/shim.js (google.script.run on an in-memory Repo, seeded with a
 *     simulation on first load). See shim.js for the query flags (?empty=1, ?poll=2, ?no3d=1, ...).
 *
 * Open the pages over HTTP from tests/harness/ (e2e.js does) or directly as files.
 * Module use: require('./build.js').build({ out }) -> { out, pages: [{ file, mode, page, title }], warnings }.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'apps-script', 'src');
const HARNESS = __dirname;
const VENDOR = path.join(HARNESS, 'vendor');
const DEFAULT_OUT = path.join(HARNESS, 'out');

// Server modules loaded by the pages, in this order (the shim needs all of them).
const BACKEND = [
  ['Config.js', path.join(SRC, 'Config.gs')],
  ['Normalize.js', path.join(SRC, 'Normalize.gs')],
  ['Engine.js', path.join(SRC, 'Engine.gs')],
  ['Simulation.js', path.join(SRC, 'Simulation.gs')],
  ['repo-memory.js', path.join(HARNESS, 'repo-memory.js')],
  ['Api.js', path.join(SRC, 'Api.gs')],
  ['shim.js', path.join(HARNESS, 'shim.js')]
];

// CDN libraries -> local copies (tests/harness/vendor, next to out/).
const CDN = [
  { re: /https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r\d+\/three(?:\.min)?\.js/g, local: '../vendor/three.min.js', file: 'three.min.js' },
  { re: /https:\/\/cdn\.sheetjs\.com\/xlsx-[0-9.]+\/package\/dist\/xlsx\.full\.min\.js/g, local: '../vendor/xlsx.full.min.js', file: 'xlsx.full.min.js' }
];

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------------------------------------------
// Apps Script stand-ins: HtmlService (templates, HtmlOutput) for doGet / include
// ---------------------------------------------------------------------------------------------------------------
function htmlFile(name) {
  const file = path.join(SRC, String(name) + '.html');
  if (!fs.existsSync(file)) throw new Error('No HTML file named ' + name + ' was found.');
  return fs.readFileSync(file, 'utf8');
}

function htmlOutput(content) {
  return {
    content: content,
    title: '',
    metas: [],
    xframe: null,
    getContent() { return this.content; },
    setContent(c) { this.content = c; return this; },
    append(c) { this.content += c; return this; },
    getTitle() { return this.title; },
    setTitle(t) { this.title = String(t); return this; },
    addMetaTag(name, content) { this.metas.push({ name: String(name), content: String(content) }); return this; },
    setXFrameOptionsMode(m) { this.xframe = m; return this; },
    setSandboxMode() { return this; },
    setWidth() { return this; },
    setHeight() { return this; },
    setFaviconUrl() { return this; }
  };
}

/** Compiles an Apps Script HTML template: <? code ?>, <?= escaped ?>, <?!= raw ?>. */
function compileTemplate(source, fileName) {
  const parts = [];
  const re = /<\?(!=|=)?([\s\S]*?)\?>/g;
  let last = 0, m;
  while ((m = re.exec(source))) {
    if (m.index > last) parts.push('__out.push(' + JSON.stringify(source.slice(last, m.index)) + ');');
    const code = m[2].trim();
    if (m[1] === '=') parts.push('__out.push(__esc(' + code + '));');
    else if (m[1] === '!=') parts.push('__out.push(__raw(' + code + '));');
    else parts.push(code);
    last = re.lastIndex;
  }
  if (last < source.length) parts.push('__out.push(' + JSON.stringify(source.slice(last)) + ');');
  return '(function (__vars, __esc, __raw) { with (__vars) { var __out = [];\n' + parts.join('\n') +
    '\nreturn __out.join(\'\'); } })\n//# sourceURL=' + fileName;
}

function makeServer() {
  let ctx;
  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME', NATIVE: 'NATIVE', EMULATED: 'EMULATED' },
    createHtmlOutput(html) { return htmlOutput(html === undefined ? '' : String(html)); },
    createHtmlOutputFromFile(name) { return htmlOutput(htmlFile(name)); },
    createTemplate(source) { return template(String(source), 'template'); },
    createTemplateFromFile(name) { return template(htmlFile(name), name + '.html'); }
  };
  function template(source, fileName) {
    const t = {};
    Object.defineProperty(t, 'evaluate', {
      enumerable: false,
      value: function () {
        const fn = vm.runInContext(compileTemplate(source, fileName), ctx);
        const vars = {};
        Object.keys(t).forEach((k) => { vars[k] = t[k]; });
        const out = fn(vars, (v) => escHtml(v === null || v === undefined ? '' : v),
          (v) => (v === null || v === undefined ? '' : String(v)));
        return htmlOutput(out);
      }
    });
    Object.defineProperty(t, 'getRawContent', { enumerable: false, value: () => source });
    return t;
  }
  ctx = vm.createContext({ console, Math, Date, JSON, HtmlService });
  // Every .gs file in one global scope, in the order clasp pushes them (alphabetical).
  fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().forEach((f) => {
    const file = path.join(SRC, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  });
  ['doGet', 'include_', 'moduleSource_'].forEach((fn) => {
    if (typeof ctx[fn] !== 'function') throw new Error('Main.gs : fonction ' + fn + ' absente.');
  });
  return ctx;
}

// ---------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------
function harnessHead(output, fileName) {
  const lines = [];
  if (output.title) lines.push('<title>' + escHtml(output.title) + '</title>');
  output.metas.forEach((m) => lines.push('<meta name="' + escHtml(m.name) + '" content="' + escHtml(m.content) + '">'));
  lines.push('<!-- Local harness page (tests/harness/build.js): in-browser server = backend/*.js + backend/shim.js. -->');
  lines.push('<script>window.EXP2_HARNESS = { file: ' + JSON.stringify(fileName) + ' };</script>');
  BACKEND.forEach(([name]) => lines.push('<script src="backend/' + name + '"></script>'));
  return lines.map((l) => '  ' + l).join('\n');
}

function checkScripts(html, fileName) {
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    if (m[1] && /\bsrc=/.test(m[1])) continue;
    n++;
    try {
      new vm.Script(m[2], { filename: fileName + '#script' + n });
    } catch (e) {
      throw new Error(fileName + ' : script ' + n + ' invalide (' + e.message + ').');
    }
  }
  return n;
}

function renderPage(server, parameter, fileName) {
  const output = server.doGet({ parameter: parameter, parameters: {}, queryString: '', contentLength: -1 });
  let html = output.getContent();
  if (/<\?/.test(html)) throw new Error(fileName + ' : scriptlet non évalué.');
  CDN.forEach((c) => {
    // Script tags of the CDN file, with their Subresource Integrity attributes: the local copy is served without them
    // (pages also open as file://, where a crossorigin request fails); tests/harness.test.js checks the hash itself.
    const tag = new RegExp('<script src="' + c.re.source + '"[^>]*></script>', 'g');
    if (c.file === 'three.min.js' && !fs.existsSync(path.join(VENDOR, c.file))) {
      // No local three.js: no request at all, Twin3D.supported() is false and the pages use the isometric view.
      html = html.replace(tag, '<!-- three.js absent de tests/harness/vendor : vue isométrique -->');
    }
    html = html.replace(tag, '<script src="' + c.local + '"></script>');
    html = html.replace(c.re, c.local);
  });
  if (/cdnjs\.cloudflare\.com|cdn\.sheetjs\.com/.test(html)) throw new Error(fileName + ' : URL CDN non remplacée.');
  // After <meta charset> (it must stay in the first 1024 bytes), before any style or script of the page.
  const charset = /<meta charset="utf-8">/i.exec(html);
  if (charset) html = html.slice(0, charset.index + charset[0].length) + '\n' + harnessHead(output, fileName) + html.slice(charset.index + charset[0].length);
  else if (/<head>/.test(html)) html = html.replace('<head>', '<head>\n  <meta charset="utf-8">\n' + harnessHead(output, fileName));
  else throw new Error(fileName + ' : <head> introuvable dans Index.html.');
  const scripts = checkScripts(html, fileName);
  const body = /<body[^>]*data-mode="([^"]*)"[^>]*data-page="([^"]*)"/.exec(html);
  return { html, title: output.title, xframe: output.xframe, scripts, mode: body ? body[1] : '', page: body ? body[2] : '' };
}

function indexPage(pages) {
  const rows = pages.map((p) => '<li><a href="' + p.file + '">' + escHtml(p.file) + '</a> · ' + escHtml(p.mode === 'tv' ? 'TV' : 'PC ' + p.page) +
    (p.mode === 'tv' ? ' · <a href="' + p.file + '?rotate=1">rotation</a> · <a href="' + p.file + '?scene=docks">quais</a>' : '') + '</li>').join('\n');
  return '<!DOCTYPE html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>EXP2 · harness local</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;max-width:860px;color:#17212b}' +
    'code{background:#eef1f4;padding:1px 4px;border-radius:4px}li{margin:4px 0}</style></head><body>' +
    '<h1>EXP2 Jumeau numérique · harness local</h1><p>Pages générées par <code>npm run harness</code> depuis <code>apps-script/src/Index.html</code> ' +
    '(scriptlets évalués comme Apps Script), avec un serveur dans la page (Api.gs + Repo en mémoire, partagé entre les pages par localStorage).</p>' +
    '<ul>\n' + rows + '\n</ul><h2>Paramètres du harness</h2><ul>' +
    '<li><code>?empty=1</code> base installée sans données · <code>?none=1</code> base non installée · <code>?reset=1</code> nouvelle simulation</li>' +
    '<li><code>?poll=2</code> vérification de version toutes les 2 s · <code>?lat=300</code> latence serveur en ms · <code>?offline=1</code> serveur injoignable</li>' +
    '<li><code>?fresh=warn|crit</code> import ancien · <code>?no3d=1</code> vue isométrique · <code>?seed=N&amp;days=N</code> première simulation</li>' +
    '<li>Clés : <code>window.__keys</code> dans la console.</li></ul></body></html>\n';
}

function ensureVendor(warnings) {
  fs.mkdirSync(VENDOR, { recursive: true });
  const xlsx = path.join(VENDOR, 'xlsx.full.min.js');
  const xlsxNpm = path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
  if (!fs.existsSync(xlsx) && fs.existsSync(xlsxNpm)) fs.copyFileSync(xlsxNpm, xlsx);
  if (!fs.existsSync(xlsx)) warnings.push('vendor/xlsx.full.min.js absent (npm install) : la page Import n\'accepte que les fichiers texte.');
  const three = path.join(VENDOR, 'three.min.js');
  const threeNpm = path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js');
  if (!fs.existsSync(three) && fs.existsSync(threeNpm)) fs.copyFileSync(threeNpm, three);
  if (!fs.existsSync(three)) {
    warnings.push('vendor/three.min.js absent (three.js r128, https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js) : ' +
      'les pages utilisent la vue isométrique.');
  }
}

function build(opts) {
  opts = opts || {};
  const out = path.resolve(opts.out || DEFAULT_OUT);
  const warnings = [];
  ensureVendor(warnings);
  const server = makeServer();
  const webPages = Array.from(server.WEB_PAGES_ || []);
  if (!webPages.length) throw new Error('Main.gs : WEB_PAGES_ vide.');

  // Fresh output (screenshots in out/shots are kept).
  fs.mkdirSync(out, { recursive: true });
  fs.readdirSync(out).forEach((f) => { if (/\.html$/.test(f)) fs.unlinkSync(path.join(out, f)); });
  fs.rmSync(path.join(out, 'backend'), { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'backend'), { recursive: true });
  BACKEND.forEach(([name, from]) => {
    if (!fs.existsSync(from)) throw new Error('Fichier absent : ' + path.relative(ROOT, from));
    fs.copyFileSync(from, path.join(out, 'backend', name));
  });

  const specs = [{ file: 'tv.html', parameter: { mode: 'tv' } }]
    .concat(webPages.map((p) => ({ file: 'pc-' + p + '.html', parameter: { page: p } })));
  const pages = specs.map((s) => {
    const r = renderPage(server, s.parameter, s.file);
    const expectMode = s.parameter.mode === 'tv' ? 'tv' : 'pc';
    if (r.mode !== expectMode || (expectMode === 'pc' && r.page !== s.parameter.page)) {
      throw new Error(s.file + ' : doGet a rendu mode=' + r.mode + ' page=' + r.page + '.');
    }
    fs.writeFileSync(path.join(out, s.file), r.html);
    return { file: s.file, mode: r.mode, page: r.page, title: r.title, xframe: r.xframe, scripts: r.scripts, bytes: Buffer.byteLength(r.html) };
  });
  fs.writeFileSync(path.join(out, 'index.html'), indexPage(pages));
  return { out, pages, webPages, warnings };
}

module.exports = { build, compileTemplate, makeServer, OUT: DEFAULT_OUT, VENDOR };

if (require.main === module) {
  try {
    const r = build({ out: process.argv[2] });
    r.pages.forEach((p) => console.log('  ' + p.file.padEnd(20) + (p.mode === 'tv' ? 'TV' : 'PC ' + p.page).padEnd(16) +
      Math.round(p.bytes / 1024) + ' Ko'));
    r.warnings.forEach((w) => console.warn('  attention : ' + w));
    console.log('Harness : ' + r.pages.length + ' pages dans ' + path.relative(process.cwd(), r.out) + '/ (ouvrir index.html).');
  } catch (e) {
    console.error('Harness : échec de la construction : ' + (e && e.stack || e));
    process.exit(1);
  }
}
