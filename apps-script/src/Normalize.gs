/**
 * EXP2 Digital Twin - import normaliser (Norm).
 *
 * Pure JavaScript, no Google services. Turns the rows of a SAP MB51 export into clean movement lines with stable
 * keys, and runs the checks shown on the import page before anything is saved.
 * The same source runs on the server (var Norm), in the browser (NormalizeModule_.toString()) and in Node tests,
 * so everything lives inside the factory and CFG is only read lazily, when it exists.
 *
 * Input rows (rows2d) are arrays of raw cell values, every physical row kept (blank ones included):
 *   - SheetJS: XLSX.utils.sheet_to_json(ws, Norm.SHEETJS_OPTIONS)  (Excel dates arrive as serial numbers)
 *   - Apps Script: range.getValues()                                  (dates arrive as Date objects)
 *   - text exports (.txt / .csv): Norm.textToRows(decodedText)        (windows-1252 decoded by the caller)
 *
 * Contract: docs/ARCHITECTURE.md section 6. Oracle: sample-data/messy/ (README.md and expected.json).
 */
function NormalizeModule_() {
  // Movement line fields, in MOUVEMENTS column order (Clé, Source, Import, Ajouté le are added by Repo).
  var FIELDS = ['article', 'division', 'magasin', 'mvt', 'text', 's', 'doc', 'poste', 'date', 'qty', 'uqs',
    'designation', 'user'];
  // What to do when a file is not recognised (appended to the header errors).
  var REEXPORT_HINT = ' Exportez la liste MB51 (Liste des documents article) avec la mise en forme habituelle, ' +
    'sans la retravailler dans Excel, puis déposez-la à nouveau.';
  var REQUIRED = ['article', 'magasin', 'mvt', 'doc', 'date', 'qty'];

  // French labels (MOUVEMENTS headers) used in every user-facing message.
  var FIELD_LABELS = {
    article: 'Article', division: 'Division', magasin: 'Magasin', mvt: 'MvT', text: 'Texte code mvt', s: 'S',
    doc: 'Doc.article', poste: 'Poste', date: 'Date cpt.', qty: 'Qté en UQS', uqs: 'UQS',
    designation: 'Désignation article', user: 'Nom utilisateur'
  };

  // Header synonyms per field, French and English, short and long ALV labels, plus SAP field names.
  // Compared after normLabel_ (case, accents, spaces and punctuation ignored). Order = priority inside a field:
  // the unit-of-entry quantity wins over the base-unit quantity when both columns are exported.
  var SYNONYMS = {
    article: ['Article', 'N° article', 'Numéro article', "Numéro d'article", 'Code article', 'Réf. article',
      'Référence article', 'Matériel', 'Material', 'Material Number', 'Matl', 'MATNR'],
    division: ['Division', 'Div.', 'Plant', 'Usine', 'WERKS'],
    magasin: ['Magasin', 'Mag.', 'Magasin de stockage', 'Emplacement magasin', 'Storage Location', 'Stor. Location',
      'Stor. Loc.', 'SLoc', 'LGORT'],
    mvt: ['MvT', 'TMvt', 'Type de mouvement', 'Type mouvement', 'Type mvt', 'Type de mvt', 'Code mouvement',
      'Code mvt', 'Code type mouvement', 'Movement Type', 'Mvmt Type', 'Mvt Type', 'Mvmt', 'BWART'],
    text: ['Texte code mvt', 'Texte code mouvement', 'Texte du code mouvement', 'Texte type mouvement',
      'Texte type de mouvement', 'Texte mvt', 'Libellé mvt', 'Libellé mouvement', 'Libellé type mouvement',
      'Mvt Type Text', 'MvT Text', 'Movement Type Text', 'Mvmt Type Text', 'Mvmt Type Txt', 'BTEXT'],
    s: ['S', 'Stock spécial', 'Ind. stock spécial', 'Indicateur stock spécial', 'Code stock spécial', 'Stock spé.',
      'Special Stock', 'Special stock indicator', 'Spec. Stock', 'Sp. Stock', 'Sp. St.', 'SOBKZ'],
    doc: ['Doc.article', 'Doc. article', 'Document article', 'N° doc. article', 'Numéro doc. article',
      'Numéro document article', 'Doc. art.', 'Mat. Doc.', 'Material Document', 'Material Doc.', 'Mat. Document',
      'MatDoc', 'MBLNR'],
    poste: ['Poste', 'Poste doc. article', 'Poste document article', 'Poste doc.', 'Pos.', 'Item',
      'Mat. Doc. Item', 'Material Doc. Item', 'Material Document Item', 'Matl Doc. Item', 'MatDoc Item', 'ZEILE'],
    date: ['Date cpt.', 'Date comptable', 'Date de comptabilisation', 'Date comptabilisation', 'Date compta.',
      'Date cptable', 'Date compt.', 'Pstng Date', 'Posting Date', 'Postg Date', 'Post. Date', 'BUDAT'],
    qty: ['Qté en UQS', 'Quantité en UQS', 'Qté en unité de saisie', 'Quantité en unité de saisie', 'Qté UQS',
      'Qté saisie', 'Quantité saisie', 'Qty in UnE', 'Qty in Un. of Entry', 'Qty in unit of entry',
      'Quantity in UnE', 'Quantity in Unit of Entry', 'ERFMG', 'Quantité', 'Qté', 'Quantity', 'Qty',
      'Qté en UQB', 'Quantité en UQB', 'Qté en unité de base', 'Quantité en unité de base', 'Qty in BUn',
      'Quantity in Base Unit', 'MENGE'],
    uqs: ['UQS', 'Unité de saisie', 'Unité qté saisie', 'Unité de quantité de saisie', 'UnE', 'EUn', 'Entry Unit',
      'Unit of Entry', 'Un. of Entry', 'ERFME', 'Unité', 'Unit', 'UQB', 'Unité de base', 'Unité de quantité de base',
      'Unité qté base', 'BUn', 'Base Unit of Measure', 'Base Unit', 'MEINS'],
    designation: ['Désignation article', 'Désignation', 'Désignation matériel', 'Texte article',
      'Texte court article', 'Libellé article', 'Material Description', 'Matl Description', 'Matl Desc.',
      'Material Text', 'Description', 'MAKTX'],
    user: ['Nom utilisateur', "Nom d'utilisateur", "Nom de l'utilisateur", 'Utilisateur', 'Code utilisateur',
      'Saisi par', 'Créé par', 'User name', 'Username', 'User', 'Entered by', 'Created by', 'USNAM']
  };

  // Recommended SheetJS reading options: raw cell values, every physical row kept.
  var SHEETJS_OPTIONS = { header: 1, raw: true, defval: null, blankrows: true };

  var HEADER_SCAN_ROWS = 50;         // rows inspected to find the header (title / blank lines may come first)
  var TRANSFER_MVTS = ['311', '312']; // documents whose legs must cancel out
  var MS_PER_DAY = 86400000;

  var SYN_NORM = {};   // field -> normalized synonyms, priority order
  FIELDS.forEach(function (f) {
    SYN_NORM[f] = [];
    SYNONYMS[f].forEach(function (label) {
      var n = normLabel_(label);
      if (n && SYN_NORM[f].indexOf(n) < 0) SYN_NORM[f].push(n);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Small helpers

  function isDate_(v) {
    return Object.prototype.toString.call(v) === '[object Date]';
  }

  function isEmpty_(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  // Trimmed text; String.prototype.trim also removes non-breaking spaces and the BOM.
  function cleanText_(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    return String(v).trim();
  }

  // Header label comparison key: lower case, no accents, no spaces or punctuation ('Qté en UQS' -> 'qteenuqs').
  function normLabel_(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (typeof s.normalize === 'function') s = s.normalize('NFD');
    return s.replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // SAP code as text (Doc.article, Article, Poste, MvT): numbers without exponent or '.0', trimmed,
  // optional removal of leading zeros for all-digit codes ('0001000914295' -> '1000914295').
  function codeText_(v, stripZeros) {
    var s;
    if (typeof v === 'number') {
      if (!isFinite(v)) return '';
      s = Math.floor(v) === v && Math.abs(v) < 1e21 ? v.toFixed(0) : String(v);
    } else {
      s = cleanText_(v);
      if (/^\d+\.0+$/.test(s)) {
        s = s.replace(/\.0+$/, '');
      } else if (isScientific_(s)) {
        // '4.901257329E+09' is exact and can be restored; '4.901E+09' lost digits and stays as is (rejected).
        var m = /^(\d+)(?:[.,](\d+))?e\+?(\d+)$/i.exec(s);
        var digits = m[1].replace(/^0+/, '').length + (m[2] ? m[2].length : 0);
        var n = Number(s.replace(',', '.'));
        if (isFinite(n) && Math.floor(n) === n && n < 9e15 && digits >= n.toFixed(0).length) {
          s = n.toFixed(0);
        }
      }
    }
    if (stripZeros && /^\d+$/.test(s)) s = s.replace(/^0+(?=\d)/, '');
    return s;
  }

  function isScientific_(s) {
    return /^\d+(?:[.,]\d+)?e\+?\d+$/i.test(s);
  }

  // Quantity text inside keys: at most 3 decimals (SAP precision), no float noise, no '-0'.
  function qtyKey_(q) {
    var n = typeof q === 'number' ? q : parseNumber(q);
    if (!isFinite(n)) return '';
    var r = Math.round(n * 1000) / 1000;
    return String(r === 0 ? 0 : r);
  }

  function pad2_(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function ymd_(y, m, d) {
    return y + '-' + pad2_(m) + '-' + pad2_(d);
  }

  // Valid calendar date -> 'yyyy-mm-dd', else null.
  function ymdChecked_(y, m, d) {
    if (!(y >= 1900 && y <= 2999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
    var t = new Date(Date.UTC(y, m - 1, d));
    if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
    return ymd_(y, m, d);
  }

  // 'yyyy-mm-dd' -> 'dd/mm/yyyy' for French messages.
  function frDate_(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }

  // French number display for messages: 729.25 -> '729,25', 1440 -> '1 440'.
  function frNumber_(n) {
    if (!isFinite(n)) return String(n);
    var r = Math.round(n * 1000) / 1000;
    var neg = r < 0;
    var parts = String(Math.abs(r)).split('.');
    var intText = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
    return (neg ? '-' : '') + intText + (parts[1] ? ',' + parts[1] : '');
  }

  function plural_(n, one, many) {
    return n + ' ' + (n <= 1 ? one : many);
  }

  function defaultPlant_() {
    return typeof CFG !== 'undefined' && CFG && CFG.PLANT ? CFG.PLANT : 'TA11';
  }

  function autoUsers_() {
    return typeof CFG !== 'undefined' && CFG && CFG.AUTO_USERS ? CFG.AUTO_USERS : ['BARFLOW_TA11'];
  }

  function cell_(row, col) {
    if (col === undefined || col === null || !row) return null;
    var v = row[col];
    return v === undefined ? null : v;
  }

  function asRow_(r) {
    if (Array.isArray(r)) return r;
    if (r === null || r === undefined) return [];
    return [r];
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Parsing

  /**
   * Number from a cell: JS numbers as is; SAP French text '1.234,500' (dot = thousands, comma = decimals),
   * '729,25', '320-' (trailing minus), '-320', '1 234,5' (normal, non-breaking or narrow spaces), '(320)',
   * English '1,234.5'. A single dot followed by exactly 3 digits is a thousands separator ('1.440' = 1440).
   * Returns NaN when the value is empty or not a number.
   */
  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    if (v === null || v === undefined || typeof v === 'boolean' || isDate_(v)) return NaN;
    var s = String(v).replace(/[\s\u00a0\u2007\u202f'\u2019]/g, '').replace(/[\u2212\u2013]/g, '-');
    if (!s) return NaN;
    var neg = false;
    var paren = /^\((.*)\)$/.exec(s);
    if (paren) {
      neg = true;
      s = paren[1];
    }
    if (/^[-+]/.test(s)) {
      if (s.charAt(0) === '-') neg = !neg;
      s = s.slice(1);
    } else if (/[-+]$/.test(s)) {
      if (s.charAt(s.length - 1) === '-') neg = !neg;
      s = s.slice(0, -1);
    }
    if (/^\d+(?:\.\d+)?e[-+]?\d+$/i.test(s)) {
      var e = Number(s);
      return isFinite(e) ? (neg && e !== 0 ? -e : e) : NaN;
    }
    if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return NaN;

    var intPart = s, decPart = '', thousands = '';
    var hasDot = s.indexOf('.') >= 0, hasComma = s.indexOf(',') >= 0;
    if (hasDot && hasComma) {
      var dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      thousands = dec === '.' ? ',' : '.';
      var p = s.split(dec);
      if (p.length !== 2) return NaN;
      intPart = p[0];
      decPart = p[1];
    } else if (hasComma) {
      var c = s.split(',');
      if (c.length === 2) {
        intPart = c[0];       // SAP French: a single comma is the decimal separator
        decPart = c[1];
      } else {
        thousands = ',';
      }
    } else if (hasDot) {
      var d = s.split('.');
      if (d.length > 2 || /^[1-9]\d{0,2}\.\d{3}$/.test(s)) {
        thousands = '.';      // SAP French thousands: '1.440', '1.234.567'
      } else {
        intPart = d[0];
        decPart = d[1];
      }
    }
    if (thousands) {
      var groups = intPart.split(thousands);
      if (groups.length > 1) {
        if (!/^\d{1,3}$/.test(groups[0])) return NaN;
        for (var i = 1; i < groups.length; i++) {
          if (!/^\d{3}$/.test(groups[i])) return NaN;
        }
      }
      intPart = groups.join('');
    }
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(decPart) || (intPart === '' && decPart === '')) return NaN;
    var n = Number((intPart || '0') + (decPart ? '.' + decPart : ''));
    if (!isFinite(n)) return NaN;
    return neg && n !== 0 ? -n : n;
  }

  // Excel serial (days since 1899-12-30, 1900 system) or yyyymmdd number -> 'yyyy-mm-dd'.
  function dateFromNumber_(n) {
    if (!isFinite(n)) return null;
    if (n >= 19000101 && n <= 29991231 && Math.floor(n) === n) {
      return ymdChecked_(Math.floor(n / 10000), Math.floor(n / 100) % 100, n % 100);
    }
    if (n < 61 || n > 2958465) return null; // before 1900-03-01 (Excel's fake 1900-02-29) or after 9999
    var t = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * MS_PER_DAY);
    return ymd_(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }

  /**
   * Date from a cell -> 'yyyy-mm-dd', or null when empty or unreadable.
   * Accepts JS Date (local calendar day), Excel serial numbers (46297 = 2026-10-02), yyyymmdd numbers,
   * 'dd.mm.yyyy', 'dd/mm/yyyy', 'dd-mm-yyyy' (always day first, 2-digit years = 20yy), 'yyyy-mm-dd',
   * 'yyyymmdd', with or without a time part.
   */
  function parseDate(v) {
    if (v === null || v === undefined) return null;
    if (isDate_(v)) {
      if (isNaN(v.getTime())) return null;
      return ymdChecked_(v.getFullYear(), v.getMonth() + 1, v.getDate());
    }
    if (typeof v === 'number') return dateFromNumber_(v);
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!s) return null;
    // Full ISO timestamp with a zone (a serialized Date): use the local calendar day.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
      var t = new Date(s);
      return isNaN(t.getTime()) ? null : ymdChecked_(t.getFullYear(), t.getMonth() + 1, t.getDate());
    }
    s = s.replace(/(?:T|\s+)\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/i, '');
    var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s);
    if (m) return ymdChecked_(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})$/.exec(s);
    if (m) return ymdChecked_(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
    if (/^\d{8}$/.test(s)) return ymdChecked_(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    if (/^\d{5}(?:[.,]\d+)?$/.test(s)) return dateFromNumber_(Number(s.replace(',', '.')));
    return null;
  }

  /**
   * Canonical user name. Automatic users are compared with spaces, '_', '-', '.' and case ignored:
   * 'BAR FLOW TA11', 'barflow_ta11' -> 'BARFLOW_TA11'. Other users are trimmed and upper-cased.
   */
  function canonUser(v) {
    var s = cleanText_(v);
    if (!s) return '';
    var k = s.toUpperCase().replace(/[\s_.\-]+/g, '');
    var autos = autoUsers_();
    for (var i = 0; i < autos.length; i++) {
      if (String(autos[i]).toUpperCase().replace(/[\s_.\-]+/g, '') === k) return autos[i];
    }
    var bf = /^BARFLOW([A-Z0-9]+)$/.exec(k);
    if (bf) return 'BARFLOW_' + bf[1];
    return s.toUpperCase().replace(/\s+/g, ' ');
  }

  function isAutoUser(v) {
    var u = canonUser(v);
    return !!u && (autoUsers_().indexOf(u) >= 0 || /^BARFLOW_/.test(u));
  }

  // Screens never show user names: 'Auto' (BARFLOW) or 'Manuel'.
  function userKind(v) {
    return isAutoUser(v) ? 'Auto' : 'Manuel';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Headers

  /**
   * Maps a header row to fields by synonyms. Each column is used once; inside a field, synonyms are tried in
   * priority order. -> { index: { field: col }, labels: { field: label }, missing: [required field],
   *    optionalMissing: [field], extra: [unmapped non-empty label], matched: count }
   */
  function mapHeaders(headerRow) {
    var row = asRow_(headerRow);
    var norm = row.map(normLabel_);
    var used = {};
    var index = {}, labels = {};
    FIELDS.forEach(function (f) {
      var syns = SYN_NORM[f];
      for (var p = 0; p < syns.length; p++) {
        for (var c = 0; c < norm.length; c++) {
          if (!used[c] && norm[c] === syns[p]) {
            index[f] = c;
            labels[f] = cleanText_(row[c]);
            used[c] = true;
            return;
          }
        }
      }
    });
    var extra = [];
    row.forEach(function (v, c) {
      if (!used[c] && !isEmpty_(v)) extra.push(cleanText_(v));
    });
    var missing = REQUIRED.filter(function (f) { return index[f] === undefined; });
    var optionalMissing = FIELDS.filter(function (f) {
      return REQUIRED.indexOf(f) < 0 && index[f] === undefined;
    });
    return {
      index: index, labels: labels, missing: missing, optionalMissing: optionalMissing, extra: extra,
      matched: Object.keys(index).length
    };
  }

  /**
   * Index (0-based) of the header row: the first row (within the first 50) that holds every required column,
   * else the row with the most recognised columns when it has at least 3, else -1.
   * Rows above it (export title, blank lines) are the preamble.
   */
  function detectHeaderRow(rows2d) {
    var rows = Array.isArray(rows2d) ? rows2d : [];
    var best = -1, bestScore = 0;
    var n = Math.min(rows.length, HEADER_SCAN_ROWS);
    for (var i = 0; i < n; i++) {
      var r = asRow_(rows[i]);
      if (!r.some(function (v) { return !isEmpty_(v); })) continue;
      var m = mapHeaders(r);
      if (!m.missing.length) return i;
      var score = REQUIRED.length - m.missing.length;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return bestScore >= 3 ? best : -1;
  }

  // A data row that repeats the header (ALV page breaks, concatenated exports).
  function isHeaderRepeat_(row, index) {
    var hits = 0;
    for (var f in index) {
      if (SYN_NORM[f].indexOf(normLabel_(row[index[f]])) >= 0) hits++;
    }
    return hits >= 3;
  }

  function isBlankRow_(row) {
    for (var i = 0; i < row.length; i++) {
      if (!isEmpty_(row[i])) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Keys

  /**
   * Line key (MOUVEMENTS 'Clé'): 'Doc.article|Poste' when Poste is known, else
   * 'Doc.article|Article|Magasin|MvT|qty|date|rank' (rank = n-th identical line inside the same document in the
   * file, 1 for the first). Tolerates raw values (numbers, Date, French number text) so Repo can rebuild keys
   * from sheet rows.
   */
  function keyOf(line, rank) {
    var doc = codeText_(line.doc, true);
    var poste = codeText_(line.poste, true);
    if (poste !== '') return doc + '|' + poste;
    var date = typeof line.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(line.date) ? line.date : parseDate(line.date);
    var r = rank || line.rank || 1;
    return [doc, codeText_(line.article, true), cleanText_(line.magasin).toUpperCase(), codeText_(line.mvt, false),
      qtyKey_(line.qty), date || '', r].join('|');
  }

  function identityOf_(line) {
    return [line.doc, line.article, line.magasin, line.mvt, qtyKey_(line.qty), line.date].join('|');
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Rows -> lines

  /**
   * Normalises the rows of one export file.
   * opts: { plant: 'TA11' (default CFG.PLANT; '' disables the filter), file: name, firstRow: physical number of
   *         rows2d[0] (default 1), headerRow: forced 0-based index, source: 'IMPORT', lastImportedDate: 'yyyy-mm-dd'
   *         (optional: flags ANTIDATE lines here; do not also pass it to flagTransfers for the same lines) }
   * -> { ok, error, file, plant, headerRow, preamble, mapping, dataRows,
   *      lines: [{ key, article, division, magasin, mvt, text, s, doc, poste, date, qty, uqs, designation, user,
   *                source, file, row, rank }],
   *      skipped: { header, subtotal, blank, other }, skippedRows: [{ row, kind }],
   *      rejected: [{ row, file, reason, doc, article, division, magasin, mvt }], flags: [], warnings: [] }
   * Rows after the header: blank -> skipped.blank; header repeated -> skipped.header; no Doc.article but a quantity
   * (subtotals, totals) -> skipped.subtotal; no Doc.article and no quantity (notes, separators) -> skipped.other;
   * every other row is a data row, valid or rejected with a French reason.
   */
  function normalizeRows(rows2d, opts) {
    opts = opts || {};
    var plant = opts.plant === undefined || opts.plant === null ? defaultPlant_() : cleanText_(opts.plant).toUpperCase();
    var file = opts.file || '';
    var firstRow = opts.firstRow === undefined || opts.firstRow === null ? 1 : opts.firstRow;
    var source = opts.source || 'IMPORT';
    var res = {
      ok: false, error: '', file: file, plant: plant, headerRow: -1, preamble: 0, mapping: null, dataRows: 0,
      lines: [], skipped: { header: 0, subtotal: 0, blank: 0, other: 0 }, skippedRows: [], rejected: [],
      flags: [], warnings: []
    };
    var rows = Array.isArray(rows2d) ? rows2d : [];
    var h = typeof opts.headerRow === 'number' ? opts.headerRow : detectHeaderRow(rows);
    if (h < 0 || h >= rows.length) {
      res.error = 'En-tête MB51 introuvable : aucune ligne ne contient les colonnes ' +
        REQUIRED.map(function (f) { return FIELD_LABELS[f]; }).join(', ') + '.' + REEXPORT_HINT;
      return res;
    }
    var mapping = mapHeaders(rows[h]);
    res.headerRow = h;
    res.preamble = h;
    res.mapping = mapping;
    if (mapping.missing.length) {
      res.error = 'Colonnes obligatoires absentes : ' +
        mapping.missing.map(function (f) { return FIELD_LABELS[f]; }).join(', ') + '.' + REEXPORT_HINT;
      return res;
    }
    var idx = mapping.index;
    if (idx.division === undefined && plant) {
      res.warnings.push('Colonne Division absente : le filtre division ' + plant + " n'est pas appliqué.");
    }
    var ranks = {};

    function skip(kind, rowNo) {
      res.skipped[kind]++;
      res.skippedRows.push({ row: rowNo, kind: kind });
    }

    for (var i = h + 1; i < rows.length; i++) {
      var row = asRow_(rows[i]);
      var rowNo = i + firstRow;
      if (isBlankRow_(row)) {
        skip('blank', rowNo);
        continue;
      }
      var doc = codeText_(cell_(row, idx.doc), true);
      var qtyRaw = cell_(row, idx.qty);
      if (!/\d/.test(doc)) {
        if (isHeaderRepeat_(row, idx)) skip('header', rowNo);
        else if (!isEmpty_(qtyRaw)) skip('subtotal', rowNo);
        else skip('other', rowNo);
        continue;
      }
      res.dataRows++;

      var dateRaw = cell_(row, idx.date);
      var line = {
        key: '',
        article: codeText_(cell_(row, idx.article), true),
        division: cleanText_(cell_(row, idx.division)).toUpperCase(),
        magasin: cleanText_(cell_(row, idx.magasin)).toUpperCase(),
        mvt: codeText_(cell_(row, idx.mvt), false),
        text: cleanText_(cell_(row, idx.text)),
        s: cleanText_(cell_(row, idx.s)).toUpperCase(),
        doc: doc,
        poste: codeText_(cell_(row, idx.poste), true),
        date: parseDate(dateRaw),
        qty: parseNumber(qtyRaw),
        uqs: cleanText_(cell_(row, idx.uqs)).toUpperCase(),
        designation: cleanText_(cell_(row, idx.designation)),
        user: canonUser(cell_(row, idx.user)),
        source: source,
        file: file,
        row: rowNo,
        rank: 0
      };

      var reasons = [];
      if (plant && line.division && line.division !== plant) {
        reasons.push('Division ' + line.division + ' hors périmètre (' + plant + ' uniquement)');
      }
      if (!line.article) reasons.push('Article manquant');
      else if (isScientific_(line.article)) reasons.push('Article illisible (notation scientifique) : « ' + line.article + ' »');
      if (!line.magasin) reasons.push('Magasin manquant');
      if (!line.mvt) reasons.push('Type de mouvement (MvT) manquant');
      if (!/^[0-9A-Za-z]+$/.test(doc)) reasons.push('Doc.article illisible : « ' + doc + ' »');
      if (!line.date) {
        reasons.push(isEmpty_(dateRaw) ? 'Date cpt. manquante' : 'Date cpt. illisible : « ' + cleanText_(dateRaw) + ' »');
      }
      if (!isFinite(line.qty)) {
        reasons.push(isEmpty_(qtyRaw) ? 'Quantité manquante' : 'Quantité illisible : « ' + cleanText_(qtyRaw) + ' »');
      }
      if (reasons.length) {
        res.rejected.push({
          row: rowNo, file: file, reason: reasons.join(' ; '), doc: doc, article: line.article,
          division: line.division, magasin: line.magasin, mvt: line.mvt
        });
        continue;
      }
      if (!line.division) line.division = plant;

      var id = identityOf_(line);
      ranks[id] = (ranks[id] || 0) + 1;
      line.rank = ranks[id];
      line.key = keyOf(line, line.rank);
      res.lines.push(line);
    }
    if (opts.lastImportedDate) res.flags = antidateFlags_(res.lines, opts.lastImportedDate);
    res.ok = true;
    return res;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Text exports

  /**
   * Splits a decoded text export into rows2d: CRLF / LF / CR line ends, a final line end does not create a row,
   * every other physical line is kept. Delimiter: tab when present (SAP 'Texte avec tabulations', no quoting),
   * else '|' for SAP unconverted lists (outer bars dropped), else ';' or ',' with RFC 4180 quotes.
   */
  function textToRows(text, delimiter) {
    var t = String(text === null || text === undefined ? '' : text).replace(/^\ufeff/, '');
    var lines = t.split(/\r\n|\n|\r/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    var sample = lines.slice(0, HEADER_SCAN_ROWS).join('\n');
    var delim = delimiter;
    if (!delim) {
      if (sample.indexOf('\t') >= 0) delim = '\t';
      else if (/^\|/m.test(sample)) delim = '|';
      else if (sample.indexOf(';') >= 0) delim = ';';
      else delim = ',';
    }
    return lines.map(function (l) {
      if (delim === '\t') return l.split('\t');
      if (delim === '|') {
        var bars = l.split('|');
        if (/^\s*\|/.test(l)) bars.shift();
        if (/\|\s*$/.test(l)) bars.pop();
        return bars;
      }
      return splitQuoted_(l, delim);
    });
  }

  function splitQuoted_(line, delim) {
    var out = [], field = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (q) {
        if (ch === '"' && line.charAt(i + 1) === '"') { field += '"'; i++; }
        else if (ch === '"') q = false;
        else field += ch;
      } else if (ch === '"' && field === '') {
        q = true;
      } else if (ch === delim) {
        out.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    out.push(field);
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Deduplication and batch checks

  function keyLookup_(keys) {
    if (!keys) return function () { return false; };
    if (typeof keys.has === 'function') return function (k) { return !!keys.has(k); };
    if (Array.isArray(keys)) {
      var set = {};
      keys.forEach(function (k) { set[k] = true; });
      return function (k) { return Object.prototype.hasOwnProperty.call(set, k); };
    }
    if (typeof keys === 'object') {
      return function (k) { return Object.prototype.hasOwnProperty.call(keys, k) && !!keys[k]; };
    }
    return function () { return false; };
  }

  /**
   * Splits lines into fresh ones and duplicates, against existingKeys (Set, Map, array of keys, { key: true }
   * object or any object with has(key)) and against the earlier lines of the same call. Does not modify its inputs.
   * -> { fresh: [line], duplicates: [line] }
   */
  function dedupe(lines, existingKeys) {
    var known = keyLookup_(existingKeys);
    var seen = {};
    var fresh = [], duplicates = [];
    (lines || []).forEach(function (l) {
      var k = l.key || keyOf(l, l.rank);
      if (known(k) || Object.prototype.hasOwnProperty.call(seen, k)) {
        duplicates.push(l);
      } else {
        seen[k] = true;
        fresh.push(l);
      }
    });
    return { fresh: fresh, duplicates: duplicates };
  }

  function flag_(code, line, text) {
    return {
      code: code, text: text, file: line.file || '', row: line.row, doc: line.doc, article: line.article,
      magasin: line.magasin, mvt: line.mvt, qty: line.qty, uqs: line.uqs, date: line.date, key: line.key
    };
  }

  // ANTIDATE: posting date strictly older than the last date already loaded (a late posting that changes
  // history; the state must be recomputed from a checkpoint on or before that date).
  function antidateFlags_(lines, lastImportedDate) {
    var last = parseDate(lastImportedDate);
    if (!last) return [];
    var out = [];
    (lines || []).forEach(function (l) {
      if (l.date && l.date < last) {
        out.push(flag_('ANTIDATE', l, 'Saisie antidatée : Doc.article ' + l.doc + ' daté du ' + frDate_(l.date) +
          ", antérieur aux données déjà chargées (jusqu'au " + frDate_(last) + ').'));
      }
    });
    return out;
  }

  /**
   * Batch checks, run once on the fresh lines of all files of an import:
   *  - TRANSFERT_ORPHELIN: lines of a 311/312 document whose legs do not cancel out (sum per Doc.article and
   *    Article != 0). opts.knownLines (lines already saved) take part in the pairing but are never flagged.
   *  - ANTIDATE: when opts.lastImportedDate is given, lines dated before it.
   * Flagged lines are still accepted. -> [{ code, text, file, row, doc, article, magasin, mvt, qty, uqs, date, key }]
   */
  function flagTransfers(lines, opts) {
    opts = opts || {};
    var mvts = (opts.transferMvts || TRANSFER_MVTS).map(String);
    var groups = {}, order = [];

    function add(l, own) {
      var mvt = codeText_(l.mvt, false);
      if (mvts.indexOf(mvt) < 0) return;
      var qty = typeof l.qty === 'number' ? l.qty : parseNumber(l.qty);
      if (!isFinite(qty)) return;
      var g = codeText_(l.doc, true) + '|' + codeText_(l.article, true);
      if (!groups[g]) {
        groups[g] = { milli: 0, own: [] };
        order.push(g);
      }
      groups[g].milli += Math.round(qty * 1000);
      if (own) groups[g].own.push(l);
    }

    (opts.knownLines || []).forEach(function (l) { add(l, false); });
    (lines || []).forEach(function (l) { add(l, true); });

    var flags = [];
    order.forEach(function (g) {
      var G = groups[g];
      if (G.milli === 0 || !G.own.length) return;
      G.own.forEach(function (l) {
        flags.push(flag_('TRANSFERT_ORPHELIN', l, 'Transfert orphelin : Doc.article ' + l.doc + ', article ' +
          l.article + ' : les lignes ' + l.mvt + " ne s'annulent pas (solde " + frNumber_(G.milli / 1000) +
          (l.uqs ? ' ' + l.uqs : '') + '). Ligne acceptée, origine inconnue.'));
      });
    });
    if (opts.lastImportedDate) flags = flags.concat(antidateFlags_(lines, opts.lastImportedDate));
    return flags;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Preview

  /**
   * Preview numbers for one normalizeRows result or an array of them (a batch). When dedupe ran, attach its output
   * to the result (result.fresh, result.duplicates) to get new / already known counts. batchFlags: optional flags
   * from flagTransfers to count with the results' own flags.
   * -> { files, preamble, read, valid, fresh, duplicates, rejected, skipped: { header, subtotal, blank, other, total },
   *      flags, flagCodes, documents, dateMin, dateMax, byMagasin, byMvt, auto, manual, errors, warnings,
   *      rows: [{ label, value }] (French labels), text (one French sentence) }
   */
  function summarize(result, batchFlags) {
    var list = Array.isArray(result) ? result : [result];
    var s = {
      files: list.length, preamble: 0, read: 0, valid: 0, fresh: null, duplicates: null, rejected: 0,
      skipped: { header: 0, subtotal: 0, blank: 0, other: 0, total: 0 }, flags: 0, flagCodes: {},
      documents: 0, dateMin: '', dateMax: '', byMagasin: {}, byMvt: {}, auto: 0, manual: 0,
      errors: [], warnings: [], rows: [], text: ''
    };
    var docs = {};
    var allFlags = [];
    list.forEach(function (r) {
      if (!r) return;
      var name = r.file ? r.file + ' : ' : '';
      if (r.error) s.errors.push(name + r.error);
      (r.warnings || []).forEach(function (w) { s.warnings.push(name + w); });
      s.preamble += r.preamble || 0;
      s.read += r.dataRows || 0;
      s.valid += (r.lines || []).length;
      s.rejected += (r.rejected || []).length;
      ['header', 'subtotal', 'blank', 'other'].forEach(function (k) {
        s.skipped[k] += r.skipped ? r.skipped[k] || 0 : 0;
      });
      if (r.fresh) s.fresh = (s.fresh || 0) + r.fresh.length;
      if (r.duplicates) s.duplicates = (s.duplicates || 0) + r.duplicates.length;
      allFlags = allFlags.concat(r.flags || []);
      (r.fresh || r.lines || []).forEach(function (l) {
        docs[l.doc] = true;
        if (!s.dateMin || l.date < s.dateMin) s.dateMin = l.date;
        if (!s.dateMax || l.date > s.dateMax) s.dateMax = l.date;
        s.byMagasin[l.magasin] = (s.byMagasin[l.magasin] || 0) + 1;
        s.byMvt[l.mvt] = (s.byMvt[l.mvt] || 0) + 1;
        if (isAutoUser(l.user)) s.auto++;
        else s.manual++;
      });
    });
    allFlags = allFlags.concat(batchFlags || []);
    allFlags.forEach(function (f) { s.flagCodes[f.code] = (s.flagCodes[f.code] || 0) + 1; });
    s.flags = allFlags.length;
    s.documents = Object.keys(docs).length;
    s.skipped.total = s.skipped.header + s.skipped.subtotal + s.skipped.blank + s.skipped.other;

    var ignored = [];
    if (s.skipped.subtotal) ignored.push(plural_(s.skipped.subtotal, 'sous-total', 'sous-totaux'));
    if (s.skipped.header) ignored.push(plural_(s.skipped.header, 'en-tête répété', 'en-têtes répétés'));
    if (s.skipped.blank) ignored.push(plural_(s.skipped.blank, 'ligne vide', 'lignes vides'));
    if (s.skipped.other) ignored.push(plural_(s.skipped.other, 'autre ligne', 'autres lignes'));
    var period = s.dateMin ? (s.dateMin === s.dateMax ? 'le ' + frDate_(s.dateMin)
      : 'du ' + frDate_(s.dateMin) + ' au ' + frDate_(s.dateMax)) : '';

    s.rows.push({ label: 'Lignes lues', value: s.read });
    s.rows.push({ label: 'Lignes valides', value: s.valid });
    if (s.fresh !== null) s.rows.push({ label: 'Nouvelles lignes', value: s.fresh });
    if (s.duplicates !== null) s.rows.push({ label: 'Déjà connues (ignorées)', value: s.duplicates });
    s.rows.push({ label: 'Rejetées', value: s.rejected });
    s.rows.push({ label: 'Ignorées (sous-totaux, en-têtes, vides)', value: s.skipped.total });
    s.rows.push({ label: 'Alertes', value: s.flags });
    s.rows.push({ label: 'Documents', value: s.documents });
    if (period) s.rows.push({ label: 'Période', value: period });

    var parts = [plural_(s.read, 'ligne lue', 'lignes lues')];
    if (s.fresh !== null) parts.push(plural_(s.fresh, 'nouvelle', 'nouvelles'));
    else parts.push(plural_(s.valid, 'valide', 'valides'));
    if (s.duplicates !== null) parts.push(plural_(s.duplicates, 'déjà connue', 'déjà connues'));
    parts.push(plural_(s.rejected, 'rejetée', 'rejetées'));
    parts.push(plural_(s.skipped.total, 'ignorée', 'ignorées') + (ignored.length ? ' (' + ignored.join(', ') + ')' : ''));
    if (s.flags) parts.push(plural_(s.flags, 'alerte', 'alertes'));
    if (period) parts.push('période ' + period);
    s.text = (s.errors.length ? s.errors.join(' ') + ' ' : '') + parts.join(' · ');
    return s;
  }

  /**
   * Whole import in one call, as the import page and the server need it:
   * files: [{ name, rows (rows2d), firstRow?, headerRow? }] in import order;
   * opts: { plant, existingKeys, knownLines, lastImportedDate, source }.
   * Each file is normalised, deduplicated against existingKeys and the earlier files, then the batch checks run
   * on all fresh lines. -> { ok, errors, files: [result + fresh, duplicates, summary], lines (fresh, file order),
   *    duplicates, rejected, flags, summary }
   */
  function normalizeBatch(files, opts) {
    opts = opts || {};
    var known = keyLookup_(opts.existingKeys);
    var added = {};
    var lookup = { has: function (k) { return known(k) || Object.prototype.hasOwnProperty.call(added, k); } };
    var out = { ok: true, errors: [], files: [], lines: [], duplicates: [], rejected: [], flags: [], summary: null };
    (files || []).forEach(function (f) {
      var r = normalizeRows(f.rows, {
        plant: opts.plant, file: f.name, firstRow: f.firstRow, headerRow: f.headerRow, source: opts.source
      });
      var d = dedupe(r.lines, lookup);
      d.fresh.forEach(function (l) { added[l.key] = true; });
      r.fresh = d.fresh;
      r.duplicates = d.duplicates;
      if (!r.ok) {
        out.ok = false;
        out.errors.push((f.name ? f.name + ' : ' : '') + r.error);
      }
      out.files.push(r);
      out.lines = out.lines.concat(d.fresh);
      out.duplicates = out.duplicates.concat(d.duplicates);
      out.rejected = out.rejected.concat(r.rejected);
    });
    out.flags = flagTransfers(out.lines, { lastImportedDate: opts.lastImportedDate, knownLines: opts.knownLines });
    out.files.forEach(function (r) {
      r.summary = summarize(r, out.flags.filter(function (fl) { return fl.file === r.file; }));
    });
    out.summary = summarize(out.files, out.flags);
    return out;
  }

  return {
    FIELDS: FIELDS,
    REQUIRED: REQUIRED,
    FIELD_LABELS: FIELD_LABELS,
    SYNONYMS: SYNONYMS,
    SHEETJS_OPTIONS: SHEETJS_OPTIONS,
    normLabel: normLabel_,
    mapHeaders: mapHeaders,
    detectHeaderRow: detectHeaderRow,
    parseNumber: parseNumber,
    parseDate: parseDate,
    codeText: codeText_,
    canonUser: canonUser,
    isAutoUser: isAutoUser,
    userKind: userKind,
    keyOf: keyOf,
    normalizeRows: normalizeRows,
    textToRows: textToRows,
    dedupe: dedupe,
    flagTransfers: flagTransfers,
    summarize: summarize,
    normalizeBatch: normalizeBatch
  };
}

var Norm = NormalizeModule_();
