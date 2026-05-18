const log = require('./logger')('InboundQueue');

/** @type {Map<string, { timer: NodeJS.Timeout | null, latest: object | null, client: object, run: Function }>} */
const pendingBySession = new Map();

const DEBOUNCE_MS = 500;
const MAX_RETRIES = 1;

/**
 * Coalesce rapid WhatsApp events for the same customer into one engine run.
 * Prevents pile-ups on Render free tier where each webhook awaited the previous 4+ min run.
 */
function enqueueInboundProcessing({ clientId, phone, parsedMessage, clientConfig, processor }) {
  const key = `${clientId}:${phone}`;
  const existing = pendingBySession.get(key);

  if (existing?.timer) {
    clearTimeout(existing.timer);
    existing.latest = parsedMessage;
    existing.client = clientConfig;
    existing.run = processor;
    existing.retries = existing.retries || 0;
    scheduleFlush(key, existing);
    return;
  }

  const entry = {
    timer: null,
    latest: parsedMessage,
    client: clientConfig,
    run: processor,
    retries: 0,
  };
  pendingBySession.set(key, entry);
  scheduleFlush(key, entry);
}

function scheduleFlush(key, entry) {
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    const msg = entry.latest;
    const client = entry.client;
    const run = entry.run;
    pendingBySession.delete(key);

    if (!msg || !run) return;

    try {
      const handled = await run(msg, client);
      if (handled === false && entry.retries < MAX_RETRIES) {
        entry.retries += 1;
        entry.latest = msg;
        entry.client = client;
        entry.run = run;
        pendingBySession.set(key, entry);
        scheduleFlush(key, entry);
      }
    } catch (err) {
      log.error(`[InboundQueue] Processor failed for ${key}:`, err.message);
      if (entry.retries < MAX_RETRIES && !String(err.message || "").includes("timed out")) {
        entry.retries += 1;
        entry.latest = msg;
        entry.client = client;
        entry.run = run;
        pendingBySession.set(key, entry);
        scheduleFlush(key, entry);
      }
    }
  }, DEBOUNCE_MS);
}

module.exports = { enqueueInboundProcessing };
