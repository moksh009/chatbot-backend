/**
 * WhatsApp chat widget chunk — BiteSpeed-style bubble, capture then wa.me.
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

  function isMobile() {
    return window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  }

  function resolveWaSuccessColors(d) {
    var sc = d.successColors || (d.completedView && d.completedView.win) || {};
    return {
      messageColor: sc.headingColor || d.chatHeadingColor || '#0F172A',
      iconBg: sc.buttonColor || d.widgetColor || '#7C3AED',
      iconText: sc.buttonTextColor || d.widgetIconColor || '#FFFFFF',
    };
  }

  window.TopEdgeOptIn.widget = {
    render: function render(ctx) {
      if (!ctx || !ctx.tool) return;

      var d = ctx.tool.design || {};
      var pos = (isMobile() && d.mobilePosition) ? d.mobilePosition : (d.position || { side: 'right', offsetX: 24, offsetY: 24 });
      var side = pos.side === 'left' ? 'left' : 'right';
      var merchantWa = ctx.tool.merchantWaPhone || d.phoneNumber || '';
      var waDigits = String(merchantWa).replace(/\D/g, '');

      var host = document.createElement('div');
      host.setAttribute('data-topedge-wa-widget', ctx.tool.id);
      host.style.cssText = 'position:fixed;z-index:2147482999;font-family:Inter,system-ui,sans-serif;' + side + ':' + (pos.offsetX || 24) + 'px;bottom:' + (pos.offsetY || 24) + 'px;';

      var expanded = false;
      var sent = false;
      var consentDefault = d.consentPreChecked === true;
      var state = { phone: '', countryCode: '', name: '', email: '', dateOfBirth: '', consent: consentDefault };
      var autoSubmitOnPhone = d.autoSubmitOnPhone === true;
      var widgetColor = d.widgetColor || '#7C3AED';
      var iconColor = d.widgetIconColor || '#FFFFFF';
      var gradL = (d.headerGradient && d.headerGradient.left) || widgetColor;
      var gradR = (d.headerGradient && d.headerGradient.right) || '#5B21B6';

      function launcherHtml() {
        var text = d.widgetStyle === 'icon_only' ? '' : esc(d.widgetText || 'Chat with us');
        return (
          '<button type="button" class="te-wa-launcher" style="display:flex;align-items:center;gap:8px;padding:' +
          (text ? '12px 16px' : '14px') +
          ';border:none;border-radius:999px;background:' +
          widgetColor +
          ';color:' +
          iconColor +
          ';font-weight:600;font-size:14px;cursor:pointer;box-shadow:0 8px 24px rgba(124,58,237,.35)">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.789 23.492a.5.5 0 0 0 .611.611l4.458-1.495A11.95 11.95 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-2.387 0-4.592-.83-6.348-2.218l-.448-.335-2.614.875.875-2.614-.335-.448A9.96 9.96 0 0 1 2 12C2 6.486 6.486 2 12 2s10 4.486 10 10-4.486 10-10 10z"/></svg>' +
          text +
          '</button>'
        );
      }

      function sentPanelHtml() {
        var success = resolveWaSuccessColors(d);
        return (
          '<div class="te-wa-panel" style="width:320px;max-width:92vw;margin-bottom:12px;border-radius:16px;overflow:hidden;box-shadow:0 16px 40px rgba(15,23,42,.18);background:#fff">' +
          '<div style="padding:16px;background:linear-gradient(135deg,' +
          gradL +
          ',' +
          gradR +
          ');color:#fff">' +
          '<div style="font-size:16px;font-weight:600">' +
          esc(d.chatHeading || 'Hi there 👋') +
          '</div>' +
          '<div style="font-size:13px;opacity:.95;margin-top:4px">' +
          esc(d.chatSubheading || '') +
          '</div></div>' +
          '<div style="padding:20px 16px;background:' +
          (d.bottomHalfColor || '#fff') +
          ';text-align:center">' +
          '<div style="width:48px;height:48px;border-radius:50%;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;background:' +
          success.iconBg +
          ';color:' +
          success.iconText +
          '">✓</div>' +
          '<p style="font-size:14px;margin:0;line-height:1.45;color:' +
          success.messageColor +
          '">' +
          esc(d.successMessage || 'Opening WhatsApp chat…') +
          '</p></div></div>'
        );
      }

      function panelHtml() {
        if (sent) return sentPanelHtml();
        var extraHtml = phoneApi.optionalFieldsHtml ? phoneApi.optionalFieldsHtml(d) : '';
        var btnHtml = autoSubmitOnPhone
          ? '<p style="text-align:center;font-size:11px;color:#64748b;padding:8px;border:1px dashed #e2e8f0;border-radius:8px;margin:0">✓ Complete all fields → auto-sends</p>'
          : '<button type="button" class="te-wa-submit" style="width:100%;padding:12px;border:none;border-radius:12px;background:' +
            widgetColor +
            ';color:#fff;font-weight:600;cursor:pointer">' +
            esc(d.buttonText || 'Send us a text') +
            '</button>';
        return (
          '<div class="te-wa-panel" style="width:320px;max-width:92vw;margin-bottom:12px;border-radius:16px;overflow:hidden;box-shadow:0 16px 40px rgba(15,23,42,.18);background:#fff">' +
          '<div style="padding:16px;background:linear-gradient(135deg,' +
          gradL +
          ',' +
          gradR +
          ');color:#fff">' +
          '<div style="font-size:16px;font-weight:600">' +
          esc(d.chatHeading || 'Hi there 👋') +
          '</div>' +
          '<div style="font-size:13px;opacity:.95;margin-top:4px">' +
          esc(d.chatSubheading || '') +
          '</div></div>' +
          '<div style="padding:16px;background:' +
          (d.bottomHalfColor || '#fff') +
          '">' +
          '<p style="font-size:13px;color:#64748b;margin:0 0 12px">' +
          esc(d.greetingText || '') +
          '</p>' +
          (d.collectPhone !== false
            ? extraHtml +
              (phoneApi.buildPhoneFieldHtml
                ? phoneApi.buildPhoneFieldHtml(d, { classPrefix: 'te-wa' })
                : '<div style="display:flex;gap:8px;margin-bottom:10px"><span style="padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;font-size:13px">' +
                  esc(d.fallbackCountryCode || '+91') +
                  '</span><input class="te-wa-phone" type="tel" placeholder="' +
                  esc(d.placeholderText || 'Enter your number') +
                  '" style="flex:1;padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;font-size:14px" /></div>') +
              '<label style="display:flex;gap:8px;font-size:11px;color:#64748b;margin-bottom:12px"><input type="checkbox" class="te-wa-consent"' + (consentDefault ? ' checked' : '') + ' />' +
              esc(d.consentText || 'I agree to receive WhatsApp messages.') +
              '</label>'
            : '') +
          btnHtml +
          '</div></div>'
        );
      }

      function doSubscribe(submit) {
        if (submit) {
          submit.disabled = true;
          submit.textContent = 'Opening WhatsApp…';
        }
        var api = ctx.apiOrigin + '/api/public/opt-in';
        var body = {
          embedKey: ctx.embedKey,
          toolId: ctx.tool.id,
          phone: state.phone,
          consent: true,
          pageUrl: window.location.href,
          visitorId: ctx.visitorId,
        };
        if (phoneApi.subscribeExtraFields) {
          var extra = phoneApi.subscribeExtraFields(state);
          Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
        }
        var openWa = function (link) {
          var url = link || (waDigits ? 'https://wa.me/' + waDigits + '?text=' + encodeURIComponent(d.defaultWhatsAppMessage || 'Hi!') : '');
          if (url) window.open(url, '_blank');
        };
        postJson(api + '/subscribe', body)
          .then(function (res) {
            if (res && res.success) {
              try { localStorage.setItem('te_optin_subscribed', '1'); } catch (e) {}
              sent = true;
              expanded = true;
              openWa(res.waLink);
              render();
            } else if (submit) {
              submit.disabled = false;
              submit.textContent = (res && res.message) || 'Try again';
            }
          })
          .catch(function () {
            if (submit) {
              submit.disabled = false;
              submit.textContent = 'Try again';
            }
          });
      }

      function render() {
        host.innerHTML =
          (expanded ? panelHtml() : '') + '<div class="te-wa-launcher-wrap">' + launcherHtml() + '</div>';
        var launcher = host.querySelector('.te-wa-launcher');
        if (launcher) {
          launcher.addEventListener('click', function () {
            if (d.collectPhone === false && waDigits && !ctx.preview) {
              var msg = encodeURIComponent(d.defaultWhatsAppMessage || 'Hi!');
              window.open('https://wa.me/' + waDigits + '?text=' + msg, '_blank');
              return;
            }
            expanded = !expanded;
            render();
          });
        }
        var phoneEl = host.querySelector('.te-wa-phone-input') || host.querySelector('.te-wa-phone');
        var consentEl = host.querySelector('.te-wa-consent');
        if (consentEl) consentEl.addEventListener('change', function () { state.consent = consentEl.checked; });
        if (phoneApi.bindOptionalFields) phoneApi.bindOptionalFields(host, state);
        if (phoneEl) {
          if (phoneApi.bindPhoneField) phoneApi.bindPhoneField(host, state, d);
          else phoneEl.addEventListener('input', function () { state.phone = phoneEl.value; });
          if (autoSubmitOnPhone) {
            ctx.autoSubmitOnPhone = true;
            ctx.autoSubmitHandler = function () {
              if (ctx.preview) return;
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
        }
        var submit = host.querySelector('.te-wa-submit');
        if (submit) {
          submit.addEventListener('click', function () {
            if (ctx.preview) return;
            if (d.collectPhone === false) {
              var msg = encodeURIComponent(d.defaultWhatsAppMessage || 'Hi!');
              window.open('https://wa.me/' + waDigits + '?text=' + msg, '_blank');
              return;
            }
            if (!state.consent) {
              submit.textContent = 'Accept consent to continue';
              return;
            }
            if (phoneApi.canSubmitLead && !phoneApi.canSubmitLead(d, state)) {
              submit.textContent = 'Complete all fields';
              return;
            }
            if (!isValidPhoneForCountry(state.phone, state.countryCode || '+91')) {
              submit.textContent = 'Enter valid 10-digit mobile';
              return;
            }
            doSubscribe(submit);
          });
        }
      }

      var showWidget = function () {
        document.body.appendChild(host);
        render();
        if (!ctx.preview && ctx.embedKey) {
          var impBody = phoneApi.impressionPayload
            ? phoneApi.impressionPayload(ctx)
            : { embedKey: ctx.embedKey, toolId: ctx.tool.id };
          postJson(ctx.apiOrigin + '/api/public/opt-in/impression', impBody).catch(function () {});
        }
      };

      showWidget();
    },
  };
})(window);
