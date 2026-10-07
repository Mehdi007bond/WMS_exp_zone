/**
 * EXP2 Digital Twin - local harness: stand-ins for the Google Sheets services that Main.gs uses, for the sheet
 * sidebars (out/sidebar.html = Sidebar.html, out/sidebar-projets.html = SidebarProjets.html).
 *
 * The sidebar pages load the same in-browser server as the web app pages (Config, Normalize, Engine, Simulation,
 * repo-memory.js, Api) plus Main.gs and this file, then shim.js: google.script.run.sidebar_*() runs the real
 * Main.gs functions on the in-memory Repo (store shared with the web app pages of the browser profile).
 *
 * Stand-ins: SpreadsheetApp (getUi: alerts answered « Oui », sidebars and dialogs recorded; getActiveSpreadsheet:
 * toasts recorded), ScriptApp (a fixed /exec URL: the web app is « deployed »), HtmlService (outputs with a title),
 * Session (Europe/Paris), Utilities.formatDate ('dd.MM.yyyy HH:mm' and the like).
 * What the sheet showed: window.__sheet = { toasts, alerts, sidebars, dialogs }.
 */
(function () {
  'use strict';

  var rec = { toasts: [], alerts: [], sidebars: [], dialogs: [] };

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function output(name) {
    return {
      name: name,
      title: '',
      setTitle: function (t) { this.title = String(t); return this; },
      setWidth: function () { return this; },
      setHeight: function () { return this; },
      getContent: function () { return ''; }
    };
  }

  var ui = {
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' },
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' },
    alert: function () {
      rec.alerts.push(Array.prototype.slice.call(arguments).filter(function (x) { return typeof x === 'string'; }).join(' · '));
      return 'YES';
    },
    showSidebar: function (o) { rec.sidebars.push(o && (o.title || o.name)); },
    showModalDialog: function (o, title) { rec.dialogs.push(String(title || (o && o.title) || '')); },
    showModelessDialog: function (o, title) { rec.dialogs.push(String(title || (o && o.title) || '')); },
    createMenu: function () {
      var m = { addItem: function () { return m; }, addSeparator: function () { return m; }, addSubMenu: function () { return m; },
        addToUi: function () {} };
      return m;
    }
  };

  window.SpreadsheetApp = {
    getUi: function () { return ui; },
    getActiveSpreadsheet: function () {
      return { toast: function (msg) { rec.toasts.push(String(msg)); }, getSpreadsheetTimeZone: function () { return 'Europe/Paris'; } };
    }
  };

  window.ScriptApp = {
    getService: function () {
      return { getUrl: function () { return 'https://script.google.com/macros/s/HARNESS/exec'; } };
    }
  };

  window.HtmlService = {
    createHtmlOutputFromFile: function (name) { return output(String(name)); },
    createHtmlOutput: function () { return output('html'); }
  };

  window.Session = { getScriptTimeZone: function () { return 'Europe/Paris'; } };

  // Utilities.formatDate(date, tz, pattern) in the time zone of the browser (the harness runs in Europe/Paris).
  window.Utilities = {
    formatDate: function (d, tz, pattern) {
      var parts = { yyyy: String(d.getFullYear()), MM: pad2(d.getMonth() + 1), dd: pad2(d.getDate()), HH: pad2(d.getHours()),
        mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()) };
      return String(pattern).replace(/yyyy|MM|dd|HH|mm|ss/g, function (k) { return parts[k]; });
    }
  };

  window.__sheet = rec;
})();
