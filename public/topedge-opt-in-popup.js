/**
 * Popup chunk — phone capture, consent, subscribe, thank-you screen.
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
  var isValidPhoneForCountry = phoneApi.isValidPhoneForCountry || phoneApi.isValidIndianPhone || function () { return false; };
  var postJson = phoneApi.postJson || function () { return Promise.resolve({}); };

  function resolvePopupSuccessColors(d, thankYou) {
    thankYou = thankYou || {};
    var sc = thankYou.successColors || d.successColors || {};
    var colors = d.colors || {};
    var kit = d.brandKit || {};
    var btnBg = colors.buttonBackground || kit.primary || '#7C3AED';
    return {
      headingColor: sc.headingColor || d.headingColor || kit.text || '#0f172a',
      subColor: sc.subheadingColor || d.subheadingColor || '#64748b',
      btnBg: sc.buttonColor || btnBg,
      btnText: sc.buttonTextColor || colors.buttonText || '#ffffff',
    };
  }

  function injectStyles(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    document.head.appendChild(s);
  }

  window.TopEdgeOptIn.popup = {
    render: function render(ctx) {
      if (!ctx || !ctx.tool) return;
      var d = ctx.tool.design || {};
      var kit = d.brandKit || {};
      var btnBg = (d.colors && d.colors.buttonBackground) || kit.primary || '#7C3AED';
      var panelBg = (d.colors && d.colors.panelBackground) || '#FFFFFF';
      var font = kit.font || 'Inter, system-ui, sans-serif';

      injectStyles('te-optin-popup-css', [
        '.te-optin-root{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;font-family:' + font + '}',
        '.te-optin-overlay{position:absolute;inset:0;background:rgba(15,23,42,.45)}',
        '.te-optin-panel{position:relative;background:' + panelBg + ';border-radius:16px;padding:24px;max-width:380px;width:92%;box-shadow:0 20px 50px rgba(124,58,237,.18)}',
        '.te-optin-h{font-size:20px;font-weight:600;color:#0f172a;margin:0 0 8px}',
        '.te-optin-sub{font-size:14px;color:#64748b;margin:0 0 16px}',
        '.te-optin-phone-wrap{display:flex;gap:8px;margin-bottom:12px}',
        '.te-optin-cc{padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;font-size:14px}',
        '.te-optin-phone{flex:1;padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;font-size:14px}',
        '.te-optin-consent{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#64748b;margin-bottom:16px}',
        '.te-optin-btn{width:100%;padding:12px;border:none;border-radius:12px;background:' + btnBg + ';color:#fff;font-weight:600;font-size:14px;cursor:pointer}',
        '.te-optin-btn:disabled{opacity:.55;cursor:not-allowed}',
        '.te-optin-code{font-size:22px;font-weight:700;letter-spacing:.05em;color:#0f172a;margin:12px 0}',
        '.te-optin-copy{font-size:12px;color:#7c3aed;cursor:pointer;border:none;background:none}',
        '.te-optin-products{display:grid;gap:8px;margin-top:12px}',
        '.te-optin-prod{display:flex;gap:10px;align-items:center;text-decoration:none;color:inherit;border:1px solid #e2e8f0;border-radius:12px;padding:8px}',
        '.te-optin-prod img{width:48px;height:48px;object-fit:cover;border-radius:8px}',
      ].join(''));

      var host = document.createElement('div');
      host.className = 'te-optin-root';
      host.setAttribute('data-topedge-optin', ctx.tool.id);

      var consentDefault = d.consentPreChecked === true;
      var state = { consent: consentDefault, phone: '', countryCode: '', name: '', email: '', dateOfBirth: '', step: 'form', coupon: '' };
      var autoSubmitOnPhone = d.autoSubmitOnPhone === true;

      function api(path) {
        return ctx.apiOrigin + '/api/public/opt-in' + path;
      }

      function renderForm() {
        var ctaHtml = autoSubmitOnPhone
          ? '<p style="text-align:center;font-size:11px;opacity:.75;padding:8px;border:1px dashed rgba(0,0,0,.18);border-radius:8px;margin:4px 0;color:#64748b">✓ Complete all fields → auto-submits</p>'
          : '<button type="button" class="te-optin-btn te-optin-submit">' + esc(d.buttonText || 'Get my code') + '</button>';
        var extraHtml = phoneApi.optionalFieldsHtml ? phoneApi.optionalFieldsHtml(d) : '';
        return (
          '<div class="te-optin-overlay"></div>' +
          '<div class="te-optin-panel">' +
          (d.showImage && d.imageUrl ? '<img src="' + esc(d.imageUrl) + '" alt="" style="width:100%;border-radius:12px;margin-bottom:12px" />' : '') +
          '<h2 class="te-optin-h">' + esc(d.headline || 'Welcome') + '</h2>' +
          '<p class="te-optin-sub">' + esc(d.subheadline || '') + '</p>' +
          (d.offerText ? '<p class="te-optin-sub">' + esc(d.offerText) + '</p>' : '') +
          extraHtml +
          (phoneApi.buildPhoneFieldHtml
            ? phoneApi.buildPhoneFieldHtml(d, { classPrefix: 'te-optin' })
            : '<div class="te-optin-phone-wrap"><span class="te-optin-cc">' +
              esc(d.countryCode || '+91') +
              '</span><input class="te-optin-phone" type="tel" placeholder="' +
              esc(d.phonePlaceholder || '10-digit mobile') +
              '" /></div>') +
          '<label class="te-optin-consent"><input type="checkbox" class="te-optin-consent-cb"' + (consentDefault ? ' checked' : '') + ' /> <span>' + esc(d.consentText || 'I agree to receive WhatsApp messages.') + '</span></label>' +
          ctaHtml +
          '</div>'
        );
      }

      function renderThanks(coupon, waSent) {
        var thankYou = ctx.tool.thankYouConfig || {};
        var success = resolvePopupSuccessColors(d, thankYou);
        var shopUrl = thankYou.shopNowUrl || '';
        return (
          '<div class="te-optin-overlay"></div>' +
          '<div class="te-optin-panel">' +
          '<div style="font-size:28px;margin-bottom:8px;color:' + success.headingColor + '">✓</div>' +
          '<h2 class="te-optin-h" style="color:' + success.headingColor + '">You\'re in!</h2>' +
          (coupon
            ? '<div class="te-optin-code" style="color:' + success.headingColor + '">' + esc(coupon) + '</div><button type="button" class="te-optin-copy" style="color:' + success.btnBg + '">Copy code</button>'
            : '') +
          (waSent ? '<p class="te-optin-sub" style="color:' + success.subColor + '">Sent to your WhatsApp</p>' : '') +
          '<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0" />' +
          '<p class="te-optin-sub" style="font-weight:600;color:' + success.headingColor + '">Shop our bestsellers</p>' +
          '<div class="te-optin-products te-optin-products-slot"></div>' +
          (shopUrl
            ? '<a href="' +
              esc(shopUrl) +
              '" class="te-optin-btn" style="display:block;text-align:center;text-decoration:none;margin-top:12px;background:' +
              success.btnBg +
              ';color:' +
              success.btnText +
              '">Shop now</a>'
            : '') +
          '</div>'
        );
      }

      function doSubscribe(btn) {
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
            state.coupon = res.couponCode || '';
            state.step = 'thanks';
            try { localStorage.setItem('te_optin_subscribed', '1'); } catch (e) {}
            host.innerHTML = renderThanks(state.coupon, res.whatsAppDelivery && res.whatsAppDelivery.sent);
            bindThanks();
          })
          .catch(function () {
            if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
          });
      }

      function bindForm() {
        var phoneEl = host.querySelector('.te-optin-phone-input') || host.querySelector('.te-optin-phone');
        var consentEl = host.querySelector('.te-optin-consent-cb');
        var btn = host.querySelector('.te-optin-submit');
        if (!phoneEl || !consentEl) return;
        if (phoneApi.bindPhoneField) phoneApi.bindPhoneField(host, state, d);

        consentEl.addEventListener('change', function () {
          state.consent = consentEl.checked;
        });
        if (!phoneApi.bindPhoneField) {
          phoneEl.addEventListener('input', function () {
            state.phone = phoneEl.value;
          });
        }
        if (phoneApi.bindOptionalFields) phoneApi.bindOptionalFields(host, state);
        if (autoSubmitOnPhone) {
          ctx.autoSubmitOnPhone = true;
          ctx.autoSubmitHandler = function () {
            if (ctx.preview || state.step !== 'form') return;
            state.step = 'submitting';
            doSubscribe(null);
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
        if (btn) {
          btn.addEventListener('click', function () {
            if (ctx.preview) return;
            if (!state.consent) {
              btn.textContent = 'Please accept consent';
              return;
            }
            if (phoneApi.canSubmitLead && !phoneApi.canSubmitLead(d, state)) {
              btn.textContent = 'Complete all fields';
              return;
            }
            if (!isValidPhoneForCountry(state.phone, state.countryCode || '+91')) {
              btn.textContent = 'Enter valid 10-digit mobile';
              return;
            }
            btn.disabled = true;
            btn.textContent = 'Submitting…';
            doSubscribe(btn);
          });
        }
      }

      function bindThanks() {
        var copyBtn = host.querySelector('.te-optin-copy');
        if (copyBtn && state.coupon) {
          copyBtn.addEventListener('click', function () {
            try {
              navigator.clipboard.writeText(state.coupon);
              copyBtn.textContent = 'Copied!';
            } catch (e) {}
          });
        }
        if (ctx.tool.thankYouConfig && ctx.tool.thankYouConfig.showBestsellers === false) return;
        fetch(api('/bestsellers?key=') + encodeURIComponent(ctx.embedKey))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var slot = host.querySelector('.te-optin-products-slot');
            if (!slot || !data.products || !data.products.length) return;
            slot.innerHTML = data.products
              .map(function (p) {
                return (
                  '<a class="te-optin-prod" href="' + esc(p.url || '#') + '" target="_blank" rel="noopener">' +
                  (p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" alt="" />' : '') +
                  '<span><strong>' + esc(p.title) + '</strong><br><span style="font-size:12px;color:#64748b">' + esc(p.price) + '</span></span></a>'
                );
              })
              .join('');
          })
          .catch(function () {});
      }

      host.innerHTML = renderForm();
      bindForm();
      host.querySelector('.te-optin-overlay').addEventListener('click', function () {
        host.remove();
      });

      document.body.appendChild(host);

      if (!ctx.preview && ctx.embedKey && ctx.tool.id) {
        var impBody = phoneApi.impressionPayload ? phoneApi.impressionPayload(ctx) : { embedKey: ctx.embedKey, toolId: ctx.tool.id };
        postJson(api('/impression'), impBody).catch(function () {});
      }
    },
  };
})(window);
