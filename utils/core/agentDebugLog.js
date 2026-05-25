/**
 * Session debug NDJSON (workspace log + optional local ingest). No secrets/PII.
 * Session: 0087e3
 */
const fs = require('fs');
const path = require('path');

// Prefer repo .cursor (IDE session); fallback to backend/logs (always writable in CI/sandbox).
const PRIMARY_LOG = path.join(__dirname, '..', '..', '.cursor', 'debug-0087e3.log');
const FALLBACK_LOG = path.join(__dirname, '..', 'logs', 'debug-0087e3.log');
const LOG_PATH = process.env.AGENT_DEBUG_LOG_PATH || PRIMARY_LOG;
function logTargets() {
  if (process.env.AGENT_DEBUG_LOG_PATH) return [LOG_PATH];
  return [PRIMARY_LOG, FALLBACK_LOG];
}
const INGEST = 'http://127.0.0.1:7454/ingest/79e241af-7b54-4cf4-b08a-d7bef56b4d69';
const SESSION_ID = '0087e3';

function agentDebug(payload) {
  const body = {
    sessionId: SESSION_ID,
    timestamp: Date.now(),
    ...payload
  };
  const line = `${JSON.stringify(body)}\n`;
  for (const target of logTargets()) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, line);
      break;
    } catch (_) {
      /* try next path */
    }
  }
  fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
    body: JSON.stringify(body)
  }).catch(() => {});
}

module.exports = { agentDebug, LOG_PATH, PRIMARY_LOG, FALLBACK_LOG, SESSION_ID };
