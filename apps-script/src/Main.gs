/** @OnlyCurrentDoc */
/**
 * EXP2 Digital Twin - entry points.
 *
 *   Web app:   doGet(e); include_(name), moduleSource_(name) for the Index.html scriptlets (docs/ARCHITECTURE.md section 9)
 *   Sheet:     onOpen() menu "EXP2 Jumeau", onEdit(e) (QUAIS_CAMIONS edited by hand -> docks version), ACCUEIL tab
 *              (status + 4 image buttons), modal "Ouvrir le jumeau"
 *   Buttons:   installerLaBase, simulerDonnees, simulerJourSuivant, effacerSimulation, recalculer, ouvrirProjets,
 *              ouvrirPanneau, ouvrirJumeau, regenererLesCles (no parameters: menu items and images with an assigned script)
 *   Sidebar:   sidebar_status, sidebar_simulate, sidebar_nextDay, sidebar_recompute, sidebar_links, sidebar_setWebAppUrl
 *   Projects:  sidebar_getProjects, sidebar_saveReferences, sidebar_saveProjects (panel SidebarProjets.html,
 *              docs/SPEC_V2.md 5.3)
 *
 * Every sheet action and sidebar function first checks that it runs from the spreadsheet (SpreadsheetApp.getUi()
 * only works there): the web app executes as the owner and google.script.run can call any public function, so this
 * keeps the keys and the key-less actions out of reach of the web pages. The work itself is done by the run*_
 * helpers of Api.gs, shared with the api_* functions. The access keys are shown only to the people who can run these
 * (editors of the sheet): in the "Ouvrir le jumeau" dialog and the sidebar, never in a cell.
 */

var HOME_LAYOUT_ = {
  rows: 35,
  cols: 4,
  title: 2,
  subtitle: 3,
  buttons: [5, 6],
  statusTitle: 8,
  statusFirst: 9,
  helpTitle: 24,
  helpFirst: 25
};

var HOME_STATUS_LABELS_ = ['Source des données', 'Données au', 'Dernier import / simulation', 'Calculé le', 'Version',
  'Palettes EXP2', 'Saturation EXP2', 'En attente PRD2', 'Quais occupés', 'Alertes', 'Lien TV', 'Lien PC',
  'Clé administrateur', 'Clé quais'];

// Number of days of « Générer » (menu, ACCUEIL button, sidebar default): the simulator's default.
var SIM_MENU_DAYS_ = 7;

var HOME_HELP_ = [
  '1. « Générer ' + SIM_MENU_DAYS_ + ' jours » crée une base simulée réaliste (données fictives) et calcule l\'état de l\'entrepôt.',
  '2. « Simuler +1 jour » ajoute la journée suivante ; « Recalculer » relit les onglets après une modification.',
  '3. « Ouvrir le jumeau » donne les liens de l\'écran TV et des pages PC, et les clés à saisir pour les actions.',
  '4. Données réelles : menu EXP2 Jumeau › Simulation › Effacer la simulation, puis page PC « Import » (fichiers SAP MB51).',
  '5. Menu EXP2 Jumeau › Projets & références (ou page PC « Projets ») : chaque référence a un projet, chaque projet ses blocs.',
  '6. Paramètres modifiables : ARTICLES, PROJETS, LAYOUT, REGLES_PLACEMENT, PARAM_MOUVEMENTS, PARAM_SEUILS, puis « Recalculer ».',
  '7. Les onglets CALC_* sont réécrits à chaque calcul : ne pas les modifier à la main.',
  '8. Menu EXP2 Jumeau › Panneau de contrôle : paramètres de simulation, état, lien de l\'application Web et clés.'
];

var KEYS_HIDDEN_TEXT_ = '•••• (menu EXP2 Jumeau › Ouvrir le jumeau)';

// PC pages of PagesPc.html (?page=...). 'twin' is the 3D view of the PC app.
var WEB_PAGES_ = ['twin', 'lookup', 'pending', 'plan', 'projects', 'docks', 'import', 'simulation'];

// Labels of the PC pages in the links (same order as WEB_PAGES_).
var WEB_PAGE_LABELS_ = {
  twin: 'Jumeau 3D', lookup: 'Recherche article', pending: 'En attente', plan: 'Plan 2D', projects: 'Projets',
  docks: 'Quais & camions', import: 'Import SAP', simulation: 'Simulation'
};

// ---------------------------------------------------------------------------------------------------------------
// Web app
// ---------------------------------------------------------------------------------------------------------------

/** ?mode=tv (TV, read only, &rotate=1 rotates the scenes) or ?page=twin|lookup|pending|plan|projects|docks|import|simulation (PC). */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var mode = String(p.mode || '').toLowerCase() === 'tv' ? 'tv' : 'pc';
  var page = String(p.page || '').toLowerCase();
  if (WEB_PAGES_.indexOf(page) < 0) page = mode === 'tv' ? '' : 'lookup';
  var template = HtmlService.createTemplateFromFile('Index');
  template.mode = mode;
  template.page = page;
  return template.evaluate()
    .setTitle(CFG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Content of an HTML file of the project, for <?!= include_('Styles') ?>. Private (trailing _): template scriptlets
 * run on the server and can call it, google.script.run cannot.
 */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * Browser copy of a pure module: 'var Engine = (function EngineModule_() { ... })();'. Private, like include_.
 * name: 'Config' (CFG), 'Normalize' (Norm), 'Engine' (Engine), 'Simulation' (Sim); the variable names work too.
 */
function moduleSource_(name) {
  var key = String(name || '');
  var varName, factory;
  switch (key) {
    case 'Config':
    case 'CFG':
      varName = 'CFG';
      factory = typeof ConfigModule_ === 'function' ? ConfigModule_ : null;
      break;
    case 'Normalize':
    case 'Norm':
      varName = 'Norm';
      factory = typeof NormalizeModule_ === 'function' ? NormalizeModule_ : null;
      break;
    case 'Engine':
      varName = 'Engine';
      factory = typeof EngineModule_ === 'function' ? EngineModule_ : null;
      break;
    case 'Simulation':
    case 'Sim':
      varName = 'Sim';
      factory = typeof SimulationModule_ === 'function' ? SimulationModule_ : null;
      break;
    default:
      throw new Error('Module inconnu : « ' + key + ' ».');
  }
  if (!factory) return '/* module ' + key + ' absent */\n';
  // The source goes inside a <script> element: never let it close the element.
  var src = factory.toString().replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  return 'var ' + varName + ' = (' + src + ')();\n';
}

// ---------------------------------------------------------------------------------------------------------------
// Menu and entry points without parameters (menu items, ACCUEIL buttons)
// ---------------------------------------------------------------------------------------------------------------
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('EXP2 Jumeau')
    .addItem('Installer / réinitialiser la base', 'installerLaBase')
    .addSubMenu(ui.createMenu('Simulation')
      .addItem('Générer ' + SIM_MENU_DAYS_ + ' jours', 'simulerDonnees')
      .addItem('Simuler +1 jour', 'simulerJourSuivant')
      .addItem('Effacer la simulation', 'effacerSimulation'))
    .addSeparator()
    .addItem('Recalculer', 'recalculer')
    .addItem('Projets & références', 'ouvrirProjets')
    .addItem('Panneau de contrôle', 'ouvrirPanneau')
    .addItem('Ouvrir le jumeau', 'ouvrirJumeau')
    .addSeparator()
    .addItem('Régénérer les clés', 'regenererLesCles')
    .addToUi();
}

/**
 * Simple trigger: a dock edited by hand in QUAIS_CAMIONS bumps the docks version, so the screens download the state
 * at their next poll (api_getState overlays the live docks). Only Properties and Cache: allowed in a simple trigger.
 */
function onEdit(e) {
  try {
    if (!e || !e.range || e.range.getSheet().getName() !== CFG.TABS.DOCKS) return;
    Repo.bumpVersion('docks');
  } catch (err) {
    // A simple trigger must never show an error to the person typing.
  }
}

function installerLaBase() {
  requireSheet_();
  var ui = SpreadsheetApp.getUi();
  var resetParams = false;
  if (Repo.isInstalled()) {
    var answer = ui.alert('Installer / réinitialiser la base',
      'La base est déjà installée.\n\n' +
      'OUI : remettre les paramètres par défaut (LAYOUT, REGLES_PLACEMENT, PARAM_MOUVEMENTS, PARAM_SEUILS, QUAIS_CAMIONS).\n' +
      'NON : réparer seulement (onglets manquants, en-têtes, formats, nouvelles colonnes).\n\n' +
      'Dans les deux cas, les mouvements, le stock initial, les articles, les projets et le journal des imports sont conservés.',
      ui.ButtonSet.YES_NO_CANCEL);
    if (answer !== ui.Button.YES && answer !== ui.Button.NO) return;
    resetParams = answer === ui.Button.YES;
  }
  runFromSheet_('Installation de la base', function () {
    var res = Repo.withLock('data', function () {
      var r = Repo.setup({ resetParams: resetParams });
      r.calc = computeAndSave_('RECALCUL');
      return r;
    });
    buildHome_();
    return {
      message: 'Base installée' + (res.created.length ? ' (' + res.created.length + ' onglets créés)' : '') + '. ' +
        'Étape suivante : « Générer ' + SIM_MENU_DAYS_ + ' jours » (démonstration) ou un import SAP depuis la page PC.'
    };
  });
}

function simulerDonnees() {
  requireSheet_();
  runFromSheet_('Simulation de ' + SIM_MENU_DAYS_ + ' jours', function () {
    return runSimulation_({ days: SIM_MENU_DAYS_, seed: 2026 });
  });
}

function simulerJourSuivant() {
  requireSheet_();
  runFromSheet_('Simulation d\'un jour de plus', runNextDay_);
}

function effacerSimulation() {
  requireSheet_();
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Effacer la simulation',
    'Supprimer toutes les données simulées (mouvements, stock initial et articles simulés, état simulé des quais) ?\n\n' +
    'Les lignes importées depuis SAP sont conservées.', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  runFromSheet_('Effacement de la simulation', runClearSimulation_);
}

function recalculer() {
  requireSheet_();
  runFromSheet_('Recalcul', runRecompute_);
}

function ouvrirPanneau() {
  requireSheet_();
  var out = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('EXP2 · Panneau de contrôle');
  SpreadsheetApp.getUi().showSidebar(out);
}

/** Menu « Projets & références »: the projects panel (references -> projects, blocks per project). */
function ouvrirProjets() {
  requireSheet_();
  var out = HtmlService.createHtmlOutputFromFile('SidebarProjets').setTitle('EXP2 · Projets & références');
  SpreadsheetApp.getUi().showSidebar(out);
}

function ouvrirJumeau() {
  requireSheet_();
  var keys = Repo.isInstalled() ? Repo.ensureKeys() : { admin: '', docks: '' };
  var out = HtmlService.createHtmlOutput(jumeauDialogHtml_(webLinks_(), keys)).setWidth(580).setHeight(540);
  SpreadsheetApp.getUi().showModalDialog(out, 'Ouvrir le jumeau numérique');
}

/** New admin and docks keys (after a leak): the old ones stop working at once; the pages ask for the new ones. */
function regenererLesCles() {
  requireSheet_();
  var ui = SpreadsheetApp.getUi();
  if (!Repo.isInstalled()) {
    ui.alert(CFG.APP_NAME, 'Base non installée : menu EXP2 Jumeau › Installer / réinitialiser la base.', ui.ButtonSet.OK);
    return;
  }
  var answer = ui.alert('Régénérer les clés',
    'Créer une nouvelle clé administrateur et une nouvelle clé quais ?\n\n' +
    'Les clés actuelles ne fonctionneront plus : communiquez les nouvelles aux personnes concernées ' +
    '(elles seront affichées juste après).', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  Repo.resetKeys();
  try {
    refreshHome_();
  } catch (e) {
    // The status block is cosmetic.
  }
  ouvrirJumeau();
}

// ---------------------------------------------------------------------------------------------------------------
// Sidebar (google.script.run from Sidebar.html; runs as the user of the spreadsheet, no key)
// ---------------------------------------------------------------------------------------------------------------
function sidebar_status() {
  requireSheet_();
  var out = {
    appName: CFG.APP_NAME,
    installed: Repo.isInstalled(),
    versions: Repo.getVersions(),
    defaults: { days: SIM_MENU_DAYS_, endDate: simEndDefault_(), palletsPerDay: '', seed: 2026 },
    limits: simLimits_(),
    state: null,
    lastImport: null,
    simulation: null
  };
  if (!out.installed) return out;
  var sim = Repo.getProp('SIM_PARAMS');
  if (sim) {
    out.simulation = { seed: sim.seed, days: sim.days, firstDate: sim.firstDate || sim.startDate, lastDate: sim.lastDate || sim.endDate,
      palletsPerDay: sim.palletsPerDay === undefined ? null : sim.palletsPerDay };
    out.defaults.seed = sim.seed;
    if (sim.palletsPerDay) out.defaults.palletsPerDay = sim.palletsPerDay;
  }
  var state = Repo.loadState();
  if (state) {
    state = withLiveDocks_(state);
    var s = summary_(state);
    var k = state.kpi || {};
    s.computedAt = state.computedAt;
    s.importedAt = state.importedAt;
    s.oldestPendingDays = k.oldestPendingDays;
    s.projects = k.projects === undefined ? null : k.projects;
    s.noProjectArticles = k.noProjectArticles === undefined ? null : k.noProjectArticles;
    s.docksOccupied = k.docksOccupied;
    s.docksTotal = k.docksTotal;
    s.alertsList = (state.alerts || []).slice(0, 5);
    out.state = s;
  }
  var last = Repo.lastImport();
  if (last) out.lastImport = { at: last.at, kind: last.kind, period: last.period, fresh: last.fresh, result: last.result };
  return out;
}

function sidebar_simulate(params) {
  requireSheet_();
  return sidebarRun_(function () { return runSimulation_(params || {}); });
}

function sidebar_nextDay() {
  requireSheet_();
  return sidebarRun_(runNextDay_);
}

function sidebar_recompute() {
  requireSheet_();
  return sidebarRun_(runRecompute_);
}

function sidebar_links() {
  requireSheet_();
  return { links: webLinks_(), keys: Repo.isInstalled() ? Repo.ensureKeys() : { admin: '', docks: '' } };
}

// ---------------------------------------------------------------------------------------------------------------
// Projects panel (google.script.run from SidebarProjets.html; editors of the sheet, no key)
// ---------------------------------------------------------------------------------------------------------------
/**
 * api_getProjects plus what the panel needs without the state on the client: designations and pallets of the
 * tracked articles (state.articles), project colors (state.projects) and the link of the PC page « Projets ».
 */
function sidebar_getProjects() {
  requireSheet_();
  if (!Repo.isInstalled()) return { installed: false };
  var out = getProjects_();
  out.installed = true;
  var state = Repo.loadState();
  out.articles = state && state.articles ? state.articles.map(function (a) {
    return { article: a.a, designation: a.d, project: a.p, exp2: a.e, pending: a.w };
  }) : [];
  out.colors = state && state.projects ? state.projects : {};
  out.asOf = state ? state.asOf : null;
  var links = webLinks_();
  var page = links.pages.filter(function (p) { return p.page === 'projects'; })[0];
  out.link = page ? page.url : '';
  out.linkHelp = page ? '' : links.instructions;
  return out;
}

/** References -> projects from the panel: same rules as api_saveReferences; answers with the panel data. */
function sidebar_saveReferences(rows) {
  requireSheet_();
  return sidebarProjectsRun_(function () { return saveReferences_(rows); });
}

/** Blocks and colors of the projects from the panel: same rules as api_saveProjects. */
function sidebar_saveProjects(projects) {
  requireSheet_();
  return sidebarProjectsRun_(function () { return saveProjects_(projects); });
}

function sidebarProjectsRun_(fn) {
  var out = fn() || {};
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(out.message || 'Terminé.', CFG.APP_NAME, 8);
  } catch (e) {
    // Toast is cosmetic.
  }
  out.data = sidebar_getProjects();
  return out;
}

/**
 * Saves the /exec URL of the web app deployment (Déployer › Gérer les déploiements). ScriptApp.getService().getUrl()
 * often gives the /dev URL of the test deployment, which only editors can open. Empty text: back to automatic.
 */
function sidebar_setWebAppUrl(url) {
  requireSheet_();
  var u = String(url === null || url === undefined ? '' : url).trim();
  if (u && !WEBAPP_URL_RE_.test(u)) {
    throw new Error('Adresse non reconnue : collez l\'URL qui se termine par /exec (Déployer › Gérer les déploiements › Application Web).');
  }
  Repo.setProp('WEBAPP_URL', u || null);
  try {
    refreshHome_();
  } catch (e) {
    // The status block is cosmetic.
  }
  return sidebar_links();
}

// ---------------------------------------------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------------------------------------------
function requireSheet_() {
  try {
    SpreadsheetApp.getUi();
  } catch (e) {
    throw new Error('Action réservée au classeur Google Sheets (menu EXP2 Jumeau, boutons ACCUEIL ou panneau de contrôle).');
  }
}

// Runs an action from the menu or a button: French toasts, French alert on error.
function runFromSheet_(label, fn) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast(label + ' en cours…', CFG.APP_NAME, 120);
  try {
    var out = fn() || {};
    ss.toast(out.message || label + ' terminé.', CFG.APP_NAME, 10);
    return out;
  } catch (err) {
    ss.toast(label + ' : échec.', CFG.APP_NAME, 5);
    SpreadsheetApp.getUi().alert(CFG.APP_NAME, label + ' : ' + errorText_(err), SpreadsheetApp.getUi().ButtonSet.OK);
    return null;
  }
}

function sidebarRun_(fn) {
  var out = fn() || {};
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(out.message || 'Terminé.', CFG.APP_NAME, 8);
  } catch (e) {
    // Toast is cosmetic.
  }
  return { message: out.message || 'Terminé.', status: sidebar_status() };
}

function errorText_(err) {
  return err && err.message ? err.message : String(err);
}

var WEBAPP_URL_RE_ = /^https:\/\/script\.google\.com\/(a\/macros\/[^\/\s]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/;

/**
 * Links of the web app: the /exec URL saved in the control panel (Script Property WEBAPP_URL) first, else
 * ScriptApp.getService().getUrl(). A /dev URL (test deployment: editors only, unpublished code) is never given as
 * the TV or PC link.
 */
function webLinks_() {
  var url = '';
  try {
    url = Repo.getProp('WEBAPP_URL') || '';
  } catch (e) {
    url = '';
  }
  var source = url ? 'saved' : 'auto';
  if (!url) {
    try {
      url = ScriptApp.getService().getUrl() || '';
    } catch (e) {
      url = '';
    }
  }
  url = String(url);
  var dev = /\/dev$/.test(url);
  var deployed = !!url && !dev;
  var sep = url.indexOf('?') >= 0 ? '&' : '?';
  var pages = WEB_PAGES_.map(function (p) { return [p, WEB_PAGE_LABELS_[p] || p]; });
  var instructions = '';
  if (dev) {
    instructions = 'Collez l\u2019URL /exec du déploiement (Déployer › Gérer les déploiements) dans le panneau de contrôle ' +
      '(menu EXP2 Jumeau › Panneau de contrôle › Liens) : l\u2019adresse /dev ne s\u2019ouvre que pour les éditeurs du script.';
  } else if (!url) {
    instructions = 'Application Web non déployée : dans Extensions › Apps Script, Déployer › Nouveau déploiement › ' +
      'type Application Web, Exécuter en tant que « Moi », accès selon votre choix (« Tout le monde » pour une TV sans ' +
      'compte Google), puis Déployer, autoriser, et collez l\u2019URL /exec dans le panneau de contrôle.';
  }
  return {
    deployed: deployed,
    dev: dev,
    source: source,
    base: deployed ? url : '',
    tv: deployed ? url + sep + 'mode=tv&rotate=1' : '',
    pc: deployed ? url + sep + 'page=lookup' : '',
    pages: deployed ? pages.map(function (p) { return { page: p[0], label: p[1], url: url + sep + 'page=' + p[0] }; }) : [],
    instructions: instructions
  };
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function jumeauDialogHtml_(links, keys) {
  var css = '<style>' +
    'body{font:14px/1.45 "Google Sans",Roboto,Arial,sans-serif;color:#1f2a37;margin:0;padding:4px 6px}' +
    'h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#5b6773;margin:16px 0 6px}' +
    'a{color:#1a5fb4;word-break:break-all}.box{background:#f4f6f8;border:1px solid #dde3ea;border-radius:8px;padding:10px 12px}' +
    '.row{margin:4px 0}.lbl{color:#5b6773}.key{font:600 16px/1.3 "Roboto Mono",Consolas,monospace;letter-spacing:.06em}' +
    'ol{margin:6px 0 0 18px;padding:0}li{margin:3px 0}.note{color:#5b6773;font-size:12px;margin-top:8px}' +
    'button{margin-top:16px;padding:7px 18px;border:0;border-radius:6px;background:#1a5fb4;color:#fff;font-weight:600;cursor:pointer}' +
    '</style>';
  var html = css + '<h2>Liens</h2>';
  if (links.deployed) {
    html += '<div class="box"><div class="row"><span class="lbl">Écran TV (plein écran, scènes en rotation) :</span><br>' +
      '<a href="' + esc_(links.tv) + '" target="_blank" rel="noopener">' + esc_(links.tv) + '</a></div>' +
      '<div class="row"><span class="lbl">Pages PC :</span> ' + links.pages.map(function (p) {
        return '<a href="' + esc_(p.url) + '" target="_blank" rel="noopener">' + esc_(p.label) + '</a>';
      }).join(' · ') + '</div></div>';
  } else if (links.dev) {
    html += '<div class="box"><b>Lien de test (/dev) détecté.</b> Il ne s\'ouvre que pour les éditeurs du script et affiche du code ' +
      'non publié : la TV et les autres postes ne peuvent pas l\'utiliser.<ol>' +
      '<li>Extensions › Apps Script, Déployer › <b>Gérer les déploiements</b>, copiez l\'URL de l\'<b>Application Web</b> (elle se termine par <b>/exec</b>).</li>' +
      '<li>Menu EXP2 Jumeau › <b>Panneau de contrôle</b>, section Liens : collez l\'URL puis Enregistrer.</li>' +
      '<li>Rouvrez cette fenêtre.</li></ol></div>';
  } else {
    html += '<div class="box"><b>L\'application Web n\'est pas encore déployée.</b><ol>' +
      '<li>Extensions › Apps Script.</li>' +
      '<li>Déployer › Nouveau déploiement › type <b>Application Web</b>.</li>' +
      '<li>Exécuter en tant que : <b>Moi</b> ; Qui a accès : selon votre choix (« Tout le monde » pour une TV sans compte Google).</li>' +
      '<li>Déployer, autoriser l\'accès, copiez l\'URL /exec et collez-la dans le panneau de contrôle (menu EXP2 Jumeau › Panneau de contrôle › Liens).</li>' +
      '<li>Rouvrez cette fenêtre.</li></ol></div>';
  }
  html += '<h2>Clés d\'accès</h2><div class="box">' +
    '<div class="row"><span class="lbl">Clé administrateur (import, simulation, recalcul) :</span><br><span class="key">' +
    esc_(keys.admin || '—') + '</span></div>' +
    '<div class="row"><span class="lbl">Clé quais (page Quais &amp; camions) :</span><br><span class="key">' +
    esc_(keys.docks || '—') + '</span></div>' +
    '<div class="note">Les pages PC demandent la clé une seule fois par session. Ne la communiquez qu\'aux personnes concernées ; ' +
    'après une fuite : menu EXP2 Jumeau › Régénérer les clés.</div></div>' +
    '<button onclick="google.script.host.close()">Fermer</button>';
  return html;
}

// ---------------------------------------------------------------------------------------------------------------
// ACCUEIL tab
// ---------------------------------------------------------------------------------------------------------------
function buildHome_() {
  var L = HOME_LAYOUT_;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CFG.TABS.HOME) || ss.insertSheet(CFG.TABS.HOME, 0);
  sh.getImages().forEach(function (img) { img.remove(); });
  sh.clear();
  var maxRows = sh.getMaxRows(), maxCols = sh.getMaxColumns();
  if (maxRows < L.rows) sh.insertRowsAfter(maxRows, L.rows - maxRows);
  else if (maxRows > L.rows) sh.deleteRows(L.rows + 1, maxRows - L.rows);
  if (maxCols < L.cols) sh.insertColumnsAfter(maxCols, L.cols - maxCols);
  else if (maxCols > L.cols) sh.deleteColumns(L.cols + 1, maxCols - L.cols);
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 24);
  sh.setColumnWidth(2, 320);
  sh.setColumnWidth(3, 330);
  sh.setColumnWidth(4, 24);
  sh.setRowHeight(1, 14);
  sh.setRowHeight(L.title, 44);
  sh.setRowHeights(L.buttons[0], L.buttons.length, 66);

  var grid = [];
  for (var r = 0; r < L.rows; r++) grid.push(['', '', '', '']);
  grid[L.title - 1][1] = CFG.APP_NAME;
  grid[L.subtitle - 1][1] = 'Entrepôt d\'expédition EXP2 · données SAP MB51 · version ' + CFG.VERSION;
  grid[L.statusTitle - 1][1] = 'État des données';
  HOME_STATUS_LABELS_.forEach(function (label, i) { grid[L.statusFirst - 1 + i][1] = label; });
  grid[L.helpTitle - 1][1] = 'Mode d\'emploi';
  HOME_HELP_.forEach(function (line, i) { grid[L.helpFirst - 1 + i][1] = line; });
  sh.getRange(1, 1, L.rows, L.cols).setNumberFormat('@').setValues(grid)
    .setFontFamily('Roboto').setFontSize(10).setFontColor('#1f2a37').setVerticalAlignment('middle');

  sh.getRange(L.title, 2).setFontSize(22).setFontWeight('bold').setFontColor('#0f2a44');
  sh.getRange(L.subtitle, 2).setFontColor('#5b6773');
  [L.statusTitle, L.helpTitle].forEach(function (row) {
    sh.getRange(row, 2, 1, 2).setFontSize(12).setFontWeight('bold').setFontColor('#0f2a44')
      .setBorder(null, null, true, null, null, null, '#c9d2dc', SpreadsheetApp.BorderStyle.SOLID);
  });
  sh.getRange(L.statusFirst, 2, HOME_STATUS_LABELS_.length, 1).setFontColor('#5b6773');
  sh.getRange(L.statusFirst, 3, HOME_STATUS_LABELS_.length, 1).setFontWeight('bold');
  sh.getRange(L.helpFirst, 2, HOME_HELP_.length, 1).setFontColor('#33404d');

  var buttons = [
    ['SIMULATE', 'simulerDonnees', 2, L.buttons[0], 'Générer ' + SIM_MENU_DAYS_ + ' jours'],
    ['NEXTDAY', 'simulerJourSuivant', 3, L.buttons[0], 'Simuler +1 jour'],
    ['RECOMPUTE', 'recalculer', 2, L.buttons[1], 'Recalculer'],
    ['OPEN', 'ouvrirJumeau', 3, L.buttons[1], 'Ouvrir le jumeau']
  ];
  buttons.forEach(function (b) {
    var blob = Utilities.newBlob(Utilities.base64Decode(ASSETS[b[0]]), 'image/png', b[0].toLowerCase() + '.png');
    var img = sh.insertImage(blob, b[2], b[3], 8, 4);
    img.setWidth(300).setHeight(58);
    img.assignScript(b[1]);
    try {
      img.setAltTextTitle(b[4]);
    } catch (e) {
      // Alt text is optional.
    }
  });
  refreshHome_();
  ss.setActiveSheet(sh);
}

// Status block of ACCUEIL, rewritten after every action (one setValues).
function refreshHome_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss ? ss.getSheetByName(CFG.TABS.HOME) : null;
  if (!sh || sh.getMaxRows() < HOME_LAYOUT_.statusFirst + HOME_STATUS_LABELS_.length) return;
  var values = homeStatus_();
  var range = sh.getRange(HOME_LAYOUT_.statusFirst, 3, values.length, 1);
  range.setNumberFormat('@');
  var rich = values.map(function (v) {
    var b = SpreadsheetApp.newRichTextValue().setText(v.text || ' ');
    if (v.link) b.setLinkUrl(v.link);
    return [b.build()];
  });
  range.setRichTextValues(rich);
}

function homeStatus_() {
  var tz = Session.getScriptTimeZone();
  function when(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : Utilities.formatDate(d, tz, 'dd.MM.yyyy HH:mm');
  }
  var versions = Repo.getVersions();
  var state = Repo.isInstalled() ? Repo.loadState() : null;
  if (state) state = withLiveDocks_(state);
  var k = state ? state.kpi || {} : {};
  var last = Repo.isInstalled() ? Repo.lastImport() : null;
  var links = webLinks_();
  var keys = Repo.getKeys();
  var alerts = state ? state.alerts || [] : [];
  var crit = alerts.filter(function (a) { return a.level === 'crit'; }).length;
  var notDeployed = links.dev ? 'Lien /dev (test) : collez l\u2019URL /exec dans le panneau de contrôle'
    : 'Non déployé : Déployer › Nouveau déploiement › Application Web';
  // En attente PRD2: pallets, then « PRD2 > 6 h : n » (threshold of PARAM_SEUILS) and the oldest wait.
  var pending = '—';
  if (state) {
    var s = summary_(state);
    var oldest = k.oldestPendingHours !== null && k.oldestPendingHours !== undefined ? frHours_(k.oldestPendingHours)
      : (k.oldestPendingDays ? plural_(k.oldestPendingDays, 'jour', 'jours') : '');
    pending = plural_(k.pendingPallets || 0, 'palette', 'palettes') + ' · PRD2 > ' + frNum_(s.pendingHoursCrit, 1).replace(/,0$/, '') +
      ' h : ' + frNum_(s.pendingCrit, 0) + (oldest ? ' (plus ancienne : ' + oldest + ')' : '');
  }
  var asOfTs = state && state.asOfTs ? ' ' + String(state.asOfTs).slice(11, 16) : '';
  return [
    { text: !state ? 'Aucune donnée' : state.source === 'SIMULATION' ? 'Simulation (données fictives)' : 'SAP (imports MB51)' },
    { text: state ? frDate_(state.asOf) + asOfTs : '—' },
    { text: last ? when(last.at) + ' · ' + last.kind + (last.fresh !== null && last.fresh !== undefined ?
      ' · ' + plural_(last.fresh, 'ligne', 'lignes') : '') : '—' },
    { text: state ? when(state.computedAt) : '—' },
    { text: 'Données ' + versions.data + ' · quais ' + versions.docks },
    { text: state ? frNum_(k.exp2Pallets || 0, 0) + ' palettes sur ' + frNum_(k.capacity || 0, 0) + ' places' : '—' },
    { text: state && k.saturation !== null && k.saturation !== undefined ? frPct_(k.saturation) : '—' },
    { text: pending },
    { text: state ? (k.docksOccupied || 0) + ' sur ' + (k.docksTotal || 0) : '—' },
    { text: state ? alerts.length + (crit ? ' dont ' + crit + ' critique' + (crit > 1 ? 's' : '') : '') : '—' },
    { text: links.deployed ? links.tv : notDeployed, link: links.deployed ? links.tv : '' },
    { text: links.deployed ? links.pc : notDeployed, link: links.deployed ? links.pc : '' },
    // Never the keys themselves: anyone who can view the sheet (or a copy, an export, the history) would read them.
    { text: keys.admin ? KEYS_HIDDEN_TEXT_ : '—' },
    { text: keys.docks ? KEYS_HIDDEN_TEXT_ : '—' }
  ];
}
