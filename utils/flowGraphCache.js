"use strict";

const NodeCache = require("node-cache");
const { getAppRedis } = require("./redisFactory");
const { createTimer } = require("./perfLogger");

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
  const timer = createTimer("FlowGraphCache.getCachedFlowGraphAsync", `${clientId}:${flowRef}`);
  timer.checkpoint("START");

  const hit = getCachedFlowGraph(clientId, flowRef);
  if (hit?.nodes?.length) {
    timer.checkpoint("L1 CACHE HIT", {
      nodeCount: hit?.nodes?.length,
      edgeCount: hit?.edges?.length,
    });
    timer.finish("l1_cache_hit");
    return hit;
  }
  if (hit) {
    timer.checkpoint("L1 CACHE SKIP (empty graph)");
  }
  timer.checkpoint("L1 CACHE MISS");

  const redis = getAppRedis();
  if (!redis || redis.status !== "ready") {
    timer.log("Redis not available — caller will load from MongoDB");
    timer.finish("redis_unavailable");
    return null;
  }

  try {
    let raw = await timer.time("Redis GET flow_graph key", () =>
      redis.get(redisKey(clientId, flowRef))
    );
    if (!raw && flowRef) {
      raw = await timer.time("Redis GET alternate flowRef key", () =>
        redis.get(redisKey(clientId, String(flowRef)))
      );
    }
    if (!raw) {
      timer.finish("redis_cache_miss");
      return null;
    }
    const payload = JSON.parse(raw);
    if (payload?.nodes?.length) {
      setCachedFlowGraph(clientId, flowRef, payload);
      timer.checkpoint("parsed + stored in L1", {
        nodeCount: payload?.nodes?.length,
        edgeCount: payload?.edges?.length,
      });
      timer.finish("redis_cache_hit");
      return payload;
    }
    timer.finish("redis_cache_skip_empty");
    return null;
  } catch (err) {
    timer.finish(`error: ${err.message}`);
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
    redis.del(`triggers:${clientId}`, `triggers:v2:${clientId}`).catch(() => {});
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
