'use strict';

const axios = require('axios');
const { getAppRedis } = require('../core/redisFactory');
const { decryptToken } = require('../core/connectionStatus');
const { auditLog } = require('../../services/audit/auditWriter');
const shopifyAdminApiVersion = require('../shopify/shopifyAdminApiVersion');

const CACHE_TTL = 300;
const graphUrl = () =>
  `https://graph.facebook.com/${process.env.API_VERSION || process.env.WHATSAPP_API_VERSION || 'v21.0'}`;

function cacheKey(clientId, channel) {
  return `connection_probe:${clientId}:${channel}`;
}

async function readProbeCache(clientId, channel) {
  const redis = getAppRedis();
  if (!redis) return null;
  const raw = await redis.get(cacheKey(clientId, channel));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeProbeCache(clientId, channel, payload) {
  const redis = getAppRedis();
  if (!redis) return;
  await redis.set(cacheKey(clientId, channel), JSON.stringify(payload), 'EX', CACHE_TTL);
}

async function probeWhatsApp(client) {
  const token = decryptToken(client.whatsappToken || client.whatsapp?.accessToken || '');
  if (!token || token.length < 8) return { tokenStatus: 'missing', ok: false };

  // Use the WABA or phone-number endpoint — more accurate for System User tokens
  const phoneNumberId = client.phoneNumberId || client.whatsapp?.phoneNumberId;
  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  const probeUrl = phoneNumberId
    ? `${graphUrl()}/${phoneNumberId}`
    : wabaId
      ? `${graphUrl()}/${wabaId}`
      : `${graphUrl()}/me`;

  try {
    const res = await axios.get(probeUrl, {
      params: { access_token: token, fields: 'id' },
      timeout: 4000,          // slightly longer — avoids false positives on slow Meta API
      validateStatus: () => true,
    });
    if (res.status === 200) return { tokenStatus: 'valid', ok: true };
    const errCode = res.data?.error?.code;
    // 190 = token expired/invalid; 100 = param error (token issue); 4 = too many calls
    if (res.status === 401 || errCode === 190 || errCode === 100) {
      return { tokenStatus: 'expired', ok: false };
    }
    // Meta rate-limit (code 4 / 80) or temporary outage — don't mark as expired
    if (errCode === 4 || errCode === 80 || res.status >= 500) {
      return { tokenStatus: 'valid', ok: true };   // assume valid, retry later
    }
    return { tokenStatus: 'unauthorized', ok: false };
  } catch (err) {
    // Network error / timeout — CANNOT determine token validity; treat as valid to avoid false banner
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    const isNetwork = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT';
    if (isTimeout || isNetwork) return { tokenStatus: 'valid', ok: true };
    return { tokenStatus: 'unknown', ok: false };
  }
}

async function probeShopify(client) {
  const token = decryptToken(client.shopifyAccessToken || '');
  const domain = client.shopDomain || client.commerce?.shopify?.domain;
  if (!token || !domain) return { tokenStatus: 'missing', ok: false };
  try {
    const res = await axios.get(
      `https://${domain}/admin/api/${shopifyAdminApiVersion}/shop.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 4000, validateStatus: () => true }
    );
    if (res.status === 200) return { tokenStatus: 'valid', ok: true };
    if (res.status === 401 || res.status === 403) return { tokenStatus: 'expired', ok: false };
    // 5xx or rate limit — assume valid
    return { tokenStatus: 'valid', ok: true };
  } catch (err) {
    const isNetwork = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED';
    return isNetwork ? { tokenStatus: 'valid', ok: true } : { tokenStatus: 'unknown', ok: false };
  }
}

async function probeRazorpay(client) {
  const keyId = client.razorpayKeyId || process.env.RAZORPAY_KEY_ID;
  const keySecret = decryptToken(client.razorpayKeySecret || '');
  if (!keyId || !keySecret) return { tokenStatus: 'missing', ok: false };
  try {
    const res = await axios.get('https://api.razorpay.com/v1/payments?count=1', {
      auth: { username: keyId, password: keySecret },
      timeout: 2000,
      validateStatus: () => true,
    });
    return res.status === 200
      ? { tokenStatus: 'valid', ok: true }
      : { tokenStatus: 'unauthorized', ok: false };
  } catch {
    return { tokenStatus: 'expired', ok: false };
  }
}

async function probeClientChannels(client) {
  const clientId = client.clientId;
  const channels = {
    whatsapp: await probeWhatsApp(client),
    shopify: await probeShopify(client),
    razorpay: await probeRazorpay(client),
  };
  for (const [ch, result] of Object.entries(channels)) {
    const prev = await readProbeCache(clientId, ch);
    await writeProbeCache(clientId, ch, { ...result, at: new Date().toISOString() });
    if (prev?.tokenStatus === 'valid' && result.tokenStatus !== 'valid') {
      auditLog({
        category: 'integration',
        action: 'integration.token_expired',
        severity: 'warning',
        clientId,
        actor: { type: 'system', source: 'connection_probe' },
        details: { channel: ch, tokenStatus: result.tokenStatus },
      });
      try {
        const { getIo } = require('../core/socket');
        const io = getIo?.();
        io?.to(`client_${clientId}`)?.emit('integration_token_expired', { channel: ch });
      } catch (_) {}
    }
  }
  return channels;
}

async function getCachedOrProbe(client, channel) {
  const cached = await readProbeCache(client.clientId, channel);
  if (cached) return cached;
  const all = await probeClientChannels(client);
  return all[channel] || { tokenStatus: 'missing' };
}

module.exports = {
  probeClientChannels,
  getCachedOrProbe,
  readProbeCache,
  writeProbeCache,
};
