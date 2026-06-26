/**
 * TopEdge Opt-In Tools — core loader (< 3KB target).
 * Fetches config once, loads trigger evaluator, lazy-loads tool chunks.
 */
(function (window, document) {
  'use strict';

  var SCRIPT = document.currentScript;
  if (!SCRIPT) return;

  var EMBED_KEY = SCRIPT.getAttribute('data-embed-key') || '';
  var CLIENT_ID = SCRIPT.getAttribute('data-client-id') || '';
  var API_ORIGIN = (function () {
    try {
      var src = SCRIPT.src || '';
      var u = new URL(src, window.location.href);
      return u.origin;
    } catch (e) {
      return '';
    }
  })();

  if (!EMBED_KEY || !API_ORIGIN) return;

  function installAddToCartListener() {
    if (window.__te_optin_atc_installed) return;
    window.__te_optin_atc_installed = true;

    function markAddToCart() {
      try {
        sessionStorage.setItem('te_optin_atc', JSON.stringify({ at: Date.now() }));
        window.dispatchEvent(new CustomEvent('te_optin_add_to_cart'));
      } catch (e) {}
    }

    try {
      var origFetch = window.fetch;
      if (origFetch && !origFetch.__te_optin_hooked) {
        window.fetch = function () {
          var args = arguments;
          var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
          var promise = origFetch.apply(this, args);
          if (/\/cart\/add/i.test(url)) {
            promise.then(function (res) {
              if (res && res.ok) markAddToCart();
            }).catch(function () {});
          }
          return promise;
        };
        window.fetch.__te_optin_hooked = true;
      }
    } catch (e) {}

    try {
      document.addEventListener('cart:updated', markAddToCart);
    } catch (e) {}
  }

  installAddToCartListener();

  var CHUNK_BASE = API_ORIGIN + '/public/';
  var loadedChunks = {};
  var cancelFns = [];

  function apiUrl(path) {
    return API_ORIGIN + '/api/public/opt-in' + path;
  }

  function getPreviewToolId() {
    try {
      var q = new URLSearchParams(window.location.search);
      return q.get('te_preview_tool') || '';
    } catch (e) {
      return '';
    }
  }

  function ensureVisitorId() {
    var key = 'te_visitor_id';
    try {
      var existing = localStorage.getItem(key);
      if (existing) return existing;
      var id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(key, id);
      return id;
    } catch (e) {
      return 'v_anon';
    }
  }

  function loadScript(name) {
    if (loadedChunks[name]) return loadedChunks[name];
    loadedChunks[name] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CHUNK_BASE + 'topedge-opt-in-' + name + '.js';
      s.async = true;
      s.onload = function () { resolve(true); };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return loadedChunks[name];
  }

  function loadChunk(name) {
    var key = 'mod_' + name;
    if (loadedChunks[key]) return loadedChunks[key];
    loadedChunks[key] = loadScript(name).then(function () {
      return window.TopEdgeOptIn && window.TopEdgeOptIn[name];
    });
    return loadedChunks[key];
  }

  function chunkForType(type) {
    if (type === 'whatsapp_widget') return 'widget';
    if (type === 'spin_wheel') return 'spin';
    if (type === 'mystery_discount') return 'mystery';
    return 'popup';
  }

  function mountTool(tool, previewId, visitorId) {
    var chunk = chunkForType(tool.type);
    var preview = Boolean(previewId);
    var triggers = window.TopEdgeOptIn && window.TopEdgeOptIn.triggers;
    var ctx = triggers && triggers.buildCtx
      ? triggers.buildCtx(visitorId, preview)
      : { path: '/', isMobile: false, preview: preview };

    function show() {
      loadChunk(chunk)
        .then(function (mod) {
          if (mod && typeof mod.render === 'function') {
            mod.render({
              tool: tool,
              embedKey: EMBED_KEY,
              clientId: CLIENT_ID,
              apiOrigin: API_ORIGIN,
              visitorId: visitorId,
              preview: preview,
            });
          }
        })
        .catch(function () {});
    }

    if (preview) {
      show();
      return;
    }

    if (triggers && triggers.scheduleToolDisplay) {
      var cancel = triggers.scheduleToolDisplay(tool, ctx, show);
      if (typeof cancel === 'function') cancelFns.push(cancel);
      return;
    }
    show();
  }

  function boot(cfg) {
    var previewId = getPreviewToolId();
    var tools = (cfg && cfg.tools) || [];
    var visitorId = ensureVisitorId();

    if (previewId) {
      var match = tools.find(function (t) { return String(t.id) === String(previewId); });
      if (match) mountTool(match, previewId, visitorId);
      return;
    }

    for (var i = 0; i < tools.length; i++) {
      mountTool(tools[i], '', visitorId);
    }
  }

  Promise.all([
    fetch(apiUrl('/config?key=') + encodeURIComponent(EMBED_KEY), { credentials: 'omit' }).then(function (r) {
      return r.json();
    }),
    loadScript('triggers'),
    loadScript('phone'),
  ])
    .then(function (results) {
      var data = results[0];
      if (!data || !data.success) return;
      boot(data);
    })
    .catch(function () {});

  window.TopEdgeOptIn = window.TopEdgeOptIn || {};
  window.TopEdgeOptIn.core = { ensureVisitorId: ensureVisitorId, apiUrl: apiUrl };
})(window, document);
