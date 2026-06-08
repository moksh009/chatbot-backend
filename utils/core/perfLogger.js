/**
 * Performance timing shim — instrumentation hooks are no-ops (no console output).
 * Call sites may keep createTimer / timeParallel / wrapCron; they execute work only.
 */

const noopTimer = {
  checkpoint: () => {},
  finish: () => {},
  log: () => {},
  time: async (_label, fn) => fn(),
};

function createTimer(_operationName, _context = '') {
  return noopTimer;
}

async function timeParallel(_timer, steps, _batchLabel = 'parallel_batch') {
  const entries = Object.entries(steps);
  const settled = await Promise.all(
    entries.map(async ([key, fn]) => ({ key, value: await fn() }))
  );
  return Object.fromEntries(settled.map((row) => [row.key, row.value]));
}

function wrapCron(_name, fn) {
  return async () => {
    const { acquireCronMongoSlot } = require('./mongoCronBudget');
    let release = () => {};
    try {
      release = await acquireCronMongoSlot(_name);
      await fn();
    } finally {
      release();
    }
  };
}

/** @deprecated Always false — perf console logging removed. */
const PERF_LOGGING = false;

module.exports = { createTimer, timeParallel, wrapCron, PERF_LOGGING, noopTimer };
