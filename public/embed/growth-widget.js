/* global window, document, localStorage */
(function () {
  var script = document.currentScript;
  if (!script || script.getAttribute('data-te-growth') === '1') return;
  script.setAttribute('data-te-growth', '1');

  var cfg = window.TopEdgeGrowth || {};
  var embedKey = String(cfg.clientId || script.getAttribute('data-embed-key') || '').trim();
  if (!embedKey) return;

  function origin() {
    try {
      return new URL(script.src).origin;
    } catch (_) {
      return window.location.origin;
    }
  }
  var apiOrigin = origin();
  var subscribeUrl = apiOrigin + '/api/public/growth/subscribe';
  var configUrl = apiOrigin + '/api/public/growth/config?key=' + encodeURIComponent(embedKey);

  function postSubscribe(payload) {
    return fetch(subscribeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }

  function commonForm(widgetType, consentText, primaryColor, onDone) {
    var wrap = document.createElement('div');
    wrap.innerHTML =
      '<input class="te-name" placeholder="Name (optional)" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:6px 0;" />' +
      '<input class="te-phone" placeholder="WhatsApp number" style="width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:10px;margin:6px 0;" />' +
      '<label style="display:flex;gap:8px;font-size:12px;color:#475569;margin-top:8px;line-height:1.4;"><input type="checkbox" class="te-consent" />' + consentText + '</label>' +
      '<button class="te-submit" style="width:100%;margin-top:10px;padding:10px 12px;border:none;border-radius:10px;color:#fff;background:' + primaryColor + ';font-weight:600;cursor:pointer;">Subscribe</button>' +
      '<div class="te-msg" style="margin-top:8px;font-size:12px;"></div>';
    var btn = wrap.querySelector('.te-submit');
    btn.addEventListener('click', function () {
      var phone = wrap.querySelector('.te-phone').value;
      var consent = !!wrap.querySelector('.te-consent').checked;
      var name = wrap.querySelector('.te-name').value;
      var msg = wrap.querySelector('.te-msg');
      if (!consent) {
        msg.style.color = '#b91c1c';
        msg.textContent = 'Please provide consent to continue.';
        return;
      }
      postSubscribe({
        embedKey: embedKey,
        phone: phone,
        consent: consent,
        name: name,
        widgetType: widgetType,
        pageUrl: window.location.href,
      }).then(function (res) {
        if (res.ok && res.j && res.j.success) {
          msg.style.color = '#15803d';
          msg.textContent = res.j.message || 'Subscribed successfully.';
          if (onDone) onDone(res.j);
        } else {
          msg.style.color = '#b91c1c';
          msg.textContent = (res.j && res.j.message) || 'Failed to subscribe.';
        }
      }).catch(function () {
        msg.style.color = '#b91c1c';
        msg.textContent = 'Network error.';
      });
    });
    return wrap;
  }

  function renderFloating(settings, consentText, brandColor) {
    var color = (settings && settings.color) || brandColor || '#25D366';
    var pos = (settings && settings.position) === 'left' ? 'left:20px;' : 'right:20px;';
    var label = (settings && settings.label) || 'WhatsApp';
    var delay = Math.max(0, Number((settings && settings.delaySeconds) || 3)) * 1000;

    var btn = document.createElement('button');
    btn.style.cssText = 'position:fixed;z-index:99999;bottom:20px;' + pos + 'border:none;border-radius:999px;padding:12px 16px;background:' + color + ';color:#fff;font:600 14px system-ui;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.2);';
    btn.textContent = label;

    var pane = document.createElement('div');
    pane.style.cssText = 'display:none;position:fixed;z-index:99999;bottom:72px;' + pos + 'width:320px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:12px;box-shadow:0 18px 40px rgba(0,0,0,.2);';
    pane.appendChild(commonForm('floating_button', consentText, color, function () { setTimeout(function () { pane.style.display = 'none'; }, 1000); }));

    btn.addEventListener('click', function () { pane.style.display = pane.style.display === 'none' ? 'block' : 'none'; });
    setTimeout(function () { document.body.appendChild(btn); document.body.appendChild(pane); }, delay);
  }

  function renderExitPopup(settings, consentText, brandColor, brandName) {
    var cooldownDays = Math.max(1, Number((settings && settings.cooldownDays) || 3));
    var key = 'te_exit_popup_last';
    var last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < cooldownDays * 86400000) return;
    var shown = false;
    function show() {
      if (shown) return;
      shown = true;
      localStorage.setItem(key, String(Date.now()));
      var back = document.createElement('div');
      back.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
      var card = document.createElement('div');
      card.style.cssText = 'max-width:420px;width:100%;background:#fff;border-radius:16px;padding:18px;';
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:start;gap:8px;"><h3 style="margin:0;font:700 18px system-ui;">' + (((settings && settings.headline) || 'Wait! Get updates on WhatsApp')) + '</h3><button class="te-close" style="border:none;background:transparent;font-size:22px;cursor:pointer;">×</button></div><p style="color:#64748b;font:500 13px system-ui;margin:8px 0 12px;">' + (((settings && settings.offerText) || ('Stay updated with ' + (brandName || 'our brand')))) + '</p>';
      card.appendChild(commonForm('exit_popup', consentText, brandColor, function () { setTimeout(function () { back.remove(); }, 1000); }));
      back.appendChild(card);
      back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
      card.querySelector('.te-close').addEventListener('click', function () { back.remove(); });
      document.body.appendChild(back);
    }
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget && e.clientY <= 4) show();
    }, { once: true });
  }

  function renderInline(settings, consentText, brandColor) {
    var root = document.getElementById('topedge-form');
    if (!root) return;
    var card = document.createElement('div');
    card.style.cssText = 'padding:14px;border:1px solid #e2e8f0;border-radius:14px;background:#fff;max-width:420px;';
    var heading = (settings && settings.heading) || 'Join our WhatsApp community';
    card.innerHTML = '<h3 style="margin:0 0 8px;font:700 16px system-ui;">' + heading + '</h3>';
    card.appendChild(commonForm('inline_form', consentText, brandColor, null));
    root.innerHTML = '';
    root.appendChild(card);
  }

  function renderStickyBar(settings, consentText, brandColor) {
    var pos = (settings && settings.position) === 'top' ? 'top:0;' : 'bottom:0;';
    var text = (settings && settings.text) || 'Get your updates on WhatsApp';
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;' + pos + 'z-index:99997;background:#111827;color:#fff;padding:8px 10px;display:flex;gap:8px;align-items:center;';
    bar.innerHTML = '<span style="font:600 12px system-ui;white-space:nowrap;">' + text + '</span>' +
      '<input class="te-phone" placeholder="Phone" style="flex:1;min-width:80px;padding:8px;border:none;border-radius:8px;" />' +
      '<button class="te-consent-btn" style="padding:8px 10px;border:none;border-radius:8px;background:' + brandColor + ';color:#fff;font:700 12px system-ui;cursor:pointer;">Subscribe</button>' +
      '<button class="te-close" style="border:none;background:transparent;color:#cbd5e1;cursor:pointer;">×</button>';
    bar.querySelector('.te-close').onclick = function () { bar.remove(); };
    bar.querySelector('.te-consent-btn').onclick = function () {
      var phone = bar.querySelector('.te-phone').value;
      if (!window.confirm(consentText.replace(/<[^>]*>/g, ''))) return;
      postSubscribe({ embedKey: embedKey, phone: phone, consent: true, widgetType: 'sticky_bar', pageUrl: window.location.href })
        .then(function () { bar.remove(); });
    };
    document.body.appendChild(bar);
  }

  function renderSpinWheel(settings, consentText) {
    var triggerDelay = Math.max(1, Number((settings && settings.triggerDelay) || 8)) * 1000;
    var prizes = (settings && settings.prizes && settings.prizes.length) ? settings.prizes : [{ label: 'Flat 10% Off', code: 'WELCOME10', probability: 100 }];
    var primary = (settings && settings.primaryColor) || '#6D28D9';
    var secondary = (settings && settings.secondaryColor) || '#F59E0B';
    setTimeout(function () {
      var back = document.createElement('div');
      back.style.cssText = 'position:fixed;inset:0;z-index:99996;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
      var card = document.createElement('div');
      card.style.cssText = 'max-width:460px;width:100%;background:#fff;border-radius:16px;padding:16px;';
      card.innerHTML = '<h3 style="margin:0 0 10px;font:700 18px system-ui;">Spin to win!</h3>';
      var wheel = document.createElement('div');
      wheel.style.cssText = 'height:160px;border-radius:999px;background:linear-gradient(90deg,' + primary + ',' + secondary + ');display:flex;align-items:center;justify-content:center;color:#fff;font:700 16px system-ui;';
      wheel.textContent = 'Tap SPIN after consent';
      card.appendChild(wheel);
      var form = commonForm('spin_wheel', consentText, primary, null);
      var spinBtn = document.createElement('button');
      spinBtn.textContent = 'SPIN';
      spinBtn.style.cssText = 'width:100%;margin-top:8px;padding:10px;border:none;border-radius:10px;background:' + secondary + ';color:#111827;font:700 13px system-ui;cursor:pointer;';
      spinBtn.onclick = function () {
        if (!form.querySelector('.te-consent').checked) {
          form.querySelector('.te-msg').style.color = '#b91c1c';
          form.querySelector('.te-msg').textContent = 'Consent is required before spinning.';
          return;
        }
        var idx = Math.floor(Math.random() * prizes.length);
        var prize = prizes[idx];
        var code = String(prize.code || ('SPIN' + Math.floor(1000 + Math.random() * 9000)));
        wheel.textContent = 'You won: ' + prize.label + ' (' + code + ')';
        postSubscribe({
          embedKey: embedKey,
          phone: form.querySelector('.te-phone').value,
          consent: true,
          name: form.querySelector('.te-name').value,
          widgetType: 'spin_wheel',
          prize: prize.label,
          prizeCode: code,
          pageUrl: window.location.href,
        }).then(function () {
          form.querySelector('.te-msg').style.color = '#15803d';
          form.querySelector('.te-msg').textContent = 'Check WhatsApp for your reward details.';
        });
      };
      card.appendChild(form);
      card.appendChild(spinBtn);
      back.appendChild(card);
      back.addEventListener('click', function (e) { if (e.target === back) back.remove(); });
      document.body.appendChild(back);
    }, triggerDelay);
  }

  fetch(configUrl)
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (!res || !res.success) return;
      var widgets = res.widgetTypes || ['floating_button'];
      var settings = res.settings || {};
      var brandColor = (res.branding && res.branding.color) || '#25D366';
      var brandName = (res.branding && res.branding.name) || 'our brand';
      var consentText = settings.consentText || ('I agree to receive WhatsApp messages from ' + brandName + '.');

      if (widgets.indexOf('floating_button') >= 0) renderFloating(settings.floatingButton || {}, consentText, brandColor);
      if (widgets.indexOf('exit_popup') >= 0) renderExitPopup(settings.exitPopup || {}, consentText, brandColor, brandName);
      if (widgets.indexOf('inline_form') >= 0) renderInline(settings.inlineForm || {}, consentText, brandColor);
      if (widgets.indexOf('sticky_bar') >= 0) renderStickyBar(settings.stickyBar || {}, consentText, brandColor);
      if (widgets.indexOf('spin_wheel') >= 0) renderSpinWheel(settings.spinWheel || {}, consentText);
      widgets.forEach(function (w) {
        fetch(apiOrigin + '/api/public/growth/impression', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embedKey: embedKey, widgetType: w }),
        }).catch(function () {});
      });
      if (widgets.indexOf('thank_you_page') >= 0) {
        if (/thank_you|order-confirmed|checkout\/thank_you/i.test(window.location.pathname || '')) {
          renderFloating({ position: 'right', label: 'Enable WhatsApp updates', delaySeconds: 2, color: brandColor }, consentText, brandColor);
        }
      }
    })
    .catch(function () {});
})();
