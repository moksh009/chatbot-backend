/**
 * Performance timing utility for debugging slow endpoints and operations.
 * Zero external dependencies. Add to any function to measure each step.
 * Remove or disable with PERF_LOGGING=false env var after debugging is done.
 */

const PERF_LOGGING = process.env.PERF_LOGGING !== 'false'; // on by default

/**
 * Creates a timer scoped to one request or operation.
 * @param {string} operationName - e.g. 'Dashboard GET /api/analytics/realtime'
 * @param {string} [context] - e.g. clientId or phone number for tracing
 */
function createTimer(operationName, context = '') {
  if (!PERF_LOGGING) {
    return {
      checkpoint: () => {},
      finish: () => {},
      log: () => {},
      time: async (_label, fn) => fn(),
    };
  }

  const timings = [];
  const startTime = Date.now();
  let lastCheckpoint = startTime;
  const contextStr = context ? ` [${context}]` : '';

  console.log(`\n⏱️  [PERF START] ${operationName}${contextStr} | ${new Date().toISOString()}`);

  return {
    /**
     * Record a named checkpoint.
     * @param {string} label
     * @param {object} [meta]
     */
    checkpoint(label, meta = {}) {
      const now = Date.now();
      const sinceStart = now - startTime;
      const sinceLast = now - lastCheckpoint;
      lastCheckpoint = now;

      const metaStr = Object.keys(meta).length
        ? ' | ' + Object.entries(meta).map(([k, v]) => `${k}=${v}`).join(', ')
        : '';

      const slowFlag = sinceLast > 500 ? ' 🐢 SLOW' : sinceLast > 200 ? ' ⚠️' : '';

      timings.push({ label, sinceLast, sinceStart });
      console.log(
        `  ├─ [+${String(sinceLast).padStart(5)}ms / ${String(sinceStart).padStart(6)}ms total] ${label}${metaStr}${slowFlag}`
      );
    },

    /**
     * Await an async operation and record it as a checkpoint.
     */
    async time(label, fn) {
      const t0 = Date.now();
      try {
        const result = await fn();
        const sinceLast = Date.now() - t0;
        const sinceStart = Date.now() - startTime;
        lastCheckpoint = Date.now();
        const slowFlag = sinceLast > 500 ? ' 🐢 SLOW' : sinceLast > 200 ? ' ⚠️' : '';
        timings.push({ label, sinceLast, sinceStart });
        console.log(
          `  ├─ [+${String(sinceLast).padStart(5)}ms / ${String(sinceStart).padStart(6)}ms total] ${label}${slowFlag}`
        );
        return result;
      } catch (err) {
        const sinceLast = Date.now() - t0;
        const sinceStart = Date.now() - startTime;
        lastCheckpoint = Date.now();
        timings.push({ label, sinceLast, sinceStart });
        console.log(
          `  ├─ [+${String(sinceLast).padStart(5)}ms / ${String(sinceStart).padStart(6)}ms total] ${label} | FAILED error=${err.message}`
        );
        throw err;
      }
    },

    finish(outcome = 'success') {
      const totalMs = Date.now() - startTime;
      const slowest = timings.reduce(
        (max, t) => (t.sinceLast > max.sinceLast ? t : max),
        { sinceLast: 0, label: 'none' }
      );

      const totalFlag = totalMs > 3000 ? ' 🔴 VERY SLOW' : totalMs > 1000 ? ' 🟡 SLOW' : ' 🟢';
      console.log(`  └─ [TOTAL: ${totalMs}ms${totalFlag}] ${operationName} | outcome=${outcome}`);

      if (totalMs > 1000) {
        console.log(`     🔍 Slowest step: "${slowest.label}" took ${slowest.sinceLast}ms`);
      }
      console.log('');
    },

    log(message) {
      const elapsed = Date.now() - startTime;
      console.log(`  │  [${elapsed}ms] NOTE: ${message}`);
    },
  };
}

/**
 * Run labeled async tasks in parallel; log each task duration.
 */
async function timeParallel(timer, steps, batchLabel = 'parallel_batch') {
  if (!PERF_LOGGING) {
    const entries = Object.entries(steps);
    const settled = await Promise.all(entries.map(async ([key, fn]) => ({ key, value: await fn() })));
    return Object.fromEntries(settled.map((row) => [row.key, row.value]));
  }

  const entries = Object.entries(steps);
  const batchStart = Date.now();

  const settled = await Promise.all(
    entries.map(async ([key, fn]) => {
      const t0 = Date.now();
      try {
        const value = await fn();
        return { key, value, ms: Date.now() - t0, ok: true };
      } catch (err) {
        return { key, ms: Date.now() - t0, ok: false, err };
      }
    })
  );

  for (const row of settled) {
    if (row.ok) {
      timer.checkpoint(`${batchLabel}.${row.key}`, { ms: row.ms });
    } else {
      timer.checkpoint(`${batchLabel}.${row.key}`, { ms: row.ms, error: row.err?.message });
      throw row.err;
    }
  }

  timer.checkpoint(batchLabel, { batch_wall_ms: Date.now() - batchStart });
  return Object.fromEntries(settled.map((row) => [row.key, row.value]));
}

function wrapCron(name, fn) {
  return async () => {
    const { acquireCronMongoSlot } = require('./mongoCronBudget');
    let release = () => {};
    const timer = createTimer(`Cron: ${name}`);
    try {
      release = await acquireCronMongoSlot(name);
      timer.checkpoint('cron_tick_start');
      await fn();
      timer.finish('success');
    } catch (err) {
      timer.finish(`error: ${err.message}`);
    } finally {
      release();
    }
  };
}

module.exports = { createTimer, timeParallel, wrapCron, PERF_LOGGING };
