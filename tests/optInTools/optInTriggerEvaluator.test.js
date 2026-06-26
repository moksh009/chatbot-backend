'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  pathMatches,
  evaluatePageRules,
  evaluateDevice,
  evaluateVisitor,
  evaluateFrequency,
  evaluateSchedule,
  passesTargetingRules,
  markToolShown,
} = require('../../utils/optIn/triggerEvaluator');

function mockStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    _store: store,
  };
}

describe('optIn triggerEvaluator', () => {
  it('pathMatches supports Shopify page types', () => {
    assert.equal(pathMatches('/products/foo', 'product'), true);
    assert.equal(pathMatches('/collections/sale', 'collection'), true);
    assert.equal(pathMatches('/cart', 'cart'), true);
    assert.equal(pathMatches('/', 'home'), true);
  });

  it('evaluateDevice respects mobile-only', () => {
    assert.equal(evaluateDevice(['mobile'], true), true);
    assert.equal(evaluateDevice(['mobile'], false), false);
  });

  it('evaluateVisitor blocks new visitors when returning', () => {
    assert.equal(evaluateVisitor({ visitorType: 'new' }, { isReturningVisitor: true }), false);
    assert.equal(evaluateVisitor({ visitorType: 'returning' }, { isReturningVisitor: true }), true);
    assert.equal(evaluateVisitor({ visitorType: 'not_subscribed' }, { isSubscribed: true }), false);
  });

  it('evaluateFrequency once_per_session uses session storage', () => {
    const session = mockStorage();
    const toolId = 'tool_1';
    assert.equal(evaluateFrequency({ type: 'once_per_session' }, toolId, null, session), true);
    markToolShown(toolId, { type: 'once_per_session' }, null, session);
    assert.equal(evaluateFrequency({ type: 'once_per_session' }, toolId, null, session), false);
  });

  it('evaluateFrequency every_visit respects cooldown days', () => {
    const storage = mockStorage();
    const toolId = 'tool_2';
    const now = Date.now();
    markToolShown(toolId, { type: 'every_visit' }, storage, null);
    assert.equal(
      evaluateFrequency({ type: 'every_visit', cooldownDays: 3 }, toolId, storage, null, now + 1000),
      false
    );
    assert.equal(
      evaluateFrequency({ type: 'every_visit', cooldownDays: 3 }, toolId, storage, null, now + 4 * 86400000),
      true
    );
  });

  it('passesTargetingRules combines mobile + exit-ready tool config', () => {
    const tool = {
      id: 't1',
      triggers: {
        where: { pagesToShow: ['product'], pagesToHide: [], devices: ['mobile'] },
        who: { visitorType: 'all' },
        frequency: { type: 'once_per_session' },
      },
    };
    const session = mockStorage();
    const ctxMobile = { path: '/products/shirt', isMobile: true, storage: mockStorage(), sessionStorage: session };
    const ctxDesktop = { ...ctxMobile, isMobile: false };
    assert.equal(passesTargetingRules(tool, ctxMobile), true);
    assert.equal(passesTargetingRules(tool, ctxDesktop), false);
  });

  it('evaluateSchedule passes when disabled', () => {
    assert.equal(evaluateSchedule({ enabled: false }, Date.now()), true);
    assert.equal(evaluateSchedule(null, Date.now()), true);
  });

  it('evaluateSchedule respects timezone, days, and hours', () => {
    const monday10amIst = new Date('2025-06-23T04:30:00.000Z').getTime();
    const sunday10amIst = new Date('2025-06-22T04:30:00.000Z').getTime();
    const monday10pmIst = new Date('2025-06-23T16:30:00.000Z').getTime();

    const schedule = {
      enabled: true,
      timezone: 'Asia/Kolkata',
      days: [1, 2, 3, 4, 5, 6],
      startHour: 9,
      endHour: 21,
    };

    assert.equal(evaluateSchedule(schedule, monday10amIst), true);
    assert.equal(evaluateSchedule(schedule, sunday10amIst), false);
    assert.equal(evaluateSchedule(schedule, monday10pmIst), false);
  });

  it('passesTargetingRules blocks outside schedule window', () => {
    const sunday10amIst = new Date('2025-06-22T04:30:00.000Z').getTime();
    const tool = {
      id: 't_sched',
      triggers: {
        where: { pagesToShow: ['all'], devices: ['all'] },
        who: { visitorType: 'all' },
        frequency: { type: 'every_visit' },
        schedule: {
          enabled: true,
          timezone: 'Asia/Kolkata',
          days: [1, 2, 3, 4, 5, 6],
          startHour: 9,
          endHour: 21,
        },
      },
    };
    const ctx = {
      path: '/',
      isMobile: false,
      storage: mockStorage(),
      sessionStorage: mockStorage(),
      now: sunday10amIst,
    };
    assert.equal(passesTargetingRules(tool, ctx), false);
  });
});
