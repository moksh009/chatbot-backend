'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const publicGrowth = require('../../routes/publicGrowth');

describe('publicGrowth deprecation headers', () => {
  it('sets Deprecation and successor Link on responses', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/growth', publicGrowth);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/public/growth/impression`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedKey: 'invalid' }),
      });
      assert.equal(res.headers.get('deprecation'), 'true');
      assert.ok(res.headers.get('sunset'));
      assert.match(res.headers.get('x-topedge-deprecation-notice') || '', /opt-in/i);
      assert.match(res.headers.get('link') || '', /opt-in/i);
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
