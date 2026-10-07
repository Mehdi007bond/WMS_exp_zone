/**
 * EXP2 Digital Twin - local harness: google.script.run / url / history / host shim.
 *
 * The pages of tests/harness/out/ (npm run harness) load the server modules first (Config, Normalize, Engine,
 * Simulation, repo-memory.js, Api), then this file: the api_* functions of Api.gs run inside the page, on the
 * in-memory Repo, the way Apps Script runs them on the Google Sheet. Like the real google.script.run, every call is
 * asynchronous and arguments and results cross as JSON copies.
 *
 * One store per data set is shared by every harness page of the browser profile through localStorage, the way the
 * screens share one Google Sheet: a write on the PC simulation page reaches the TV at its next poll.
 * On the first load (no saved store) the shim installs the base and seeds a simulation with the admin key.
 *
 * Query flags (read by the harness only):
 *   empty=1          installed base without data (own store)         none=1   base not installed (nothing saved)
 *   reset=1          forget the saved store and seed again             seed=N, days=N, ppd=N   first simulation
 *                                                                      (2026, 5 days, 200 labels a day: ~2.6 MB of
 *                                                                      localStorage; the v2 default of 450 a day
 *                                                                      for 7 days would be ~8 MB, over the quota)
 *   poll=S           version polling period in seconds (window.EXP2_HARNESS.pollMs, read by App.pollPeriodMs)
 *   lat=MS           server latency (default 40)                       fresh=warn|crit  import 6 h / 30 h ago
 *   no3d=1           Twin3D.supported() is false (isometric fallback)  offline=1  every server call fails
 *
 * Exposes window.__keys = { admin, docks } (keys of the store) and window.__harness (flags, calls, setOffline(b),
 * reseed(), persist(), Repo).
 */
(function () {
  'use strict';

  var FLAG_NAMES = ['empty', 'none', 'poll', 'lat', 'fresh', 'no3d', 'offline', 'seed', 'days', 'ppd'];
  var READ_ONLY = { api_getVersion: true, api_getState: true, api_lookup: true, api_searchArticles: true, api_checkKey: true,
    api_getProjects: true, sidebar_status: true, sidebar_getProjects: true, sidebar_links: true };
  // Sheet sidebars (out/sidebar*.html also load Main.gs and sheet-stub.js): the sidebar_* functions and the menu
  // functions their buttons call.
  var SHEET_FUNCTIONS = ['ouvrirPanneau', 'ouvrirProjets', 'ouvrirJumeau'];

  function parseQuery(search) {
    var out = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (part) {
      if (!part) return;
      var i = part.indexOf('=');
      var k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
      var v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
      if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
    });
    return out;
  }

  function queryArrays(search) {
    var out = {};
    String(search || '').replace(/^\?/, '').split('&').forEach(function (part) {
      if (!part) return;
      var i = part.indexOf('=');
      var k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
      (out[k] = out[k] || []).push(i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' ')));
    });
    return out;
  }

  function on(v) {
    return v !== undefined && v !== '0' && v !== 'false';
  }

  function copy(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  if (typeof Repo === 'undefined' || typeof api_getState !== 'function' || typeof Engine === 'undefined') {
    throw new Error('Harness : modules serveur absents (Config, Normalize, Engine, Simulation, repo-memory.js, Api).');
  }

  var params = parseQuery(window.location.search);
  var flags = {
    empty: on(params.empty),
    none: on(params.none),
    reset: on(params.reset),
    poll: Number(params.poll) > 0 ? Number(params.poll) : 0,
    lat: params.lat !== undefined && isFinite(Number(params.lat)) ? Math.max(0, Number(params.lat)) : 40,
    fresh: params.fresh === 'warn' || params.fresh === 'crit' ? params.fresh : '',
    no3d: on(params.no3d),
    offline: on(params.offline),
    seed: params.seed !== undefined && params.seed !== '' ? Number(params.seed) : 2026,
    days: Number(params.days) > 0 ? Number(params.days) : 5,
    ppd: Number(params.ppd) > 0 ? Number(params.ppd) : 200
  };
  var ns = flags.none ? 'none' : flags.empty ? 'empty' : 'sim';
  var DB_KEY = 'exp2.harness.' + ns + '.db';
  var REV_KEY = 'exp2.harness.' + ns + '.rev';
  var rev = null;
  var calls = [];

  window.EXP2_HARNESS = window.EXP2_HARNESS || {};
  if (flags.poll) window.EXP2_HARNESS.pollMs = flags.poll * 1000;

  // ---------------------------------------------------------------------------------------------------------------
  // Shared store (localStorage; the page still works alone when storage is blocked or full)
  // ---------------------------------------------------------------------------------------------------------------
  function storage() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function persist() {
    var ls = storage();
    if (!ls || ns === 'none') return;
    try {
      ls.setItem(DB_KEY, Repo.snapshot());
      rev = Date.now() + '-' + Math.floor(Math.random() * 1e9);
      ls.setItem(REV_KEY, rev);
    } catch (e) {
      if (window.console) console.warn('Harness : magasin non partagé entre les pages (' + e.message + ').');
    }
  }

  function seed() {
    Repo.reset();
    if (ns !== 'none') {
      Repo.setup({});
      var keys = Repo.ensureKeys();
      if (ns === 'sim') api_simulate(keys.admin, { days: flags.days, seed: flags.seed, palletsPerDay: flags.ppd });
    }
    window.__keys = Repo.getKeys();
    persist();
  }

  // Before every call: take the store written by another page since this page last saw it.
  function sync() {
    var ls = storage();
    if (!ls || ns === 'none') return;
    var stored = null;
    try {
      stored = ls.getItem(REV_KEY);
      if (stored && stored !== rev) {
        var json = ls.getItem(DB_KEY);
        if (json) {
          Repo.restore(json);
          rev = stored;
          window.__keys = Repo.getKeys();
        }
      }
    } catch (e) {
      if (window.console) console.warn('Harness : lecture du magasin partagé impossible (' + e.message + ').');
    }
  }

  function load() {
    var ls = storage();
    var json = null, stored = null;
    if (ls && ns !== 'none' && !flags.reset) {
      try {
        json = ls.getItem(DB_KEY);
        stored = ls.getItem(REV_KEY);
      } catch (e) {
        json = null;
      }
    }
    if (json && stored) {
      try {
        Repo.restore(json);
        rev = stored;
        window.__keys = Repo.getKeys();
        return;
      } catch (e) {
        if (window.console) console.warn('Harness : magasin enregistré illisible, nouvelle simulation.');
      }
    }
    seed();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // google.script.run
  // ---------------------------------------------------------------------------------------------------------------
  function serverFunctions() {
    return Object.getOwnPropertyNames(window).filter(function (k) {
      var fn;
      try {
        fn = window[k];
      } catch (e) {
        return false;
      }
      return (/^(api|sidebar)_/.test(k) || SHEET_FUNCTIONS.indexOf(k) >= 0) && typeof fn === 'function';
    }).sort();
  }

  function invoke(name, args, ok, ko, userObject) {
    var payload;
    try {
      payload = copy(args);
    } catch (e) {
      payload = null;
    }
    setTimeout(function () {
      var started = Date.now();
      var out, err = null;
      try {
        if (flags.offline) throw new Error('NetworkError: Connection failure due to HTTP 0');
        if (payload === null) throw new Error('Argument non transmissible au serveur.');
        sync();
        var before = Repo.getVersions();
        out = window[name].apply(null, payload);
        var after = Repo.getVersions();
        if (!READ_ONLY[name] || before.data !== after.data || before.docks !== after.docks) persist();
        out = copy(out);
        if (name === 'api_getState' && out && flags.fresh) {
          out.importedAt = new Date(Date.now() - (flags.fresh === 'crit' ? 30 : 6) * 3600000).toISOString();
        }
      } catch (e) {
        err = new Error(e && e.message ? e.message : String(e));
        err.name = 'ScriptError';
      }
      calls.push({ name: name, ok: !err, ms: Date.now() - started, error: err ? err.message : '' });
      if (err) {
        if (ko) ko(err, userObject);
        else if (window.console) console.error('google.script.run.' + name + ' : ' + err.message);
      } else if (ok) {
        ok(out, userObject);
      }
    }, flags.lat);
  }

  function Runner(ok, ko, userObject) {
    this._ok = ok;
    this._ko = ko;
    this._user = userObject;
  }
  Runner.prototype.withSuccessHandler = function (fn) {
    return new Runner(fn, this._ko, this._user);
  };
  Runner.prototype.withFailureHandler = function (fn) {
    return new Runner(this._ok, fn, this._user);
  };
  Runner.prototype.withUserObject = function (obj) {
    return new Runner(this._ok, this._ko, obj);
  };
  serverFunctions().forEach(function (name) {
    Runner.prototype[name] = function () {
      invoke(name, Array.prototype.slice.call(arguments), this._ok, this._ko, this._user);
    };
  });

  // ---------------------------------------------------------------------------------------------------------------
  // google.script.url / history / host
  // ---------------------------------------------------------------------------------------------------------------
  function location_() {
    return {
      parameter: parseQuery(window.location.search),
      parameters: queryArrays(window.location.search),
      hash: String(window.location.hash || '').replace(/^#/, '')
    };
  }

  // New query of an in-app navigation: the route plus the harness flags of the current URL (never reset=1).
  function toSearch(query) {
    var cur = parseQuery(window.location.search);
    var q = {};
    FLAG_NAMES.forEach(function (k) {
      if (cur[k] !== undefined) q[k] = cur[k];
    });
    Object.keys(query || {}).forEach(function (k) {
      q[k] = query[k];
    });
    var keys = Object.keys(q);
    return keys.length ? '?' + keys.map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&') : '';
  }

  function historyCall(method, state, query, hash) {
    try {
      window.history[method](state, '', toSearch(query) + (hash ? '#' + hash : '') || window.location.pathname);
    } catch (e) {
      // file:// pages may refuse URL changes: the in-page navigation still happens.
    }
  }

  window.google = {
    script: {
      run: new Runner(null, null, undefined),
      url: {
        getLocation: function (cb) {
          setTimeout(function () { cb(location_()); }, 0);
        }
      },
      history: {
        push: function (state, query, hash) { historyCall('pushState', state, query, hash); },
        replace: function (state, query, hash) { historyCall('replaceState', state, query, hash); },
        setChangeHandler: function (fn) {
          window.addEventListener('popstate', function (ev) {
            fn({ state: ev.state, location: location_() });
          });
        }
      },
      host: {
        close: function () {},
        setHeight: function () {},
        setWidth: function () {},
        editor: { focus: function () {} },
        origin: window.location.origin
      }
    }
  };

  // Isometric fallback on demand: the Twin3D module says WebGL is unavailable.
  if (flags.no3d) {
    var twin = undefined;
    Object.defineProperty(window, 'Twin3D', {
      configurable: true,
      get: function () { return twin; },
      set: function (v) {
        twin = v;
        if (v) v.supported = function () { return false; };
      }
    });
  }

  load();

  window.__harness = {
    flags: flags,
    store: ns,
    calls: calls,
    functions: serverFunctions(),
    Repo: Repo,
    persist: persist,
    reseed: function () {
      seed();
      return window.__keys;
    },
    setOffline: function (b) {
      flags.offline = !!b;
    }
  };
})();
