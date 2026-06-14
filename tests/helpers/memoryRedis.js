/**
 * In-memory Redis shim for phase 2 E2E (no external Redis required).
 */
function createMemoryRedis() {
  const strings = new Map();
  const hashes = new Map();
  const expiries = new Map();

  function alive(key) {
    const exp = expiries.get(key);
    if (exp && Date.now() > exp) {
      strings.delete(key);
      expiries.delete(key);
      return false;
    }
    return strings.has(key);
  }

  return {
    status: 'ready',
    async get(key) {
      return alive(key) ? strings.get(key) : null;
    },
    async set(key, value, ...args) {
      let nx = false;
      let ex = null;
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === 'NX') nx = true;
        if (args[i] === 'EX' && args[i + 1]) ex = Number(args[i + 1]);
      }
      if (nx && alive(key)) return null;
      strings.set(key, String(value));
      if (ex) expiries.set(key, Date.now() + ex * 1000);
      else expiries.delete(key);
      return 'OK';
    },
    async setex(key, ttl, value) {
      strings.set(key, String(value));
      expiries.set(key, Date.now() + Number(ttl) * 1000);
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const key of keys) {
        if (strings.delete(key)) n += 1;
        hashes.delete(key);
        expiries.delete(key);
      }
      return n;
    },
    async incr(key) {
      const cur = alive(key) ? Number(strings.get(key) || 0) : 0;
      const next = cur + 1;
      strings.set(key, String(next));
      return next;
    },
    async incrby(key, delta = 1) {
      const cur = alive(key) ? Number(strings.get(key) || 0) : 0;
      const next = cur + Number(delta);
      strings.set(key, String(next));
      return next;
    },
    async decr(key) {
      const cur = alive(key) ? Number(strings.get(key) || 0) : 0;
      const next = Math.max(0, cur - 1);
      strings.set(key, String(next));
      return next;
    },
    async expire(key, ttl) {
      if (!strings.has(key) && !hashes.has(key)) return 0;
      expiries.set(key, Date.now() + Number(ttl) * 1000);
      return 1;
    },
    async hincrby(key, field, delta = 1) {
      const h = hashes.get(key) || {};
      h[field] = String(Number(h[field] || 0) + Number(delta));
      hashes.set(key, h);
      return Number(h[field]);
    },
    async hset(key, field, value) {
      const h = hashes.get(key) || {};
      h[field] = String(value);
      hashes.set(key, h);
      return 1;
    },
    async hgetall(key) {
      const h = hashes.get(key);
      if (!h) return {};
      return { ...h };
    },
    pipeline() {
      const ops = [];
      const pipe = {
        del(...keys) {
          ops.push(keys);
          return pipe;
        },
        exec: async () => {
          const out = [];
          for (const keys of ops) {
            let n = 0;
            for (const key of keys) {
              if (strings.delete(key)) n += 1;
              expiries.delete(key);
            }
            out.push([null, n]);
          }
          return out;
        },
      };
      return pipe;
    },
    async scan(cursor, ...args) {
      let pattern = '*';
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === 'MATCH' && args[i + 1]) pattern = args[i + 1];
      }
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      const keys = [...strings.keys()].filter((k) => {
        if (!alive(k)) return false;
        return pattern === '*' || k.startsWith(prefix);
      });
      return ['0', keys];
    },
  };
}

function injectMemoryRedis() {
  const mem = createMemoryRedis();
  const { __setAppRedisForTests, __setQueueRedisForTests } = require('../../utils/core/redisFactory');
  __setAppRedisForTests(mem);
  __setQueueRedisForTests(null);
  return mem;
}

function resetMemoryRedis() {
  const { __resetAppRedisForTests } = require('../../utils/core/redisFactory');
  __resetAppRedisForTests();
}

module.exports = { createMemoryRedis, injectMemoryRedis, resetMemoryRedis };
