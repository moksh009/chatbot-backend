const ScheduledMessage = require('../models/ScheduledMessage');
const Conversation = require('../models/Conversation');
const log = require('./logger')('CSATService');

const DEFAULT_DELAY_MS = 60 * 60 * 1000; // 1 hour
const IDLE_DELAY_MS = 90 * 60 * 1000; // 90 min after last message

function buildCsatListPayload(conversationId) {
  return {
    type: 'list',
    body: {
      text:
        'Hi {{first_name}} 👋\n\nDid we solve your issue today?\n\nPlease rate your experience with *{{bot_name}}* at *{{brand_name}}* (1 = poor, 5 = excellent).',
    },
    action: {
      button: 'Rate experience',
      sections: [
        {
          title: 'Your rating',
          rows: [
            { id: `csat_1_${conversationId}`, title: '⭐ 1 — Poor', description: 'Needs improvement' },
            { id: `csat_2_${conversationId}`, title: '⭐⭐ 2', description: '' },
            { id: `csat_3_${conversationId}`, title: '⭐⭐⭐ 3 — OK', description: '' },
            { id: `csat_4_${conversationId}`, title: '⭐⭐⭐⭐ 4', description: '' },
            { id: `csat_5_${conversationId}`, title: '⭐⭐⭐⭐⭐ 5 — Great', description: 'Excellent' },
          ],
        },
      ],
    },
  };
}

async function scheduleCsatSurvey(conversation, { delayMs = DEFAULT_DELAY_MS, sourceType = 'csat_survey' } = {}) {
  const { _id, clientId, phone, channel } = conversation;
  if (channel !== 'whatsapp') return false;
  if (conversation.csatSent) return false;

  const sendAt = new Date(Date.now() + Math.max(5 * 60 * 1000, delayMs));
  const convoId = String(_id);

  await ScheduledMessage.create({
    clientId,
    phone,
    channel: 'whatsapp',
    messageType: 'interactive',
    content: buildCsatListPayload(convoId),
    sendAt,
    status: 'pending',
    sourceType,
    sourceId: `csat_${convoId}`,
  });

  await Conversation.findByIdAndUpdate(_id, { csatSent: true });
  log.info(`[CSAT] Scheduled ${sourceType} for ${phone} at ${sendAt.toISOString()}`);
  return true;
}

/**
 * Trigger CSAT after agent resolves a conversation (1h delay).
 */
async function triggerCSAT(conversation) {
  try {
    return await scheduleCsatSurvey(conversation, { delayMs: DEFAULT_DELAY_MS, sourceType: 'csat_resolved' });
  } catch (err) {
    log.error(`[CSAT] Failed to trigger CSAT for ${conversation._id}:`, err.message);
    return false;
  }
}

/**
 * Schedule CSAT when chat goes idle (no messages for ~90 min).
 */
async function triggerIdleCSAT(conversation) {
  try {
    return await scheduleCsatSurvey(conversation, { delayMs: IDLE_DELAY_MS, sourceType: 'csat_idle' });
  } catch (err) {
    log.error(`[CSAT] Failed idle CSAT for ${conversation._id}:`, err.message);
    return false;
  }
}

/**
 * Handle CSAT list/button response (called from dualBrainEngine.js).
 */
async function handleCSATResponse(conversationId, buttonId) {
  try {
    const match = String(buttonId || '').match(/^csat_(\d)_/i);
    if (!match) return;
    const rating = parseInt(match[1], 10);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return;

    const convo = await Conversation.findByIdAndUpdate(
      conversationId,
      {
        csatScore: {
          rating,
          respondedAt: new Date(),
          source: 'whatsapp_list',
        },
      },
      { new: true }
    );

    try {
      const BotAnalytics = require('../models/BotAnalytics');
      if (convo?.clientId) {
        await BotAnalytics.create({
          clientId: convo.clientId,
          phoneNumber: convo.phone,
          event: 'csat_rating',
          metadata: { rating, conversationId: String(conversationId), buttonId },
        });
      }
    } catch (analyticsErr) {
      log.warn(`[CSAT] Analytics log skipped: ${analyticsErr.message}`);
    }

    log.info(`[CSAT] Recorded rating ${rating} for convo ${conversationId}`);
    if (rating >= 4) {
      return 'Thank you so much! 🙏 We are glad we could help. Have a wonderful day!';
    }
    if (rating === 3) {
      return 'Thanks for your feedback. We will keep improving — message us anytime if you need more help.';
    }
    return 'Sorry we missed the mark. A team member may follow up shortly to make this right.';
  } catch (err) {
    console.error('[CSAT] Error saving response:', err);
    return null;
  }
}

module.exports = { triggerCSAT, triggerIdleCSAT, handleCSATResponse, scheduleCsatSurvey };
