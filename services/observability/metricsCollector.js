'use strict';

const { getAppRedis } = require('../../utils/core/redisFactory');

const buffers = new Map();

function record(metric, value = 1, tags = {}) {
  const key = `${metric}:${JSON.stringify(tags)}`;
  if (!buffers.has(key)) buffers.set(key, []);
  const buf = buffers.get(key);
  buf.push({ ts: Date.now(), value });
  if (buf.length > 500) buf.shift();
}

async function flush() {
  const redis = getAppRedis();
  if (!redis) return;
  const ts = Math.floor(Date.now() / 30000);
  for (const [key, buf] of buffers.entries()) {
    const sum = buf.reduce((s, x) => s + x.value, 0);
    await redis.set(`metrics:${ts}:${key}`, String(sum), 'EX', 86400);
  }
}

function snapshot() {
  const out = {};
  for (const [key, buf] of buffers.entries()) {
    const vals = buf.map((x) => x.value);
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    const p95 = vals[Math.floor(vals.length * 0.95)] || 0;
    out[key] = { count: vals.length, sum: vals.reduce((a, b) => a + b, 0), p95 };
  }
  return out;
}

setInterval(() => flush().catch(() => {}), 30000).unref?.();

module.exports = { record, snapshot, flush };
