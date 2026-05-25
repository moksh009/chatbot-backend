'use strict';

const crypto = require('crypto');
const Message = require('../../models/Message');
const AdLead = require('../../models/AdLead');
const Client = require('../../models/Client');
const Conversation = require('../../models/Conversation');
const { analyzeSentiment } = require('../../utils/core/sentimentEngine');
const { getAppRedis } = require('../../utils/core/redisFactory');
const log = require('../../utils/core/logger')('SentimentScoring');

function toScore100(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= 100) return Math.round(n);
  if (n >= -1 && n <= 1) return Math.round((n + 1) * 50);
  return 50;
}

function toLabel(sentiment, score100) {
  const s = String(sentiment || '').toLowerCase();
  if (score100 < 20 || s.includes('frustrat') || s.includes('urgent') || s.includes('negative')) {
    return 'negative';
  }
  if (score100 > 70 || s.includes('positive')) return 'positive';
  return 'neutral';
}

async function runSentimentScoring(messageId) {
  try {
    const msg = await Message.findById(messageId).lean();
    if (!msg || msg.direction === 'outgoing') return;
    const text = msg.content || msg.body || '';
    if (!text.trim()) return;

    const redis = getAppRedis();
    const hash = crypto.createHash('sha1').update(text.trim().toLowerCase()).digest('hex');
    const cacheKey = `sentiment_cache:${hash}`;
    let result = null;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) result = JSON.parse(cached);
    }

    if (!result) {
      const client = await Client.findOne({ clientId: msg.clientId }).lean();
      const analyzed = await analyzeSentiment(text, client || {});
      const score100 = toScore100(analyzed.score);
      result = {
        score: score100,
        label: toLabel(analyzed.sentiment, score100),
        summary: analyzed.summary || '',
      };
      if (redis) await redis.set(cacheKey, JSON.stringify(result), 'EX', 7 * 86400);
    }

    await Message.updateOne(
      { _id: messageId },
      { $set: { sentimentScore: result.score, sentimentLabel: result.label } }
    );

    const phone = msg.from || msg.phone;
    try {
      const { recordSentimentOutcome } = require('../../services/training/trainingOutcomeTracker');
      await recordSentimentOutcome(msg.clientId, phone, result.score);
    } catch (_) {}
    if (phone) {
      const recent = await Message.find({
        clientId: msg.clientId,
        $or: [{ from: phone }, { phone }],
        sentimentScore: { $exists: true },
      })
        .sort({ timestamp: -1 })
        .limit(10)
        .select('sentimentScore')
        .lean();
      const avg =
        recent.length > 0
          ? recent.reduce((s, m) => s + (m.sentimentScore || 50), 0) / recent.length
          : result.score;
      await AdLead.updateOne(
        { clientId: msg.clientId, phoneNumber: phone },
        { $set: { recentSentimentTrend: Math.round(avg), lastActivityAt: new Date() } }
      );
    }

    if (result.score < 20) {
      const client = await Client.findOne({ clientId: msg.clientId })
        .select('complianceConfig')
        .lean();
      if (client?.complianceConfig?.autoHandoffOnNegative) {
        await Conversation.updateMany(
          { clientId: msg.clientId, phone },
          { $set: { botPaused: true, botStatus: 'paused' } }
        );
      }
      try {
        const { getIo } = require('../../utils/core/socket');
        const io = getIo?.();
        io?.to(`client_${msg.clientId}`)?.emit('attention_required', {
          phone,
          messageId,
          sentimentScore: result.score,
          reason: 'negative_sentiment',
        });
      } catch (_) {}
    }
  } catch (e) {
    log.warn(`runSentimentScoring failed: ${e.message}`);
  }
}

module.exports = { runSentimentScoring };
