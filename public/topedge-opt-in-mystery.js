/**
 * Mystery discount chunk — tap-to-reveal, weighted prize via subscribe.
 */
(function (window) {
  'use strict';
  window.TopEdgeOptIn = window.TopEdgeOptIn || {};

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var phoneApi = window.TopEdgeOptIn.phone || {};
  var isValidIndianPhone = phoneApi.isValidIndianPhone || function () { return false; };
  var postJson = phoneApi.postJson || function () { return Promise.resolve({}); };

  function completedStateColors(d, lose) {
    var cv = d.completedView || {};
    var sc = lose ? cv.lose || {} : cv.win || {};
    return {
      heading: sc.headingColor || d.headingColor || '#fff',
      sub: sc.subheadingColor || d.subheadingColor || 'rgba(255,255,255,.85)',
      couponBg: sc.couponBg || '#F5F3FF',
      couponText: sc.couponText || '#5B21B6',
    };
  }

  window.TopEdgeOptIn.mystery = {
    render: function render(ctx) {
      if (!ctx || !ctx.tool) return;
      var d = ctx.tool.design || {};
      var cv = d.completedView || {};
      var showPhoneFirst = d.collectInputsBeforeSpin === true;
      var bg = d.brandKit?.background || d.background || '#1A1A2E';
      var gold = d.brandKit?.primary || '#D4AF37';

      var host = document.createElement('div');
      host.style.cssText =
        'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif';
      host.innerHTML =
        '<div style="position:absolute;inset:0;background:rgba(15,23,42,.55)"></div>' +
        '<div style="position:relative;background:' +
        bg +
        ';color:#fff;border-radius:16px;padding:24px;max-width:360px;width:92%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.35)">' +
        '<button type="button" class="te-myst-close" style="position:absolute;top:10px;right:12px;border:none;background:transparent;color:#fff;font-size:20px;cursor:pointer">×</button>' +
        '<h2 style="margin:0 0 8px;font-size:20px">' +
        esc(d.headline || 'Tap to reveal') +
        '</h2>' +
        '<p style="margin:0 0 16px;font-size:13px;opacity:.9">' +
        esc(d.subheadline || '') +
        '</p>' +
        '<div class="te-myst-card" style="width:140px;height:180px;margin:0 auto 16px;border-radius:16px;background:linear-gradient(145deg,' +
        gold +
        ',#8B6914);display:flex;align-items:center;justify-content:center;font-size:42px;cursor:pointer;transition:transform .6s;transform-style:preserve-3d">🎁</div>' +
        '<div class="te-myst-form"></div>' +
        '<div class="te-myst-result" style="display:none"></div>' +
        '</div>';

      var formSlot = host.querySelector('.te-myst-form');
      var resultSlot = host.querySelector('.te-myst-result');
      var card = host.querySelector('.te-myst-card');
      var consentDefault = d.consentPreChecked === true;
      var state = { phone: '', name: '', email: '', dateOfBirth: '', consent: consentDefault, revealed: false };
      var autoSubmitOnPhone = d.autoSubmitOnPhone === true;

      function api(path) {
        return ctx.apiOrigin + '/api/public/opt-in' + path;
      }

      function showResult(res) {
        formSlot.style.display = 'none';
        resultSlot.style.display = 'block';
        var lose = res.prize && res.prize.isLose;
        var cc = completedStateColors(d, lose);
        resultSlot.innerHTML =
          '<h3 style="margin:0 0 8px;font-size:18px;color:' +
          cc.heading +
          '">' +
          esc(lose ? cv.failureHeading || 'So close!' : (cv.successHeading || 'You won!') + ' ' + ((res.prize && res.prize.label) || '')) +
          '</h3>' +
          (lose
            ? '<p style="font-size:13px;color:' + cc.sub + '">' + esc(cv.failureSubheading || '') + '</p>'
            : '<p style="font-size:13px;color:' +
              cc.sub +
              '">' +
              esc(cv.successSubheading || 'Your code:') +
              '</p><div style="font-size:22px;font-weight:700;margin:10px 0;background:' +
              cc.couponBg +
              ';color:' +
              cc.couponText +
              ';padding:8px 12px;border-radius:10px;display:inline-block">' +
              esc(res.couponCode || '') +
              '</div>');
      }

      function doRevealSubscribe(btn) {
        var payload = {
          embedKey: ctx.embedKey,
          toolId: ctx.tool.id,
          phone: state.phone,
          consent: true,
          pageUrl: window.location.href,
          visitorId: ctx.visitorId,
        };
        if (phoneApi.subscribeExtraFields) {
          var extra = phoneApi.subscribeExtraFields(state);
          Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
        }
        postJson(api('/subscribe'), payload)
          .then(function (res) {
            if (!res || !res.success) {
              if (btn) { btn.disabled = false; btn.textContent = (res && res.message) || 'Try again'; }
              return;
            }
            try { localStorage.setItem('te_optin_subscribed', '1'); } catch (e) {}
            card.style.transform = 'rotateY(180deg)';
            card.textContent = (res.prize && res.prize.isLose) ? '😔' : '🎉';
            showResult(res);
          })
          .catch(function () {
            if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
          });
      }

      function renderForm() {
        var showPhone = showPhoneFirst || state.revealed;
        var extraStyle =
          'width:100%;padding:10px;border-radius:10px;border:none;margin-bottom:8px;background:rgba(255,255,255,.12);color:#fff';
        var extraHtml = phoneApi.optionalFieldsHtml ? phoneApi.optionalFieldsHtml(d, extraStyle) : '';
        var btnHtml = autoSubmitOnPhone
          ? '<p style="text-align:center;font-size:11px;opacity:.75;padding:8px;border:1px dashed rgba(255,255,255,.3);border-radius:8px;margin:4px 0">✓ Complete all fields → auto-reveals</p>'
          : '<button type="button" class="te-myst-action" style="width:100%;padding:12px;border:none;border-radius:12px;background:#7C3AED;color:#fff;font-weight:600;cursor:pointer">' +
            esc(state.revealed ? d.buttonText || 'Claim prize' : d.buttonText || 'Reveal my prize') +
            '</button>';
        formSlot.innerHTML =
          (showPhone ? extraHtml : '') +
          '<div class="te-myst-phone" style="display:' +
          (showPhone ? 'flex' : 'none') +
          ';gap:8px;margin-bottom:10px">' +
          '<span style="padding:10px;border-radius:10px;background:rgba(255,255,255,.15)">' +
          esc(d.fallbackCountryCode || '+91') +
          '</span>' +
          '<input type="tel" class="te-myst-phone-input" placeholder="' +
          esc(d.phonePlaceholder || '10-digit mobile') +
          '" style="flex:1;padding:10px;border-radius:10px;border:none" /></div>' +
          '<label style="display:' +
          (showPhone ? 'flex' : 'none') +
          ';gap:8px;font-size:11px;margin-bottom:12px;text-align:left">' +
          '<input type="checkbox" class="te-myst-consent"' + (consentDefault ? ' checked' : '') + ' />' +
          esc(d.consentText || '') +
          '</label>' +
          (showPhone ? btnHtml : '');
        var phoneEl = formSlot.querySelector('.te-myst-phone-input');
        var consentEl = formSlot.querySelector('.te-myst-consent');
        var btn = formSlot.querySelector('.te-myst-action');
        if (consentEl) consentEl.addEventListener('change', function () { state.consent = consentEl.checked; });
        if (phoneEl) {
          phoneEl.addEventListener('input', function () { state.phone = phoneEl.value; });
          if (phoneApi.bindOptionalFields) phoneApi.bindOptionalFields(formSlot, state);
          if (autoSubmitOnPhone) {
            ctx.autoSubmitOnPhone = true;
            ctx.autoSubmitHandler = function () {
              if (ctx.preview) return;
              if (!showPhoneFirst && !state.revealed) {
                state.revealed = true;
                card.style.transform = 'rotateY(180deg)';
                card.textContent = '✨';
                renderForm();
                return;
              }
              doRevealSubscribe(null);
            };
          }
          if (phoneApi.setupDebouncedCapture) {
            phoneApi.setupDebouncedCapture({
              phoneEl: phoneEl,
              getConsent: function () { return state.consent; },
              getLeadState: function () { return state; },
              ctx: ctx,
            });
          }
        }
        if (btn) {
          btn.addEventListener('click', function () {
            if (ctx.preview) {
              card.style.transform = 'rotateY(180deg)';
              return;
            }
            if (!showPhoneFirst && !state.revealed) {
              state.revealed = true;
              card.style.transform = 'rotateY(180deg)';
              card.textContent = '✨';
              renderForm();
              return;
            }
            if (!state.consent) {
              btn.textContent = 'Accept consent';
              return;
            }
            if (phoneApi.canSubmitLead && !phoneApi.canSubmitLead(d, state)) {
              btn.textContent = 'Complete all fields';
              return;
            }
            if (!isValidIndianPhone(state.phone)) {
              btn.textContent = 'Enter valid mobile';
              return;
            }
            btn.disabled = true;
            doRevealSubscribe(btn);
          });
        }
      }

      card.addEventListener('click', function () {
        if (!showPhoneFirst && !state.revealed) {
          state.revealed = true;
          card.style.transform = 'rotateY(180deg)';
          card.textContent = '✨';
          renderForm();
        }
      });

      renderForm();
      host.querySelector('.te-myst-close').addEventListener('click', function () { host.remove(); });
      host.firstChild.addEventListener('click', function () { host.remove(); });
      document.body.appendChild(host);

      if (!ctx.preview && ctx.embedKey) {
        var impBody = phoneApi.impressionPayload ? phoneApi.impressionPayload(ctx) : { embedKey: ctx.embedKey, toolId: ctx.tool.id };
        postJson(api('/impression'), impBody).catch(function () {});
      }
    },
  };
})(window);
