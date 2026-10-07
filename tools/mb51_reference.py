#!/usr/bin/env python3
"""Independent reference calculation for the real-format MB51 fixture (sample-data/mb51-reel/).

Implements, in plain Python and without sharing any code with the Apps Script engine, the v2 rules of
docs/SPEC_V2.md (sections 2 and 4, summarised in docs/ARCHITECTURE.md): label derivation, timestamps, finished-goods filter,
label-aware FIFO layers, pallets per label, pending ages in hours, PRD2 -> EXP2 dwell times.
Writes sample-data/mb51-reel/expected.json, which tests/normalize.test.js and tests/engine.test.js must match.

Usage: python3 tools/mb51_reference.py [fixture.xlsx] [expected.json]
"""
import datetime as dt
import json
import math
import re
import sys
from collections import Counter, defaultdict

import openpyxl

FIX = sys.argv[1] if len(sys.argv) > 1 else 'sample-data/mb51-reel/MB51_reel_anonymise.xlsx'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'sample-data/mb51-reel/expected.json'

ITEM_RE = re.compile(r'^\d{6,12}$')
HEADER_RE = re.compile(r'^(\d{6,12})(?:[_|].*)?$')
HEADER_MVTS = {'101', '102', '131', '132'}
KINDS = {'101': 'DECL', '102': 'DECL_REV', '131': 'DECL', '132': 'DECL_REV', '311': 'TRANSFER', '312': 'TRANSFER_REV',
         '601': 'ISSUE', '602': 'ISSUE_REV'}
HOURS_WARN, HOURS_CRIT = 4, 6


def text(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def code(v):
    s = text(v)
    return s.lstrip('0') or s if s.isdigit() else s


def iso(v):
    return v.date().isoformat() if isinstance(v, dt.datetime) else (v.isoformat() if isinstance(v, dt.date) else '')


def hms(v):
    if isinstance(v, dt.time):
        return '%02d:%02d:%02d' % (v.hour, v.minute, v.second)
    if isinstance(v, dt.datetime):
        return '%02d:%02d:%02d' % (v.hour, v.minute, v.second)
    return ''


def hours_between(a, b):
    fa = dt.datetime.strptime(a, '%Y-%m-%d %H:%M:%S')
    fb = dt.datetime.strptime(b, '%Y-%m-%d %H:%M:%S')
    return (fb - fa).total_seconds() / 3600.0


def median(xs):
    s = sorted(xs)
    n = len(s)
    if not n:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def p90(xs):
    s = sorted(xs)
    if not s:
        return None
    return s[math.ceil(0.9 * len(s)) - 1]


def r2(x):
    return None if x is None else round(x + 0.0, 2)


wb = openpyxl.load_workbook(FIX, read_only=True)
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
head = [text(h) for h in rows[0]]
col = {h: i for i, h in enumerate(head)}
lines = []
for i, r in enumerate(rows[1:]):
    mvt = text(r[col['Code mouvement']])
    header = text(r[col["Texte d'en-tête pièce"]])
    item = text(r[col['Texte']])
    label = ''
    if ITEM_RE.match(item):
        label = item
    elif mvt in HEADER_MVTS:
        m = HEADER_RE.match(header)
        label = m.group(1) if m else ''
    d_ent, t_ent = iso(r[col['Date de saisie']]), hms(r[col['Heure de saisie']])
    lines.append({
        'i': i, 'article': code(r[col['Article']]), 'magasin': text(r[col['Magasin']]).upper(), 'mvt': mvt,
        'doc': code(r[col['Document article']]), 'date': iso(r[col['Date comptable']]),
        'qty': float(r[col['Qté en unité saisie']]), 'uqs': text(r[col['UQ de saisie']]),
        'ts': (d_ent + ' ' + t_ent) if d_ent and t_ent else '', 'label': label, 'header': header, 'item': item,
    })

read = len(lines)
with_time = sum(1 for l in lines if l['ts'])
with_label = sum(1 for l in lines if l['label'])
tracked = {l['article'] for l in lines if l['magasin'] == 'EXP2'}
kept = [l for l in lines if l['article'] in tracked or l['magasin'] == 'EXP2']
dropped = [l for l in lines if not (l['article'] in tracked or l['magasin'] == 'EXP2')]

# Learned quantity per pallet: mode of the quantities of labeled positive lines (ties -> larger).
qty_counts = defaultdict(Counter)
for l in kept:
    if l['label'] and l['qty'] > 0:
        qty_counts[l['article']][l['qty']] += 1
qpp = {a: max(c.items(), key=lambda kv: (kv[1], kv[0]))[0] for a, c in qty_counts.items()}

# Engine order: posting date, entry timestamp, document, issuing line first, file order.
order = sorted(kept, key=lambda l: (l['date'], l['ts'], l['doc'], 0 if l['qty'] < 0 else 1, l['i']))
by_doc = defaultdict(list)
for l in order:
    by_doc[l['doc']].append(l)


def paired_mag(l):
    for o in by_doc[l['doc']]:
        if o is not l and o['article'] == l['article'] and (o['qty'] > 0) != (l['qty'] > 0):
            return o['magasin']
    return ''


buckets = defaultdict(list)  # (article, magasin) -> layers
seen_labels = defaultdict(set)  # (article, magasin) -> labels ever stored there
diag = Counter()
dwell = defaultdict(list)  # posting date -> hours
daily = defaultdict(lambda: {'declared': 0, 'entries': 0, 'exits': 0})
seq = 0


def line_pallets(l):
    if l['label']:
        return 1
    q = qpp.get(l['article'])
    return math.ceil(abs(l['qty']) / q - 1e-9) if q else 0


for l in order:
    kind = KINDS.get(l['mvt'], '')
    rev = kind.endswith('_REV')
    key = (l['article'], l['magasin'])
    layers = buckets[key]
    pm = paired_mag(l)
    if kind in ('TRANSFER', 'TRANSFER_REV') and not pm:
        diag['unpairedLabeled' if l['label'] else 'unpairedUnlabeled'] += 1
    if l['qty'] > 0:
        seq += 1
        layers.append({'qty': l['qty'], 'label': l['label'], 'ts': l['ts'], 'date': l['date'], 'doc': l['doc'], 'seq': seq})
        if l['label']:
            seen_labels[key].add(l['label'])
        if l['magasin'] == 'EXP2' and not rev:
            daily[l['date']]['entries'] += line_pallets(l)
    else:
        need = -l['qty']
        first_labeled = None
        if l['label']:
            for L in layers:
                if need <= 0:
                    break
                if L['label'] == l['label'] and L['qty'] > 0:
                    t = min(need, L['qty'])
                    L['qty'] -= t
                    need -= t
                    if first_labeled is None:
                        first_labeled = L
            for L in layers:
                if need <= 0:
                    break
                if not L['label'] and L['qty'] > 0:
                    t = min(need, L['qty'])
                    L['qty'] -= t
                    need -= t
            if need > 1e-9:
                diag['preData' if l['label'] not in seen_labels[key] else 'negative'] += 1
        else:
            live = [L for L in layers if L['qty'] > 0]
            if rev:
                live = live[::-1]
            for L in live:
                if need <= 0:
                    break
                t = min(need, L['qty'])
                L['qty'] -= t
                need -= t
            if need > 1e-9:
                diag['negative'] += 1
        buckets[key] = [L for L in layers if L['qty'] > 1e-9]
        if l['magasin'] == 'EXP2' and not rev:
            daily[l['date']]['exits'] += line_pallets(l)
        if l['magasin'] == 'PRD2' and pm == 'EXP2' and first_labeled is not None and first_labeled['ts'] and l['ts']:
            dwell[l['date']].append(hours_between(first_labeled['ts'], l['ts']))
    if kind == 'DECL':
        daily[l['date']]['declared'] += line_pallets(l)

as_of = max(l['date'] for l in order)
as_of_ts = max(l['ts'] for l in order if l['ts'] and l['date'] <= as_of)


def mag_summary(mag):
    labeled, unlabeled_qty, pallets = [], defaultdict(float), 0
    for (art, m), layers in buckets.items():
        if m != mag:
            continue
        u = 0.0
        for L in layers:
            if L['label']:
                labeled.append((art, L))
            else:
                u += L['qty']
        n_lab = sum(1 for L in layers if L['label'])
        pallets += n_lab
        if u > 1e-9:
            unlabeled_qty[art] = u
            q = qpp.get(art)
            pallets += math.ceil(u / q - 1e-9) if q else 0
    return labeled, unlabeled_qty, pallets


pend_lab, pend_unl, pend_pal = mag_summary('PRD2')
exp_lab, exp_unl, exp_pal = mag_summary('EXP2')
emrt_lab, emrt_unl, emrt_pal = mag_summary('EMRT')
pend_hours = sorted(((hours_between(L['ts'], as_of_ts), art, L['label']) for art, L in pend_lab if L['ts']), reverse=True)
crit = [h for h in pend_hours if h[0] >= HOURS_CRIT]
warn = [h for h in pend_hours if HOURS_WARN <= h[0] < HOURS_CRIT]

expected = {
    'fixture': FIX.split('/')[-1],
    'normalize': {
        'read': read,
        'valid': read,
        'rejected': 0,
        'withTime': with_time,
        'withLabel': with_label,
        'dateMin': min(l['date'] for l in lines),
        'dateMax': max(l['date'] for l in lines),
        'trackedArticles': len(tracked),
        'kept': len(kept),
        'dropped': len(dropped),
        'droppedArticles': len({l['article'] for l in dropped}),
        'firstLine': {k: lines[0][k] for k in ('article', 'magasin', 'mvt', 'doc', 'date', 'qty', 'ts', 'label')},
        'labelSamples': [{k: l[k] for k in ('doc', 'article', 'magasin', 'mvt', 'label', 'ts')}
                         for l in kept if l['label']][:5],
        'unpairedLabeled': diag['unpairedLabeled'],
        'unpairedUnlabeled': diag['unpairedUnlabeled'],
    },
    'engine': {
        'asOf': as_of,
        'asOfTs': as_of_ts,
        'learnedQpp': {a: qpp[a] for a in sorted(qpp)},
        'pending': {
            'labeled': len(pend_lab),
            'unlabeledQty': {a: pend_unl[a] for a in sorted(pend_unl)},
            'pallets': pend_pal,
            'crit': len(crit),
            'warn': len(warn),
            'oldestHours': r2(pend_hours[0][0]) if pend_hours else None,
            'oldest': {'article': pend_hours[0][1], 'label': pend_hours[0][2]} if pend_hours else None,
        },
        'exp2': {'labeled': len(exp_lab), 'unlabeledQty': {a: exp_unl[a] for a in sorted(exp_unl)}, 'pallets': exp_pal},
        'emrt': {'labeled': len(emrt_lab), 'unlabeledQty': {a: emrt_unl[a] for a in sorted(emrt_unl)}, 'pallets': emrt_pal},
        'dwellAsOf': {'count': len(dwell[as_of]), 'medianH': r2(median(dwell[as_of])), 'p90H': r2(p90(dwell[as_of]))},
        'dwellByDate': {d: {'count': len(v), 'medianH': r2(median(v)), 'p90H': r2(p90(v))} for d, v in sorted(dwell.items())},
        'daily': {d: daily[d] for d in sorted(daily)},
        'diag': {'preData': diag['preData'], 'negative': diag['negative']},
    },
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(expected, f, ensure_ascii=False, indent=2)
    f.write('\n')
print(json.dumps({k: expected[k] for k in ('normalize',)}, ensure_ascii=False)[:900])
print(json.dumps({k: v for k, v in expected['engine'].items() if k not in ('learnedQpp', 'dwellByDate')}, ensure_ascii=False)[:1600])
