"use strict";

const IGAutomation = require('../../models/IGAutomation');
const IGAutomationSession = require('../../models/IGAutomationSession');
const Client = require('../../models/Client');
const { sendInstagramDMv2, replyToCommentv2, checkFollowStatusv2 } = require('../../utils/igGraphApi');
const { canSendCommentReply, incrementCommentReplyCount } = require('../../utils/igRateLimiter');
const log = require('../../utils/logger')('IGDispatcher');

/**
 * Get the client's Instagram access token from the Client model.
 */
async function getClientToken(clientId) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const token = client.instagramAccessToken || client.social?.instagram?.accessToken;
  if (!token) throw new Error(`No Instagram access token for client: ${clientId}`);

  return token;
}

/**
 * Send the opening DM to a commenter.
 */
async function sendOpeningDM(automationId, igsid, clientId) {
  const auto = await IGAutomation.findById(automationId);
  if (!auto) throw new Error(`Automation not found: ${automationId}`);

  const accessToken = await getClientToken(clientId);

  // Build message payload
  const message = {};
  const flowType = auto.flow?.flowType;

  if (auto.flow?.openingButton) {
    // Send as quick reply with encoded postback payload
    let postbackAction = 'VIEW_LINK';
    if (flowType === 'follow_gate') postbackAction = 'GATE_CHECK';

    message.text = auto.flow.openingDm;
    message.quick_replies = [{
      content_type: 'text',
      title: auto.flow.openingButton,
      payload: `IG_AUTO:${automationId}:${postbackAction}`
    }];
  } else {
    message.text = auto.flow.openingDm;
  }

  await sendInstagramDMv2(igsid, message, accessToken, { clientId });

  // Create session document
  try {
    await IGAutomationSession.create({
      clientId,
      automationId,
      igsid,
      stage: 'opening_sent',
      automationName: auto.name,
      actionTaken: 'Opening DM Sent'
    });
  } catch (err) {
    // Duplicate key error means session already exists (de-dup working correctly)
    if (err.code !== 11000) throw err;
  }

  // Increment stats atomically
  await IGAutomation.findByIdAndUpdate(automationId, {
    $inc: { 'stats.totalDmsSent': 1 }
  });

  log.info(`[DM] Opening DM sent for automation="${auto.name}" to igsid=${igsid}`);
}

/**
 * Send a public comment reply (cycling through defined responses).
 */
async function sendCommentReply(automationId, commentId, clientId, mediaId) {
  const auto = await IGAutomation.findById(automationId);
  if (!auto || !auto.trigger.commentReplies || auto.trigger.commentReplies.length === 0) return;

  // Rate limit check
  const canReply = await canSendCommentReply(clientId, mediaId || 'unknown');
  if (!canReply) {
    log.warn(`[Reply] Rate limit reached — skipping comment reply for automation="${auto.name}"`);
    return;
  }

  const accessToken = await getClientToken(clientId);

  // Get the next reply using cycling index
  const replyIndex = auto.commentReplyIndex % auto.trigger.commentReplies.length;
  const replyText = auto.trigger.commentReplies[replyIndex];

  await replyToCommentv2(commentId, replyText, accessToken, { clientId });

  // Atomically increment cycling index and stats
  await IGAutomation.findByIdAndUpdate(automationId, {
    $inc: { commentReplyIndex: 1, 'stats.totalCommentReplies': 1 }
  });

  // Increment rate limit counter
  await incrementCommentReplyCount(clientId, mediaId || 'unknown');

  log.info(`[Reply] Comment reply sent for automation="${auto.name}" comment=${commentId}`);
}

/**
 * Check if a user follows the business account (follow gate verification).
 */
async function checkFollowStatus(automationId, igsid, clientId) {
  const auto = await IGAutomation.findById(automationId);
  if (!auto) throw new Error(`Automation not found: ${automationId}`);

  const session = await IGAutomationSession.findOne({ automationId, igsid });
  if (!session) throw new Error(`Session not found for automation=${automationId} igsid=${igsid}`);

  const accessToken = await getClientToken(clientId);

  try {
    const result = await checkFollowStatusv2(igsid, accessToken, { clientId });
    const isFollowing = result?.is_user_follow_business === true;

    if (isFollowing) {
      // Gate passed — send success message with link buttons
      session.stage = 'gate_passed';
      session.actionTaken = 'Gate Passed';
      await session.save();

      const fg = auto.flow.followGate;
      const successMessage = buildLinkMessage(
        fg.successMessage,
        fg.successLinkButtons
      );

      await sendInstagramDMv2(igsid, successMessage, accessToken, { clientId });

      await IGAutomation.findByIdAndUpdate(automationId, {
        $inc: { 'stats.totalFollowGatePassed': 1, 'stats.totalDmsSent': 1 }
      });

      log.info(`[FollowGate] PASSED for automation="${auto.name}" igsid=${igsid}`);
    } else {
      // Gate failed
      if (session.attemptCount >= 2) {
        // Terminal — too many attempts
        session.stage = 'gate_failed_terminal';
        session.actionTaken = 'Gate Failed (Terminal)';
        await session.save();

        const terminalMessage = { text: auto.flow.followGate.terminalMessage };
        await sendInstagramDMv2(igsid, terminalMessage, accessToken, { clientId });

        await IGAutomation.findByIdAndUpdate(automationId, {
          $inc: { 'stats.totalFollowGateFailed': 1, 'stats.totalDmsSent': 1 }
        });

        log.info(`[FollowGate] TERMINAL FAIL for automation="${auto.name}" igsid=${igsid}`);
      } else {
        // Send fail message with retry button
        const stageKey = session.attemptCount === 0 ? 'gate_check_1' : 'gate_check_2';
        session.stage = stageKey;
        session.actionTaken = 'Gate Check Failed';
        await session.save();

        const fg = auto.flow.followGate;
        const failMessage = {
          text: fg.failMessage,
          quick_replies: [{
            content_type: 'text',
            title: fg.failRetryButtonLabel || 'Try Again',
            payload: `IG_AUTO:${automationId}:GATE_RETRY`
          }]
        };

        await sendInstagramDMv2(igsid, failMessage, accessToken, { clientId });

        await IGAutomation.findByIdAndUpdate(automationId, {
          $inc: { 'stats.totalDmsSent': 1 }
        });

        log.info(`[FollowGate] FAIL attempt ${session.attemptCount} for automation="${auto.name}" igsid=${igsid}`);
      }
    }
  } catch (err) {
    log.error(`[FollowGate] Error checking follow status:`, err.message, { automationId, igsid, stack: err.stack });
    throw err;
  }
}

/**
 * Send a story-triggered DM.
 */
async function sendStoryDM(automationId, igsid, clientId) {
  const auto = await IGAutomation.findById(automationId);
  if (!auto) throw new Error(`Automation not found: ${automationId}`);

  const accessToken = await getClientToken(clientId);

  const message = buildLinkMessage(
    auto.flow.openingDm,
    auto.flow.linkButtons
  );

  await sendInstagramDMv2(igsid, message, accessToken, { clientId });

  // Create session
  try {
    await IGAutomationSession.create({
      clientId,
      automationId,
      igsid,
      stage: 'link_sent',
      automationName: auto.name,
      actionTaken: 'Story DM Sent'
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }

  await IGAutomation.findByIdAndUpdate(automationId, {
    $inc: { 'stats.totalDmsSent': 1 }
  });

  log.info(`[StoryDM] DM sent for automation="${auto.name}" to igsid=${igsid}`);
}

/**
 * Send the standard link follow-up message (after opening DM button is clicked).
 */
async function sendStandardLinkFollow(automationId, igsid, clientId) {
  const auto = await IGAutomation.findById(automationId);
  if (!auto) return;

  const accessToken = await getClientToken(clientId);

  const message = buildLinkMessage(
    auto.flow.secondMessage,
    auto.flow.linkButtons
  );

  await sendInstagramDMv2(igsid, message, accessToken, { clientId });

  // Update session
  await IGAutomationSession.findOneAndUpdate(
    { automationId, igsid },
    { $set: { stage: 'link_sent', actionTaken: 'Link Sent' } }
  );

  await IGAutomation.findByIdAndUpdate(automationId, {
    $inc: { 'stats.totalDmsSent': 1 }
  });

  log.info(`[Link] Standard link sent for automation="${auto.name}" to igsid=${igsid}`);
}

/**
 * Build a message payload with optional link buttons using Instagram's Generic Template.
 */
function buildLinkMessage(text, linkButtons) {
  if (!linkButtons || linkButtons.length === 0) {
    return { text: text || '' };
  }

  // Filter out buttons with invalid URLs
  const validButtons = linkButtons.filter(b => {
    if (!b.label || !b.url) return false;
    try {
      const parsed = new URL(b.url);
      return parsed.protocol === 'https:';
    } catch {
      log.warn(`[Message] Invalid button URL skipped: ${b.url}`);
      return false;
    }
  });

  if (validButtons.length === 0) {
    return { text: text || '' };
  }

  return {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'generic',
        elements: [{
          title: text || 'Check this out',
          buttons: validButtons.map(b => ({
            type: 'web_url',
            url: b.url,
            title: b.label
          }))
        }]
      }
    }
  };
}

module.exports = {
  sendOpeningDM,
  sendCommentReply,
  checkFollowStatus,
  sendStoryDM,
  sendStandardLinkFollow,
  buildLinkMessage
};
