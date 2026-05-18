"use strict";

const NodeCache = require("node-cache");
const { getAppRedis } = require("./redisFactory");

const TTL_SEC = Number(process.env.FLOW_GRAPH_CACHE_TTL_SEC || 300);

/** L1 — in-process (fast, lost on restart) */
const graphCache = new NodeCache({ stdTTL: TTL_SEC, checkperiod: 60, maxKeys: 500 });

function l1Key(clientId, flowRef) {
  return `fg:${clientId}:${String(flowRef || "").trim()}`;
}

function redisKey(clientId, flowRef) {
  return `flow_graph:${clientId}:${String(flowRef || "").trim()}`;
}

function getCachedFlowGraph(clientId, flowRef) {
  if (!clientId || !flowRef) return null;
  return graphCache.get(l1Key(clientId, flowRef)) || null;
}

function setCachedFlowGraph(clientId, flowRef, payload) {
  if (!clientId || !flowRef || !payload) return;
  graphCache.set(l1Key(clientId, flowRef), payload);
  if (payload.flowId && String(payload.flowId) !== String(flowRef)) {
    graphCache.set(l1Key(clientId, payload.flowId), payload);
  }
  if (payload.mongoId && String(payload.mongoId) !== String(flowRef)) {
    graphCache.set(l1Key(clientId, payload.mongoId), payload);
  }
  const redis = getAppRedis();
  if (redis && redis.status === "ready") {
    const serialized = JSON.stringify(payload);
    const keys = new Set([
      redisKey(clientId, flowRef),
      payload.flowId ? redisKey(clientId, payload.flowId) : null,
      payload.mongoId ? redisKey(clientId, payload.mongoId) : null,
    ]);
    for (const k of keys) {
      if (k) redis.setex(k, TTL_SEC, serialized).catch(() => {});
    }
  }
}

/** L2 Redis + L1 — use on hot path when L1 may be cold after deploy */
async function getCachedFlowGraphAsync(clientId, flowRef) {
  const hit = getCachedFlowGraph(clientId, flowRef);
  if (hit) return hit;

  const redis = getAppRedis();
  if (!redis || redis.status !== "ready") return null;

  try {
    let raw = await redis.get(redisKey(clientId, flowRef));
    if (!raw && flowRef) {
      raw = await redis.get(redisKey(clientId, String(flowRef)));
    }
    if (!raw) return null;
    const payload = JSON.parse(raw);
    setCachedFlowGraph(clientId, flowRef, payload);
    return payload;
  } catch (_) {
    return null;
  }
}

function invalidateFlowGraphCache(clientId, flowRef) {
  if (!clientId) return;
  if (flowRef) {
    graphCache.del(l1Key(clientId, flowRef));
    const redis = getAppRedis();
    if (redis && redis.status === "ready") {
      redis.del(redisKey(clientId, flowRef)).catch(() => {});
    }
    return;
  }
  const prefix = `fg:${clientId}:`;
  graphCache.keys().forEach((k) => {
    if (String(k).startsWith(prefix)) graphCache.del(k);
  });
  const redis = getAppRedis();
  if (redis && redis.status === "ready") {
    redis.keys(`flow_graph:${clientId}:*`).then((keys) => {
      if (keys?.length) redis.del(...keys).catch(() => {});
    }).catch(() => {});
  }
}

function invalidateTriggerListCache(clientId) {
  const redis = getAppRedis();
  if (redis && redis.status === "ready") {
    redis.del(`triggers:${clientId}`).catch(() => {});
  }
}

module.exports = {
  getCachedFlowGraph,
  getCachedFlowGraphAsync,
  setCachedFlowGraph,
  invalidateFlowGraphCache,
  invalidateTriggerListCache,
  TTL_SEC,
};
