'use strict';

/**
 * Abandoned cart API routes use verifyClientAccess — cross-tenant blocked.
 */
const assert = require('assert');

async function testVerifyClientAccessBlocksCrossTenant() {
  const { verifyClientAccess } = require('../../middleware/auth');
  const req = {
    user: { role: 'CLIENT_ADMIN', clientId: 'tenant_a' },
    params: { clientId: 'tenant_b' },
  };
  let status = 0;
  const res = {
    status(c) {
      status = c;
      return res;
    },
    json() {},
  };
  await new Promise((resolve) => verifyClientAccess(req, res, resolve));
  assert.strictEqual(status, 403);
}

async function testVerifyClientAccessAllowsSameTenant() {
  const { verifyClientAccess } = require('../../middleware/auth');
  let called = false;
  const req = {
    user: { role: 'CLIENT_ADMIN', clientId: 'tenant_a' },
    params: { clientId: 'tenant_a' },
  };
  const res = { status() { return res; }, json() {} };
  await new Promise((resolve) => verifyClientAccess(req, res, () => {
    called = true;
    resolve();
  }));
  assert.ok(called);
}

async function main() {
  await testVerifyClientAccessBlocksCrossTenant();
  await testVerifyClientAccessAllowsSameTenant();
  console.log('✓ abandonedCartRoutes security tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
