/**
 * TopEdge AI — Website Chat Widget Embed Script
 * Version: 2.0 (Phase 21)
 *
 * Usage: Add this script to any website's <body>:
 *   <script src="https://your-api-domain.com/widget.js"
 *           data-client-id="YOUR_CLIENT_ID"
 *           data-wa-number="919XXXXXXXXX"
 *           data-greeting="Hi! How can we help you today? 👋"
 *           data-theme="#6366f1"
 *           data-mode="whatsapp">  <!-- "whatsapp" | "form" -->
 *   </script>
 */
(function () {
  'use strict';

  // ── 1. CONFIG EXTRACTION ───────────────────────────────────────────────────
  var script = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var CONFIG = {
    clientId:   script.getAttribute('data-client-id') || 'default',
    waNumber:   script.getAttribute('data-wa-number')  || '',
    greeting:   script.getAttribute('data-greeting')   || 'Hi! How can we help? 👋',
    theme:      script.getAttribute('data-theme')      || '#6366f1',
    mode:       script.getAttribute('data-mode')       || 'whatsapp',   // 'whatsapp' | 'form'
    position:   script.getAttribute('data-position')   || 'bottom-right',
    delay:      parseInt(script.getAttribute('data-delay') || '0', 10),
    apiBase:    script.src.replace('/widget.js', ''),
  };

  // ── 2. STYLE INJECTION ─────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#topedge-widget-btn {',
    '  position: fixed;',
    CONFIG.position === 'bottom-left' ? 'left: 24px;' : 'right: 24px;',
    '  bottom: 24px;',
    '  z-index: 2147483647;',
    '  width: 60px; height: 60px;',
    '  border-radius: 50%;',
    '  background: ' + CONFIG.theme + ';',
    '  box-shadow: 0 8px 32px rgba(0,0,0,0.28);',
    '  border: none; cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: transform 0.3s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s;',
    '  animation: topedge-pulse 2.4s infinite;',
    '}',
    '#topedge-widget-btn:hover { transform: scale(1.12) rotate(-4deg); box-shadow: 0 12px 40px rgba(0,0,0,0.34); }',
    '#topedge-widget-btn svg { width:32px; height:32px; fill:#fff; }',
    '#topedge-widget-badge {',
    '  position: absolute; top:-4px; right:-4px;',
    '  width:18px; height:18px;',
    '  background: #ef4444; color:#fff;',
    '  border-radius:50%; font-size:10px; font-weight:800;',
    '  display:flex; align-items:center; justify-content:center;',
    '  font-family: system-ui, sans-serif;',
    '}',
    '#topedge-widget-tooltip {',
    '  position:fixed; z-index:2147483646;',
    CONFIG.position === 'bottom-left' ? 'left:92px;' : 'right:92px;',
    '  bottom:30px;',
    '  background:#1e293b; color:#fff;',
    '  padding:10px 16px; border-radius:12px;',
    '  font-size:13px; font-weight:600;',
    '  font-family: system-ui, sans-serif;',
    '  white-space:nowrap; max-width:240px;',
    '  box-shadow:0 4px 24px rgba(0,0,0,0.24);',
    '  opacity:0; transform:translateX(' + (CONFIG.position === 'bottom-left' ? '-8px' : '8px') + ');',
    '  transition: opacity 0.3s, transform 0.3s;',
    '  pointer-events:none;',
    '}',
    '#topedge-widget-tooltip::after {',
    '  content:""; position:absolute; top:50%;',
    CONFIG.position === 'bottom-left' ? 'left:-8px; border-right-color:#1e293b;' : 'right:-8px; border-left-color:#1e293b;',
    '  transform:translateY(-50%);',
    '  border:4px solid transparent;',
    '}',
    '#topedge-widget-tooltip.visible { opacity:1; transform:translateX(0); }',
    '#topedge-widget-iframe-wrap {',
    '  position:fixed; z-index:2147483646;',
    CONFIG.position === 'bottom-left' ? 'left:24px;' : 'right:24px;',
    '  bottom:96px;',
    '  width:380px; height:580px;',
    '  border-radius:20px;',
    '  box-shadow:0 24px 80px rgba(0,0,0,0.32);',
    '  overflow:hidden;',
    '  transform:scale(0.92) translateY(20px);',
    '  opacity:0; pointer-events:none;',
    '  transition: opacity 0.3s cubic-bezier(0.16,1,0.3,1), transform 0.35s cubic-bezier(0.16,1,0.3,1);',
    '}',
    '#topedge-widget-iframe-wrap.open { opacity:1; transform:scale(1) translateY(0); pointer-events:all; }',
    '#topedge-widget-iframe-wrap iframe { width:100%; height:100%; border:none; }',
    '@keyframes topedge-pulse {',
    '  0%,100% { box-shadow: 0 8px 32px rgba(0,0,0,0.28), 0 0 0 0 ' + CONFIG.theme + '55; }',
    '  50% { box-shadow: 0 8px 32px rgba(0,0,0,0.28), 0 0 0 10px ' + CONFIG.theme + '00; }',
    '}',
    '@media (max-width: 480px) {',
    '  #topedge-widget-iframe-wrap { width: calc(100vw - 24px); height: 82vh; left:12px; right:12px; bottom:88px; }',
    '  #topedge-widget-tooltip { display:none; }',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  // ── 3. DOM CONSTRUCTION ────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.id = 'topedge-widget-btn';
  btn.setAttribute('aria-label', 'Open Chat');
  btn.innerHTML = [
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">',
    CONFIG.mode === 'whatsapp'
      // WhatsApp icon
      ? '<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.296-.767.966-.94 1.164-.174.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.57-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>'
      // Chat icon
      : '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>',
    '</svg>',
    '<span id="topedge-widget-badge" style="display:none">1</span>'
  ].join('');

  var tooltip = document.createElement('div');
  tooltip.id = 'topedge-widget-tooltip';
  tooltip.textContent = CONFIG.greeting;

  var iframeWrap = document.createElement('div');
  iframeWrap.id = 'topedge-widget-iframe-wrap';

  var iframe = document.createElement('iframe');
  iframe.src = CONFIG.apiBase + '/widgetIframe.html'
    + '?clientId=' + encodeURIComponent(CONFIG.clientId)
    + '&waNumber=' + encodeURIComponent(CONFIG.waNumber)
    + '&greeting=' + encodeURIComponent(CONFIG.greeting)
    + '&theme=' + encodeURIComponent(CONFIG.theme)
    + '&mode=' + encodeURIComponent(CONFIG.mode);
  iframe.allow = 'clipboard-write';
  iframe.setAttribute('loading', 'lazy');

  iframeWrap.appendChild(iframe);
  document.body.appendChild(btn);
  document.body.appendChild(tooltip);
  document.body.appendChild(iframeWrap);

  // ── 4. BEHAVIOR ────────────────────────────────────────────────────────────
  var isOpen = false;

  function openWidget() {
    isOpen = true;
    iframeWrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    btn.style.animation = 'none';
    // Change icon to X
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    document.getElementById('topedge-widget-badge').style.display = 'none';
    tooltip.classList.remove('visible');
    // Track open
    try { iframe.contentWindow.postMessage({ type: 'widget_opened' }, '*'); } catch(e) {}
  }

  function closeWidget() {
    isOpen = false;
    iframeWrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    btn.style.animation = '';
    btn.innerHTML = [
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">',
      CONFIG.mode === 'whatsapp'
        ? '<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.296-.767.966-.94 1.164-.174.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.57-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>'
        : '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>',
      '</svg>',
      '<span id="topedge-widget-badge" style="display:none">1</span>'
    ].join('');
  }

  btn.addEventListener('click', function () {
    isOpen ? closeWidget() : openWidget();
  });

  // Close on outside click
  document.addEventListener('click', function (e) {
    if (isOpen && !btn.contains(e.target) && !iframeWrap.contains(e.target)) {
      closeWidget();
    }
  });

  // Listen for iframe messages (e.g. close, wa redirect)
  window.addEventListener('message', function (e) {
    if (!e.data) return;
    if (e.data.type === 'topedge_close') closeWidget();
    if (e.data.type === 'topedge_wa_redirect') {
      var url = 'https://wa.me/' + CONFIG.waNumber + '?text=' + encodeURIComponent(e.data.text || '');
      window.open(url, '_blank');
      closeWidget();
    }
  });

  // ── 5. AUTO-OPEN AFTER DELAY ───────────────────────────────────────────────
  if (CONFIG.delay > 0) {
    setTimeout(function () {
      tooltip.classList.add('visible');
      setTimeout(function () { tooltip.classList.remove('visible'); }, 4000);
    }, CONFIG.delay * 1000);
  } else {
    setTimeout(function () {
      tooltip.classList.add('visible');
      setTimeout(function () { tooltip.classList.remove('visible'); }, 4000);
    }, 3000);
  }

})();
