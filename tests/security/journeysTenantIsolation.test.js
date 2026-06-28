'use strict';

process.env.SKIP_AUDIT_PERSIST = 'true';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function readJourneysRoute() {
  return fs.readFileSync(path.join(ROOT, 'routes/journeys.js'), 'utf8');
}

async function testJourneysRouteUsesTenantClientId() {
  const src = readJourneysRoute();
  assert.ok(src.includes('tenantClientId(req)'), 'journeys routes must use tenantClientId');
  assert.ok((src.match(/clientId !== req\.params\.clientId/g) || []).length >= 5, 'expected multiple tenant mismatch guards');
}

async function testJourneysRouteUsesProtect() {
  const src = readJourneysRoute();
  assert.ok(src.includes("const { protect } = require('../middleware/auth')"), 'journeys must import protect');
  assert.ok((src.match(/protect/g) || []).length >= 8, 'journeys routes should use protect middleware');
}

async function testMigrationRoutesHaveTenantGuard() {
  const src = readJourneysRoute();
  assert.ok(src.includes("router.get('/:clientId/migration-status', protect"), 'migration-status must be protected');
  assert.ok(src.includes("router.post('/:clientId/migrate-rule', protect"), 'migrate-rule must be protected');
}

async function testStatsRoutesExist() {
  const src = readJourneysRoute();
  assert.ok(src.includes('/:clientId/hub-stats'), 'hub-stats route missing');
  assert.ok(src.includes('/:clientId/:flowId/stats/steps'), 'stats/steps route missing');
  assert.ok(src.includes('/:clientId/:flowId/stats'), 'stats route missing');
  assert.ok(src.includes('journeyStatsService'), 'must delegate to journeyStatsService');
}

async function main() {
  await testJourneysRouteUsesTenantClientId();
  await testJourneysRouteUsesProtect();
  await testMigrationRoutesHaveTenantGuard();
  await testStatsRoutesExist();
  console.log('✓ journeysTenantIsolation tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
