'use strict';
// Import normaliser (apps-script/src/Normalize.gs) against the messy MB51 fixtures of sample-data/messy/
// (expected.json is the oracle), the real-format export of sample-data/mb51-reel/ (expected.json written by
// tools/mb51_reference.py, docs/SPEC_V2.md 2) plus unit tests of the parsing rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const XLSX = require('xlsx');
const { loadGs, readCsv, SRC } = require('./lib/load-gs');

const ROOT = path.join(__dirname, '..');
const MESSY = path.join(ROOT, 'sample-data', 'messy');
const CSV = path.join(ROOT, 'sample-data', 'csv');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(MESSY, 'expected.json'), 'utf8'));

const ctx = loadGs(['Config', 'Normalize']);
const Norm = ctx.Norm;

// Objects built inside the vm context have other prototypes: compare plain JSON copies.
const plain = (x) => JSON.parse(JSON.stringify(x));
const round3 = (n) => Math.round(n * 1000) / 1000;

// windows-1252: latin1 plus the 0x80-0x9F block (Node's TextDecoder maps that block like latin1).
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178
};
function decodeCp1252(buf) {
  let out = '';
  for (const b of buf) out += String.fromCharCode(CP1252_HIGH[b] || b);
  return out;
}

// Reads one fixture the way the browser will: SheetJS raw values (every row kept) or decoded TSV text.
function readFixture(name) {
  const file = path.join(MESSY, name);
  if (/\.xlsx$/i.test(name)) {
    const wb = XLSX.readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const firstRow = XLSX.utils.decode_range(ws['!ref']).s.r + 1;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    return { name, rows, firstRow };
  }
  return { name, rows: Norm.textToRows(decodeCp1252(fs.readFileSync(file))), firstRow: 1 };
}

// Clean base (the 12 MB51 fields) of the batch period, from sample-data/csv.
function baseLines() {
  const out = [];
  for (const f of EXPECTED.scenario.base.files) {
    for (const r of readCsv(path.join(ROOT, f))) {
      out.push({
        article: r['Article'], division: r['Division'], magasin: r['Magasin'], mvt: r['MvT'],
        text: r['Texte code mvt'], s: r['S'], doc: r['Doc.article'], date: isoFromDotted(r['Date cpt.']),
        qty: Number(r['Qté en UQS']), uqs: r['UQS'], designation: r['Désignation article'], user: r['Nom utilisateur']
      });
    }
  }
  return out;
}
function isoFromDotted(s) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  assert.ok(m, 'base date ' + s);
  return `${m[3]}-${m[2]}-${m[1]}`;
}
const tuple12 = (l) => JSON.stringify([l.article, l.division, l.magasin, l.mvt, l.text, l.s, l.doc, l.date, round3(l.qty),
  l.uqs, l.designation, l.user]);

// Reference run: files in expected.json order, global dedupe, batch checks after the last file.
function runReference(order) {
  const seen = new Map(); // key -> file kept from
  const files = [];
  const fresh = [];
  const dups = [];
  for (const name of order) {
    const fx = readFixture(name);
    const res = Norm.normalizeRows(fx.rows, { plant: 'TA11', file: name, firstRow: fx.firstRow });
    const d = Norm.dedupe(res.lines, seen);
    for (const l of d.fresh) seen.set(l.key, name);
    for (const l of d.duplicates) dups.push({ line: l, keptFrom: seen.get(l.key) });
    fresh.push(...d.fresh);
    files.push({ name, res, fresh: d.fresh, duplicates: d.duplicates });
  }
  return { files, fresh, dups, seen };
}

const ORDER = EXPECTED.scenario.reference_import_order;
const REF = runReference(ORDER);
const BATCH_START = EXPECTED.scenario.batch_period[0];
const ALL_BASE = baseLines();
// Last posting date of the clean base before the files (the date the twin is loaded up to).
const LAST_LOADED = ALL_BASE.map((l) => l.date).filter((d) => d < BATCH_START).sort().pop();

// ---------------------------------------------------------------------------------------------------------------
// Messy fixtures vs expected.json

// v1 exports have none of the optional v2 columns (SPEC_V2 2.1): no Poste and no entry time, texts or customer.
const V2_FIELDS = ['entryDate', 'entryTime', 'headerText', 'itemText', 'reference', 'client', 'salesOrder'];

test('messy: every file is read and its header found', () => {
  for (const f of REF.files) {
    assert.equal(f.res.ok, true, f.name + ': ' + f.res.error);
    assert.deepEqual(plain(f.res.mapping.missing), [], f.name);
    assert.deepEqual(plain(f.res.mapping.optionalMissing), ['poste'].concat(V2_FIELDS), f.name + ' has no Poste column');
    assert.deepEqual(plain(f.res.mapping.extra), [], f.name + ' every column used');
    assert.deepEqual(plain(f.res.warnings), [], f.name + ' no warning');
    for (const l of f.res.lines) {
      assert.equal(l.ts, '', 'no entry time in a v1 export');
      assert.equal(l.label, '', 'no label in a v1 export');
    }
  }
});

test('messy: per-file counts in the reference import order', () => {
  for (const f of REF.files) {
    const exp = EXPECTED.per_file[f.name];
    assert.ok(exp, 'expected.json has ' + f.name);
    const r = f.res;
    assert.equal(r.preamble, exp.preamble_rows_before_header, f.name + ' preamble');
    assert.equal(r.dataRows, exp.data_rows, f.name + ' data rows');
    assert.equal(r.lines.length, exp.valid_parsed, f.name + ' valid parsed');
    assert.equal(f.duplicates.length, exp.duplicates_skipped, f.name + ' duplicates');
    assert.equal(f.fresh.length, exp.new_lines, f.name + ' new lines');
    assert.equal(r.rejected.length, exp.rejected, f.name + ' rejected');
    assert.equal(r.dataRows, r.lines.length + r.rejected.length, f.name + ' data rows = valid + rejected');
    assert.deepEqual(
      { subtotal: r.skipped.subtotal, header: r.skipped.header, blank: r.skipped.blank },
      exp.skipped, f.name + ' skipped');
    assert.equal(r.skipped.other, 0, f.name + ' no other skipped row');
  }
});

test('messy: batch totals', () => {
  const t = EXPECTED.totals;
  const sum = (fn) => REF.files.reduce((a, f) => a + fn(f), 0);
  assert.equal(sum((f) => f.res.dataRows), t.data_rows);
  assert.equal(sum((f) => f.res.lines.length), t.valid_parsed_before_dedup);
  assert.equal(REF.fresh.length, t.valid_lines);
  assert.equal(REF.dups.length, t.duplicates_skipped);
  assert.equal(sum((f) => f.res.rejected.length), t.rejected);
  assert.equal(sum((f) => f.res.preamble), t.preamble_rows_before_header);
  const sk = { subtotal: 0, header: 0, blank: 0 };
  for (const f of REF.files) for (const k of Object.keys(sk)) sk[k] += f.res.skipped[k];
  assert.deepEqual(sk, { subtotal: t.skipped.subtotal, header: t.skipped.header, blank: t.skipped.blank });
  assert.equal(sk.subtotal + sk.header + sk.blank, t.skipped.total);
});

test('messy: flagged documents (batch checks after the last file)', () => {
  assert.equal(LAST_LOADED, EXPECTED.scenario.twin_loaded_until);
  const flags = plain(Norm.flagTransfers(REF.fresh, { lastImportedDate: LAST_LOADED }));
  assert.equal(flags.length, EXPECTED.totals.lines_flagged);
  const byDoc = new Map();
  for (const f of flags) {
    const k = f.doc + '|' + f.code;
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k).push(f);
  }
  assert.equal(byDoc.size, EXPECTED.totals.documents_flagged);
  for (const exp of EXPECTED.flagged_documents) {
    const got = byDoc.get(exp.doc + '|' + exp.code);
    assert.ok(got, `flag ${exp.code} on doc ${exp.doc}`);
    assert.equal(got.length, exp.lines, exp.doc + ' lines');
    assert.deepEqual(got.map((f) => f.row).sort((a, b) => a - b), exp.rows, exp.doc + ' rows');
    for (const f of got) {
      assert.equal(f.file, exp.file);
      assert.equal(f.article, exp.article);
      assert.equal(f.date, exp.date);
      if (exp.magasin) assert.equal(f.magasin, exp.magasin);
      if (exp.qty !== undefined) assert.equal(f.qty, exp.qty);
      if (exp.uqs) assert.equal(f.uqs, exp.uqs);
      assert.ok(f.text && f.text.indexOf(exp.doc) >= 0, 'French text names the document');
    }
  }
  // Without the last loaded date only the orphan remains; flagged lines are still accepted (in REF.fresh).
  const orphanOnly = plain(Norm.flagTransfers(REF.fresh));
  assert.deepEqual(orphanOnly.map((f) => f.code), ['TRANSFERT_ORPHELIN']);
  for (const f of flags) assert.ok(REF.fresh.some((l) => l.key === f.key), 'flagged line kept: ' + f.key);
});

test('messy: rejected lines', () => {
  const rejected = [];
  for (const f of REF.files) for (const r of f.res.rejected) rejected.push(plain(r));
  assert.equal(rejected.length, EXPECTED.rejected_lines.length);
  for (const exp of EXPECTED.rejected_lines) {
    const got = rejected.find((r) => r.file === exp.file && r.row === exp.row);
    assert.ok(got, `rejected row ${exp.row} of ${exp.file}`);
    assert.equal(got.doc, exp.doc);
    assert.equal(got.division, exp.division);
    assert.equal(got.article, exp.article);
    assert.match(got.reason, /Division TA12 hors périmètre/);
  }
});

test('messy: duplicates skipped (kept from the first file that brought them)', () => {
  const got = REF.dups.map((d) => ({
    doc: d.line.doc, magasin: d.line.magasin, article: d.line.article, qty: d.line.qty,
    kept_from: d.keptFrom, skipped_in: d.line.file
  }));
  const norm = (a) => a.map((x) => JSON.stringify([x.doc, x.magasin, x.article, round3(x.qty), x.kept_from, x.skipped_in])).sort();
  assert.deepEqual(norm(got), norm(EXPECTED.duplicates));
});

test('messy: the valid lines equal the clean base plus the extra lines (12 fields)', () => {
  const period = EXPECTED.scenario.base.dates;
  const base = ALL_BASE.filter((l) => period.indexOf(l.date) >= 0);
  assert.equal(base.length, EXPECTED.scenario.base.lines);
  const extra = EXPECTED.extra_lines_vs_base.map((e) => Object.assign({}, e, { text: e.texte }));
  const want = base.concat(extra).map(tuple12).sort();
  const got = REF.fresh.map(tuple12).sort();
  assert.equal(got.length, want.length);
  assert.deepEqual(got, want);
});

test('messy: aggregate checks of the valid lines', () => {
  const chk = EXPECTED.valid_lines_check;
  const byMag = {};
  const sums = {};
  const docs = new Set();
  let auto = 0;
  for (const l of REF.fresh) {
    byMag[l.magasin] = (byMag[l.magasin] || 0) + 1;
    const k = l.magasin + ' ' + l.uqs;
    sums[k] = round3((sums[k] || 0) + l.qty);
    docs.add(l.doc);
    if (l.user === 'BARFLOW_TA11') auto++;
    assert.match(l.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(l.doc, /^\d+$/, 'doc as plain digits: ' + l.doc);
    assert.match(l.article, /^[1-9]\d*$/, 'article trimmed, no leading zero: ' + l.article);
    assert.equal(l.source, 'IMPORT');
    assert.equal(l.key, [l.doc, l.article, l.magasin, l.mvt, String(l.qty), l.date, 1].join('|'));
  }
  assert.deepEqual(byMag, chk.count_by_magasin);
  assert.deepEqual(sums, chk.qty_sum_by_magasin_unit);
  assert.equal(docs.size, chk.distinct_documents);
  assert.equal(auto, chk.lines_user_BARFLOW_TA11);
});

test('messy: 52 row-level spot checks', () => {
  const rows = EXPECTED.spot_checks.rows;
  assert.equal(rows.length, 52);
  for (const spot of rows) {
    const f = REF.files.find((x) => x.name === spot.file);
    const label = `${spot.file} row ${spot.row}`;
    const e = spot.expect;
    if (e.status === 'valid') {
      const l = f.res.lines.find((x) => x.row === spot.row);
      assert.ok(l, label + ' is a valid line');
      for (const k of ['article', 'doc', 'magasin', 'mvt', 'date', 'qty', 'uqs', 'user']) {
        assert.equal(l[k], e[k], `${label} ${k}`);
      }
    } else if (e.status === 'rejected') {
      const r = f.res.rejected.find((x) => x.row === spot.row);
      assert.ok(r, label + ' is rejected');
      assert.equal(r.division, e.division);
      if (spot.doc) assert.equal(r.doc, spot.doc);
    } else if (e.status === 'skipped') {
      const s = f.res.skippedRows.find((x) => x.row === spot.row);
      assert.ok(s, label + ' is skipped');
      assert.equal(s.kind, e.kind, label);
    } else {
      assert.fail('unknown status ' + e.status);
    }
  }
});

test('messy: totals do not depend on the import order', () => {
  const rev = runReference(ORDER.slice().reverse());
  assert.equal(rev.fresh.length, EXPECTED.totals.valid_lines);
  assert.equal(rev.dups.length, EXPECTED.totals.duplicates_skipped);
  assert.deepEqual(rev.fresh.map((l) => l.key).sort(), REF.fresh.map((l) => l.key).sort());
  const flags = Norm.flagTransfers(rev.fresh, { lastImportedDate: LAST_LOADED });
  assert.equal(flags.length, EXPECTED.totals.lines_flagged);
});

test('messy: normalizeBatch gives the same result, and re-importing adds 0 lines', () => {
  const files = ORDER.map(readFixture);
  const b = Norm.normalizeBatch(files, { plant: 'TA11', lastImportedDate: LAST_LOADED });
  assert.equal(b.ok, true);
  assert.equal(b.lines.length, EXPECTED.totals.valid_lines);
  assert.equal(b.duplicates.length, EXPECTED.totals.duplicates_skipped);
  assert.equal(b.rejected.length, EXPECTED.totals.rejected);
  assert.equal(b.flags.length, EXPECTED.totals.lines_flagged);
  assert.deepEqual(plain(b.lines.map((l) => l.key)), REF.fresh.map((l) => l.key));
  b.files.forEach((r, i) => {
    assert.equal(r.fresh.length, EXPECTED.per_file[ORDER[i]].new_lines);
    assert.equal(r.summary.fresh, EXPECTED.per_file[ORDER[i]].new_lines);
  });
  const s = b.summary;
  assert.equal(s.read, EXPECTED.totals.data_rows);
  assert.equal(s.valid, EXPECTED.totals.valid_parsed_before_dedup);
  assert.equal(s.fresh, EXPECTED.totals.valid_lines);
  assert.equal(s.duplicates, EXPECTED.totals.duplicates_skipped);
  assert.equal(s.rejected, EXPECTED.totals.rejected);
  assert.equal(s.skipped.total, EXPECTED.totals.skipped.total);
  assert.equal(s.flags, EXPECTED.totals.lines_flagged);
  assert.deepEqual(plain(s.flagCodes), { TRANSFERT_ORPHELIN: 1, ANTIDATE: 2 });
  assert.equal(s.documents, EXPECTED.valid_lines_check.distinct_documents);
  assert.equal(s.dateMin, '2026-09-30');
  assert.equal(s.dateMax, '2026-10-03');
  assert.equal(s.auto, EXPECTED.valid_lines_check.lines_user_BARFLOW_TA11);
  assert.match(s.text, /^452 lignes lues · 446 nouvelles · 5 déjà connues · 1 rejetée · 38 ignorées \(34 sous-totaux, 2 en-têtes répétés, 2 lignes vides\) · 3 alertes · période du 30\/09\/2026 au 03\/10\/2026$/);

  // Second upload of the same files against the saved keys: nothing new.
  const again = Norm.normalizeBatch(files, { plant: 'TA11', existingKeys: REF.fresh.map((l) => l.key) });
  assert.equal(again.lines.length, 0);
  assert.equal(again.duplicates.length, EXPECTED.totals.valid_parsed_before_dedup);
  // The saved lines also pair the transfer legs: no orphan except the lone leg, which is saved too.
  const known = Norm.flagTransfers([], { knownLines: REF.fresh });
  assert.equal(known.length, 0, 'known lines are never flagged');
});

test('messy: the browser copy (NormalizeModule_.toString(), no CFG) gives the same result', () => {
  const src = ctx.NormalizeModule_.toString();
  const browser = vm.createContext({});
  vm.runInContext('var Norm = (' + src + ')();', browser);
  const fx = readFixture(ORDER[0]);
  const r = browser.Norm.normalizeRows(fx.rows, { file: fx.name });
  assert.equal(r.plant, 'TA11', 'default plant without CFG');
  assert.equal(r.lines.length, EXPECTED.per_file[ORDER[0]].valid_parsed);
  assert.equal(r.rejected.length, EXPECTED.per_file[ORDER[0]].rejected);
  assert.equal(browser.Norm.canonUser('BAR FLOW TA11'), 'BARFLOW_TA11');
});

test('Normalize.gs: Apps Script safe syntax', () => {
  const src = fs.readFileSync(path.join(SRC, 'Normalize.gs'), 'utf8');
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /\?\?/);
  assert.doesNotMatch(src, /[\w\])]\?\.[A-Za-z_$]/);
  assert.match(src, /^function NormalizeModule_\(\) \{/m);
  assert.match(src, /^var Norm = NormalizeModule_\(\);/m);
  // Loads alone too (CFG is optional).
  const alone = loadGs(['Normalize']);
  assert.equal(alone.Norm.parseNumber('1.234,500'), 1234.5);
});

// ---------------------------------------------------------------------------------------------------------------
// Real export format (sample-data/mb51-reel, docs/SPEC_V2.md 2) vs expected.json (tools/mb51_reference.py)

const REEL_DIR = path.join(ROOT, 'sample-data', 'mb51-reel');
const REEL_NAME = 'MB51_reel_anonymise.xlsx';
const REEL = JSON.parse(fs.readFileSync(path.join(REEL_DIR, 'expected.json'), 'utf8')).normalize;
const REEL_HEADER = ['Article', 'Division', 'Magasin', 'Code mouvement', 'Texte code mouvement', 'Stock spécial',
  'Document article', 'Date comptable', 'Qté en unité saisie', 'UQ de saisie', 'Désignation article', 'Montant DI',
  'Date de saisie', 'Heure de saisie', "Nom de l'utilisateur", "Texte d'en-tête pièce", 'Motif du mouvement', 'Texte',
  'Référence', 'Client', 'Fournisseur', 'Commande client'];
// Field of each of the 22 columns (null = not used by the twin, kept in mapping.extra without a warning).
const REEL_FIELDS = ['article', 'division', 'magasin', 'mvt', 'text', 's', 'doc', 'date', 'qty', 'uqs', 'designation', null,
  'entryDate', 'entryTime', 'user', 'headerText', null, 'itemText', 'reference', 'client', null, 'salesOrder'];
const REEL_DATE_COLS = [7, 12];
const REEL_TIME_COL = 13;
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

let reelRows = null;
// SheetJS raw rows of the fixture, read once (dates and times arrive as Excel serial numbers).
function readReel() {
  if (!reelRows) {
    const wb = XLSX.readFile(path.join(REEL_DIR, REEL_NAME));
    reelRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], Norm.SHEETJS_OPTIONS);
  }
  return reelRows;
}

let reelBatch = null;
function reelFiltered() {
  if (!reelBatch) reelBatch = Norm.normalizeBatch([{ name: REEL_NAME, rows: readReel() }], { trackedOnly: true });
  return reelBatch;
}

const pad2 = (n) => String(n).padStart(2, '0');
// Excel serial -> calendar day and wall-clock time (what Excel shows).
function serialParts(v) {
  const days = Math.floor(v);
  const t = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  const sec = Math.round((v - days) * 86400);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: Math.floor(sec / 3600), mi: Math.floor(sec / 60) % 60, s: sec % 60 };
}

// The fixture as Apps Script range.getValues() returns it: Date objects (local midnight) for date cells, Dates of
// 1899-12-30 for time cells, '' for empty cells, and digit codes turned into numbers as Sheets does when pasting.
function asSheetValues(rows) {
  return rows.map((r, i) => (i === 0 ? r.slice() : r.map((v, c) => {
    if (v === null || v === undefined) return '';
    if (REEL_DATE_COLS.includes(c)) {
      const p = serialParts(v);
      return new Date(p.y, p.m - 1, p.d);
    }
    if (c === REEL_TIME_COL) {
      const p = serialParts(v);
      return new Date(1899, 11, 30, p.h, p.mi, p.s);
    }
    if (typeof v === 'string' && /^[1-9]\d{0,14}$/.test(v)) return Number(v);
    return v;
  })));
}

// SAP French number text: thousands '.', decimals ',', trailing minus ('104.000-').
function sapNumber(n) {
  const parts = String(Math.abs(n)).split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (parts[1] ? ',' + parts[1] : '') + (n < 0 ? '-' : '');
}

// The fixture as a « Texte avec tabulations » export: title and blank line, '05.10.2026', '10:54:54', CRLF.
function asTabText(rows) {
  const out = ['Liste des documents article', ''];
  rows.forEach((r, i) => {
    out.push(i === 0 ? r.join('\t') : r.map((v, c) => {
      if (v === null || v === undefined) return '';
      if (REEL_DATE_COLS.includes(c)) {
        const p = serialParts(v);
        return `${pad2(p.d)}.${pad2(p.m)}.${p.y}`;
      }
      if (c === REEL_TIME_COL) {
        const p = serialParts(v);
        return `${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
      }
      return typeof v === 'number' ? sapNumber(v) : v;
    }).join('\t'));
  });
  return out.join('\r\n') + '\r\n';
}

const lineSig = (l) => [l.key, l.ts, l.label, round3(l.qty), l.headerText, l.itemText, l.reference, l.client, l.salesOrder,
  l.user].join('~');

test('real format: the 22 columns are mapped as SPEC_V2 says, unused ones without a warning', () => {
  const rows = readReel();
  assert.deepEqual(rows[0], REEL_HEADER, 'fixture header');
  const r = reelFiltered().files[0];
  assert.equal(r.ok, true, r.error);
  assert.equal(r.headerRow, 0);
  const want = {};
  REEL_FIELDS.forEach((f, c) => { if (f) want[f] = c; });
  assert.deepEqual(plain(r.mapping.index), want);
  assert.deepEqual(plain(r.mapping.missing), []);
  assert.deepEqual(plain(r.mapping.optionalMissing), ['poste']);
  assert.deepEqual(plain(r.mapping.extra), ['Montant DI', 'Motif du mouvement', 'Fournisseur']);
  assert.deepEqual(plain(r.warnings), []);
  assert.deepEqual(plain(r.summary.format), { file: REEL_NAME, columns: 22, hasTime: true, hasLabels: true, hasClient: true,
    extra: ['Montant DI', 'Motif du mouvement', 'Fournisseur'], withTime: REEL.withTime, withLabel: REEL.withLabel });
  // Same mapping whatever the column order (exact synonyms: no generic label takes another column).
  const rev = Norm.mapHeaders(REEL_HEADER.slice().reverse());
  for (const [f, c] of Object.entries(want)) assert.equal(rev.index[f], 21 - c, f);
  assert.deepEqual(plain(rev.extra).sort(), ['Fournisseur', 'Montant DI', 'Motif du mouvement']);
});

test('real format: counts, filter, period and first line match expected.json', () => {
  const b = reelFiltered();
  const s = b.summary;
  assert.equal(b.ok, true);
  assert.equal(s.read, REEL.read);
  assert.equal(s.valid, REEL.valid);
  assert.equal(s.rejected, REEL.rejected);
  assert.equal(s.withTime, REEL.withTime);
  assert.equal(s.withLabel, REEL.withLabel);
  assert.equal(s.dateMin, REEL.dateMin);
  assert.equal(s.dateMax, REEL.dateMax);
  assert.equal(s.skipped.total, 0);
  // Finished-goods filter on the valid lines, before dedupe (SPEC_V2 2.4).
  assert.equal(b.trackedOnly, true);
  assert.equal(b.lines.length, REEL.kept);
  assert.equal(s.fresh, REEL.kept);
  assert.equal(s.duplicates, 0);
  assert.equal(b.untracked.lines, REEL.dropped);
  assert.equal(b.untracked.articles, REEL.droppedArticles);
  assert.equal(b.untracked.list.length, REEL.droppedArticles);
  assert.equal(s.untracked, REEL.dropped);
  assert.equal(s.untrackedArticles, REEL.droppedArticles);
  assert.equal(b.files[0].summary.untracked, REEL.dropped);
  assert.equal(b.batchTracked.length, REEL.trackedArticles);
  assert.equal(s.valid, s.fresh + s.duplicates + s.untracked);
  const kept = new Set(b.lines.map((l) => l.article));
  assert.equal(kept.size, REEL.trackedArticles, 'every kept article is a tracked one');
  for (const a of b.untracked.list) assert.ok(!kept.has(a) && !b.batchTracked.includes(a), 'dropped article ' + a);
  for (const a of b.batchTracked) assert.ok(kept.has(a));
  // The French preview.
  assert.equal(s.text, '4157 lignes lues · 2800 nouvelles · 0 déjà connue · 1357 hors produits finis · 0 rejetée · ' +
    '0 ignorée · 3 alertes · période du 04/10/2026 au 05/10/2026');
  const rows = Object.fromEntries(plain(s.rows).map((x) => [x.label, x.value]));
  assert.equal(rows['Hors produits finis (ignorées)'], REEL.dropped);
  assert.equal(rows['Avec heure de saisie'], REEL.withTime);
  assert.equal(rows['Avec étiquette'], REEL.withLabel);
  assert.equal(rows['Nouvelles lignes'], REEL.kept);
  assert.deepEqual(plain(s.warnings), []);
  // First line of the file (dropped by the filter: a raw material, but valid).
  const first = plain(b.files[0].lines[0]);
  for (const k of Object.keys(REEL.firstLine)) assert.equal(first[k], REEL.firstLine[k], 'firstLine ' + k);
  assert.equal(first.user, 'OPERATEUR01');
  assert.equal(first.headerText, 'transfert PRD5 test');
  assert.ok(b.files[0].untracked.includes(b.files[0].lines[0]));
});

test('real format: timestamps and labels (entry date + entry time, label numbers from the texts)', () => {
  const b = reelFiltered();
  const all = b.files[0].lines;
  for (const l of all) {
    assert.equal(typeof l.ts, 'string');
    assert.match(l.ts, TS_RE, 'ts of row ' + l.row);
    assert.match(l.label, /^(\d{6,12})?$/, 'label of row ' + l.row);
    assert.equal(l.label, Norm.labelOf(l), 'label = labelOf(line)');
  }
  // Night entries (00:00-01:59) are posted on the previous day: ts keeps the entry date.
  const night = all.filter((l) => l.ts.slice(0, 10) !== l.date);
  assert.ok(night.length > 0, 'the fixture has night entries');
  for (const l of night) {
    assert.ok(l.ts.slice(0, 10) > l.date, 'entry after posting: row ' + l.row);
    assert.ok(l.ts.slice(11, 13) < '02', 'night entry: row ' + l.row);
  }
  for (const exp of REEL.labelSamples) {
    const got = b.lines.find((l) => l.doc === exp.doc && l.article === exp.article && l.magasin === exp.magasin && l.mvt === exp.mvt);
    assert.ok(got, 'label sample ' + exp.doc);
    assert.equal(got.label, exp.label, exp.doc + ' label');
    assert.equal(got.ts, exp.ts, exp.doc + ' ts');
  }
  assert.deepEqual(plain(b.lines.filter((l) => l.label).slice(0, 5).map((l) => ({ doc: l.doc, article: l.article,
    magasin: l.magasin, mvt: l.mvt, label: l.label, ts: l.ts }))), REEL.labelSamples, 'first labeled kept lines in file order');
  // Labels come from the item text of the 311 scans and from the header text of the 131 declarations only.
  const by = {};
  for (const l of all.filter((x) => x.label)) {
    const src = l.itemText === l.label ? 'item' : 'header';
    by[l.mvt + ' ' + src] = (by[l.mvt + ' ' + src] || 0) + 1;
    if (src === 'header') assert.ok(l.headerText.startsWith(l.label), 'header label of row ' + l.row);
  }
  assert.deepEqual(Object.keys(by).sort(), ['131 header', '311 item']);
  assert.ok(all.some((l) => l.mvt === '131' && /^Z001:/.test(l.headerText) && l.label === ''), 'Z001 headers carry no label');
  assert.ok(all.some((l) => l.mvt === '311' && /^TA11P/.test(l.headerText) && l.label === l.itemText), '311: label from Texte');
  // Users: the automatic scan user is recognised (screens show Auto / Manuel only).
  assert.equal(b.summary.auto + b.summary.manual, REEL.kept);
  assert.ok(b.lines.some((l) => l.user === 'BARFLOW_TA11'));
});

test('real format: labeled 311 legs are never TRANSFERT_ORPHELIN, unlabeled lone legs still are', () => {
  const b = reelFiltered();
  const orphans = plain(b.flags).filter((f) => f.code === 'TRANSFERT_ORPHELIN');
  assert.equal(orphans.length, REEL.unpairedUnlabeled, 'same count as the reference (unlabeled unpaired legs)');
  for (const f of orphans) {
    assert.equal(f.label, '');
    const line = b.lines.find((l) => l.key === f.key);
    assert.equal(line.label, '');
  }
  // Without the labeled rule the labeled lone legs (other leg in PRD5...) would be flagged too.
  const unlabeled = b.lines.map((l) => Object.assign({}, l, { label: '', itemText: '', headerText: '' }));
  assert.ok(Norm.flagTransfers(unlabeled).length > orphans.length);
  // Flags carry no user name.
  assert.ok(!JSON.stringify(orphans).includes('OPERATEUR'));
});

test('real format: getValues() Dates and a tab-separated text export give the same lines as SheetJS', () => {
  const rows = readReel();
  const ref = reelFiltered();
  const values = asSheetValues(rows);
  // The copy really holds Sheets types: numeric codes (article, document, label texts) and Date cells.
  assert.equal(typeof values[1][0], 'number');
  assert.equal(typeof values[1][6], 'number');
  assert.ok(values[1][7] instanceof Date && values[1][13] instanceof Date && values[1][13].getFullYear() === 1899);
  assert.ok(values.some((r) => typeof r[17] === 'number') && values.some((r) => typeof r[15] === 'number'), 'numeric texts');
  assert.ok(values.some((r) => typeof r[18] === 'string' && /^0\d+$/.test(r[18])), 'references with leading zeros stay text');
  const sheet = Norm.normalizeBatch([{ name: 'MB51 (feuille)', rows: values }], { trackedOnly: true });
  const text = Norm.textToRows(asTabText(rows));
  assert.equal(text[1].length, 1, 'blank line kept');
  const tsv = Norm.normalizeBatch([{ name: 'MB51.txt', rows: text }], { trackedOnly: true });
  for (const [what, b] of [['getValues', sheet], ['text', tsv]]) {
    assert.equal(b.ok, true, what);
    assert.equal(b.summary.read, REEL.read, what);
    assert.equal(b.summary.rejected, 0, what);
    assert.equal(b.summary.withTime, REEL.withTime, what);
    assert.equal(b.summary.withLabel, REEL.withLabel, what);
    assert.equal(b.untracked.lines, REEL.dropped, what);
    assert.deepEqual(plain(b.files[0].lines.map(lineSig)), plain(ref.files[0].lines.map(lineSig)), what + ': same valid lines');
    assert.deepEqual(plain(b.lines.map((l) => l.key)), plain(ref.lines.map((l) => l.key)), what + ': same kept lines');
    assert.deepEqual(plain(b.files[0].warnings), [], what);
  }
  assert.equal(tsv.files[0].preamble, 2);
  // Re-importing any copy against the saved keys adds nothing.
  const again = Norm.normalizeBatch([{ name: 'MB51.txt', rows: text }], { trackedOnly: true, existingKeys: ref.lines.map((l) => l.key) });
  assert.equal(again.lines.length, 0);
  assert.equal(again.duplicates.length, REEL.kept);
  assert.equal(again.untracked.lines, REEL.dropped);
});

test('real format: without the filter every valid line is kept; the browser copy (no CFG) agrees', () => {
  const rows = readReel();
  const b = Norm.normalizeBatch([{ name: REEL_NAME, rows }]);
  assert.equal(b.trackedOnly, false);
  assert.equal(b.lines.length, REEL.valid);
  assert.deepEqual(plain(b.untracked), { lines: 0, articles: 0, list: [] });
  assert.equal(b.summary.untracked, null);
  assert.equal(b.summary.untrackedArticles, null);
  assert.equal(b.batchTracked.length, REEL.trackedArticles, 'batch tracked articles are reported anyway');
  assert.doesNotMatch(b.summary.text, /hors produits finis/);
  assert.ok(!plain(b.summary.rows).some((x) => x.label === 'Hors produits finis (ignorées)'));

  const browser = vm.createContext({});
  vm.runInContext('var Norm = (' + ctx.NormalizeModule_.toString() + ')();', browser);
  const bb = browser.Norm.normalizeBatch([{ name: REEL_NAME, rows }], { trackedOnly: true });
  assert.deepEqual(plain(bb.lines.map(lineSig)), plain(reelFiltered().lines.map(lineSig)));
  assert.equal(bb.summary.withLabel, REEL.withLabel);
  assert.equal(bb.summary.auto, reelFiltered().summary.auto, 'same automatic users without CFG');
});

// ---------------------------------------------------------------------------------------------------------------
// Unit tests

test('parseNumber: SAP French text, trailing minus, spaces, real numbers', () => {
  const ok = [
    [1234.5, 1234.5], [-320, -320], [0, 0],
    ['1.234,500', 1234.5], ['729,25', 729.25], ['320-', -320], ['-320', -320], ['+320', 320],
    ['400,000-', -400], ['2.850,000-', -2850], ['750,000', 750], ['5.484,500', 5484.5],
    ['1.440', 1440], ['1.440-', -1440], ['123.456', 123456], ['1.234.567', 1234567], ['1.234.567,89', 1234567.89],
    ['1 234,5', 1234.5], ['1\u00a0234,5', 1234.5], ['1\u202f234,5', 1234.5], ['1\u2007234,5', 1234.5],
    [' 320 ', 320], ['320 -', -320], ['- 320', -320], ['\u2212320', -320], ['(320)', -320],
    ['1,234,567.89', 1234567.89], ['1,234,567', 1234567], ['1,234.5', 1234.5],
    ['0,5', 0.5], [',5', 0.5], ['12.5', 12.5], ['0.500', 0.5], ['1.5', 1.5], ['1e3', 1000],
    ['0', 0], ['0,000', 0], ['320', 320], ['14028', 14028]
  ];
  for (const [v, want] of ok) assert.equal(Norm.parseNumber(v), want, JSON.stringify(v));
  assert.ok(Object.is(Norm.parseNumber('0-'), 0), 'no negative zero');
  assert.ok(Object.is(Norm.parseNumber('0,000-'), 0), 'no negative zero');
  const bad = ['', '   ', null, undefined, 'abc', '12abc', '1,2,3', '1.23.4', '1.2345,6', '--320', '-320-', '.', '-', ',',
    true, false, NaN, Infinity, -Infinity, new Date(2026, 9, 2), {}, '4.901E+09x'];
  for (const v of bad) assert.ok(Number.isNaN(Norm.parseNumber(v)), 'NaN for ' + String(v));
});

test('parseDate: Date, Excel serial, day-first text, ISO', () => {
  const ok = [
    [46297, '2026-10-02'], [46298, '2026-10-03'], [46297.75, '2026-10-02'], [61, '1900-03-01'], [45658, '2025-01-01'],
    ['46297', '2026-10-02'], [20261002, '2026-10-02'], ['20261002', '2026-10-02'],
    ['02.10.2026', '2026-10-02'], ['2.10.2026', '2026-10-02'], ['02/10/2026', '2026-10-02'], ['2/10/2026', '2026-10-02'],
    ['02-10-2026', '2026-10-02'], ['02.10.26', '2026-10-02'], [' 30.09.2026 ', '2026-09-30'], ['31.12.2026', '2026-12-31'],
    ['2026-10-02', '2026-10-02'], ['2026/10/02', '2026-10-02'], ['2026-10-02 00:00:00', '2026-10-02'],
    ['2026-10-02T00:00:00', '2026-10-02'], ['02.10.2026 14:35:10', '2026-10-02'], ['29.02.2028', '2028-02-29'],
    ['12/01/2026', '2026-01-12'],
    [new Date(2026, 9, 2), '2026-10-02'], [new Date(2026, 9, 2, 23, 59, 59), '2026-10-02'], [new Date(2026, 8, 30), '2026-09-30']
  ];
  for (const [v, want] of ok) assert.equal(Norm.parseDate(v), want, String(v));
  // A zoned ISO timestamp (serialized Date) gives the local calendar day.
  const d = new Date(2026, 9, 2, 0, 0, 0);
  assert.equal(Norm.parseDate(d.toISOString()), '2026-10-02');
  const bad = ['31.02.2026', '29.02.2026', '13/13/2026', '00.10.2026', '32.10.2026', '2026-13-01', '', '  ', null, undefined,
    'abc', '02.10', NaN, Infinity, new Date('invalid'), 30, 60, true, {}, '1.234,5'];
  for (const v of bad) assert.equal(Norm.parseDate(v), null, 'null for ' + String(v));
});

test('mapHeaders: French and English synonyms, short and long labels', () => {
  const cases = {
    article: ['Article', 'ARTICLE', 'N° article', 'Material', 'Matériel'],
    division: ['Division', 'Div.', 'Plant'],
    magasin: ['Magasin', 'Storage Location', 'SLoc', 'Stor. Loc.'],
    mvt: ['MvT', 'Type de mouvement', 'TMvt', 'Type mouvement', 'Movement Type', 'Mvmt Type'],
    text: ['Texte code mvt', 'Texte code mouvement', 'Movement Type Text', 'Mvt Type Text'],
    s: ['S', 'Stock spécial', 'Special Stock'],
    doc: ['Doc.article', 'Doc. article', 'Document article', 'Mat. Doc.', 'Material Document', 'Material Doc.', 'N° doc. article'],
    poste: ['Poste', 'Item', 'Mat. Doc. Item'],
    date: ['Date cpt.', 'Date comptable', 'Date de comptabilisation', 'Pstng Date', 'Posting Date', 'DATE CPT'],
    qty: ['Qté en UQS', 'Quantité en unité de saisie', 'Qty in UnE', 'Qté en unité de saisie', 'Qty in Un. of Entry', 'qte en uqs'],
    uqs: ['UQS', 'Unité de saisie', 'UnE', 'EUn', 'Unit of Entry'],
    designation: ['Désignation article', 'Designation article', 'Material Description', 'Texte article'],
    user: ['Nom utilisateur', 'Utilisateur', 'User name', 'User Name', 'Username', "Nom d'utilisateur"]
  };
  for (const [field, labels] of Object.entries(cases)) {
    for (const label of labels) {
      const m = Norm.mapHeaders(['xx', label]);
      assert.equal(m.index[field], 1, `${label} -> ${field}`);
    }
  }
  // No normalised synonym belongs to two fields.
  const owner = new Map();
  for (const [field, labels] of Object.entries(Norm.SYNONYMS)) {
    for (const label of labels) {
      const n = Norm.normLabel(label);
      assert.ok(!owner.has(n) || owner.get(n) === field, `${label} in ${owner.get(n)} and ${field}`);
      owner.set(n, field);
    }
  }
  // Full English header, any order ('Entry Date' is a v2 field since SPEC_V2 2.1; 'Amount in LC' is not used).
  const en = Norm.mapHeaders(['Mat. Doc.', 'Item', 'Pstng Date', 'Material', 'Plant', 'SLoc', 'MvT', 'Mvt Type Text', 'S',
    'Qty in UnE', 'EUn', 'Material Description', 'User name', 'Entry Date', 'Amount in LC']);
  assert.deepEqual(plain(en.missing), []);
  assert.deepEqual(plain(en.optionalMissing), V2_FIELDS.filter((f) => f !== 'entryDate'));
  assert.deepEqual(plain(en.extra), ['Amount in LC']);
  assert.deepEqual(plain(en.index), { article: 3, division: 4, magasin: 5, mvt: 6, text: 7, s: 8, doc: 0, poste: 1,
    date: 2, qty: 9, uqs: 10, designation: 11, user: 12, entryDate: 13 });
  // Priority: the unit-of-entry quantity wins over the base-unit one, whatever the column order.
  const both = Norm.mapHeaders(['Quantité', 'UQB', 'Qté en UQS', 'UQS']);
  assert.equal(both.index.qty, 2);
  assert.equal(both.index.uqs, 3);
  assert.deepEqual(plain(both.extra), ['Quantité', 'UQB']);
  // Missing required columns.
  const miss = Norm.mapHeaders(['Article', 'Magasin', 'Qté en UQS']);
  assert.deepEqual(plain(miss.missing), ['mvt', 'doc', 'date']);
});

test('detectHeaderRow: header after title and blank lines', () => {
  const header = ['Article', 'Division', 'Magasin', 'MvT', 'Doc.article', 'Date cpt.', 'Qté en UQS'];
  assert.equal(Norm.detectHeaderRow([header]), 0);
  assert.equal(Norm.detectHeaderRow([['Liste des documents article - Division TA11'], [''], [], [null, null], header]), 4);
  assert.equal(Norm.detectHeaderRow([['Titre'], ['1000', 'TA11']]), -1);
  assert.equal(Norm.detectHeaderRow([]), -1);
  assert.equal(Norm.detectHeaderRow(null), -1);
  // A partial header is still found (normalizeRows then reports the missing columns).
  assert.equal(Norm.detectHeaderRow([['Titre'], ['Article', 'Magasin', 'MvT', 'Qté en UQS']]), 1);
});

const H = ['Article', 'Division', 'Magasin', 'MvT', 'Texte code mvt', 'S', 'Doc.article', 'Date cpt.', 'Qté en UQS', 'UQS',
  'Désignation article', 'Nom utilisateur'];
const row = (o) => [o.article === undefined ? '1000102657' : o.article, o.division === undefined ? 'TA11' : o.division,
  o.magasin || 'PRD2', o.mvt === undefined ? '101' : o.mvt, 'EM entrée en stock', o.s || null, o.doc === undefined ? '4901257367' : o.doc,
  o.date === undefined ? '02.10.2026' : o.date, o.qty === undefined ? '144' : o.qty, o.uqs || 'PC', ' PF BAC ', o.user || 'BARFLOW_TA11'];

test('normalizeRows: classification of rows and normalised fields', () => {
  const rows = [
    ['Export MB51'], [], H,
    row({ article: ' 0001000102657 ', doc: 4901257367, qty: '1.440-', user: 'bar flow ta11', s: ' e ' }),
    [null, null, null, null, null, null, null, null, '1.440-', 'PC', null, null],         // subtotal
    ['*', '', '', '', '', '', '', '', '0', 'PC', '', ''],                                 // total line
    H.slice(),                                                                             // header repeated
    ['', '\t', '   ', null, '\u00a0'],                                                     // blank
    ['Nombre de lignes : 2'],                                                              // other
    row({ doc: '4901257368', date: 46298, qty: 729.25, uqs: 'kg', user: 'OPEXP02' })
  ];
  const r = Norm.normalizeRows(rows, { file: 'f.xlsx' });
  assert.equal(r.ok, true);
  assert.equal(r.preamble, 2);
  assert.equal(r.headerRow, 2);
  assert.equal(r.dataRows, 2);
  assert.deepEqual(plain(r.skipped), { header: 1, subtotal: 2, blank: 1, other: 1 });
  assert.deepEqual(plain(r.skippedRows), [{ row: 5, kind: 'subtotal' }, { row: 6, kind: 'subtotal' },
    { row: 7, kind: 'header' }, { row: 8, kind: 'blank' }, { row: 9, kind: 'other' }]);
  const [a, b] = plain(r.lines);
  assert.deepEqual(a, {
    key: '4901257367|1000102657|PRD2|101|-1440|2026-10-02|1', article: '1000102657', division: 'TA11', magasin: 'PRD2',
    mvt: '101', text: 'EM entrée en stock', s: 'E', doc: '4901257367', poste: '', date: '2026-10-02', qty: -1440,
    uqs: 'PC', designation: 'PF BAC', user: 'BARFLOW_TA11', source: 'IMPORT', file: 'f.xlsx', row: 4, rank: 1,
    ts: '', label: '', headerText: '', itemText: '', reference: '', client: '', salesOrder: ''   // v2 fields, no v2 column
  });
  assert.equal(b.date, '2026-10-03');
  assert.equal(b.qty, 729.25);
  assert.equal(b.uqs, 'KG');
  assert.equal(b.user, 'OPEXP02');
  assert.equal(b.row, 10);
  // firstRow shifts the physical row numbers (sheet range not starting at row 1).
  const shifted = Norm.normalizeRows(rows, { firstRow: 5 });
  assert.equal(shifted.lines[0].row, 8);
});

test('normalizeRows: plant filter, rejections with French reasons', () => {
  const rows = [H,
    row({ division: 'TA12' }),
    row({ doc: '2', article: '' }),
    row({ doc: '3', date: '31.02.2026' }),
    row({ doc: '4', qty: 'douze' }),
    row({ doc: '5', mvt: '', date: '' }),
    row({ doc: '4.901E+09' }),
    row({ doc: '7', division: '' }),
    row({ doc: '8', division: ' ta11 ' })
  ];
  const r = Norm.normalizeRows(rows);
  assert.equal(r.plant, 'TA11', 'default plant from CFG');
  const reasons = plain(r.rejected).map((x) => [x.row, x.reason]);
  assert.deepEqual(reasons, [
    [2, 'Division TA12 hors périmètre (TA11 uniquement)'],
    [3, 'Article manquant'],
    [4, 'Date cpt. illisible : « 31.02.2026 »'],
    [5, 'Quantité illisible : « douze »'],
    [6, 'Type de mouvement (MvT) manquant ; Date cpt. manquante'],
    [7, 'Doc.article illisible : « 4.901E+09 »']
  ]);
  assert.deepEqual(plain(r.lines).map((l) => [l.doc, l.division]), [['7', 'TA11'], ['8', 'TA11']]);
  // Another plant, or no filter.
  const ta12 = plain(Norm.normalizeRows(rows, { plant: 'TA12' }));
  assert.deepEqual(ta12.lines.map((l) => [l.row, l.division]), [[2, 'TA12'], [8, 'TA12']], 'blank division takes the plant');
  assert.equal(ta12.rejected.find((x) => x.row === 9).reason, 'Division TA11 hors périmètre (TA12 uniquement)');
  assert.equal(Norm.normalizeRows(rows, { plant: '' }).rejected.length, 5);
  // Without a Division column: lines accepted with the plant, and a warning.
  const noDiv = Norm.normalizeRows([H.filter((h) => h !== 'Division'), row({}).filter((v, i) => i !== 1)]);
  assert.equal(noDiv.lines[0].division, 'TA11');
  assert.match(noDiv.warnings[0], /Colonne Division absente/);
});

test('normalizeRows: errors when the header cannot be used', () => {
  const none = Norm.normalizeRows([['Titre'], ['a', 'b']]);
  assert.equal(none.ok, false);
  assert.match(none.error, /^En-tête MB51 introuvable/);
  assert.equal(none.lines.length, 0);
  const missing = Norm.normalizeRows([['Article', 'Magasin', 'MvT', 'Date cpt.', 'Qté en UQS'], ['1', 'PRD2', '101', '02.10.2026', '1']]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /^Colonnes obligatoires absentes : Doc\.article\. Exportez la liste MB51 .* puis déposez-la à nouveau\.$/);
  assert.equal(Norm.normalizeRows(null).ok, false);
});

test('normalizeRows: rank of identical lines in a document, Poste keys, Date objects (Sheets values)', () => {
  const same = row({ doc: '4901257400' });
  const r = Norm.normalizeRows([H, same, same.slice(), row({ doc: '4901257401' })]);
  assert.deepEqual(plain(r.lines).map((l) => l.rank), [1, 2, 1]);
  assert.deepEqual(plain(r.lines).map((l) => l.key), [
    '4901257400|1000102657|PRD2|101|144|2026-10-02|1',
    '4901257400|1000102657|PRD2|101|144|2026-10-02|2',
    '4901257401|1000102657|PRD2|101|144|2026-10-02|1']);
  // A later file holding one copy only: it is the first one, already known.
  const later = Norm.normalizeRows([H, same]);
  const d = Norm.dedupe(later.lines, r.lines.map((l) => l.key));
  assert.equal(d.duplicates.length, 1);

  const HP = ['Doc.article', 'Poste', 'Article', 'Magasin', 'MvT', 'Date cpt.', 'Qté en UQS'];
  const p = Norm.normalizeRows([HP, ['4901257400', '0001', 1000102657, 'EXP2', 311, new Date(2026, 9, 2), 144],
    ['4901257400', 2, '1000102657', 'PRD2', '311', new Date(2026, 9, 2, 12), -144]]);
  assert.deepEqual(plain(p.lines).map((l) => l.key), ['4901257400|1', '4901257400|2']);
  assert.deepEqual(plain(p.lines).map((l) => l.date), ['2026-10-02', '2026-10-02']);
});

test('codeText, canonUser, userKind', () => {
  const codes = [[4901257329, '4901257329'], ['4901257329', '4901257329'], ['4901257329.0', '4901257329'],
    ['4.901257329E+09', '4901257329'], ['4,901257329E+09', '4901257329'], ['4.901E+09', '4.901E+09'],
    [' 1000216115', '1000216115'], ['1000184644 ', '1000184644'], ['0001000914295', '1000914295'], ['000', '0'],
    ['ABC-01 ', 'ABC-01'], [null, ''], [undefined, '']];
  for (const [v, want] of codes) assert.equal(Norm.codeText(v, true), want, String(v));
  assert.equal(Norm.codeText('0101', false), '0101');
  assert.equal(Norm.codeText(311, false), '311');

  const users = [['BAR FLOW TA11', 'BARFLOW_TA11'], ['BARFLOW_TA11', 'BARFLOW_TA11'], [' barflow_ta11 ', 'BARFLOW_TA11'],
    ['Bar-Flow TA11', 'BARFLOW_TA11'], ['BARFLOWTA11', 'BARFLOW_TA11'], ['BAR FLOW TA12', 'BARFLOW_TA12'],
    ['opexp01', 'OPEXP01'], ['PLANIF01', 'PLANIF01'], ['', ''], [null, '']];
  for (const [v, want] of users) assert.equal(Norm.canonUser(v), want, String(v));
  assert.equal(Norm.userKind('BAR FLOW TA11'), 'Auto');
  assert.equal(Norm.userKind('OPEXP01'), 'Manuel');
});

test('keyOf: same key from normalised lines and from raw sheet values', () => {
  const line = { doc: '4901257329', article: '1000744039', magasin: 'PRD2', mvt: '101', qty: 480, date: '2026-10-02' };
  assert.equal(Norm.keyOf(line, 1), '4901257329|1000744039|PRD2|101|480|2026-10-02|1');
  assert.equal(Norm.keyOf(line), '4901257329|1000744039|PRD2|101|480|2026-10-02|1', 'rank defaults to 1');
  const raw = { doc: 4901257329, article: '0001000744039', magasin: 'prd2 ', mvt: 101, qty: '480,000', date: new Date(2026, 9, 2) };
  assert.equal(Norm.keyOf(raw, 1), Norm.keyOf(line, 1));
  assert.equal(Norm.keyOf(Object.assign({}, line, { qty: 0.1 + 0.2 }), 3), '4901257329|1000744039|PRD2|101|0.3|2026-10-02|3');
  assert.equal(Norm.keyOf(Object.assign({}, line, { poste: '0002' })), '4901257329|2');
});

test('dedupe: existing keys as Set, Map, array or object; duplicates inside the batch; inputs untouched', () => {
  const lines = [{ key: 'a' }, { key: 'b' }, { key: 'a' }, { key: 'c' }];
  const copy = JSON.stringify(lines);
  const forms = [new Set(['b']), new Map([['b', 'x']]), ['b'], { b: true }];
  for (const known of forms) {
    const d = Norm.dedupe(lines, known);
    assert.deepEqual(plain(d.fresh).map((l) => l.key), ['a', 'c']);
    assert.deepEqual(plain(d.duplicates).map((l) => l.key), ['b', 'a']);
  }
  assert.equal(Norm.dedupe(lines).fresh.length, 3);
  assert.equal(Norm.dedupe([], ['a']).fresh.length, 0);
  assert.equal(JSON.stringify(lines), copy);
  const set = new Set(['b']);
  Norm.dedupe(lines, set);
  assert.equal(set.size, 1, 'existing keys not modified');
  // A line without a key gets one from keyOf.
  const k = Norm.keyOf({ doc: '1', article: '2', magasin: 'PRD2', mvt: '101', qty: 1, date: '2026-10-02' });
  assert.equal(Norm.dedupe([{ doc: '1', article: '2', magasin: 'PRD2', mvt: '101', qty: 1, date: '2026-10-02' }], [k]).duplicates.length, 1);
});

test('flagTransfers: orphan legs, reversals, known lines, backdated lines', () => {
  const L = (doc, article, magasin, mvt, qty, date, row) =>
    ({ doc, article, magasin, mvt, qty, date: date || '2026-10-02', uqs: 'PC', file: 't.txt', row: row || 1, key: doc + magasin });
  const lines = [
    L('A', '1', 'PRD2', '311', -10), L('A', '1', 'EXP2', '311', 10),           // balanced
    L('B', '1', 'EXP2', '311', 5, null, 7),                                    // lone leg
    L('C', '1', 'PRD2', '101', 10),                                            // not a transfer
    L('D', '1', 'PRD2', '312', 10), L('D', '1', 'EXP2', '312', -10),           // balanced reversal
    L('E', '1', 'EXP2', '312', -10),                                           // lone reversal leg
    L('F', '1', 'PRD2', '311', -0.1), L('F', '1', 'PRD2', '311', -0.2), L('F', '1', 'EXP2', '311', 0.3), // float noise
    L('G', '1', 'PRD2', '311', -4), L('G', '2', 'EXP2', '311', 4),             // legs of different articles
    L('H', '1', 'PRD2', '311', -3, '2026-09-30'), L('H', '1', 'EXP2', '311', 3, '2026-10-01')
  ];
  const flags = plain(Norm.flagTransfers(lines));
  assert.deepEqual(flags.map((f) => [f.code, f.doc, f.article]), [
    ['TRANSFERT_ORPHELIN', 'B', '1'], ['TRANSFERT_ORPHELIN', 'E', '1'],
    ['TRANSFERT_ORPHELIN', 'G', '1'], ['TRANSFERT_ORPHELIN', 'G', '2']]);
  assert.equal(flags[0].row, 7);
  assert.equal(flags[0].file, 't.txt');
  assert.equal(flags[0].text, "Transfert orphelin : Doc.article B, article 1 : les lignes 311 ne s'annulent pas (solde 5 PC). Ligne acceptée, origine inconnue.");
  // The other leg already saved: no orphan, and saved lines are never flagged.
  const known = plain(Norm.flagTransfers([lines[2]], { knownLines: [L('B', '1', 'PRD2', '311', -5)] }));
  assert.deepEqual(known, []);
  // Backdated: strictly before the last loaded date.
  const back = plain(Norm.flagTransfers(lines, { lastImportedDate: '2026-10-01' })).filter((f) => f.code === 'ANTIDATE');
  assert.deepEqual(back.map((f) => [f.doc, f.date]), [['H', '2026-09-30']]);
  assert.match(back[0].text, /^Saisie antidatée : Doc\.article H daté du 30\/09\/2026/);
  assert.equal(plain(Norm.flagTransfers(lines, { lastImportedDate: 'pas une date' })).length, 4);
  // normalizeRows can flag ANTIDATE per file when given the date.
  const r = Norm.normalizeRows([H, row({ date: '30.09.2026' }), row({ doc: '2', date: '02.10.2026' })], { lastImportedDate: '2026-10-01' });
  assert.deepEqual(plain(r.flags).map((f) => [f.code, f.row]), [['ANTIDATE', 2]]);
});

test('textToRows: tab text with CRLF, SAP unconverted lists, CSV', () => {
  assert.deepEqual(plain(Norm.textToRows('Titre\r\n\r\nA\tB\r\n1\t2\r\n\t\r\n')),
    [['Titre'], [''], ['A', 'B'], ['1', '2'], ['', '']]);
  assert.deepEqual(plain(Norm.textToRows('A\tB\n1\t2')), [['A', 'B'], ['1', '2']]);
  assert.deepEqual(plain(Norm.textToRows('A\tB\r1\t2\r')), [['A', 'B'], ['1', '2']]);
  assert.deepEqual(plain(Norm.textToRows('\ufeffA\tB\r\n')), [['A', 'B']]);
  assert.deepEqual(plain(Norm.textToRows('Titre\n|A |B|\n|----|\n| 1|2 |\n')),
    [['Titre'], ['A ', 'B'], ['----'], [' 1', '2 ']]);
  assert.deepEqual(plain(Norm.textToRows('A;B;C\n"x;y";"q""z";729,25\n')), [['A', 'B', 'C'], ['x;y', 'q"z', '729,25']]);
  assert.deepEqual(plain(Norm.textToRows('A,B\n1,"2,5"')), [['A', 'B'], ['1', '2,5']]);
  assert.deepEqual(plain(Norm.textToRows('A;B', ',')), [['A;B']]);
  assert.deepEqual(plain(Norm.textToRows('')), []);
  assert.deepEqual(plain(Norm.textToRows(null)), []);
  // An unconverted SAP list goes through the normaliser like the tab export.
  const list = '|Article|Division|Magasin|MvT|Doc.article|Date cpt.|Qté en UQS|UQS|\n' +
    '|-------------------------------------|\n' +
    '|1000921426|TA11|PRD2|311|4901257657|02.10.2026|       200-|PC|\n';
  const r = Norm.normalizeRows(Norm.textToRows(list));
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].qty, -200);
  assert.equal(r.skipped.other, 1);
});

test('summarize: preview numbers and French sentence', () => {
  const r = Norm.normalizeRows([H, row({}), row({ doc: '2', user: 'OPEXP01', date: '03.10.2026' }), row({ doc: '3', division: 'TA12' }),
    [null, null, null, null, null, null, null, null, '288', 'PC']], { file: 'x.xlsx' });
  const s1 = plain(Norm.summarize(r));
  assert.equal(s1.read, 3);
  assert.equal(s1.valid, 2);
  assert.equal(s1.fresh, null);
  assert.equal(s1.rejected, 1);
  assert.equal(s1.skipped.total, 1);
  assert.equal(s1.auto, 1);
  assert.equal(s1.manual, 1);
  assert.deepEqual(s1.byMagasin, { PRD2: 2 });
  assert.equal(s1.text, '3 lignes lues · 2 valides · 1 rejetée · 1 ignorée (1 sous-total) · période du 02/10/2026 au 03/10/2026');
  assert.equal(s1.rows[0].label, 'Lignes lues');
  const d = Norm.dedupe(r.lines, [r.lines[0].key]);
  r.fresh = d.fresh;
  r.duplicates = d.duplicates;
  const s2 = plain(Norm.summarize(r, [{ code: 'ANTIDATE' }]));
  assert.equal(s2.fresh, 1);
  assert.equal(s2.duplicates, 1);
  assert.deepEqual(s2.flagCodes, { ANTIDATE: 1 });
  assert.equal(s2.text, '3 lignes lues · 1 nouvelle · 1 déjà connue · 1 rejetée · 1 ignorée (1 sous-total) · 1 alerte · période le 03/10/2026');
  const bad = plain(Norm.summarize(Norm.normalizeRows([['?']], { file: 'vide.txt' })));
  assert.match(bad.errors[0], /^vide\.txt : En-tête MB51 introuvable/);
});

// ---------------------------------------------------------------------------------------------------------------
// v2 unit tests (docs/SPEC_V2.md 2)

test('parseTime: day fractions, date-time serials, Dates, SAP text forms', () => {
  const ok = [
    [0, '00:00:00'], [0.5, '12:00:00'], [0.4547916666666666, '10:54:54'], [0.07140046296296296, '01:42:49'],
    [0.999999, '23:59:59'], [0.99999999, '23:59:59'], [1 / 86400, '00:00:01'], [0.5 / 86400, '00:00:01'],
    [46300.4547916666666, '10:54:54'], [46300, '00:00:00'], [46300.99999999, '23:59:59'], [1, '00:00:00'],
    [new Date(1899, 11, 30, 10, 54, 54), '10:54:54'], [new Date(2026, 9, 5, 7, 5, 0), '07:05:00'],
    [new Date(1899, 11, 30, 10, 54, 53, 999), '10:54:54'], [new Date(1899, 11, 30, 23, 59, 59, 700), '23:59:59'],
    [new Date(1899, 11, 30), '00:00:00'],
    ['10:54:54', '10:54:54'], [' 10:54:54 ', '10:54:54'], ['\u00a010:54:54\t', '10:54:54'], ['\u202f07:05\u202f', '07:05:00'], ['7:05', '07:05:00'],
    ['07:05', '07:05:00'], ['0:00', '00:00:00'], ['23:59:59', '23:59:59'], ['10:54:54.250', '10:54:54'],
    ['10:54:54 PM', '22:54:54'], ['10:54:54 AM', '10:54:54'], ['10:54:54PM', '22:54:54'], ['10:54:54 pm', '22:54:54'],
    ['10:54 p.m.', '22:54:00'], ['12:00:01 AM', '00:00:01'], ['12:30:00 PM', '12:30:00'], ['1:05:09 PM', '13:05:09'],
    ['105454', '10:54:54'], ['000000', '00:00:00'], ['235959', '23:59:59'], [' 070500 ', '07:05:00'],
    ['05.10.2026 10:54:54', '10:54:54'], ['2026-10-05 10:54:54', '10:54:54'], ['2026-10-05T07:05', '07:05:00']
  ];
  for (const [v, want] of ok) assert.equal(Norm.parseTime(v), want, String(v));
  const bad = ['24:00', '24:00:00', '10:60', '10:54:60', '13:00 PM', '00:30 PM', '7:5', '10:5:00', '1054', '1054545',
    '246000', '106000', '105460', '10.54.54', '10h54', 'abc', '10:54:54 XM', '', '   ', '05.10.2026', '31.02.2026 10:00',
    null, undefined, true, false, {}, [], -0.1, -1, NaN, Infinity, new Date('invalid')];
  for (const v of bad) assert.equal(Norm.parseTime(v), null, 'null for ' + JSON.stringify(v));
  // Never 24:00:00, whatever the float noise.
  for (let i = 0; i < 2000; i++) {
    const t = Norm.parseTime(46300 + i / 2000 + 1e-9);
    assert.match(t, /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/);
  }
});

test('labelOf: SPEC_V2 examples, item text first, header text of declarations only, raw values', () => {
  const cases = [
    [{ mvt: '131', headerText: '434514671|20261005010841' }, '434514671'],
    [{ mvt: '131', headerText: '434409999_1|202610050101' }, '434409999'],
    [{ mvt: '131', headerText: 'Z001:618402867320260005' }, ''],
    [{ mvt: '311', itemText: '434505101' }, '434505101'],
    [{ mvt: '311', headerText: 'TA11P101844856' }, ''],
    [{ mvt: '131', headerText: '434523710' }, '434523710'],
    [{ mvt: '101', headerText: '434523710|x' }, '434523710'],
    [{ mvt: '102', headerText: '434523710' }, '434523710'],
    [{ mvt: '132', headerText: '434523710' }, '434523710'],
    [{ mvt: '311', headerText: '434523710' }, '', 'a header label only on a declaration'],
    [{ mvt: '601', headerText: '434523710|20261005010841' }, ''],
    [{ mvt: '131', headerText: '434523710-1' }, '', 'only _ or | after the number'],
    [{ mvt: '131', headerText: '12345|20261005' }, '', '5 digits'],
    [{ mvt: '131', headerText: '1234567890123' }, '', '13 digits'],
    [{ mvt: '311', itemText: '123456' }, '123456'],
    [{ mvt: '311', itemText: '123456789012' }, '123456789012'],
    [{ mvt: '311', itemText: '12345' }, ''],
    [{ mvt: '311', itemText: '1234567890123' }, ''],
    [{ mvt: '311', itemText: '434505101|x' }, '', 'item text: digits only'],
    [{ mvt: '311', itemText: ' 434505101 ' }, '434505101'],
    [{ mvt: '311', itemText: 'Lot 05102026' }, ''],
    [{ mvt: '131', itemText: '434500001', headerText: '434500002|20261005' }, '434500001', 'item text wins'],
    [{ mvt: '131', itemText: 'abc', headerText: '434500002' }, '434500002'],
    [{ mvt: 131, headerText: 434523710 }, '434523710', 'numbers (Sheets values)'],
    [{ mvt: 311, itemText: 434505101 }, '434505101'],
    [{ mvt: '131' }, ''], [{}, '']
  ];
  for (const [line, want, why] of cases) assert.equal(Norm.labelOf(line), want, JSON.stringify(line) + (why ? ' ' + why : ''));
  assert.equal(Norm.labelOf(null), '');
  assert.equal(Norm.labelOf(undefined), '');
});

test('labelOf: patterns from CFG.LABEL, the same defaults without CFG, invalid pattern falls back', () => {
  const src = fs.readFileSync(path.join(SRC, 'Normalize.gs'), 'utf8');
  // CFG.LABEL of Config.gs = the normaliser defaults.
  assert.deepEqual(plain(ctx.CFG.LABEL), { itemRe: '^\\d{6,12}$', headerRe: '^(\\d{6,12})(?:[_|].*)?$', headerMvts: ['101', '102', '131', '132'] });
  const none = loadGs(['Normalize']);
  assert.equal(none.Norm.labelOf({ mvt: '131', headerText: '434514671|20261005010841' }), '434514671');
  assert.equal(none.Norm.labelOf({ mvt: '311', itemText: '434505101' }), '434505101');
  // Custom patterns, read at call time (CFG may change, the compiled patterns follow).
  const custom = vm.createContext({ CFG: { LABEL: { itemRe: '^L\\d{4}$', headerRe: '^H-(\\d{4})', headerMvts: ['311'] } } });
  vm.runInContext(src, custom);
  assert.equal(custom.Norm.labelOf({ mvt: '311', itemText: 'L1234' }), 'L1234');
  assert.equal(custom.Norm.labelOf({ mvt: '311', itemText: '434505101' }), '');
  assert.equal(custom.Norm.labelOf({ mvt: '311', headerText: 'H-4321 x' }), '4321');
  assert.equal(custom.Norm.labelOf({ mvt: '131', headerText: 'H-4321' }), '');
  vm.runInContext("CFG.LABEL = { itemRe: '(', headerRe: '^X(\\\\d+)$', headerMvts: ['131'] };", custom);
  assert.equal(custom.Norm.labelOf({ mvt: '311', itemText: '434505101' }), '434505101', 'invalid itemRe -> default');
  assert.equal(custom.Norm.labelOf({ mvt: '131', headerText: 'X77' }), '77');
  vm.runInContext('CFG.LABEL = { itemRe: /^\\d{3}$/g };', custom);
  assert.equal(custom.Norm.labelOf({ mvt: '311', itemText: '123' }), '123');
  assert.equal(custom.Norm.labelOf({ mvt: '311', itemText: '123' }), '123', 'RegExp with g: no lastIndex state');
  assert.equal(custom.Norm.labelOf({ mvt: '131', headerText: '434514671|1' }), '434514671', 'missing keys -> defaults');
});

test('mapHeaders: v2 synonyms, no collision between generic and long labels', () => {
  const cases = {
    qty: ['Qté en unité saisie', 'Quantité en unité saisie', 'Qté unité saisie', 'QTE EN UNITE SAISIE'],
    uqs: ['UQ de saisie', 'UQ saisie', 'Unité saisie'],
    entryDate: ['Date de saisie', 'Date saisie', 'Saisi le', 'Entry Date', 'Entered on', 'CPUDT'],
    entryTime: ['Heure de saisie', 'Heure saisie', 'Heure', 'Time of Entry', 'Entry Time', 'Time', 'CPUTM'],
    headerText: ["Texte d'en-tête pièce", 'Texte en-tête pièce', "Texte d'en-tête", 'Texte en-tête', 'Document Header Text',
      'Doc. Header Text', 'BKTXT', 'Texte d’en-tête pièce'],
    itemText: ['Texte', 'Texte poste', 'Texte du poste', 'Item Text', 'Text', 'SGTXT'],
    reference: ['Référence', 'Reference', 'Réf.', 'XBLNR'],
    client: ['Client', 'Customer', 'KUNNR'],
    salesOrder: ['Commande client', 'Cde client', 'Sales Order', 'Sales Document', 'KDAUF']
  };
  for (const [field, labels] of Object.entries(cases)) {
    for (const label of labels) assert.equal(Norm.mapHeaders(['xx', label]).index[field], 1, `${label} -> ${field}`);
  }
  for (const f of V2_FIELDS) assert.ok(Norm.FIELD_LABELS[f], 'French label of ' + f);
  assert.equal(Norm.FIELD_LABELS.entryTime, 'Heure de saisie');
  assert.equal(Norm.FIELD_LABELS.headerText, "Texte d'en-tête pièce");
  const idx = (h) => plain(Norm.mapHeaders(h).index);
  // The three texts, any order.
  for (const h of [['Texte', 'Texte code mouvement', "Texte d'en-tête pièce"], ["Texte d'en-tête pièce", 'Texte code mouvement', 'Texte']]) {
    const m = idx(h);
    assert.equal(h[m.itemText], 'Texte');
    assert.equal(h[m.text], 'Texte code mouvement');
    assert.equal(h[m.headerText], "Texte d'en-tête pièce");
  }
  // Référence vs Référence article.
  let m = Norm.mapHeaders(['Référence', 'Référence article', 'Article']);
  assert.equal(m.index.reference, 0);
  assert.equal(m.index.article, 2);
  assert.deepEqual(plain(m.extra), ['Référence article']);
  m = Norm.mapHeaders(['Référence article', 'Référence']);
  assert.equal(m.index.article, 0);
  assert.equal(m.index.reference, 1);
  // Generic time labels never take a more specific column.
  m = Norm.mapHeaders(['Heure', 'Heure de saisie', 'Date comptable']);
  assert.equal(m.index.entryTime, 1);
  assert.deepEqual(plain(m.extra), ['Heure']);
  m = Norm.mapHeaders(['Time', 'Entry Time']);
  assert.equal(m.index.entryTime, 1);
  m = Norm.mapHeaders(['Date de saisie', 'Date comptable', 'Heure']);
  assert.deepEqual([m.index.entryDate, m.index.date, m.index.entryTime], [0, 1, 2]);
  // Unit-of-entry quantity and unit before the base ones, with the real labels.
  m = Norm.mapHeaders(['Qté en unité de base', 'Unité de base', 'Qté en unité saisie', 'UQ de saisie']);
  assert.deepEqual([m.index.qty, m.index.uqs], [2, 3]);
  // Client vs Commande client vs Fournisseur.
  m = Norm.mapHeaders(['Commande client', 'Fournisseur', 'Client']);
  assert.deepEqual([m.index.salesOrder, m.index.client], [0, 2]);
  assert.deepEqual(plain(m.extra), ['Fournisseur']);
});

const H2 = ['Article', 'Division', 'Magasin', 'Code mouvement', 'Document article', 'Date comptable', 'Qté en unité saisie',
  'UQ de saisie', 'Date de saisie', 'Heure de saisie', "Texte d'en-tête pièce", 'Texte', 'Référence', 'Client',
  'Commande client', 'Montant DI', "Nom de l'utilisateur"];
const row2 = (o) => H2.map((h) => (Object.prototype.hasOwnProperty.call(o, h) ? o[h] : {
  Article: 'AB12345', Division: 'TA11', Magasin: 'PRD2', 'Code mouvement': '131', 'Document article': '6900000001',
  'Date comptable': '05.10.2026', 'Qté en unité saisie': '24', 'UQ de saisie': 'PCE', 'Date de saisie': '05.10.2026',
  'Heure de saisie': '10:54:54', "Texte d'en-tête pièce": '434500001|20261005105454', Texte: '', Référence: '',
  Client: '', 'Commande client': '', 'Montant DI': '0', "Nom de l'utilisateur": 'BARFLOWTA11'
}[h]));

test('normalizeRows: v2 fields (ts, label, texts, reference, customer, sales order)', () => {
  const r = Norm.normalizeRows([H2,
    row2({}),
    row2({ 'Document article': '6900000002', 'Date comptable': '04.10.2026', 'Date de saisie': '05.10.2026', 'Heure de saisie': '00:42:10' }),
    row2({ 'Document article': '6900000003', 'Date de saisie': '', 'Heure de saisie': '10:00' }),
    row2({ 'Document article': '6900000004', 'Heure de saisie': '' }),
    row2({ 'Document article': '6900000005', 'Heure de saisie': 'midi' }),
    row2({ 'Document article': '6900000006', 'Date de saisie': 'hier', 'Heure de saisie': '235959' }),
    row2({ 'Document article': '6900000007', 'Code mouvement': '311', "Texte d'en-tête pièce": ' TA11P101844856 ', Texte: ' 434500001 ',
      Référence: '0700011312', Client: '0000123456', 'Commande client': 1234567890 }),
    row2({ 'Document article': '6900000008', 'Code mouvement': '601', "Texte d'en-tête pièce": '434500009', Client: 'CLIENT A',
      'Commande client': '0012345678', Référence: 300506 })
  ], { file: 'v2.txt' });
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 8);
  assert.deepEqual(plain(r.mapping.extra), ['Montant DI']);
  const by = Object.fromEntries(plain(r.lines).map((l) => [l.doc, l]));
  const a = by['6900000001'];
  assert.equal(a.ts, '2026-10-05 10:54:54');
  assert.equal(a.label, '434500001');
  assert.equal(a.headerText, '434500001|20261005105454');
  assert.equal(a.itemText, '');
  assert.equal(a.user, 'BARFLOW_TA11');
  assert.equal(a.key, '6900000001|AB12345|PRD2|131|24|2026-10-05|1', 'ts and label are not part of the key');
  assert.equal(by['6900000002'].ts, '2026-10-05 00:42:10', 'night entry: entry date, not the posting date');
  assert.equal(by['6900000002'].date, '2026-10-04');
  assert.equal(by['6900000003'].ts, '2026-10-05 10:00:00', 'no entry date: posting date + time');
  assert.equal(by['6900000004'].ts, '', 'no time: no ts');
  assert.equal(by['6900000005'].ts, '', 'unreadable time: no ts, line kept');
  assert.equal(by['6900000006'].ts, '2026-10-05 23:59:59', 'unreadable entry date: posting date');
  const t = by['6900000007'];
  assert.deepEqual([t.label, t.headerText, t.itemText, t.reference, t.client, t.salesOrder],
    ['434500001', 'TA11P101844856', '434500001', '0700011312', '123456', '1234567890']);
  const s = by['6900000008'];
  assert.deepEqual([s.label, s.client, s.salesOrder, s.reference], ['', 'CLIENT A', '12345678', '300506']);
  for (const l of r.lines) assert.equal(typeof l.ts, 'string');
  // One warning for the unreadable time, none for the empty one or the unused column.
  assert.deepEqual(plain(r.warnings), ['1 ligne avec une heure de saisie illisible : acceptée sans horodatage (attente comptée en jours).']);
  const sum = plain(Norm.summarize(r));
  assert.equal(sum.withTime, 6);
  assert.equal(sum.withLabel, 7, 'six 131 header labels and one 311 item label');
  assert.deepEqual(sum.format, { file: 'v2.txt', columns: 17, hasTime: true, hasLabels: true, hasClient: true, extra: ['Montant DI'],
    withTime: 6, withLabel: 7 });
  assert.equal(sum.untracked, null);
  // Without the time column: ts stays empty, no warning.
  const noTime = Norm.normalizeRows([H2.filter((h) => h !== 'Heure de saisie'), row2({}).filter((v, i) => H2[i] !== 'Heure de saisie')]);
  assert.equal(noTime.lines[0].ts, '');
  assert.equal(noTime.lines[0].label, '434500001');
  assert.deepEqual(plain(noTime.warnings), []);
  assert.equal(plain(Norm.summarize(noTime)).format.hasTime, false);
  // Several unreadable times: plural warning.
  const bad = Norm.normalizeRows([H2, row2({ 'Heure de saisie': 'x' }), row2({ 'Document article': '6900000002', 'Heure de saisie': '25:00' })]);
  assert.match(bad.warnings[0], /^2 lignes avec une heure de saisie illisible : acceptées sans horodatage/);
});

test('flagTransfers: a labeled 311/312 leg is never an orphan, unlabeled legs keep the v1 rule', () => {
  const L = (doc, magasin, qty, extra) => Object.assign({ doc, article: 'AB12345', magasin, mvt: '311', qty, date: '2026-10-05',
    uqs: 'PCE', file: 'r.xlsx', row: 1, key: doc + magasin + qty }, extra || {});
  const lines = [
    L('A', 'PRD2', -24, { label: '434500001' }),                                      // other leg in PRD5: normal
    L('B', 'EXP2', 24, { itemText: '434500002' }),                                    // label from the item text
    L('C', 'EXP2', 24),                                                               // unlabeled lone leg
    L('D', 'PRD2', -24, { label: '434500003' }), L('D', 'EXP2', 20),                  // only the unlabeled leg flagged
    L('E', 'PRD2', -24, { label: '434500004' }), L('E', 'EXP2', 24, { label: '434500004' }), // balanced
    L('F', 'EXP2', 24, { label: '', itemText: '434500005' }),                         // label field wins (normalised line)
    L('G', 'EXP2', 12, { mvt: '312', label: '434500006' })                            // reversal with a label
  ];
  const flags = plain(Norm.flagTransfers(lines));
  assert.deepEqual(flags.map((f) => [f.code, f.doc, f.magasin, f.label]), [
    ['TRANSFERT_ORPHELIN', 'C', 'EXP2', ''], ['TRANSFERT_ORPHELIN', 'D', 'EXP2', ''], ['TRANSFERT_ORPHELIN', 'F', 'EXP2', '']]);
  assert.match(flags[1].text, /solde -4 PCE/);
});

test('filterTracked: tracked articles plus the EXP2 articles of the batch; EXP2 lines always kept', () => {
  const L = (article, magasin, doc) => ({ article, magasin, doc: doc || article + magasin, mvt: '131', qty: 1, date: '2026-10-05' });
  const lines = [
    L('FG1', 'PRD2'), L('FG1', 'EXP2'), L('SF1', 'PRD2'), L('RM1', 'EMRT'), L('RM1', 'PRD2'), L('FG2', 'PRD2'),
    L('123', 'PRD2'), L('LF23855', 'PRD2'), L('FG3', 'exp2 ')
  ];
  const copy = JSON.stringify(lines);
  const none = plain(Norm.filterTracked(lines));
  assert.deepEqual(none.batchTracked, ['FG1', 'FG3']);
  assert.deepEqual(none.keptArticles, ['FG1', 'FG3']);
  assert.deepEqual(none.droppedArticles, ['123', 'FG2', 'LF23855', 'RM1', 'SF1']);
  assert.equal(none.kept.length + none.dropped.length, lines.length);
  assert.deepEqual(none.kept.map((l) => l.doc), ['FG1PRD2', 'FG1EXP2', 'FG3exp2 ']);
  // Known tracked articles in every accepted form (leading zeros and case ignored).
  const forms = [['FG2', '000123', 'lf23855'], new Set(['FG2', '123', 'LF23855']), new Map([['FG2', 1], ['123', 1], ['LF23855', 1]]),
    { FG2: true, 123: true, LF23855: true, SF1: false }, [{ a: 'FG2' }, { a: '123' }, { article: 'LF23855' }]];
  for (const tracked of forms) {
    const r = plain(Norm.filterTracked(lines, tracked));
    assert.deepEqual(r.keptArticles, ['123', 'FG1', 'FG2', 'FG3', 'LF23855'], JSON.stringify(tracked));
    assert.deepEqual(r.droppedArticles, ['RM1', 'SF1']);
    assert.deepEqual(r.batchTracked, ['FG1', 'FG3'], 'batchTracked = EXP2 articles of the lines only');
  }
  assert.equal(JSON.stringify(lines), copy, 'inputs untouched');
  assert.deepEqual(plain(Norm.filterTracked(null)), { kept: [], dropped: [], keptArticles: [], droppedArticles: [], batchTracked: [] });
  assert.equal(Norm.filterTracked(lines, 'FG2').keptArticles.includes('FG2'), true, 'a single code');
});

test('normalizeBatch: trackedOnly filters all files together before dedupe; trackedOnly false keeps all', () => {
  const decl = [H2,
    row2({ Article: 'FG1', 'Document article': '6900000001' }),
    row2({ Article: 'SF1', 'Document article': '6900000002', "Texte d'en-tête pièce": 'Z001:6184' }),
    row2({ Article: 'FG2', 'Document article': '6900000003' }),
    row2({ Article: 'SF1', 'Document article': '6900000004', Division: 'TA12' })];
  const trans = [H2,
    row2({ Article: 'FG1', 'Document article': '6900000010', 'Code mouvement': '311', 'Qté en unité saisie': '24-', Texte: '434500001' }),
    row2({ Article: 'FG1', 'Document article': '6900000010', 'Code mouvement': '311', Magasin: 'EXP2', Texte: '434500001' }),
    row2({ Article: 'SF1', 'Document article': '6900000011', 'Code mouvement': '311', Magasin: 'EMRT', 'Qté en unité saisie': '5-' })];
  const files = [{ name: 'decl.xlsx', rows: decl }, { name: 'trans.xlsx', rows: trans }];
  const known = Norm.normalizeRows(decl).lines;
  const existingKeys = [known.find((l) => l.article === 'SF1').key, known.find((l) => l.article === 'FG2').key];

  const all = Norm.normalizeBatch(files, { existingKeys });
  assert.equal(all.summary.valid, 6);
  assert.equal(all.lines.length, 4);
  assert.equal(all.duplicates.length, 2);
  assert.deepEqual(plain(all.untracked), { lines: 0, articles: 0, list: [] });
  assert.equal(all.files[0].untracked, undefined);
  assert.equal(all.summary.untracked, null);

  const b = Norm.normalizeBatch(files, { existingKeys, trackedOnly: true, tracked: ['FG2'] });
  assert.equal(b.ok, true);
  assert.deepEqual(plain(b.batchTracked), ['FG1']);
  // FG1 of decl.xlsx is kept thanks to the EXP2 leg of trans.xlsx (all files together).
  assert.deepEqual(plain(b.lines.map((l) => [l.file, l.article, l.magasin])), [['decl.xlsx', 'FG1', 'PRD2'],
    ['trans.xlsx', 'FG1', 'PRD2'], ['trans.xlsx', 'FG1', 'EXP2']]);
  // The filter runs before dedupe: the known SF1 line is untracked, not a duplicate; the known FG2 line is a duplicate.
  assert.deepEqual(plain(b.duplicates.map((l) => l.article)), ['FG2']);
  assert.deepEqual(plain(b.untracked), { lines: 2, articles: 1, list: ['SF1'] });
  assert.deepEqual(plain(b.files.map((r) => r.untracked.length)), [1, 1]);
  assert.deepEqual(plain(b.files.map((r) => [r.summary.untracked, r.summary.untrackedArticles])), [[1, 1], [1, 1]]);
  assert.equal(b.summary.untracked, 2);
  assert.equal(b.summary.untrackedArticles, 1, 'distinct articles over the files');
  assert.equal(b.rejected.length, 1, 'rejected lines are not part of the filter');
  assert.equal(b.summary.valid, b.summary.fresh + b.summary.duplicates + b.summary.untracked);
  assert.equal(b.summary.text, '7 lignes lues · 3 nouvelles · 1 déjà connue · 2 hors produits finis · 1 rejetée · 0 ignorée · période le 05/10/2026');
  assert.deepEqual(plain(b.flags), [], 'labeled and balanced legs: no orphan');
  assert.deepEqual(plain(b.warnings), []);
  const rows = plain(b.summary.rows).map((x) => x.label);
  assert.deepEqual(rows.slice(0, 4), ['Lignes lues', 'Lignes valides', 'Hors produits finis (ignorées)', 'Nouvelles lignes']);
  assert.equal(b.summary.format, null, 'two files: one format each');
  assert.deepEqual(plain(b.summary.formats.map((f) => [f.file, f.columns, f.withLabel])), [['decl.xlsx', 17, 2], ['trans.xlsx', 17, 2]]);

  // Nothing tracked at all: everything dropped, with a French hint.
  const lonely = Norm.normalizeBatch([{ name: 'decl.xlsx', rows: decl }], { trackedOnly: true });
  assert.equal(lonely.lines.length, 0);
  assert.equal(lonely.untracked.lines, 3);
  assert.match(lonely.warnings[0], /^Aucune ligne de produit fini/);
  assert.ok(lonely.summary.warnings.includes(lonely.warnings[0]));
  // Without valid lines there is nothing to say.
  assert.deepEqual(plain(Norm.normalizeBatch([{ name: 'x', rows: [H2] }], { trackedOnly: true }).warnings), []);
  assert.equal(Norm.normalizeBatch([null], {}).ok, false, 'a missing file is an error, not a crash');
});

test('Normalize.gs: ES5 style (no arrow functions, let/const, template literals)', () => {
  const src = fs.readFileSync(path.join(SRC, 'Normalize.gs'), 'utf8');
  assert.doesNotMatch(src, /=>/);
  assert.doesNotMatch(src, /\b(let|const)\s/);
  assert.doesNotMatch(src, /`/);
  assert.doesNotMatch(src, /\bclass\s/);
});
