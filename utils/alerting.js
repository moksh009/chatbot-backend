/**
 * Optional outbound alerts when health degrades (Slack/Discord generic webhook).
 * Set ALERT_WEBHOOK_URL. Rate-limited in-memory to avoid storms.
 */

const axios = require('axios');
const log = require('./logger')('Alerting');

let lastAlertAt = 0;
const MIN_INTERVAL_MS = 120000;

async function alertDegraded(reason, detail = {}) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  const now = Date.now();
  if (now - lastAlertAt < MIN_INTERVAL_MS) return;
  lastAlertAt = now;

  const payload = {
    text: `[${process.env.NODE_ENV || 'development'}] Chatbot backend degraded: ${reason}`,
    detail,
    ts: new Date().toISOString()
  };

  try {
    await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000
    });
  } catch (e) {
    log.warn('Alert webhook failed:', e.message);
  }
}

module.exports = { alertDegraded };
