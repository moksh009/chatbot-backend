'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRedis } = require('./helpers/memoryRedis');
const { redisIncrBy, incrementEmailCount, checkEmailDailyLimit } = require('../utils/core/emailRateLimiter');
const { __setAppRedisForTests, __resetAppRedisForTests } = require('../utils/core/redisFactory');

test('redisIncrBy uses incrby on memory redis shim', async () => {
  const redis = createMemoryRedis();
  await redisIncrBy(redis, 'email:daily:test:20260614', 3);
  assert.equal(await redis.get('email:daily:test:20260614'), '3');
});

test('incrementEmailCount increments daily key via getAppRedis', async () => {
  const redis = createMemoryRedis();
  __setAppRedisForTests(redis);
  try {
    await incrementEmailCount('client_a', 2);
    const key = `email:daily:client_a:${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}`;
    assert.equal(await redis.get(key), '2');
  } finally {
    __resetAppRedisForTests();
  }
});

test('checkEmailDailyLimit allows when under cap', async () => {
  const redis = createMemoryRedis();
  __setAppRedisForTests(redis);
  try {
    const check = await checkEmailDailyLimit('client_b', 1);
    assert.equal(check.allowed, true);
  } finally {
    __resetAppRedisForTests();
  }
});
