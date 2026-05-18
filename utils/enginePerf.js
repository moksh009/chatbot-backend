"use strict";

const log = require("./logger")("EnginePerf");

const SLOW_SEGMENT_MS = Number(process.env.PERF_SLOW_SEGMENT_MS || 500);
const SLOW_TOTAL_MS = Number(process.env.PERF_SLOW_TOTAL_MS || 3000);

/**
 * Lightweight per-request timing for DualBrain (and other hot paths).
 */
function createPerfTimer(clientId, phone) {
  const timings = { start: Date.now() };
  const order = ["start"];

  const checkpoint = (label) => {
    timings[label] = Date.now();
    order.push(label);
    const prevLabel = order[order.length - 2];
    const prevTs = timings[prevLabel];
    const delta = Date.now() - prevTs;
    if (delta > SLOW_SEGMENT_MS) {
      log.warn(
        `[PerfAlert] ${label} +${delta}ms (total ${Date.now() - timings.start}ms) | ${phone}@${clientId}`
      );
    }
  };

  const finish = () => {
    const total = Date.now() - timings.start;
    if (total <= SLOW_TOTAL_MS) return;
    const parts = [];
    for (let i = 1; i < order.length; i++) {
      const label = order[i];
      const prev = timings[order[i - 1]];
      parts.push(`${label}:${timings[label] - prev}ms`);
    }
    log.warn(
      `[SlowRequest] ${phone}@${clientId} | total=${total}ms | ${parts.join(", ")}`
    );
  };

  return { checkpoint, finish, timings };
}

module.exports = { createPerfTimer, SLOW_SEGMENT_MS, SLOW_TOTAL_MS };
