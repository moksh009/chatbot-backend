"use strict";

/**
 * Limits how many cron ticks may hold MongoDB work at once.
 * Prevents API routes from waiting 15–20s for a pool slot when crons align on :00/:05.
 */
const log = require('./logger')("MongoCronBudget");

const MAX_CONCURRENT = Math.min(
  10,
  Math.max(1, parseInt(process.env.CRON_MONGO_CONCURRENCY || "3", 10) || 3)
);

let active = 0;
const waitQueue = [];

function releaseSlot() {
  active = Math.max(0, active - 1);
  pumpQueue();
}

function pumpQueue() {
  while (active < MAX_CONCURRENT && waitQueue.length > 0) {
    const { resolve, cronName, enqueuedAt } = waitQueue.shift();
    const waitedMs = Date.now() - enqueuedAt;
    if (waitedMs > 500) {
      log.warn(`[MongoCronBudget] ${cronName} waited ${waitedMs}ms for slot`);
    }
    active += 1;
    resolve(releaseSlot);
  }
}

/**
 * @param {string} [cronName]
 * @returns {Promise<() => void>} release function
 */
function acquireCronMongoSlot(cronName = "cron") {
  if (process.env.CRON_MONGO_BUDGET === "false") {
    return Promise.resolve(() => {});
  }

  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve(releaseSlot);
  }

  return new Promise((resolve) => {
    waitQueue.push({ resolve, cronName, enqueuedAt: Date.now() });
  });
}

function getMongoCronBudgetStats() {
  return {
    maxConcurrent: MAX_CONCURRENT,
    active,
    queued: waitQueue.length,
    disabled: process.env.CRON_MONGO_BUDGET === "false",
  };
}

module.exports = {
  acquireCronMongoSlot,
  getMongoCronBudgetStats,
};
