/**
 * Phase 2 Slice 7 — global envelope flag removal (no DB).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { shouldUseSendEnvelope } = require('../utils/messaging/envelopeHelpers');

const ROOT = path.join(__dirname, '..');

function testShouldUseSendEnvelopeAlways() {
  assert.strictEqual(shouldUseSendEnvelope(null), true);
  assert.strictEqual(shouldUseSendEnvelope({}), true);
  assert.strictEqual(shouldUseSendEnvelope({ flags: { useSendEnvelope: false } }), true);
}

function testNoForceSendEnvInRuntimeCode() {
  const dirs = ['routes', 'cron', 'services', 'utils', 'controllers'];
  const hits = [];
  for (const dir of dirs) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    walk(base, (file) => {
      if (!file.endsWith('.js')) return;
      const rel = path.relative(ROOT, file);
      if (rel.includes('envelopeHelpers.js')) return;
      const src = fs.readFileSync(file, 'utf8');
      if (src.includes('FORCE_SEND_ENVELOPE')) hits.push(rel);
    });
  }
  assert.strictEqual(hits.length, 0, `FORCE_SEND_ENVELOPE still referenced: ${hits.join(', ')}`);
}

function walk(dir, fn) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, fn);
    else fn(full);
  }
}

function testCampaignCronNoLegacyOptInGate() {
  const src = fs.readFileSync(path.join(ROOT, 'cron/campaignProgressMonitorCron.js'), 'utf8');
  assert.ok(!src.includes('canSendToContact('), 'campaign monitor should not pre-gate with canSendToContact');
  assert.ok(!src.includes('dispatchCampaignMessage'), 'sync send loop removed');
}

function testIgDispatcherNoGraphBypass() {
  const src = fs.readFileSync(
    path.join(ROOT, 'controllers/igAutomation/messageDispatcher.js'),
    'utf8'
  );
  assert.ok(!src.includes('return { legacy: true }'), 'IG must not bypass envelope');
  assert.ok(!src.includes("callInstagramAPI('POST', '/me/messages'"), 'no direct DM Graph fallback');
}

function testMigrationScriptExists() {
  const p = path.join(ROOT, 'scripts/migrations/202605-useSendEnvelope-enable-all.js');
  assert.ok(fs.existsSync(p), 'tenant backfill migration missing');
}

let failed = 0;
for (const [name, fn] of [
  ['shouldUseSendEnvelopeAlways', testShouldUseSendEnvelopeAlways],
  ['noForceSendEnvInRuntimeCode', testNoForceSendEnvInRuntimeCode],
  ['campaignCronNoLegacyOptInGate', testCampaignCronNoLegacyOptInGate],
  ['igDispatcherNoGraphBypass', testIgDispatcherNoGraphBypass],
  ['migrationScriptExists', testMigrationScriptExists],
]) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`✗ ${name}:`, e.message);
  }
}
process.exit(failed ? 1 : 0);
