/**
 * Phase 3 Module 1 — rate limit halve/restore math.
 */
const assert = require('assert');
const {
  normalizeChannelRateLimit,
  halveEffective,
  rampEffectiveTowardConfigured,
} = require('../utils/messaging/rateLimitConfig');

function testLegacyNormalize() {
  const n = normalizeChannelRateLimit({ sustainedPerSec: 20, burst: 40 }, 'whatsapp');
  assert.strictEqual(n.configured.sustainedPerSec, 20);
  assert.strictEqual(n.effective.burst, 40);
}

function testHalve() {
  const h = halveEffective({ sustainedPerSec: 11, burst: 31 });
  assert.strictEqual(h.sustainedPerSec, 5);
  assert.strictEqual(h.burst, 15);
}

function testRampRestore() {
  let eff = { sustainedPerSec: 5, burst: 15 };
  const cfg = { sustainedPerSec: 10, burst: 30 };
  for (let i = 0; i < 10; i += 1) {
    const { next, restored } = rampEffectiveTowardConfigured(eff, cfg);
    eff = next;
    if (restored) break;
  }
  assert.strictEqual(eff.sustainedPerSec, cfg.sustainedPerSec);
  assert.strictEqual(eff.burst, cfg.burst);
}

function testShouldUseEffectiveInChannelLimits() {
  const { resolveChannelRateLimits } = require('../utils/messaging/channelRateLimits');
  const client = {
    clientId: 't1',
    complianceConfig: {
      rateLimits: {
        whatsapp: {
          configured: { sustainedPerSec: 10, burst: 30 },
          effective: { sustainedPerSec: 4, burst: 12 },
        },
      },
    },
  };
  return resolveChannelRateLimits(client, 'whatsapp').then((r) => {
    assert.strictEqual(r.sustainedPerSec, 4);
    assert.strictEqual(r.burst, 12);
  });
}

let failed = 0;
(async () => {
  for (const [name, fn] of [
    ['legacyNormalize', testLegacyNormalize],
    ['halve', testHalve],
    ['rampRestore', testRampRestore],
    ['effectiveInResolve', testShouldUseEffectiveInChannelLimits],
  ]) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`✗ ${name}:`, e.message);
    }
  }
  process.exit(failed ? 1 : 0);
})();
