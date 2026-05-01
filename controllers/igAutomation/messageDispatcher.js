"use strict";

const IGAutomation = require('../../models/IGAutomation');
const IGAutomationSession = require('../../models/IGAutomationSession');
const Client = require('../../models/Client');
const { decrypt } = require('../../utils/encryption');
const axios = require('axios');
const redis = require('../../utils/redisClient'); // Ensure this points to a valid redis client instance

const igApiCallCounts = new Map(); // tracks calls per token per hour in memory

async function getClientTokenAndId(clientId) {
  const client = await Client.findOne({ clientId })
    .select('igUserId igAccessToken igPageId instagramAccessToken instagramFbPageId instagramPageId')
    .lean();
  
  const rawToken = client?.instagramAccessToken || client?.igAccessToken;
  if (!rawToken) throw new Error(`No IG token for clientId: ${clientId}`);

  return {
    igUserId: client.igUserId || client.instagramPageId,
    pageId: client.instagramFbPageId || client.igPageId,
    accessToken: decrypt(rawToken)
  };
}

async function handleTokenExpiry(tokenPartial) {
  // We only have the last 8 chars — log the event and let the cron handle refresh
  console.error('[IG Token] Token expired during API call. Cron will attempt refresh. Token partial:', tokenPartial);
}

async function callInstagramAPI(method, path, data, accessToken) {
  const tokenKey = accessToken.slice(-8); // use last 8 chars as key, never log full token
  const hourKey = `${tokenKey}:${new Date().getHours()}`;
  const currentCount = igApiCallCounts.get(hourKey) || 0;

  // Soft rate limit warning at 180 calls/hour (hard limit is 200)
  if (currentCount >= 180) {
    console.warn('[IG API] Approaching rate limit for token key:', tokenKey, 'Count:', currentCount);
    await new Promise(resolve => setTimeout(resolve, 5000)); // brief pause
  }

  const url = `https://graph.facebook.com/v21.0${path}`;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios({
        method,
        url,
        data: method !== 'GET' ? data : undefined,
        params: method === 'GET' ? { ...data, access_token: accessToken } : undefined,
        headers: method !== 'GET' ? { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } : undefined,
        timeout: 15000
      });

      // Track call count
      igApiCallCounts.set(hourKey, currentCount + 1);
      return response.data;

    } catch (err) {
      lastError = err;
      if (!err.response) {
        // Network error — retry
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[IG API] Network error attempt ${attempt}, retrying in ${delay}ms:`, err.message);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      const code = err.response.data?.error?.code;
      const msg = err.response.data?.error?.message;
      console.error(`[IG API] Error code ${code}:`, msg);

      if (code === 190) {
        // Token expired — trigger refresh and propagate
        await handleTokenExpiry(tokenKey);
        throw new Error(`Token expired for ${tokenKey}`);
      }
      if (code === 10) throw new Error(`IG permission denied: ${msg}`);
      if (code === 100) throw new Error(`IG invalid parameter: ${msg}`);
      if (code === 613) {
        // Rate limit — wait and retry
        const retryAfter = 3600000 / 200; // ~18 seconds
        console.warn('[IG API] Rate limited. Waiting', retryAfter, 'ms');
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        continue;
      }

      throw new Error(`IG API error ${code}: ${msg}`);
    }
  }

  throw lastError;
}

async function sendOpeningDM(automationId, igsid, clientId) {
  const automation = await IGAutomation.findById(automationId).lean();
  if (!automation) throw new Error(`Automation ${automationId} not found`);

  const { accessToken } = await getClientTokenAndId(clientId);

  const openingText = automation.flow.openingDm;
  const buttonLabel = automation.flow.openingButton;
  const buttonType = automation.flow.openingButtonType || 'postback';
  const flowType = automation.flow.flowType;

  // Validate text length using Unicode code points
  if ([...openingText].length > 640) {
    throw new Error(`Opening DM text exceeds 640 code points for automation ${automationId}`);
  }
  if ([...(buttonLabel || '')].length > 20) {
    throw new Error(`Button label exceeds 20 code points for automation ${automationId}`);
  }

  let button;
  if (buttonLabel) {
    if (flowType === 'follow_gate') {
      button = {
        type: 'postback',
        title: buttonLabel,
        payload: `FOLLOW_CHECK_ATTEMPT_1:${automationId}:${igsid}`
      };
    } else {
      // Standard link flow — opening button routes to second message, so postback
      button = {
        type: 'postback',
        title: buttonLabel,
        payload: `VIEW_CONTENT:${automationId}:${igsid}`
      };
    }
  }

  const payload = {
    recipient: { id: igsid },
    message: button ? {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: openingText,
          buttons: [button]
        }
      }
    } : {
      text: openingText
    }
  };

  await callInstagramAPI('POST', '/me/messages', payload, accessToken);

  // Create session
  await IGAutomationSession.create({
    clientId,
    automationId: automation._id,
    igsid,
    stage: 'opening_sent',
    attemptCount: 0,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });

  await IGAutomation.findByIdAndUpdate(automationId, {
    $inc: { 'stats.totalDmsSent': 1 }
  });

  // Safe emit via socket (requires it's correctly injected or required inline)
  try {
    const { getIO } = require('../../socket');
    getIO().to(`client_${clientId}`).emit('igDmSent', { automationId, igsid });
  } catch(e) {}

  console.log('[Dispatcher] Opening DM sent to igsid:', igsid, 'for automation:', automationId);
}

async function sendCommentReply(automationId, commentId, clientId) {
  const automation = await IGAutomation.findById(automationId).lean();
  if (!automation?.trigger?.commentReplies?.length) return;

  const { accessToken } = await getClientTokenAndId(clientId);

  // Atomic cycle using findOneAndUpdate with $inc
  const updated = await IGAutomation.findByIdAndUpdate(
    automationId,
    { $inc: { commentReplyIndex: 1 } },
    { new: false } // get the value BEFORE increment to use as index
  ).lean();

  const replies = updated.trigger.commentReplies;
  const index = (updated.commentReplyIndex || 0) % replies.length;
  const replyText = replies[index];

  // Post raw text directly — no transformation, no trim, no replace
  await callInstagramAPI('POST', `/${commentId}/replies`, {
    message: replyText
  }, accessToken);

  await IGAutomation.findByIdAndUpdate(automationId, {
    $inc: { 'stats.totalCommentReplies': 1 }
  });

  console.log('[Dispatcher] Comment reply sent to comment:', commentId, 'using reply index:', index);
}

async function handleViewContentPostback(automationId, igsid, clientId) {
  const automation = await IGAutomation.findById(automationId).lean();
  if (!automation) throw new Error(`Automation ${automationId} not found`);

  const session = await IGAutomationSession.findOne({ automationId, igsid });
  if (!session || new Date() > session.expiresAt) {
    console.log('[Dispatcher] Session expired for igsid:', igsid);
    return;
  }

  if (session.stage !== 'opening_sent') {
    console.log('[Dispatcher] Idempotency check: content already sent for igsid:', igsid);
    return;
  }

  const { accessToken } = await getClientTokenAndId(clientId);

  const secondText = automation.flow.secondMessage;
  const linkButtons = automation.flow.linkButtons || [];

  const buttons = linkButtons.slice(0, 3).map(btn => ({
    type: 'web_url',
    url: btn.url,
    title: btn.label.slice(0, 20)
  }));

  const payload = {
    recipient: { id: igsid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: secondText,
          buttons
        }
      }
    }
  };

  await callInstagramAPI('POST', '/me/messages', payload, accessToken);

  await IGAutomationSession.findByIdAndUpdate(session._id, {
    $set: { stage: 'link_sent' }
  });

  await IGAutomation.findByIdAndUpdate(automationId, {
    $inc: { 'stats.totalDmsSent': 1 }
  });
}

async function checkFollowStatus(automationId, igsid, clientId) {
  const automation = await IGAutomation.findById(automationId).lean();
  if (!automation) throw new Error(`Automation ${automationId} not found`);

  const session = await IGAutomationSession.findOne({ automationId, igsid });
  if (!session || new Date() > session.expiresAt) {
    console.log('[Dispatcher] Session expired during follow check for igsid:', igsid);
    return;
  }

  const { igUserId, accessToken } = await getClientTokenAndId(clientId);

  // Check followers list — Redis cache first
  const cacheKey = `ig_followers:${igUserId}`;
  let isFollowing = false;

  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const followerIds = JSON.parse(cached);
      isFollowing = followerIds.includes(igsid);
      console.log('[Dispatcher] Follow check via cache for igsid:', igsid, '— following:', isFollowing);
    }
  }

  if (!isFollowing) {
    // Paginate through followers API
    const followerIds = [];
    let nextUrl = `https://graph.facebook.com/v21.0/${igUserId}/followers?fields=id&limit=100&access_token=${accessToken}`;

    while (nextUrl) {
      const response = await axios.get(nextUrl, { timeout: 15000 });
      const data = response.data.data || [];
      followerIds.push(...data.map(f => f.id));
      if (followerIds.includes(igsid)) {
        isFollowing = true;
        break; // found — no need to paginate further
      }
      nextUrl = response.data.paging?.next || null;
    }

    // Cache for 5 minutes
    if (redis) {
      await redis.setex(cacheKey, 300, JSON.stringify(followerIds));
    }
    console.log('[Dispatcher] Follow check via API for igsid:', igsid, '— following:', isFollowing);
  }

  if (isFollowing) {
    // Send success message with link buttons
    const successText = automation.flow.followGate.successMessage;
    const successButtons = (automation.flow.followGate.successLinkButtons || []).slice(0, 3).map(btn => ({
      type: 'web_url',
      url: btn.url,
      title: btn.label.slice(0, 20)
    }));

    const successPayload = {
      recipient: { id: igsid },
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'button',
            text: successText,
            buttons: successButtons
          }
        }
      }
    };

    await callInstagramAPI('POST', '/me/messages', successPayload, accessToken);

    await IGAutomationSession.findByIdAndUpdate(session._id, { $set: { stage: 'gate_passed' } });
    await IGAutomation.findByIdAndUpdate(automationId, {
      $inc: { 'stats.totalFollowGatePassed': 1, 'stats.totalDmsSent': 1 }
    });

    console.log('[Dispatcher] Follow gate passed for igsid:', igsid);

  } else {
    // Not following
    const currentAttempts = session.attemptCount;

    if (currentAttempts < 1) {
      // First fail — send fail message with retry button
      const failText = automation.flow.followGate.failMessage;
      const retryButtonLabel = automation.flow.followGate.failRetryButtonLabel || 'Try Again';

      const failPayload = {
        recipient: { id: igsid },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'button',
              text: failText,
              buttons: [{
                type: 'postback',
                title: retryButtonLabel,
                payload: `FOLLOW_CHECK_ATTEMPT_2:${automationId}:${igsid}`
              }]
            }
          }
        }
      };

      await callInstagramAPI('POST', '/me/messages', failPayload, accessToken);

      await IGAutomationSession.findByIdAndUpdate(session._id, {
        $set: { stage: 'gate_check_1' },
        $inc: { attemptCount: 1 }
      });

      console.log('[Dispatcher] Follow gate fail 1 sent to igsid:', igsid);

    } else {
      // Second fail — send terminal message, no button
      const terminalText = automation.flow.followGate.terminalMessage;

      const terminalPayload = {
        recipient: { id: igsid },
        message: { text: terminalText } // plain text, no template, no button
      };

      await callInstagramAPI('POST', '/me/messages', terminalPayload, accessToken);

      await IGAutomationSession.findByIdAndUpdate(session._id, {
        $set: { stage: 'gate_failed_terminal' }
      });
      await IGAutomation.findByIdAndUpdate(automationId, {
        $inc: { 'stats.totalFollowGateFailed': 1, 'stats.totalDmsSent': 1 }
      });

      console.log('[Dispatcher] Terminal message sent to igsid:', igsid, '— infinite loop prevention active');
    }
  }
}

async function sendStoryDM(automationId, igsid, clientId) {
  // Legacy stub — route to generic link send logic for now
  // For the new prompt architecture, this could be handled similarly to standard opening DM.
  console.log('[Dispatcher] sendStoryDM not fully implemented, falling back to handleViewContentPostback.');
  await handleViewContentPostback(automationId, igsid, clientId);
}

module.exports = {
  sendOpeningDM,
  sendCommentReply,
  checkFollowStatus,
  handleViewContentPostback,
  sendStoryDM
};
