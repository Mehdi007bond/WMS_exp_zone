'use strict';
// Import normaliser (apps-script/src/Normalize.gs) against the messy MB51 fixtures of sample-data/messy/
// (expected.json is the oracle) plus unit tests of the parsing rules.
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

test('messy: every file is read and its header found', () => {
  for (const f of REF.files) {
    assert.equal(f.res.ok, true, f.name + ': ' + f.res.error);
    assert.deepEqual(plain(f.res.mapping.missing), [], f.name);
    assert.deepEqual(plain(f.res.mapping.optionalMissing), ['poste'], f.name + ' has no Poste column');
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
  // Full English header, any order.
  const en = Norm.mapHeaders(['Mat. Doc.', 'Item', 'Pstng Date', 'Material', 'Plant', 'SLoc', 'MvT', 'Mvt Type Text', 'S',
    'Qty in UnE', 'EUn', 'Material Description', 'User name', 'Entry Date']);
  assert.deepEqual(plain(en.missing), []);
  assert.deepEqual(plain(en.optionalMissing), []);
  assert.deepEqual(plain(en.extra), ['Entry Date']);
  assert.deepEqual(plain(en.index), { article: 3, division: 4, magasin: 5, mvt: 6, text: 7, s: 8, doc: 0, poste: 1,
    date: 2, qty: 9, uqs: 10, designation: 11, user: 12 });
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
    uqs: 'PC', designation: 'PF BAC', user: 'BARFLOW_TA11', source: 'IMPORT', file: 'f.xlsx', row: 4, rank: 1
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
