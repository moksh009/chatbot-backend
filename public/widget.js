/**
 * TopEdge AI — Website Chat Widget Embed (v3)
 * Usage: <script src="https://your-api/public/widget.js" data-client-id="CLIENT_ID" defer></script>
 */
(function () {
  'use strict';

  var script =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();

  var apiBase = (script.src || '').replace(/\/public\/widget\.js.*$/, '').replace(/\/widget\.js.*$/, '');
  var clientId = script.getAttribute('data-client-id') || 'default';

  var CONFIG = {
    clientId: clientId,
    waNumber: script.getAttribute('data-wa-number') || '',
    greeting: script.getAttribute('data-greeting') || '',
    theme: script.getAttribute('data-theme') || '#7C3AED',
    themeSecondary: script.getAttribute('data-theme-secondary') || '#5B21B6',
    mode: script.getAttribute('data-mode') || 'both',
    position: script.getAttribute('data-position') || 'bottom-right',
    delay: parseInt(script.getAttribute('data-delay') || '3', 10),
    launcherIcon: script.getAttribute('data-icon') || 'chat',
    launcherStyle: script.getAttribute('data-launcher-style') || 'pill',
    launcherLabel: script.getAttribute('data-label') || 'Chat with us',
    customIconUrl: script.getAttribute('data-icon-url') || '',
    bubblePulse: script.getAttribute('data-pulse') !== 'false',
    apiBase: apiBase,
    loaded: false,
  };

  var isOpen = false;
  var btn, tooltip, iframeWrap, iframe;

  function leftPos() {
    return CONFIG.position === 'bottom-left';
  }

  function injectStyles() {
    var t = CONFIG.theme;
    var t2 = CONFIG.themeSecondary || t;
    var style = document.createElement('style');
    style.textContent = [
      '#topedge-widget-btn {',
      '  position:fixed; z-index:2147483647;',
      leftPos() ? 'left:20px;' : 'right:20px;',
      '  bottom:20px;',
      '  border:none; cursor:pointer;',
      '  display:flex; align-items:center; justify-content:center; gap:10px;',
      '  color:#fff; font-family:system-ui,-apple-system,sans-serif;',
      '  font-weight:700; font-size:14px;',
      '  background:linear-gradient(135deg,' + t + ',' + t2 + ');',
      '  box-shadow:0 12px 40px rgba(0,0,0,0.22);',
      '  transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .2s;',
      CONFIG.launcherStyle === 'pill'
        ? '  padding:0 20px 0 16px; min-height:52px; border-radius:999px;'
        : '  width:56px; height:56px; border-radius:50%; padding:0;',
      '}',
      '#topedge-widget-btn:hover { transform:translateY(-2px) scale(1.04); }',
      CONFIG.bubblePulse
        ? '@keyframes te-pulse{0%,100%{box-shadow:0 12px 40px rgba(0,0,0,.22)}50%{box-shadow:0 14px 48px ' +
          t +
          '55}} #topedge-widget-btn.te-pulse{animation:te-pulse 2.5s ease-in-out infinite}'
        : '',
      '#topedge-widget-btn svg { width:24px; height:24px; fill:currentColor; flex-shrink:0; }',
      '#topedge-widget-btn img { width:26px; height:26px; object-fit:contain; }',
      '#topedge-widget-tooltip {',
      '  position:fixed; z-index:2147483646;',
      leftPos() ? 'left:96px;' : 'right:96px;',
      '  bottom:28px; max-width:260px;',
      '  background:#0f172a; color:#f8fafc;',
      '  padding:12px 16px; border-radius:14px;',
      '  font:600 13px/1.4 system-ui,sans-serif;',
      '  box-shadow:0 8px 32px rgba(0,0,0,.28);',
      '  opacity:0; transform:translateY(8px); pointer-events:none;',
      '  transition:opacity .3s,transform .3s;',
      '}',
      '#topedge-widget-tooltip.visible { opacity:1; transform:translateY(0); }',
      '#topedge-widget-iframe-wrap {',
      '  position:fixed; z-index:2147483646;',
      leftPos() ? 'left:16px;' : 'right:16px;',
      '  bottom:88px; width:400px; max-width:calc(100vw - 24px); height:min(640px,82vh);',
      '  border-radius:20px; overflow:hidden;',
      '  box-shadow:0 28px 80px rgba(15,23,42,.35);',
      '  transform:scale(.94) translateY(16px); opacity:0; pointer-events:none;',
      '  transition:opacity .28s ease,transform .32s cubic-bezier(.16,1,.3,1);',
      '}',
      '#topedge-widget-iframe-wrap.open { opacity:1; transform:scale(1) translateY(0); pointer-events:all; }',
      '#topedge-widget-iframe-wrap iframe { width:100%; height:100%; border:none; display:block; }',
      '@media(max-width:480px){',
      '  #topedge-widget-iframe-wrap{ left:12px!important; right:12px!important; width:auto!important; bottom:80px; }',
      '  #topedge-widget-tooltip{ display:none; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function iconSvg() {
    if (CONFIG.launcherIcon === 'whatsapp') {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.296-.767.966-.94 1.164-.174.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.57-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
  }

  function renderLauncherInner() {
    var icon =
      CONFIG.customIconUrl && CONFIG.launcherIcon === 'custom'
        ? '<img src="' + CONFIG.customIconUrl + '" alt="" />'
        : iconSvg();
    var label =
      CONFIG.launcherStyle === 'pill'
        ? '<span>' + (CONFIG.launcherLabel || 'Chat with us') + '</span>'
        : '';
    return icon + label;
  }

  function buildIframeSrc() {
    return (
      CONFIG.apiBase +
      '/public/widgetIframe.html?clientId=' +
      encodeURIComponent(CONFIG.clientId)
    );
  }

  function mount() {
    injectStyles();
    btn = document.createElement('button');
    btn.id = 'topedge-widget-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open chat');
    if (CONFIG.bubblePulse) btn.className = 'te-pulse';
    btn.innerHTML = renderLauncherInner();

    tooltip = document.createElement('div');
    tooltip.id = 'topedge-widget-tooltip';
    tooltip.textContent = CONFIG.greeting || 'Hi! How can we help? 👋';

    iframeWrap = document.createElement('div');
    iframeWrap.id = 'topedge-widget-iframe-wrap';
    iframe = document.createElement('iframe');
    iframe.src = buildIframeSrc();
    iframe.title = 'Chat';
    iframe.allow = 'clipboard-write';
    iframe.setAttribute('loading', 'lazy');
    iframeWrap.appendChild(iframe);

    document.body.appendChild(btn);
    document.body.appendChild(tooltip);
    document.body.appendChild(iframeWrap);

    btn.addEventListener('click', function () {
      isOpen ? closeWidget() : openWidget();
    });
    document.addEventListener('click', function (e) {
      if (isOpen && !btn.contains(e.target) && !iframeWrap.contains(e.target)) closeWidget();
    });
    window.addEventListener('message', onMessage);

    if (CONFIG.delay > 0) {
      setTimeout(function () {
        if (!isOpen) {
          tooltip.classList.add('visible');
          setTimeout(function () {
            tooltip.classList.remove('visible');
          }, 4500);
        }
      }, CONFIG.delay * 1000);
    }
  }

  function openWidget() {
    isOpen = true;
    iframeWrap.classList.add('open');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    tooltip.classList.remove('visible');
    try {
      iframe.contentWindow.postMessage({ type: 'topedge_widget_opened' }, '*');
    } catch (e) {}
  }

  function closeWidget() {
    isOpen = false;
    iframeWrap.classList.remove('open');
    btn.innerHTML = renderLauncherInner();
  }

  function onMessage(e) {
    if (!e.data) return;
    if (e.data.type === 'topedge_close') closeWidget();
    if (e.data.type === 'topedge_wa_redirect') {
      var num = String(e.data.waNumber || CONFIG.waNumber || '').replace(/\D/g, '');
      if (!num) return;
      window.open('https://wa.me/' + num + '?text=' + encodeURIComponent(e.data.text || ''), '_blank');
      closeWidget();
    }
  }

  function applyRemoteConfig(data) {
    if (!data || !data.widget) return;
    var w = data.widget;
    var b = data.branding || {};
    CONFIG.theme = w.theme || CONFIG.theme;
    CONFIG.themeSecondary = w.themeSecondary || CONFIG.themeSecondary;
    CONFIG.mode = w.mode || CONFIG.mode;
    CONFIG.position = w.position || CONFIG.position;
    CONFIG.delay = typeof w.delaySeconds === 'number' ? w.delaySeconds : CONFIG.delay;
    CONFIG.greeting = w.greeting || b.greeting || CONFIG.greeting;
    CONFIG.launcherIcon = w.launcherIcon || CONFIG.launcherIcon;
    CONFIG.launcherStyle = w.launcherStyle || CONFIG.launcherStyle;
    CONFIG.launcherLabel = w.launcherLabel || CONFIG.launcherLabel;
    CONFIG.customIconUrl = w.customIconUrl || CONFIG.customIconUrl;
    CONFIG.bubblePulse = w.bubblePulse !== false;
    if (b.supportWhatsApp) CONFIG.waNumber = b.supportWhatsApp;
    if (tooltip) tooltip.textContent = CONFIG.greeting || 'Hi! How can we help? 👋';
    if (btn && !isOpen) btn.innerHTML = renderLauncherInner();
  }

  function fetchConfig() {
    if (!clientId || clientId === 'default') {
      mount();
      return;
    }
    fetch(CONFIG.apiBase + '/api/support-chat/widget-config/' + encodeURIComponent(clientId))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        applyRemoteConfig(data);
        if (data.widget && data.widget.enabled === false) return;
        mount();
      })
      .catch(function () {
        mount();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchConfig);
  } else {
    fetchConfig();
  }
})();
