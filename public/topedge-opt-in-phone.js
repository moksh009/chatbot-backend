/**
 * Shared phone validation + UI + debounced capture-phone for all opt-in chunks.
 * Keep in sync with utils/optIn/indianPhoneValidator.js (server).
 */
(function (window) {
  'use strict';
  window.TopEdgeOptIn = window.TopEdgeOptIn || {};

  var FLAGS = {
    '+91': '🇮🇳',
    '+1': '🇺🇸',
    '+44': '🇬🇧',
    '+971': '🇦🇪',
    '+966': '🇸🇦',
    '+65': '🇸🇬',
    '+61': '🇦🇺',
    '+49': '🇩🇪',
    '+33': '🇫🇷',
    '+81': '🇯🇵',
  };

  var COUNTRY_OPTIONS = [
    { id: '+91', label: 'India (+91)' },
    { id: '+1', label: 'United States / Canada (+1)' },
    { id: '+44', label: 'United Kingdom (+44)' },
    { id: '+971', label: 'UAE (+971)' },
    { id: '+966', label: 'Saudi Arabia (+966)' },
    { id: '+65', label: 'Singapore (+65)' },
    { id: '+61', label: 'Australia (+61)' },
    { id: '+49', label: 'Germany (+49)' },
    { id: '+33', label: 'France (+33)' },
    { id: '+81', label: 'Japan (+81)' },
  ];

  function normalizeCountryCode(value) {
    var s = String(value || '+91').trim();
    if (!s) return '+91';
    if (s.charAt(0) === '+') return s;
    return '+' + s.replace(/\D/g, '');
  }

  function digitsOnly(raw) {
    return String(raw || '').replace(/\D/g, '');
  }

  function isValidPhoneForCountry(raw, countryCode) {
    var code = normalizeCountryCode(countryCode);
    var d = digitsOnly(raw);
    var dialDigits = code.replace(/\D/g, '');
    if (d.indexOf(dialDigits) === 0 && d.length > dialDigits.length) d = d.slice(dialDigits.length);
    if (code === '+91') {
      if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
      if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
      return d.length === 10 && /^[6-9]/.test(d);
    }
    if (code === '+1') return d.length === 10;
    if (code === '+44') return d.length >= 10 && d.length <= 11;
    if (code === '+971') return d.length === 9;
    if (code === '+966') return d.length === 9;
    if (code === '+65') return d.length === 8;
    return d.length >= 7 && d.length <= 15;
  }

  function isValidIndianPhone(raw) {
    return isValidPhoneForCountry(raw, '+91');
  }

  function resolvePhoneConfig(design) {
    design = design || {};
    var phone = design.phone || {};
    var defaultCountryCode = normalizeCountryCode(
      phone.defaultCountryCode || design.fallbackCountryCode || design.countryCode
    );
    var allowed = phone.allowedCountries;
    var legacy = Array.isArray(design.phoneCountries) ? design.phoneCountries : [];
    var allowedCountries = 'all';
    if (allowed === 'all' || allowed === null || allowed === undefined) {
      allowedCountries = legacy.length ? legacy : 'all';
    } else if (Array.isArray(allowed)) {
      allowedCountries = allowed.length ? allowed : 'all';
    } else if (legacy.length) {
      allowedCountries = legacy;
    }
    return {
      defaultCountryCode: defaultCountryCode,
      allowedCountries: allowedCountries,
      displayFormat: phone.displayFormat || design.countryCodeDisplayFormat || 'flag_code',
      autofillFromLocation: phone.autofillFromLocation !== false && design.autofillCountryCode !== false,
      placeholder: phone.placeholder || design.phonePlaceholder || design.placeholderText || '10-digit mobile number',
    };
  }

  function formatCountryLabel(code, displayFormat) {
    var fmt = displayFormat || 'flag_code';
    var flag = getCountryFlag(code);
    var dial = normalizeCountryCode(code);
    if (fmt === 'code_only') return dial;
    if (fmt === 'flag_only') return flag;
    return flag + ' ' + dial;
  }

  function guessCountryFromTimezone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      var map = {
        'Asia/Kolkata': '+91',
        'Asia/Calcutta': '+91',
        'America/New_York': '+1',
        'America/Chicago': '+1',
        'America/Denver': '+1',
        'America/Los_Angeles': '+1',
        'America/Toronto': '+1',
        'Europe/London': '+44',
        'Asia/Dubai': '+971',
        'Asia/Riyadh': '+966',
        'Asia/Singapore': '+65',
        'Australia/Sydney': '+61',
      };
      return map[tz] || '+91';
    } catch (e) {
      return '+91';
    }
  }

  function getCountryFlag(code) {
    return FLAGS[normalizeCountryCode(code)] || '🌐';
  }

  function getAllowedOptions(config) {
    if (config.allowedCountries === 'all' || !config.allowedCountries ||
      (Array.isArray(config.allowedCountries) && !config.allowedCountries.length)) {
      return COUNTRY_OPTIONS;
    }
    var set = {};
    config.allowedCountries.forEach(function (c) { set[c] = true; });
    set[config.defaultCountryCode] = true;
    return COUNTRY_OPTIONS.filter(function (o) { return set[o.id]; });
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildPhoneFieldHtml(design, opts) {
    opts = opts || {};
    var config = resolvePhoneConfig(design);
    var options = getAllowedOptions(config);
    var showPicker = options.length > 1;
    var cls = opts.classPrefix || 'te-optin';
    var style = opts.inputStyle || '';
    var selectHtml = '';
    if (showPicker) {
      selectHtml =
        '<select class="' + cls + '-cc-select" aria-label="Country code" style="border:none;background:transparent;font-weight:600;cursor:pointer;max-width:5.5rem">' +
        options.map(function (o) {
          return '<option value="' + esc(o.id) + '">' + esc(formatCountryLabel(o.id, config.displayFormat)) + '</option>';
        }).join('') +
        '</select>';
    } else {
      var fmt = config.displayFormat || 'flag_code';
      if (fmt !== 'code_only') {
        selectHtml += '<span class="' + cls + '-flag" aria-hidden>' + getCountryFlag(config.defaultCountryCode) + '</span>';
      }
      if (fmt !== 'flag_only') {
        selectHtml += '<span class="' + cls + '-cc">' + esc(config.defaultCountryCode) + '</span>';
      }
    }
    return (
      '<div class="' + cls + '-phone" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;' +
      (opts.phoneWrapStyle || '') +
      '">' +
      selectHtml +
      '<input type="tel" class="' + cls + '-phone-input" placeholder="' +
      esc(config.placeholder) +
      '" style="flex:1;border:none;outline:none;font-size:14px;' +
      style +
      '" inputmode="tel" autocomplete="tel" />' +
      '</div>'
    );
  }

  function bindPhoneField(root, state, design) {
    if (!root) return;
    var config = resolvePhoneConfig(design);
    var options = getAllowedOptions(config);
    var selectEl = root.querySelector('.te-optin-cc-select, .te-spin-cc-select, .te-myst-cc-select, .te-wa-cc-select, [class$="-cc-select"]');
    var phoneEl = root.querySelector(
      '.te-optin-phone-input, .te-spin-phone-input, .te-myst-phone-input, .te-wa-phone, [class$="-phone-input"]'
    );
    state.countryCode = config.defaultCountryCode;
    if (config.autofillFromLocation) {
      var guessed = guessCountryFromTimezone();
      if (options.some(function (o) { return o.id === guessed; })) {
        state.countryCode = guessed;
      }
    }
    if (selectEl) {
      selectEl.value = state.countryCode;
      selectEl.addEventListener('change', function () {
        state.countryCode = selectEl.value;
      });
    }
    if (phoneEl) {
      phoneEl.addEventListener('input', function () {
        state.phone = phoneEl.value;
      });
    }
    return { phoneEl: phoneEl, selectEl: selectEl, config: config };
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function canSubmitLead(d, state) {
    var cc = state.countryCode || resolvePhoneConfig(d).defaultCountryCode;
    if (!state || !state.consent || !isValidPhoneForCountry(state.phone, cc)) return false;
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
      var state = getLeadState ? getLeadState() : { phone: phoneEl.value, consent: getConsent && getConsent() };
      var cc = state.countryCode || resolvePhoneConfig(ctx.tool && ctx.tool.design).defaultCountryCode;
      if (!getConsent || !getConsent()) return;
      if (!isValidPhoneForCountry(state.phone, cc)) return;
      if (getLeadState && ctx.tool && ctx.tool.design) {
        var leadState = getLeadState();
        if (!canSubmitLead(ctx.tool.design, leadState)) return;
      }
      timer = setTimeout(function () {
        postJson(ctx.apiOrigin + '/api/public/opt-in/capture-phone', {
          embedKey: ctx.embedKey,
          toolId: ctx.tool.id,
          phone: state.phone,
          countryCode: cc,
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
        '<input type="text" class="te-optin-name" placeholder="' +
        (d.namePlaceholder || 'Your name').replace(/"/g, '&quot;') +
        '" autocomplete="name" style="' +
        style +
        '" />';
    }
    if (d.collectEmail) {
      html +=
        '<input type="email" class="te-optin-email" placeholder="' +
        (d.emailPlaceholder || 'Email address').replace(/"/g, '&quot;') +
        '" autocomplete="email" style="' +
        style +
        '" />';
    }
    if (d.collectDob) {
      html +=
        '<input type="date" class="te-optin-dob" aria-label="' +
        (d.dobPlaceholder || 'Date of birth').replace(/"/g, '&quot;') +
        '" style="' +
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
    if (state.countryCode) body.countryCode = state.countryCode;
    return body;
  }

  window.TopEdgeOptIn.phone = {
    isValidIndianPhone: isValidIndianPhone,
    isValidPhoneForCountry: isValidPhoneForCountry,
    resolvePhoneConfig: resolvePhoneConfig,
    guessCountryFromTimezone: guessCountryFromTimezone,
    getCountryFlag: getCountryFlag,
    buildPhoneFieldHtml: buildPhoneFieldHtml,
    bindPhoneField: bindPhoneField,
    setupDebouncedCapture: setupDebouncedCapture,
    postJson: postJson,
    impressionPayload: impressionPayload,
    optionalFieldsHtml: optionalFieldsHtml,
    bindOptionalFields: bindOptionalFields,
    subscribeExtraFields: subscribeExtraFields,
    canSubmitLead: canSubmitLead,
  };
})(window);
