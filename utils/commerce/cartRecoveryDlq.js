'use strict';

const crypto = require('crypto');
const { getAppRedis } = require('../core/redisFactory');

const DLQ_MAX = 500;
const DLQ_TTL_SEC = 14 * 24 * 3600;

function dlqKey(clientId) {
  return `cart_recovery:dlq:${clientId}`;
}

function parseEntry(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function pushCartRecoveryDlq(entry) {
  const redis = getAppRedis();
  if (!redis || redis.status !== 'ready') return null;

  const payload = {
    id: entry.id || crypto.randomUUID(),
    clientId: entry.clientId,
    leadId: String(entry.leadId || ''),
    stepNum: Number(entry.stepNum) || 0,
    phone: entry.phone || '',
    templateName: entry.templateName || '',
    reason: String(entry.reason || 'failed').slice(0, 128),
    detail: String(entry.detail || '').slice(0, 512),
    createdAt: entry.createdAt || Date.now(),
    replayCount: Number(entry.replayCount) || 0,
  };

  const key = dlqKey(entry.clientId);
  await redis.lpush(key, JSON.stringify(payload));
  await redis.ltrim(key, 0, DLQ_MAX - 1);
  await redis.expire(key, DLQ_TTL_SEC);
  return payload;
}

async function listCartRecoveryDlq(clientId, limit = 50) {
  const redis = getAppRedis();
  if (!redis || redis.status !== 'ready') return [];

  const rows = await redis.lrange(dlqKey(clientId), 0, Math.max(0, limit - 1));
  return rows.map(parseEntry).filter(Boolean);
}

async function findCartRecoveryDlqEntry(clientId, entryId) {
  const items = await listCartRecoveryDlq(clientId, DLQ_MAX);
  return items.find((e) => e.id === entryId) || null;
}

async function removeCartRecoveryDlqEntry(clientId, entryId) {
  const redis = getAppRedis();
  if (!redis || redis.status !== 'ready') return false;

  const key = dlqKey(clientId);
  const rows = await redis.lrange(key, 0, DLQ_MAX - 1);
  const kept = rows.filter((raw) => {
    const e = parseEntry(raw);
    return e && e.id !== entryId;
  });

  await redis.del(key);
  if (kept.length) {
    await redis.rpush(key, ...kept);
    await redis.expire(key, DLQ_TTL_SEC);
  }
  return true;
}

async function replayCartRecoveryDlqEntry(clientId, entryId) {
  const entry = await findCartRecoveryDlqEntry(clientId, entryId);
  if (!entry) return { ok: false, reason: 'not_found' };

  const Client = require('../../models/Client');
  const AdLead = require('../../models/AdLead');
  const client = await Client.findOne({ clientId }).lean();
  const lead = await AdLead.findById(entry.leadId);
  if (!client || !lead) return { ok: false, reason: 'missing_client_or_lead' };

  const { sendRichNudge } = require('../../cron/abandonedCartScheduler');
  const cartRules = (client.commerceAutomations || []).filter((a) => a.meta?.category === 'abandoned_cart');
  const slot = entry.stepNum === 1 ? 'followup_1' : entry.stepNum === 2 ? 'followup_2' : 'followup_3';
  const cartRule = cartRules.find((x) => x.meta?.systemSlot === slot) || null;

  const outcome = await sendRichNudge(client, lead, '', {
    stepNum: Number(entry.stepNum) || 1,
    templateName: entry.templateName || cartRule?.templateName || `cart_recovery_${entry.stepNum || 1}`,
    cartRule,
  });

  if (outcome?.sent) {
    await removeCartRecoveryDlqEntry(clientId, entryId);
    return { ok: true, outcome };
  }
  return { ok: false, reason: outcome?.reason || 'send_failed', detail: outcome?.detail };
}

module.exports = {
  pushCartRecoveryDlq,
  listCartRecoveryDlq,
  findCartRecoveryDlqEntry,
  removeCartRecoveryDlqEntry,
  replayCartRecoveryDlqEntry,
  dlqKey,
};
