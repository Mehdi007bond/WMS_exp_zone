'use strict';
// Loads Apps Script .gs files into one Node vm context, the way Apps Script shares one global scope.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'apps-script', 'src');

function loadGs(names, extraGlobals) {
  const context = vm.createContext(Object.assign({ console, Math, Date, JSON }, extraGlobals || {}));
  for (const name of names) {
    const file = path.join(SRC, name.endsWith('.gs') ? name : name + '.gs');
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return context;
}

// Minimal CSV reader for sample-data/csv (RFC 4180 quotes, UTF-8, optional BOM).
function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter(r => r.length > 1 || r[0] !== '').map(r => Object.fromEntries(header.map((h, k) => [h, r[k] === undefined ? '' : r[k]])));
}

module.exports = { loadGs, readCsv, SRC };
