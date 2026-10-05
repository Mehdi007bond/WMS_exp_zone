/**
 * EXP2 Digital Twin - shared configuration.
 * Pure data, no Google services: also injected into the browser (see moduleSource) and loaded by Node tests.
 */
function ConfigModule_() {
  var TABS = {
    HOME: 'ACCUEIL',
    MOVEMENTS: 'MOUVEMENTS',
    OPENING: 'STOCK_INITIAL',
    ARTICLES: 'ARTICLES',
    PROJECTS: 'PROJETS',
    LAYOUT: 'LAYOUT',
    RULES: 'REGLES_PLACEMENT',
    MVT: 'PARAM_MOUVEMENTS',
    SETTINGS: 'PARAM_SEUILS',
    DOCKS: 'QUAIS_CAMIONS',
    VISITS: 'VISITES_CAMIONS',
    CALC_STOCK: 'CALC_STOCK',
    CALC_PENDING: 'CALC_EN_ATTENTE',
    CALC_FIFO: 'CALC_FIFO_EXP2',
    CALC_EXITS: 'CALC_SORTIES',
    CALC_DAILY: 'CALC_JOURNALIER',
    CALC_BLOCKS: 'CALC_BLOCS',
    CALC_KPI: 'CALC_KPI',
    IMPORT_LOG: 'IMPORT_LOG',
    STATE: '_STATE',
    LOOKUP: '_LOOKUP'
  };

  // Headers of the tabs the app writes. The first CALC_* columns are identical to sample-data/csv (v1 oracle);
  // v2 columns are always appended at the end, so a v1 sheet is migrated by adding headers (docs/SPEC_V2.md 3).
  var HEADERS = {
    MOUVEMENTS: ['Clé', 'Article', 'Division', 'Magasin', 'MvT', 'Texte code mvt', 'S', 'Doc.article', 'Poste',
      'Date cpt.', 'Qté en UQS', 'UQS', 'Désignation article', 'Nom utilisateur', 'Source', 'Import', 'Ajouté le',
      'Saisie le', 'Étiquette', 'Texte en-tête', 'Texte', 'Référence', 'Client', 'Commande client'],
    STOCK_INITIAL: ['Article', 'Division', 'Magasin', 'Désignation article', 'Stock utilisation libre', 'UQS', 'Date stock'],
    ARTICLES: ['Article', 'Désignation article', 'UQS', 'Qté par palette', 'Type palette', 'Hauteur palette (cm)',
      'Niveaux gerbage max', 'Famille', 'Projet'],
    PROJETS: ['Projet', 'Blocs', 'Couleur', 'Commentaire'],
    LAYOUT: ['ID', 'Type', 'Libellé (sketch)', 'X (m)', 'Y (m)', 'Largeur (m)', 'Profondeur (m)', 'Colonnes', 'Rangées',
      'Niveaux', 'Capacité (palettes)', 'Couleur', 'Statut'],
    REGLES_PLACEMENT: ['Priorité', 'Critère', 'Valeur', 'Bloc cible', 'Commentaire'],
    PARAM_MOUVEMENTS: ['MvT', 'Type', 'Texte', 'Signification', 'Pris en compte'],
    PARAM_SEUILS: ['Paramètre', 'Clé', 'Valeur', 'Unité', 'Commentaire'],
    QUAIS_CAMIONS: ['Quai', 'Statut quai', 'Camion', 'Transporteur', 'Couleur cabine', 'Arrivée', 'Départ prévu',
      'Palettes prévues', 'Palettes chargées', 'Palettes en zone quai', 'Capacité zone quai (pal)'],
    VISITES_CAMIONS: ['Horodatage', 'Quai', 'Statut quai', 'Camion', 'Transporteur', 'Arrivée', 'Départ prévu',
      'Palettes prévues', 'Palettes chargées', 'Palettes en zone quai', 'Saisi par'],
    CALC_STOCK: ['Article', 'Désignation article', 'UQS', 'Qté par palette', 'PRD2 qté', 'PRD2 palettes', 'EXP2 qté',
      'EXP2 palettes', 'EMRT qté', 'EMRT palettes', 'Source qté/pal', 'Projet'],
    CALC_EN_ATTENTE: ['Article', 'Désignation article', 'Date déclaration', 'Doc.article', 'Qté', 'Palettes', 'Attente (jours)',
      'Étiquette', 'Saisie le', 'Attente (h)', 'Niveau', 'Projet'],
    CALC_FIFO_EXP2: ['Article', 'Désignation article', 'Date entrée', 'Doc.article entrée', 'Origine', 'Qté restante',
      'Palettes', 'Âge (jours)', 'Étiquette', 'Saisie le', 'Âge (h)', 'Projet'],
    CALC_SORTIES: ['Article', 'Date entrée', 'Date sortie', 'Qté', 'Palettes (équiv.)', 'Destination', 'Séjour (jours)',
      'Doc.article sortie', 'Étiquette', 'Entrée le', 'Sortie le', 'Séjour (h)'],
    CALC_JOURNALIER: ['Date', 'Déclarations (pal)', 'Entrées EXP2 (pal)', 'Sorties EXP2 (pal)',
      'Stock EXP2 fin de journée (pal)', 'Saturation EXP2 (%)', 'En attente PRD2 fin de journée (pal)',
      'Délai PRD2→EXP2 médian (h)', 'Délai PRD2→EXP2 P90 (h)'],
    CALC_BLOCS: ['Bloc', 'Libellé (sketch)', 'Famille(s)', 'Capacité (pal)', 'Palettes placées', 'Saturation (%)', 'Projet(s)'],
    CALC_KPI: ['Indicateur', 'Valeur', 'Unité', 'Définition'],
    IMPORT_LOG: ['Horodatage', 'Type', 'Fichier', 'Période', 'Lues', 'Nouvelles', 'Déjà connues', 'Rejetées',
      'Alertes', 'Résultat', 'Durée (s)']
  };

  // Movement type -> kind used by the engine. Editable in PARAM_MOUVEMENTS.
  // DECL: declaration into PRD2; TRANSFER: 311 legs; ISSUE: goods issue; *_REV: reversals (consume newest, LIFO);
  // ADJ: inventory adjustment; IGNORE: not a stock move for the twin (components, status changes).
  var MVT_KINDS = {
    '101': 'DECL', '102': 'DECL_REV', '131': 'DECL', '132': 'DECL_REV',
    '311': 'TRANSFER', '312': 'TRANSFER_REV', '313': 'TRANSFER', '315': 'TRANSFER',
    '601': 'ISSUE', '602': 'ISSUE_REV', '641': 'ISSUE', '643': 'ISSUE', '551': 'ISSUE',
    '701': 'ADJ', '702': 'ADJ', '261': 'IGNORE', '262': 'IGNORE',
    '321': 'IGNORE', '322': 'IGNORE', '343': 'IGNORE', '344': 'IGNORE'
  };

  var MVT_TEXTS = {
    '101': 'EM entrée en stock', '102': 'EM entrée stock ann.', '131': 'Entrée marchandises', '132': 'Annulation 131',
    '311': 'TR dans division', '312': 'TR transf. div. ann.', '313': 'TR sortie stock mag.', '315': 'TR entrée stock mag.',
    '601': 'SM livraison', '602': 'SM livraison annul.', '641': 'TR vers stock en transit', '643': 'TR inter-sociétés',
    '551': 'SM mise au rebut', '701': 'EM inventaire : libre', '702': 'SM inventaire : libre',
    '261': 'SM pour ordre', '262': 'SM pour ordre annul.', '321': 'TR contrôle qualité -> libre', '322': 'TR libre -> contrôle qualité',
    '343': 'TR bloqué -> libre', '344': 'TR libre -> bloqué'
  };

  var THRESHOLDS = {
    satWarn: 0.85,          // block / warehouse saturation, orange
    satCrit: 0.95,          // red
    pendingDaysWarn: 3,     // declared, not transferred, days
    dockStagingWarn: 0.85,  // pallets staged in front of a dock / its capacity
    freshWarnH: 4,          // hours since last import before the TV badge turns orange
    freshCritH: 24,         // red
    tvRefreshS: 60,         // version polling period
    tvSceneS: 45,           // rotating TV scenes
    pendingHoursWarn: 4,    // label in PRD2 since this many hours (entry time), amber
    pendingHoursCrit: 6,    // red: a reference in PRD2 for more than 6 h is a real problem (user rule)
    labelIsPallet: 1,       // 1 label (container number) = 1 pallet
    importTrackedOnly: 1,   // import keeps finished goods only (articles that reach EXP2, or listed in ARTICLES)
    trackAll: 0             // engine: 1 = compute every article, not only the tracked ones
  };

  // Label (container number) found in the MB51 texts: item text of any line, or header text of a declaration
  // ('434514671|20261005010841' -> '434514671'). docs/SPEC_V2.md 2.3.
  var LABEL = { itemRe: '^\\d{6,12}$', headerRe: '^(\\d{6,12})(?:[_|].*)?$', headerMvts: ['101', '102', '131', '132'] };

  // Display colors. Families mirror the block colors of the user's sketch.
  var COLORS = {
    blocks: { blanc: '#f5f6f7', creme: '#efe3bb', cyan: '#c3e4ec', rose: '#f1cadb', vert: '#cfe6c8' },
    families: { F1: '#e7ebef', F2: '#ecdeb0', F3: '#a2dce9', F4: '#f0c0d5', F5: '#b8e2ab' },
    // Projects without a color in PROJETS, in sorted name order (light enough for dark pallets text, distinct from
    // the saturation blue / amber / red).
    projects: ['#7fb3e0', '#f2b27a', '#8fd19e', '#e79ac0', '#c3a6e8', '#f3d36b', '#7fd1cf', '#e8a39a', '#b4c77a',
      '#a9b8d6', '#d9b48f', '#9fd4f0'],
    noProject: '#c9ced6',
    familyByBlockColor: { blanc: 'F1', creme: 'F2', cyan: 'F3', rose: 'F4', vert: 'F5' },
    cabs: { bleu: '#2a78d6', rouge: '#e34948', vert: '#1baf7a', gris: '#8a949e', jaune: '#eda100' },
    status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' }
  };

  // Placement comes from the projects (PROJETS: project -> blocks) and REGLES_PLACEMENT; no placeholder rules
  // (v1 used families F1-F5 here). docs/SPEC_V2.md 4.7.
  var DEFAULT_RULES = [];

  // Warehouse layout redrawn from the user's sketch (meters, origin top-left, 50 x 32 m assumed).
  var DEFAULT_LAYOUT = {
    "building": {
      "id": "BAT",
      "type": "BATIMENT",
      "label": "Bâtiment EXP2 (1 600 m², 50 x 32 m supposé)",
      "x": 0,
      "y": 0,
      "w": 50,
      "h": 32
    },
    "blocks": [
      {
        "id": "B1",
        "label": "Allée 26",
        "x": 19,
        "y": 2.9,
        "w": 10.4,
        "h": 10.4,
        "cols": 10,
        "rows": 13,
        "levels": 2,
        "color": "blanc"
      },
      {
        "id": "B2",
        "label": "Allée 72",
        "x": 32.9,
        "y": 3,
        "w": 4.1,
        "h": 10.1,
        "cols": 4,
        "rows": 12,
        "levels": 2,
        "color": "creme"
      },
      {
        "id": "B3",
        "label": "Allée 24",
        "x": 37.1,
        "y": 3,
        "w": 4,
        "h": 9.9,
        "cols": 4,
        "rows": 12,
        "levels": 2,
        "color": "cyan"
      },
      {
        "id": "B4",
        "label": "Allée 36 / 72",
        "x": 41.2,
        "y": 3,
        "w": 5,
        "h": 10,
        "cols": 5,
        "rows": 12,
        "levels": 2,
        "color": "rose"
      },
      {
        "id": "B5",
        "label": "Allée 26",
        "x": 3.9,
        "y": 17.3,
        "w": 9.5,
        "h": 10.3,
        "cols": 10,
        "rows": 13,
        "levels": 2,
        "color": "cyan"
      },
      {
        "id": "B6",
        "label": "Allée 50",
        "x": 16.5,
        "y": 16.6,
        "w": 3.9,
        "h": 7.7,
        "cols": 4,
        "rows": 10,
        "levels": 2,
        "color": "vert"
      },
      {
        "id": "B7",
        "label": "",
        "x": 20.7,
        "y": 14.8,
        "w": 9.7,
        "h": 9.5,
        "cols": 10,
        "rows": 12,
        "levels": 2,
        "color": "blanc"
      },
      {
        "id": "B8",
        "label": "Allée 72",
        "x": 32.9,
        "y": 14.8,
        "w": 13.3,
        "h": 9.5,
        "cols": 13,
        "rows": 12,
        "levels": 2,
        "color": "creme"
      }
    ],
    "truck_zone": {
      "id": "ZC",
      "label": "Zone camion",
      "x": 2.6,
      "y": 2,
      "w": 16.3,
      "h": 11.3
    },
    "quais": [
      {
        "id": "Q01",
        "x": 4.1
      },
      {
        "id": "Q02",
        "x": 5.9
      },
      {
        "id": "Q03",
        "x": 7.7
      },
      {
        "id": "Q04",
        "x": 9.5
      },
      {
        "id": "Q05",
        "x": 11.3
      },
      {
        "id": "Q06",
        "x": 13.1
      },
      {
        "id": "Q07",
        "x": 14.9
      },
      {
        "id": "Q08",
        "x": 16.7
      }
    ],
    "quai_common": {
      "y": 13.3,
      "w": 1.6,
      "h": 0.5
    },
    "roads": [
      {
        "id": "R0",
        "x": 19,
        "y": 2.3,
        "w": 12,
        "h": 0.7
      },
      {
        "id": "R1",
        "x": 30.4,
        "y": 2.9,
        "w": 1.7,
        "h": 21.4
      },
      {
        "id": "R2",
        "x": 17.6,
        "y": 13.3,
        "w": 28.6,
        "h": 1.5
      },
      {
        "id": "R3",
        "x": 46.2,
        "y": 2.1,
        "w": 2.7,
        "h": 25.2
      },
      {
        "id": "R4",
        "x": 15.1,
        "y": 24.3,
        "w": 33.8,
        "h": 2.9
      }
    ],
    "zones": [
      {
        "id": "G1",
        "label": "G1",
        "x": 2.3,
        "y": 14.4,
        "w": 2.1,
        "h": 1.5,
        "color": "rose",
        "short": "G1"
      },
      {
        "id": "G2",
        "label": "G2",
        "x": 4.9,
        "y": 14.4,
        "w": 2.1,
        "h": 1.5,
        "color": "vert",
        "short": "G2"
      },
      {
        "id": "G3",
        "label": "G3",
        "x": 7.3,
        "y": 14.4,
        "w": 2.1,
        "h": 1.5,
        "color": "vert",
        "short": "G3"
      },
      {
        "id": "G4",
        "label": "G4",
        "x": 9.8,
        "y": 14.4,
        "w": 2.1,
        "h": 1.5,
        "color": "vert",
        "short": "G4"
      },
      {
        "id": "GH1",
        "label": "",
        "x": 31.3,
        "y": 1.1,
        "w": 2.6,
        "h": 1.6,
        "color": "vert",
        "short": ""
      },
      {
        "id": "GH2",
        "label": "",
        "x": 35,
        "y": 1.1,
        "w": 2.6,
        "h": 1.6,
        "color": "vert",
        "short": ""
      },
      {
        "id": "ZM",
        "label": "Zone M",
        "x": 2.6,
        "y": 27.8,
        "w": 2.6,
        "h": 2.2,
        "short": "M"
      },
      {
        "id": "CONV",
        "type": "CONVOYEUR",
        "label": "Convoyeur",
        "x": 5.3,
        "y": 28.6,
        "w": 17.8,
        "h": 0.8,
        "short": ""
      },
      {
        "id": "ECH",
        "label": "Zone d'échange chariot / file d'attente",
        "x": 1.7,
        "y": 30.4,
        "w": 26.8,
        "h": 1.4,
        "short": "Zone d'échange chariot / file d'attente"
      },
      {
        "id": "OUTAGV",
        "label": "OUT AGV",
        "x": 24.1,
        "y": 28,
        "w": 2,
        "h": 2,
        "short": "OUT"
      },
      {
        "id": "CHAGV",
        "label": "Charge AGV",
        "x": 26.1,
        "y": 28,
        "w": 1.8,
        "h": 2,
        "short": "AGV"
      },
      {
        "id": "EMB",
        "label": "Emb. vides",
        "x": 27.9,
        "y": 28,
        "w": 1.8,
        "h": 2,
        "short": "Emb."
      },
      {
        "id": "CART",
        "label": "Carton PF",
        "x": 29.8,
        "y": 28,
        "w": 2.6,
        "h": 2,
        "short": "PF"
      },
      {
        "id": "BUR",
        "label": "Zone bureau",
        "x": 32.5,
        "y": 28,
        "w": 6.6,
        "h": 2,
        "short": "Bureaux"
      },
      {
        "id": "ZX",
        "label": "Zone",
        "x": 39.6,
        "y": 28,
        "w": 6.3,
        "h": 2,
        "short": "Zone"
      }
    ],
    "trucks_sketch": [
      {
        "quai": "Q01",
        "color": "bleu"
      },
      {
        "quai": "Q02",
        "color": "rouge"
      },
      {
        "quai": "Q04",
        "color": "vert"
      },
      {
        "quai": "Q05",
        "color": "gris"
      },
      {
        "quai": "Q07",
        "color": "jaune"
      }
    ]
  };

  return {
    APP_NAME: 'EXP2 · Jumeau numérique',
    VERSION: '2.0.0',
    PLANT: 'TA11',
    MAGASINS: { PRD2: 'PRD2', EXP2: 'EXP2', EMRT: 'EMRT' },
    AUTO_USERS: ['BARFLOW_TA11', 'ADMINJOB'],
    TRUCK_CAPACITY: 33,
    DOCK_STAGING_CAPACITY: 12,
    TABS: TABS,
    HEADERS: HEADERS,
    MVT_KINDS: MVT_KINDS,
    MVT_TEXTS: MVT_TEXTS,
    THRESHOLDS: THRESHOLDS,
    LABEL: LABEL,
    COLORS: COLORS,
    DEFAULT_RULES: DEFAULT_RULES,
    DEFAULT_LAYOUT: DEFAULT_LAYOUT
  };
}

var CFG = ConfigModule_();
