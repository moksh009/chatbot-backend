'use strict';

const assert = require('assert');

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

async function bench(name, fn, n = 1000) {
  const samples = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const p = p95(samples);
  console.log(`${name}: p95=${p.toFixed(3)}ms (n=${n})`);
  return p;
}

async function main() {
  process.env.SKIP_AUDIT_PERSIST = 'true';
  const { requireRoleCategory } = require('../../middleware/requireRole');
  const { verifyTenantScope } = require('../../middleware/verifyTenantScope');
  const { requirePaidOrTrial } = require('../../middleware/requirePaidOrTrial');
  const { auditLog } = require('../../services/audit/auditWriter');

  const req = {
    user: { role: 'CLIENT_ADMIN', clientId: 'perf_a', _id: '000000000000000000000001' },
    params: { clientId: 'perf_a' },
    method: 'GET',
    originalUrl: '/api/billing/perf_a',
    ip: '127.0.0.1',
    get: () => '',
  };
  const res = { status() { return this; }, json() {} };

  const roleMw = requireRoleCategory('read');
  const scopeMw = verifyTenantScope();
  const paidMw = requirePaidOrTrial();

  const roleP = await bench('requireRole', () => new Promise((r) => roleMw(req, res, r)), 1000);
  const scopeP = await bench('verifyTenantScope(param)', () => new Promise((r) => scopeMw(req, res, r)), 1000);

  const auditSamples = [];
  for (let i = 0; i < 1000; i += 1) {
    const t0 = process.hrtime.bigint();
    auditLog({ category: 'auth', action: 'test', clientId: 'perf_a' });
    auditSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const auditP = p95(auditSamples);
  console.log(`auditWriter overhead: p95=${auditP.toFixed(3)}ms`);

  assert.ok(roleP <= 1, `requireRole p95 ${roleP} > 1ms`);
  assert.ok(scopeP <= 5, `verifyTenantScope p95 ${scopeP} > 5ms`);
  assert.ok(auditP <= 1, `auditWriter p95 ${auditP} > 1ms`);

  console.log('✓ phase5SecurityPerf gates passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
