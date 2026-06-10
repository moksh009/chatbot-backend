const log = require('./logger')('InboundQueue');

/** @type {Map<string, { timer: NodeJS.Timeout | null, latest: object | null, client: object, run: Function }>} */
const pendingBySession = new Map();

const DEBOUNCE_MS = parseInt(process.env.INBOUND_QUEUE_DEBOUNCE_MS || '300', 10) || 300;
const FIRST_MESSAGE_FLUSH_MS = parseInt(process.env.INBOUND_QUEUE_FIRST_FLUSH_MS || '0', 10) || 0;
const LOCK_RETRY_MS = parseInt(process.env.INBOUND_LOCK_RETRY_MS || '1500', 10) || 1500;
const MAX_RETRIES = parseInt(process.env.INBOUND_QUEUE_MAX_RETRIES || '3', 10) || 3;

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
    scheduleFlush(key, existing, DEBOUNCE_MS);
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
  scheduleFlush(key, entry, FIRST_MESSAGE_FLUSH_MS);
}

function scheduleFlush(key, entry, delayMs = DEBOUNCE_MS) {
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
        scheduleFlush(key, entry, LOCK_RETRY_MS);
      }
    } catch (err) {
      log.error(`[InboundQueue] Processor failed for ${key}:`, err.message);
      if (entry.retries < MAX_RETRIES && !String(err.message || "").includes("timed out")) {
        entry.retries += 1;
        entry.latest = msg;
        entry.client = client;
        entry.run = run;
        pendingBySession.set(key, entry);
        scheduleFlush(key, entry, DEBOUNCE_MS);
      }
    }
  }, delayMs);
}

module.exports = { enqueueInboundProcessing };
