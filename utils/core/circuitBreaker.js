"use strict";

const log = require('./logger')("CircuitBreaker");

class CircuitBreaker {
  constructor(name, threshold = 5, resetTimeMs = 30000) {
    this.name = name;
    this.failures = 0;
    this.threshold = threshold;
    this.state = "CLOSED";
    this.lastFailureTime = null;
    this.resetTimeMs = resetTimeMs;
  }

  async call(fn, options = {}) {
    const shouldCountFailure = typeof options.shouldCountFailure === 'function'
      ? options.shouldCountFailure
      : () => true;

    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeMs) {
        this.state = "HALF_OPEN";
      } else {
        throw new Error(`[CircuitBreaker] ${this.name} is OPEN — failing fast`);
      }
    }

    try {
      const result = await fn();
      if (this.state === "HALF_OPEN") {
        this.state = "CLOSED";
        this.failures = 0;
      }
      return result;
    } catch (err) {
      if (shouldCountFailure(err)) {
        this.failures += 1;
        this.lastFailureTime = Date.now();
        if (this.failures >= this.threshold) {
          this.state = "OPEN";
          log.warn(`[CircuitBreaker] ${this.name} opened after ${this.failures} failures`);
        }
      }
      throw err;
    }
  }

  /** Alias used by WhatsApp Graph API paths (whatsapp.js). */
  exec(fn) {
    return this.call(fn);
  }
}

const shopifyBreaker = new CircuitBreaker("Shopify", 5, 30000);
const geminiBreaker = new CircuitBreaker("Gemini", 5, 45000);

const namedBreakers = new Map();

function getBreaker(name, opts = {}) {
  const key = String(name || "default");
  if (!namedBreakers.has(key)) {
    namedBreakers.set(
      key,
      new CircuitBreaker(key, opts.failureThreshold || 5, opts.resetTimeoutMs || 30000)
    );
  }
  return namedBreakers.get(key);
}

function breakerSnapshot(b) {
  return {
    state: b.state,
    failures: b.failures,
    threshold: b.threshold,
  };
}

/** Health / metrics: snapshot of built-in and dynamic breakers. */
function allStatuses() {
  const dynamic = {};
  for (const [name, b] of namedBreakers.entries()) {
    dynamic[name] = breakerSnapshot(b);
  }
  return {
    shopify: breakerSnapshot(shopifyBreaker),
    gemini: breakerSnapshot(geminiBreaker),
    ...dynamic,
  };
}

function resetShopifyBreaker() {
  shopifyBreaker.state = "CLOSED";
  shopifyBreaker.failures = 0;
  shopifyBreaker.lastFailureTime = null;
  log.info("[CircuitBreaker] Shopify manually reset to CLOSED");
}

function isCircuitOpenError(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("[CircuitBreaker]") && msg.includes("OPEN");
}

module.exports = {
  CircuitBreaker,
  shopifyBreaker,
  geminiBreaker,
  getBreaker,
  allStatuses,
  resetShopifyBreaker,
  isCircuitOpenError,
};
