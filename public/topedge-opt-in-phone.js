/**
 * Shared Indian phone validation + debounced capture-phone for all opt-in chunks.
 * Keep in sync with utils/optIn/indianPhoneValidator.js (server).
 */
(function (window) {
  'use strict';
  window.TopEdgeOptIn = window.TopEdgeOptIn || {};

  function isValidIndianPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    if (d.length === 11 && d[0] === '0') d = d.slice(1);
    return d.length === 10 && /^[6-9]/.test(d);
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  /**
   * Debounced partial lead capture while typing (800ms default).
   */
  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function canSubmitLead(d, state) {
    if (!state || !state.consent || !isValidIndianPhone(state.phone)) return false;
    if (d.collectName && !String(state.name || '').trim()) return false;
    if (d.collectEmail && !isValidEmail(state.email)) return false;
    if (d.collectDob && !String(state.dateOfBirth || '').trim()) return false;
    return true;
  }

  function setupDebouncedCapture(opts) {
    var phoneEl = opts && opts.phoneEl;
    var getConsent = opts && opts.getConsent;
    var getLeadState = opts && opts.getLeadState;
    var ctx = opts && opts.ctx;
    var debounceMs = (opts && opts.debounceMs) || 800;
    if (!phoneEl || !ctx || ctx.preview || !ctx.embedKey) return function () {};

    var timer = null;
    function onInput() {
      clearTimeout(timer);
      var phone = phoneEl.value;
      if (!getConsent || !getConsent()) return;
      if (!isValidIndianPhone(phone)) return;
      if (getLeadState && ctx.tool && ctx.tool.design) {
        var leadState = getLeadState();
        if (!canSubmitLead(ctx.tool.design, leadState)) return;
      }
      timer = setTimeout(function () {
        postJson(ctx.apiOrigin + '/api/public/opt-in/capture-phone', {
          embedKey: ctx.embedKey,
          toolId: ctx.tool.id,
          phone: phone,
          consent: true,
          pageUrl: window.location.href,
          visitorId: ctx.visitorId,
        }).catch(function () {}).finally(function () {
          if (ctx.autoSubmitOnPhone && typeof ctx.autoSubmitHandler === 'function') {
            if (!getLeadState || !ctx.tool || !ctx.tool.design || canSubmitLead(ctx.tool.design, getLeadState())) {
              ctx.autoSubmitHandler();
            }
          }
        });
      }, debounceMs);
    }

    phoneEl.addEventListener('input', onInput);
    return function cleanup() {
      clearTimeout(timer);
      phoneEl.removeEventListener('input', onInput);
    };
  }

  function impressionPayload(ctx) {
    return {
      embedKey: ctx.embedKey,
      toolId: ctx.tool.id,
      pageUrl: window.location.href,
      isMobile: window.matchMedia && window.matchMedia('(max-width: 768px)').matches,
    };
  }

  function optionalFieldsHtml(d, inputStyle) {
    var style =
      inputStyle ||
      'width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;font-size:14px;margin-bottom:8px;box-sizing:border-box';
    var html = '';
    if (d.collectName) {
      html +=
        '<input type="text" class="te-optin-name" placeholder="Your name" autocomplete="name" style="' +
        style +
        '" />';
    }
    if (d.collectEmail) {
      html +=
        '<input type="email" class="te-optin-email" placeholder="Email address" autocomplete="email" style="' +
        style +
        '" />';
    }
    if (d.collectDob) {
      html +=
        '<input type="date" class="te-optin-dob" aria-label="Date of birth" style="' +
        style +
        '" />';
    }
    return html;
  }

  function bindOptionalFields(root, state) {
    if (!root) return;
    var nameEl = root.querySelector('.te-optin-name');
    var emailEl = root.querySelector('.te-optin-email');
    var dobEl = root.querySelector('.te-optin-dob');
    if (nameEl) nameEl.addEventListener('input', function () { state.name = nameEl.value; });
    if (emailEl) emailEl.addEventListener('input', function () { state.email = emailEl.value; });
    if (dobEl) dobEl.addEventListener('input', function () { state.dateOfBirth = dobEl.value; });
  }

  function subscribeExtraFields(state) {
    var body = {};
    if (state.name) body.name = state.name;
    if (state.email) body.email = state.email;
    if (state.dateOfBirth) body.dateOfBirth = state.dateOfBirth;
    return body;
  }

  window.TopEdgeOptIn.phone = {
    isValidIndianPhone: isValidIndianPhone,
    setupDebouncedCapture: setupDebouncedCapture,
    postJson: postJson,
    impressionPayload: impressionPayload,
    optionalFieldsHtml: optionalFieldsHtml,
    bindOptionalFields: bindOptionalFields,
    subscribeExtraFields: subscribeExtraFields,
    canSubmitLead: canSubmitLead,
  };
})(window);
