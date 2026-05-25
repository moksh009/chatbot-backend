'use strict';

process.env.SKIP_AUDIT_PERSIST = 'true';
const assert = require('assert');

async function testVerifyTenantScopeBlocks() {
  const { verifyTenantScope } = require('../../middleware/verifyTenantScope');
  const mw = verifyTenantScope();
  const req = {
    user: { role: 'CLIENT_ADMIN', clientId: 'tenant_a', _id: '000000000000000000000001' },
    params: { clientId: 'tenant_b' },
    originalUrl: '/api/billing/tenant_b',
    method: 'GET',
    ip: '127.0.0.1',
    get: () => '',
  };
  let status = 0;
  const res = {
    status(c) {
      status = c;
      return res;
    },
    json() {},
  };
  await new Promise((resolve) => mw(req, res, resolve));
  assert.strictEqual(status, 403);
}

async function testSuperAdminBypass() {
  const { verifyTenantScope } = require('../../middleware/verifyTenantScope');
  const mw = verifyTenantScope();
  let called = false;
  const req = {
    user: { role: 'SUPER_ADMIN', clientId: 'tenant_a' },
    params: { clientId: 'tenant_b' },
    originalUrl: '/api/billing/tenant_b',
    method: 'GET',
    ip: '127.0.0.1',
    get: () => '',
  };
  const res = { status() { return res; }, json() {} };
  await new Promise((resolve) => mw(req, res, () => { called = true; resolve(); }));
  assert.ok(called);
}

async function testEnforceClientScopeThrows() {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'staging';
  process.env.ENFORCE_CLIENT_SCOPE = 'true';
  const Campaign = require('../../models/Campaign');
  let threw = false;
  try {
    await Campaign.find({ status: 'DRAFT' }).setOptions({ bypassClientScope: false });
  } catch (e) {
    threw = e.code === 'CLIENT_SCOPE_REQUIRED';
  }
  process.env.NODE_ENV = prev;
  assert.ok(threw, 'scoped find without clientId must throw');
}

async function main() {
  await testVerifyTenantScopeBlocks();
  await testSuperAdminBypass();
  await testEnforceClientScopeThrows();
  console.log('✓ crossTenantIsolation tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
