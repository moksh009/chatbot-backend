const crypto = require('crypto');
const { getAppRedis } = require('../../core/redisFactory');
const { emitToClient } = require('../../core/socket');

const COUNTERS = ['queued', 'processing', 'retrying', 'sent', 'delivered', 'failed', 'cancelled'];

function progressKey(campaignId) {
  return `campaign:progress:${campaignId}`;
}

async function incrCampaignProgress(campaignId, field, delta = 1) {
  const redis = getAppRedis();
  if (!redis || !COUNTERS.includes(field)) return;
  await redis.hincrby(progressKey(campaignId), field, delta);
  await redis.hset(progressKey(campaignId), 'lastUpdateTs', String(Date.now()));
}

async function readCampaignProgress(campaignId) {
  const redis = getAppRedis();
  const out = {};
  if (!redis) return out;
  const raw = await redis.hgetall(progressKey(campaignId));
  for (const c of COUNTERS) out[c] = Number(raw[c] || 0);
  out.lastUpdateTs = Number(raw.lastUpdateTs || 0);
  return out;
}

function computePercent(counts, totalHint = 0) {
  const total =
    totalHint ||
    COUNTERS.reduce((s, k) => s + (counts[k] || 0), 0);
  if (!total) return 0;
  const done = (counts.sent || 0) + (counts.delivered || 0) + (counts.failed || 0) + (counts.cancelled || 0);
  return Math.min(100, Math.round((done / total) * 100));
}

function computeEtaSeconds(counts, sustainedPerSec = 10) {
  const pending = (counts.queued || 0) + (counts.processing || 0) + (counts.retrying || 0);
  if (!pending || !sustainedPerSec) return null;
  return Math.min(86400, Math.ceil(pending / sustainedPerSec));
}

const lastEmit = new Map();

async function flushCampaignProgress(campaignId, clientId, meta = {}) {
  const counts = await readCampaignProgress(campaignId);
  const now = Date.now();
  const last = lastEmit.get(String(campaignId)) || 0;
  if (now - last < 500) return false;
  lastEmit.set(String(campaignId), now);

  const percent = computePercent(counts, meta.totalHint);
  const etaSeconds = computeEtaSeconds(counts, meta.sustainedPerSec || 10);
  emitToClient(clientId, 'campaign:progress', {
    campaignId: String(campaignId),
    counts,
    percent,
    etaSeconds,
    throttledUntil: meta.throttledUntil || null,
  });
  return true;
}

function assignAbVariant({ campaignId, leadKey, variants, holdbackPercent = 0 }) {
  const hash = crypto.createHash('sha256').update(`${campaignId}:${leadKey}`).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;
  if (bucket < holdbackPercent) return { holdback: true, variantId: null };
  const weights = variants.map((v) => Number(v.weight || 50));
  const total = weights.reduce((a, b) => a + b, 0) || 100;
  let cursor = (parseInt(hash.slice(8, 16), 16) % total) + 1;
  for (let i = 0; i < variants.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) return { holdback: false, variantId: variants[i].id || variants[i].label, variant: variants[i] };
  }
  return { holdback: false, variantId: variants[0]?.id || variants[0]?.label, variant: variants[0] };
}

module.exports = {
  incrCampaignProgress,
  readCampaignProgress,
  flushCampaignProgress,
  computePercent,
  computeEtaSeconds,
  assignAbVariant,
};
