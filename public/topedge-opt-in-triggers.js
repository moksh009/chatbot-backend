/**
 * Opt-in trigger evaluator — browser runtime (keep in sync with utils/optIn/triggerEvaluator.js).
 */
(function (window) {
  'use strict';
  window.TopEdgeOptIn = window.TopEdgeOptIn || {};

  var PAGE_TYPES = {
    home: function (path) { return path === '/' || path === '/index' || /^\/pages\/home\/?$/i.test(path); },
    product: function (path) { return /\/products\//i.test(path); },
    collection: function (path) { return /\/collections\//i.test(path); },
    cart: function (path) { return /\/cart\/?$/i.test(path); },
  };

  function normPath(path) {
    return String(path || '/').toLowerCase().split('?')[0];
  }

  function pathMatches(path, pattern) {
    if (!pattern || pattern === 'all') return true;
    var p = normPath(path);
    var pat = String(pattern).toLowerCase().trim();
    if (pat === 'all') return true;
    if (PAGE_TYPES[pat]) return PAGE_TYPES[pat](p);
    return p.indexOf(pat.replace(/^\//, '')) >= 0;
  }

  function evaluatePageRules(where, path) {
    var show = (where && where.pagesToShow) || ['all'];
    if (show.indexOf('all') < 0 && !show.some(function (s) { return pathMatches(path, s); })) return false;
    var hide = (where && where.pagesToHide) || [];
    if (hide.some(function (h) { return pathMatches(path, h); })) return false;
    return true;
  }

  function evaluateDevice(devices, isMobile) {
    var list = devices || ['all'];
    if (list.indexOf('all') >= 0) return true;
    if (list.indexOf('mobile') >= 0 && isMobile) return true;
    if (list.indexOf('desktop') >= 0 && !isMobile) return true;
    return false;
  }

  function evaluateVisitor(who, ctx) {
    var vt = (who && who.visitorType) || 'all';
    if (vt === 'all') return true;
    if (vt === 'new') return !ctx.isReturningVisitor;
    if (vt === 'returning') return ctx.isReturningVisitor;
    if (vt === 'not_subscribed') return !ctx.isSubscribed;
    return true;
  }

  function cooldownKey(toolId) {
    return 'te_optin_cooldown_' + toolId;
  }

  function readCooldown(storage, toolId) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(cooldownKey(toolId));
      if (!raw) return null;
      try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.at) return parsed;
      } catch (e) {
        if (raw === '1') return { at: Date.now() };
      }
    } catch (e) {}
    return null;
  }

  var WEEKDAY_TO_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function evaluateSchedule(schedule, now) {
    if (!schedule || !schedule.enabled) return true;
    var tz = schedule.timezone || 'Asia/Kolkata';
    var days = Array.isArray(schedule.days) ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
    var startHour = Math.min(23, Math.max(0, Number(schedule.startHour) || 0));
    var endHour = Math.min(23, Math.max(0, Number(schedule.endHour) || 23));
    var ts = now != null ? now : Date.now();
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(new Date(ts));
    var weekday = '';
    var hour = NaN;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'weekday') weekday = parts[i].value;
      if (parts[i].type === 'hour') hour = Number(parts[i].value);
    }
    var dayOfWeek = WEEKDAY_TO_NUM[weekday];
    if (dayOfWeek == null || isNaN(hour)) return false;
    if (days.indexOf(dayOfWeek) < 0) return false;
    if (startHour <= endHour) return hour >= startHour && hour <= endHour;
    return hour >= startHour || hour <= endHour;
  }

  function evaluateFrequency(frequency, toolId, storage, sessionStorage) {
    var freq = frequency || {};
    var type = freq.type || 'once_per_session';
    var cooldownDays = Math.max(1, Number(freq.cooldownDays) || 3);
    var cooldownMs = cooldownDays * 86400000;
    var key = cooldownKey(toolId);
    var stored = readCooldown(storage, toolId);
    var now = Date.now();

    if (type === 'every_visit') {
      if (stored && now - stored.at < cooldownMs) return false;
      return true;
    }
    if (type === 'once_ever') return !stored;
    if (type === 'once_per_session') {
      try {
        return !(sessionStorage && sessionStorage.getItem(key));
      } catch (e) {
        return true;
      }
    }
    if (type === 'once_per_day') {
      if (!stored) return true;
      if (cooldownDays > 1) return now - stored.at >= cooldownMs;
      var last = new Date(stored.at);
      var cur = new Date(now);
      return last.getUTCFullYear() !== cur.getUTCFullYear() || last.getUTCMonth() !== cur.getUTCMonth() || last.getUTCDate() !== cur.getUTCDate();
    }
    return true;
  }

  function passesTargetingRules(tool, ctx) {
    var tr = tool.triggers || {};
    if (!evaluatePageRules(tr.where, ctx.path)) return false;
    if (!evaluateDevice(tr.where && tr.where.devices, ctx.isMobile)) return false;
    if (!evaluateVisitor(tr.who, ctx)) return false;
    if (!evaluateFrequency(tr.frequency, tool.id, ctx.storage, ctx.sessionStorage)) return false;
    if (!evaluateSchedule(tr.schedule, ctx.now)) return false;
    return true;
  }

  function normalizeCondition(when) {
    var c = (when && when.condition) || 'delay';
    if (c === 'immediate_on_load' || c === 'immediate') return 'immediate';
    if (c === 'delay_seconds' || c === 'delay') return 'delay';
    return c;
  }

  function markToolShown(toolId, frequency, storage, sessionStorage) {
    var freq = frequency || {};
    var type = freq.type || 'once_per_session';
    var key = cooldownKey(toolId);
    var payload = JSON.stringify({ at: Date.now() });
    try {
      if (type === 'once_per_session' && sessionStorage) sessionStorage.setItem(key, payload);
      if (storage && (type === 'once_ever' || type === 'once_per_day' || type === 'every_visit')) storage.setItem(key, payload);
    } catch (e) {}
  }

  function buildCtx(visitorId, preview) {
    var path = '/';
    var isMobile = false;
    try {
      path = window.location.pathname || '/';
      isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    } catch (e) {}
    var isReturning = false;
    var isSubscribed = false;
    try {
      isReturning = Boolean(localStorage.getItem('te_visitor_id'));
      isSubscribed = Boolean(localStorage.getItem('te_optin_subscribed'));
    } catch (e) {}
    return {
      path: path,
      isMobile: isMobile,
      isReturningVisitor: isReturning,
      isSubscribed: isSubscribed,
      visitorId: visitorId,
      preview: preview,
      storage: preview ? null : localStorage,
      sessionStorage: preview ? null : sessionStorage,
    };
  }

  function scheduleWhen(when, onReady) {
    var cond = normalizeCondition(when);
    if (cond === 'immediate') {
      onReady();
      return function () {};
    }
    if (cond === 'delay') {
      var ms = Math.max(0, Number(when && when.delaySeconds) || 0) * 1000;
      var t = setTimeout(onReady, ms);
      return function () { clearTimeout(t); };
    }
    if (cond === 'time_on_page') {
      var topMs = Math.max(0, Number(when && when.timeOnPage) || 5) * 1000;
      var t2 = setTimeout(onReady, topMs);
      return function () { clearTimeout(t2); };
    }
    if (cond === 'scroll_depth') {
      var target = Math.min(100, Math.max(5, Number(when && when.scrollDepth) || 50));
      var fired = false;
      function onScroll() {
        if (fired) return;
        var doc = document.documentElement;
        var scrollTop = window.pageYOffset || doc.scrollTop || 0;
        var height = Math.max(doc.scrollHeight - window.innerHeight, 1);
        if ((scrollTop / height) * 100 >= target) {
          fired = true;
          window.removeEventListener('scroll', onScroll, { passive: true });
          onReady();
        }
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
      return function () { window.removeEventListener('scroll', onScroll, { passive: true }); };
    }
    if (cond === 'exit_intent') {
      var done = false;
      function onLeave(e) {
        if (done) return;
        if (e.clientY <= 0) {
          done = true;
          document.removeEventListener('mouseout', onLeave);
          onReady();
        }
      }
      document.addEventListener('mouseout', onLeave);
      return function () { document.removeEventListener('mouseout', onLeave); };
    }
    if (cond === 'add_to_cart') {
      var atcFired = false;
      function onAtc() {
        if (atcFired) return;
        atcFired = true;
        window.removeEventListener('te_optin_add_to_cart', onAtc);
        onReady();
      }
      try {
        if (sessionStorage.getItem('te_optin_atc')) {
          onAtc();
          return function () {};
        }
      } catch (e) {}
      window.addEventListener('te_optin_add_to_cart', onAtc);
      return function () { window.removeEventListener('te_optin_add_to_cart', onAtc); };
    }
    onReady();
    return function () {};
  }

  function scheduleToolDisplay(tool, ctx, onShow) {
    if (!tool) return function () {};
    if (ctx.preview) {
      onShow();
      return function () {};
    }
    if (!passesTargetingRules(tool, ctx)) return function () {};

    var when = (tool.triggers && tool.triggers.when) || {};
    var cancelWhen = scheduleWhen(when, function () {
      if (!passesTargetingRules(tool, ctx)) return;
      markToolShown(tool.id, tool.triggers && tool.triggers.frequency, ctx.storage, ctx.sessionStorage);
      onShow();
    });
    return cancelWhen;
  }

  window.TopEdgeOptIn.triggers = {
    pathMatches: pathMatches,
    evaluateSchedule: evaluateSchedule,
    passesTargetingRules: passesTargetingRules,
    scheduleToolDisplay: scheduleToolDisplay,
    markToolShown: markToolShown,
    buildCtx: buildCtx,
  };
})(window);
