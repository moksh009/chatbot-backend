/**
 * Minimal circuit breaker for outbound HTTP (WhatsApp Graph, OpenAI, Meta).
 * Opens after consecutive failures; half-opens after resetTimeoutMs.
 */

const log = require('./logger')('CircuitBreaker');

const registry = new Map();

class CircuitBreaker {
  constructor(name, opts = {}) {
    this.name = name;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 45000;
    this.failures = 0;
    this.state = 'closed'; // closed | open | half-open
    this.openedAt = 0;
  }

  async exec(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.resetTimeoutMs) {
        this.state = 'half-open';
        log.info(`[${this.name}] Circuit half-open — trial request`);
      } else {
        const err = new Error(`CircuitOpen:${this.name}`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    try {
      const result = await fn();
      this.failures = 0;
      if (this.state === 'half-open') {
        this.state = 'closed';
        log.info(`[${this.name}] Circuit closed after successful trial`);
      }
      return result;
    } catch (e) {
      this.failures += 1;
      if (this.failures >= this.failureThreshold || this.state === 'half-open') {
        this.state = 'open';
        this.openedAt = Date.now();
        log.warn(`[${this.name}] Circuit OPEN after ${this.failures} failures`);
      }
      throw e;
    }
  }

  status() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt
    };
  }
}

function getBreaker(name, opts) {
  if (!registry.has(name)) {
    registry.set(name, new CircuitBreaker(name, opts));
  }
  return registry.get(name);
}

function allStatuses() {
  return Array.from(registry.values()).map((b) => b.status());
}

module.exports = {
  CircuitBreaker,
  getBreaker,
  allStatuses
};
