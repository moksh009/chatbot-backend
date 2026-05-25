'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function testReplayWiring() {
  const dynamic = read('routes/dynamicClientRouter.js');
  const ig = read('controllers/igAutomation/webhookController.js');
  assert.ok(dynamic.includes('metaPayloadReplayGuard'));
  assert.ok(dynamic.includes('webhookReplayDuplicate'));
  assert.ok(ig.includes('igWebhookReplayGuard'));
  assert.ok(ig.includes('duplicate: true'));
}

async function testReplayGuardDedupes() {
  const { replayGuard, metaPayloadReplayGuard } = require('../../middleware/webhookReplayGuard');

  const store = new Map();
  const mockRedis = {
    set: async (key, val, exFlag, ttl, nxFlag) => {
      if (nxFlag === 'NX' && store.has(key)) return null;
      store.set(key, val);
      return 'OK';
    },
  };
  const orig = require('../../utils/core/redisFactory').getAppRedis;
  require('../../utils/core/redisFactory').getAppRedis = () => mockRedis;

  try {
    const calls = [];
    const run = (guard, body) =>
      new Promise((resolve) => {
        const req = {
          body,
          rawBody: Buffer.from(JSON.stringify(body)),
          get: (h) => req.headers[h.toLowerCase()] || req.headers[h],
          headers: { 'x-hub-signature-256': 'sha256=abc' },
        };
        const res = {
          statusCode: 200,
          payload: null,
          status(c) {
            this.statusCode = c;
            return this;
          },
          json(p) {
            this.payload = p;
            resolve();
          },
        };
        guard(req, res, () => {
          calls.push('next');
          resolve();
        });
      });

    const body = { entry: [{ time: 123, changes: [{ value: { messages: [{ id: 'm1' }] } }] }] };
    await run(metaPayloadReplayGuard(), body);
    await run(metaPayloadReplayGuard(), body);
    assert.strictEqual(calls.length, 1, 'second meta payload should be duplicate');

    const igBody = {
      entry: [
        {
          changes: [{ field: 'comments', value: { id: 'comment-99' } }],
        },
      ],
    };
    const { igWebhookReplayGuard } = require('../../middleware/webhookReplayGuard');
    store.clear();
    let igNext = 0;
    const igReq = {
      body: igBody,
      get: () => null,
      headers: {},
    };
    await new Promise((resolve) => {
      igWebhookReplayGuard()(igReq, { status: () => ({ json: () => resolve() }) }, () => {
        igNext += 1;
        resolve();
      });
    });
    await new Promise((resolve) => {
      igWebhookReplayGuard()(igReq, { status: () => ({ json: (p) => { assert.ok(p.duplicate); resolve(); } }) }, () => {
        igNext += 1;
        resolve();
      });
    });
    assert.strictEqual(igNext, 1);
  } finally {
    require('../../utils/core/redisFactory').getAppRedis = orig;
  }
}

async function main() {
  testReplayWiring();
  await testReplayGuardDedupes();
  console.log('✓ replayGuardCompletion tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
