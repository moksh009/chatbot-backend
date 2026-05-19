#!/usr/bin/env node
/**
 * Plan D — WhatsApp inbound <3s (greeting, queue, lean client, flow cache, AI budget).
 * Usage: node scripts/verifyPlanDChecklist.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');

const staticChecks = [
  ['INBOUND_QUEUE_FIRST_FLUSH_MS=0', '.env.example', 'INBOUND_QUEUE_FIRST_FLUSH_MS=0'],
  ['inbound queue first flush', 'utils/inboundMessageQueue.js', 'FIRST_MESSAGE_FLUSH_MS'],
  ['message_saved_early', 'utils/dualBrainEngine.js', 'message_saved_early'],
  ['greeting_instant_fallback', 'utils/dualBrainEngine.js', 'greeting_instant_fallback'],
  ['flowGraphCache on load', 'utils/dualBrainEngine.js', 'getCachedFlowGraphAsync'],
  ['gemini circuit breaker', 'utils/gemini.js', 'geminiBreaker'],
  ['AI fast timeout', 'utils/gemini.js', 'AI_CALL_TIMEOUT_MS'],
  ['whatsapp inbound lean select', 'utils/clientCache.js', 'getCachedClientForWhatsAppInbound'],
  ['webhook uses inbound select', 'middleware/clientConfig.js', 'getCachedClientForWhatsAppInbound'],
  ['greeting skip translation', 'utils/dualBrainEngine.js', 'skipTranslation: true'],
  ['DUAL_BRAIN_BUDGET_MS env', 'utils/dualBrainEngine.js', 'DUAL_BRAIN_BUDGET_MS'],
];

console.log('\n=== Plan D checklist ===\n');
let failed = 0;

for (const [label, file, needle] of staticChecks) {
  const fp = path.join(root, file);
  const ok = fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}

console.log('\nManual sign-off (API-only, PERF_LOGGING=true):');
console.log('  1. ./scripts/start-api-dev.sh');
console.log('  2. Send "hi" on WhatsApp');
console.log('  3. Expect <3s reply; logs: message_saved_early + greeting_sent OR greeting_instant_fallback\n');

process.exit(failed ? 1 : 0);
