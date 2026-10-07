# Export MB51 réel anonymisé (`mb51-reel/`)

*English summary at the end.*

## Ce que c'est

Un extrait **anonymisé** de l'export SAP MB51 réel, au format exact où il sort de SAP : une feuille, l'en-tête en ligne 1, **22 colonnes**. Période : 04.10.2026 et 05.10.2026, division `TA11`. Il sert de référence aux tests de l'import (format, étiquettes, heures, filtre produits finis) et du calcul (attente PRD2 en heures, palettes par étiquette, délai PRD2 → EXP2). Le contrat qui s'appuie dessus est [docs/SPEC_V2.md](../../docs/SPEC_V2.md) (sections 1, 2.4 et 4.10).

| Fichier | Contenu |
|---|---|
| `MB51_reel_anonymise.xlsx` | 4 157 lignes : 2 148 déclarations (MvT 131) et 2 009 lignes de transfert (MvT 311). Magasins : PRD2 2 981 lignes, EXP2 1 098, EMRT 78. Aucune sortie 601. |
| `expected.json` | Résultats attendus de l'import (`normalize`) et du calcul (`engine`), écrits par `tools/mb51_reference.py`. |

Les 22 colonnes, dans l'ordre : `Article`, `Division`, `Magasin`, `Code mouvement`, `Texte code mouvement`, `Stock spécial`, `Document article`, `Date comptable`, `Qté en unité saisie`, `UQ de saisie`, `Désignation article`, `Montant DI`, `Date de saisie`, `Heure de saisie`, `Nom de l'utilisateur`, `Texte d'en-tête pièce`, `Motif du mouvement`, `Texte`, `Référence`, `Client`, `Fournisseur`, `Commande client`.

## Comment il a été construit

À partir de l'export complet (23 150 lignes) :

- **toutes** les lignes des 93 articles produits finis (les articles qui passent par EXP2) : 2 800 lignes ;
- **une ligne sur 15** des autres articles (pièces semi-finies consommées sur les lignes, matières premières entre EMRT et PRD2) : 1 357 lignes, pour que le filtre « produits finis » de l'import ait de quoi travailler.

Anonymisation :

- noms des opérateurs remplacés par `OPERATEUR01`, `OPERATEUR02`… (17 noms) ; les utilisateurs automatiques `BARFLOWTA11` (scan) et `ADMINJOB` sont gardés ;
- nom de l'entreprise retiré des textes d'en-tête ;
- `Montant DI` mis à 0 sur toutes les lignes.

Les autres colonnes n'ont pas été modifiées. Aucun fichier du dépôt ne doit contenir le nom de l'entreprise ni un nom d'opérateur réel.

## Chiffres clés (`expected.json`)

**Import** (`normalize`, filtre produits finis activé, aucun article suivi connu au départ) :

- 4 157 lignes lues, 4 157 valides, 0 rejetée ; 4 157 avec heure de saisie ; 3 543 avec un numéro d'étiquette ;
- 93 articles suivis : **2 800 lignes gardées**, **1 357 ignorées** (196 articles hors produits finis) ;
- 164 lignes de transfert étiquetées dont l'autre ligne est dans un magasin absent de l'export (normal, pas d'alerte) et 3 lignes sans étiquette signalées « transfert orphelin ».

**Calcul** (`engine`, sans stock initial, sans onglet ARTICLES, sans projets, seuils par défaut) :

- date des données 05.10.2026, **heure des données 05.10.2026 22:09:10** ;
- en attente PRD2 : 128 étiquettes, 145 palettes, dont **86 depuis plus de 6 h** et **11 entre 4 et 6 h** ; la plus ancienne attend depuis 44,04 h (44 h 02 : article `LB73297`, étiquette `434503024`) ;
- EXP2 : 1 023 palettes (1 023 étiquettes) ; EMRT : 8 palettes ;
- quantité par palette apprise des étiquettes pour 79 articles ;
- délai PRD2 → EXP2 le 05.10 : 417 transferts, médiane 0,5 h, 90 % en moins de 1,26 h (le 04.10 : 320 transferts, 0,76 h et 3,22 h) ;
- palettes par jour : 04.10 368 déclarées, 439 entrées EXP2, 38 sorties EXP2 ; 05.10 523, 595 et 10 ;
- lignes qui retirent du stock sans stock connu (il n'y a pas de stock initial) : 82 lignes étiquetées (palettes déclarées avant le 04.10, comptées sans alerte) et 27 sans étiquette (une seule alerte calme « … sorties sans stock connu : importez le stock initial (MB52) »).

## Qui l'utilise

- `tests/normalize.test.js` et `tests/engine.test.js` : comparaison exacte avec `expected.json` ;
- `tests/api.test.js` : import par `api_importLines` (champs v2 stockés, heure des données, alerte 6 h, réimport = 0 ligne ajoutée), API des projets ;
- `npm run e2e`, scénario `pc-import-real` : le fichier passe par la vraie page Import, puis les pages En attente, Recherche article et la TV.

Pour le voir dans l'application : base vide (ou **EXP2 Jumeau › Simulation › Effacer la simulation**), puis déposer le fichier sur la page PC **Import**.

## Régénérer `expected.json`

`tools/mb51_reference.py` est un calcul de référence indépendant, en Python, sans code commun avec Apps Script. Il lit le fichier `.xlsx` (bibliothèque `openpyxl`) et réécrit `expected.json` :

```bash
pip install openpyxl
python3 tools/mb51_reference.py                     # depuis la racine du dépôt : fichier et sortie par défaut
python3 tools/mb51_reference.py <fichier.xlsx> <expected.json>
npm test                                            # les tests comparent le code Apps Script au nouveau fichier
```

Si le moteur et la référence ne donnent pas le même résultat, chercher d'abord lequel des deux s'écarte de [docs/SPEC_V2.md](../../docs/SPEC_V2.md) avant de modifier l'un ou l'autre.

---

## English summary

Anonymised extract of the user's real SAP MB51 export (04–05.10.2026, plant TA11, the exact 22-column layout). It keeps every line of the 93 finished-goods articles (2,800 lines) plus one line in 15 of the other articles (1,357 lines): 4,157 lines in all, 131 declarations and 311 transfers only, no 601 exits. Operator names are replaced by `OPERATEUR01`…, the company name is removed from the header texts, `Montant DI` is set to 0; the other columns are unchanged.

`expected.json` is written by `tools/mb51_reference.py` (independent Python reference, needs `openpyxl`; run it from the repository root, then `npm test`). Key figures: 2,800 lines kept and 1,357 dropped (196 articles), 3,543 labeled lines, data time 05.10.2026 22:09:10, 128 labels pending in PRD2 (145 pallets), 86 pallets waiting more than 6 h and 11 between 4 and 6 h (oldest 44.04 h, label `434503024`), 1,023 pallets in EXP2, PRD2 → EXP2 dwell on 05.10: median 0.5 h, P90 1.26 h. Used by `tests/normalize.test.js`, `tests/engine.test.js`, `tests/api.test.js` and the e2e scenario `pc-import-real`.
