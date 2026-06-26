/**
 * Spin wheel chunk — prize table, phone capture, server-side prize pick.
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

  function drawWheel(canvas, prizes, colors, rotation) {
    var ctx = canvas.getContext('2d');
    var n = prizes.length || 1;
    var cx = canvas.width / 2;
    var cy = canvas.height / 2;
    var r = Math.min(cx, cy) - 8;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var slice = (Math.PI * 2) / n;
    for (var i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, rotation + i * slice, rotation + (i + 1) * slice);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length] || '#7C3AED';
      ctx.fill();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation + i * slice + slice / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px Inter, sans-serif';
      var label = (prizes[i] && prizes[i].label) || '';
      ctx.fillText(label.length > 14 ? label.slice(0, 12) + '…' : label, r - 12, 4);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  function spinToIndex(canvas, prizes, colors, targetIndex, onDone) {
    var n = prizes.length || 1;
    var slice = (Math.PI * 2) / n;
    var extra = Math.PI * 2 * 5;
    var target = extra + (Math.PI * 1.5 - targetIndex * slice - slice / 2);
    var start = 0;
    var duration = 3200;
    var t0 = Date.now();
    function frame() {
      var t = Math.min(1, (Date.now() - t0) / duration);
      var ease = 1 - Math.pow(1 - t, 3);
      var rot = start + (target - start) * ease;
      drawWheel(canvas, prizes, colors, rot);
      if (t < 1) requestAnimationFrame(frame);
      else if (onDone) onDone();
    }
    frame();
  }

  function completedStateColors(d, lose) {
    var cv = d.completedView || {};
    var sc = lose ? cv.lose || {} : cv.win || {};
    return {
      heading: sc.headingColor || d.headingColor || '#fff',
      sub: sc.subheadingColor || d.subheadingColor || 'rgba(255,255,255,.9)',
      btnBg: sc.buttonColor || d.buttonColor || '#0f172a',
      btnText: sc.buttonTextColor || d.buttonTextColor || '#fff',
      couponBg: sc.couponBg || '#F5F3FF',
      couponText: sc.couponText || '#5B21B6',
      disclaimer: sc.disclaimerColor || d.disclaimerColor || 'rgba(255,255,255,.7)',
    };
  }

  window.TopEdgeOptIn.spin = {
    render: function render(ctx) {
      if (!ctx || !ctx.tool) return;
      var d = ctx.tool.design || {};
      var prizes = ctx.tool.prizes || [];
      var colors = d.wheelColors || ['#7C3AED', '#F59E0B', '#10B981', '#EF4444'];
      var cv = d.completedView || {};
      var beforeSpin = d.collectInputsBeforeSpin !== true;
      var host = document.createElement('div');
      host.className = 'te-spin-root';
      host.style.cssText =
        'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif';
      host.innerHTML =
        '<div style="position:absolute;inset:0;background:rgba(15,23,42,.5)"></div>' +
        '<div class="te-spin-panel" style="position:relative;background:linear-gradient(135deg,' +
        (d.backgroundLeft || '#fff') +
        ',' +
        (d.backgroundRight || '#7C3AED') +
        ');border-radius:16px;padding:20px;max-width:400px;width:92%;color:' +
        (d.headingColor || '#fff') +
        '">' +
        '<button type="button" class="te-spin-close" style="position:absolute;top:12px;right:12px;border:none;background:transparent;color:' +
        (d.closeButtonColor || '#fff') +
        ';font-size:20px;cursor:pointer">×</button>' +
        '<h2 style="margin:0 0 6px;font-size:20px">' +
        esc(d.headline || 'SPIN TO WIN!') +
        '</h2>' +
        '<p style="margin:0 0 12px;font-size:13px;opacity:.95;color:' +
        (d.subheadingColor || '#fff') +
        '">' +
        esc(d.subheadline || '') +
        '</p>' +
        '<canvas class="te-spin-canvas" width="280" height="280" style="display:block;margin:0 auto 12px"></canvas>' +
        '<div class="te-spin-form"></div>' +
        '<div class="te-spin-result" style="display:none;text-align:center"></div>' +
        '</div>';

      var formSlot = host.querySelector('.te-spin-form');
      var resultSlot = host.querySelector('.te-spin-result');
      var canvas = host.querySelector('.te-spin-canvas');
      var consentDefault = d.consentPreChecked === true;
      var state = { phone: '', countryCode: '', consent: consentDefault, spun: false, name: '', email: '', dateOfBirth: '' };
      var autoSubmitOnPhone = d.autoSubmitOnPhone === true;

      function optionalFieldsHtml() {
        var html = '';
        if (d.collectName) {
          html +=
            '<input type="text" class="te-spin-name" placeholder="Your name" style="width:100%;padding:10px;border-radius:10px;border:none;margin-bottom:8px" />';
        }
        if (d.collectEmail) {
          html +=
            '<input type="email" class="te-spin-email" placeholder="Email address" style="width:100%;padding:10px;border-radius:10px;border:none;margin-bottom:8px" />';
        }
        if (d.collectDob) {
          html +=
            '<input type="date" class="te-spin-dob" style="width:100%;padding:10px;border-radius:10px;border:none;margin-bottom:8px" />';
        }
        return html;
      }

      function api(path) {
        return ctx.apiOrigin + '/api/public/opt-in' + path;
      }

      function submitAndSpin(btn) {
        postJson(api('/subscribe'), {
          embedKey: ctx.embedKey,
          toolId: ctx.tool.id,
          phone: state.phone,
          countryCode: state.countryCode,
          consent: true,
          name: state.name,
          email: state.email,
          dateOfBirth: state.dateOfBirth,
          pageUrl: window.location.href,
          visitorId: ctx.visitorId,
        })
          .then(function (res) {
            if (!res || !res.success) {
              if (btn) { btn.disabled = false; btn.textContent = (res && res.message) || 'Try again'; }
              return;
            }
            try { localStorage.setItem('te_optin_subscribed', '1'); } catch (e) {}
            var idx = res.prize && typeof res.prize.index === 'number' ? res.prize.index : 0;
            spinToIndex(canvas, prizes, colors, idx, function () {
              formSlot.style.display = 'none';
              resultSlot.style.display = 'block';
              var lose = res.prize && res.prize.isLose;
              var cc = completedStateColors(d, lose);
              resultSlot.innerHTML =
                '<h3 style="margin:0 0 8px;font-size:18px;color:' +
                cc.heading +
                '">' +
                esc(lose ? cv.failureHeading || 'Better luck next time' : (cv.successHeading || 'Congratulations!') + ' ' + (res.prize.label || '')) +
                '</h3>' +
                (lose
                  ? '<p style="font-size:13px;color:' + cc.sub + '">' + esc(cv.failureSubheading || '') + '</p>'
                  : '<p style="font-size:13px;color:' +
                    cc.sub +
                    '">' +
                    esc(cv.successSubheading || 'Your code:') +
                    '</p><div style="font-size:22px;font-weight:700;margin:8px 0;letter-spacing:.05em;background:' +
                    cc.couponBg +
                    ';color:' +
                    cc.couponText +
                    ';padding:8px 12px;border-radius:10px;display:inline-block">' +
                    esc(res.couponCode || '') +
                    '</div>') +
                (cv.disclaimerText
                  ? '<p style="font-size:11px;margin-top:10px;color:' + cc.disclaimer + '">' + esc(cv.disclaimerText) + '</p>'
                  : '');
            });
          })
          .catch(function () {
            if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
          });
      }

      function renderForm() {
        formSlot.style.display = 'block';
        resultSlot.style.display = 'none';
        var btnHtml = autoSubmitOnPhone
          ? '<p class="te-auto-hint" style="text-align:center;font-size:11px;opacity:.8;padding:8px;border:1px dashed rgba(255,255,255,.4);border-radius:8px;margin:4px 0">✓ Complete all fields → auto-spins</p>'
          : '<button type="button" class="te-spin-action" style="width:100%;padding:12px;border:none;border-radius:12px;background:' +
            (d.buttonColor || '#7C3AED') +
            ';color:' +
            (d.buttonTextColor || '#fff') +
            ';font-weight:600;cursor:pointer">' +
            esc(beforeSpin ? d.spinButtonText || 'Try my luck!' : state.spun ? d.buttonText || 'Get coupon' : d.spinButtonText || 'Try my luck!') +
            '</button>';
        formSlot.innerHTML =
          (beforeSpin || !state.spun
            ? phoneApi.buildPhoneFieldHtml
              ? phoneApi.buildPhoneFieldHtml(d, { classPrefix: 'te-spin', phoneWrapStyle: 'margin-bottom:10px;background:rgba(255,255,255,.12);border:none' })
              : '<div class="te-spin-phone" style="display:flex;gap:8px;margin-bottom:10px"><span>' +
                esc(d.fallbackCountryCode || '+91') +
                '</span><input type="tel" class="te-spin-phone-input" placeholder="' +
                esc(d.phonePlaceholder || '10-digit mobile') +
                '" style="flex:1;padding:10px;border-radius:10px;border:none" /></div>'
            : '') +
          optionalFieldsHtml() +
          '<label style="display:' +
          (beforeSpin || !state.spun ? 'flex' : 'none') +
          ';gap:8px;font-size:11px;margin-bottom:12px;align-items:flex-start">' +
          '<input type="checkbox" class="te-spin-consent"' + (consentDefault ? ' checked' : '') + ' />' +
          esc(d.consentText || '') +
          '</label>' +
          btnHtml;
        var phoneEl = formSlot.querySelector('.te-spin-phone-input');
        var nameEl = formSlot.querySelector('.te-spin-name');
        var emailEl = formSlot.querySelector('.te-spin-email');
        var dobEl = formSlot.querySelector('.te-spin-dob');
        var consentEl = formSlot.querySelector('.te-spin-consent');
        var btn = formSlot.querySelector('.te-spin-action');
        if (consentEl) consentEl.addEventListener('change', function () { state.consent = consentEl.checked; });
        if (nameEl) nameEl.addEventListener('input', function () { state.name = nameEl.value; });
        if (emailEl) emailEl.addEventListener('input', function () { state.email = emailEl.value; });
        if (dobEl) dobEl.addEventListener('change', function () { state.dateOfBirth = dobEl.value; });
        if (phoneEl) {
          if (phoneApi.bindPhoneField) phoneApi.bindPhoneField(formSlot, state, d);
          else phoneEl.addEventListener('input', function () { state.phone = phoneEl.value; });
          if (autoSubmitOnPhone) {
            // Wire auto-submit: debounce fires → submitAndSpin
            ctx.autoSubmitOnPhone = true;
            ctx.autoSubmitHandler = function () {
              if (ctx.preview) { spinToIndex(canvas, prizes, colors, 0, function () {}); return; }
              if (state.spun) return;
              state.spun = true;
              submitAndSpin(null);
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
              spinToIndex(canvas, prizes, colors, 0, function () {});
              return;
            }
            if (!beforeSpin && !state.spun) {
              state.spun = true;
              spinToIndex(canvas, prizes, colors, Math.floor(Math.random() * prizes.length), function () {
                renderForm();
              });
              return;
            }
            if (!state.consent) {
              btn.textContent = 'Accept consent to continue';
              return;
            }
            if (!isValidPhoneForCountry(state.phone, state.countryCode || '+91')) {
              btn.textContent = 'Enter valid 10-digit mobile';
              return;
            }
            btn.disabled = true;
            btn.textContent = 'Spinning…';
            submitAndSpin(btn);
          });
        }
      }

      drawWheel(canvas, prizes, colors, 0);
      renderForm();
      host.querySelector('.te-spin-close').addEventListener('click', function () { host.remove(); });
      host.querySelector('div').addEventListener('click', function (e) {
        if (e.target === host.firstChild) host.remove();
      });
      document.body.appendChild(host);

      if (!ctx.preview && ctx.embedKey) {
        var impBody = phoneApi.impressionPayload ? phoneApi.impressionPayload(ctx) : { embedKey: ctx.embedKey, toolId: ctx.tool.id };
        postJson(api('/impression'), impBody).catch(function () {});
      }
    },
  };
})(window);
