'use strict';

const { getAppRedis } = require('../utils/core/redisFactory');

function replayGuard({ header, keyPrefix = 'webhook_replay', ttlSec = 3600, idFromBody } = {}) {
  return async (req, res, next) => {
    const id = req.get(header) || (idFromBody ? idFromBody(req) : null);
    if (!id) return next();
    const redis = getAppRedis();
    if (!redis) return next();
    const key = `${keyPrefix}:${id}`;
    try {
      const set = await redis.set(key, '1', 'EX', ttlSec, 'NX');
      if (set !== 'OK') {
        req.webhookReplayDuplicate = true;
        return res.status(200).json({ ok: true, duplicate: true });
      }
    } catch (e) {
      process.stderr.write(`[replayGuard] ${e.message}\n`);
    }
    return next();
  };
}

function metaPayloadReplayGuard() {
  return async (req, res, next) => {
    const crypto = require('crypto');
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const sig = req.get('x-hub-signature-256') || '';
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const entryTs =
      req.body?.entry?.[0]?.time ||
      req.body?.entry?.[0]?.changes?.[0]?.value?.timestamp ||
      '';
    const id = `${sig.slice(0, 16)}:${hash.slice(0, 32)}:${entryTs}`;
    req.headers['x-meta-replay-id'] = id;
    return replayGuard({ header: 'x-meta-replay-id', keyPrefix: 'meta_replay', ttlSec: 300 })(req, res, next);
  };
}

/** IG automation webhook — per-event replay keys, 1h TTL (longer Meta retries). */
function igWebhookReplayGuard() {
  return replayGuard({
    header: 'x-ig-replay-id',
    keyPrefix: 'ig_replay',
    ttlSec: 3600,
    idFromBody: (req) => {
      const entry = req.body?.entry?.[0];
      if (!entry) return null;
      for (const change of entry.changes || []) {
        if (change.field === 'comments') {
          const commentId = change.value?.id || change.value?.comment_id;
          if (commentId) return `comment:${commentId}`;
        }
        if (change.field === 'mentions') {
          const storyId = change.value?.media_id || change.value?.id;
          const senderId = change.value?.from?.id || change.value?.sender_id || '';
          if (storyId) return `story:${storyId}:${senderId}`;
        }
      }
      for (const msg of entry.messaging || []) {
        const messageId = msg.message?.mid;
        if (messageId) return `dm:${messageId}`;
        if (msg.postback?.mid) return `dm:${msg.postback.mid}`;
        const storyId = msg.message?.attachments?.[0]?.payload?.story_id;
        const senderId = msg.sender?.id;
        if (storyId && senderId) return `story:${storyId}:${senderId}`;
      }
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
      return `payload:${hash.slice(0, 32)}`;
    },
  });
}

module.exports = { replayGuard, metaPayloadReplayGuard, igWebhookReplayGuard };
