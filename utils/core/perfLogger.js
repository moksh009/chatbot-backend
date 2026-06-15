'use strict';

const log = require('./logger')('Perf');

const noopTimer = {
  checkpoint: () => {},
  finish: () => {},
  log: () => {},
  time: async (_label, fn) => fn(),
};

const PERF_LOGGING =
  process.env.PERF_LOGGING === 'true' ||
  (process.env.NODE_ENV !== 'production' && process.env.PERF_LOGGING !== 'false');

function createTimer(operationName, context = '') {
  if (!PERF_LOGGING) return noopTimer;

  const start = Date.now();
  const checkpoints = [];
  const label = context ? `${operationName} (${context})` : operationName;

  return {
    checkpoint(name) {
      checkpoints.push({ name, ms: Date.now() - start });
    },
    finish(extra = '') {
      const total = Date.now() - start;
      const suffix = extra ? ` — ${extra}` : '';
      const payload = checkpoints.length ? { checkpoints, totalMs: total } : { totalMs: total };
      log.info(`${label}${suffix}`, payload);
    },
    log(message) {
      log.debug(`${label}: ${message}`);
    },
    time: async (stepLabel, fn) => {
      const stepStart = Date.now();
      const result = await fn();
      checkpoints.push({ name: stepLabel, ms: Date.now() - stepStart });
      return result;
    },
  };
}

async function timeParallel(timer, steps, batchLabel = 'parallel_batch') {
  const entries = Object.entries(steps);
  if (PERF_LOGGING && timer?.checkpoint) {
    timer.checkpoint(`${batchLabel}:start`);
  }
  const settled = await Promise.all(
    entries.map(async ([key, fn]) => ({ key, value: await fn() }))
  );
  if (PERF_LOGGING && timer?.checkpoint) {
    timer.checkpoint(`${batchLabel}:done`);
  }
  return Object.fromEntries(settled.map((row) => [row.key, row.value]));
}

function wrapCron(name, fn) {
  return async () => {
    const { acquireCronMongoSlot } = require('./mongoCronBudget');
    let release = () => {};
    const cronStart = Date.now();
    try {
      release = await acquireCronMongoSlot(name);
      await fn();
    } finally {
      if (PERF_LOGGING) {
        log.info(`cron:${name}`, { totalMs: Date.now() - cronStart });
      }
      release();
    }
  };
}

module.exports = { createTimer, timeParallel, wrapCron, PERF_LOGGING, noopTimer };
