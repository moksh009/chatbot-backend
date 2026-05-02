"use strict";

const IGAutomation = require('../models/IGAutomation');
const IGAutomationSession = require('../models/IGAutomationSession');
const IGProcessedComment = require('../models/IGProcessedComment');
const Client = require('../models/Client');
const log = require('./logger')('IGWebhookProcessor');

// BullMQ queue references — set by the worker on boot
let commentDmQueue = null;
let commentReplyQueue = null;
let followGateQueue = null;
let storyDmQueue = null;

/**
 * Register queue instances (called from igAutomationWorker.js during initialization)
 */
function registerQueues(queues) {
  commentDmQueue = queues.commentDmQueue;
  commentReplyQueue = queues.commentReplyQueue;
  followGateQueue = queues.followGateQueue;
  storyDmQueue = queues.storyDmQueue;
}

/**
 * Fallback for inline processing when queues are unavailable (no Redis)
 */
async function enqueueOrInline(queue, jobName, data) {
  if (queue) {
    let priority = 1; // Default highest priority
    
    // Dynamic Priority: Simulate Fair-Share Round-Robin by tracking client load
    if (global.redisClient && data.clientId) {
      try {
        const key = `ig_queue_load:${data.clientId}`;
        // Increment the rolling counter (returns the new count)
        const count = await global.redisClient.incr(key);
        // Expire the key after 60 seconds of inactivity
        await global.redisClient.expire(key, 60);
        
        // BullMQ priority: 1 is highest, larger numbers are lower priority.
        // A viral client gets priorities 1, 2, 3... 50000. 
        // A quiet client gets priority 1. BullMQ will process the quiet client's job before the viral client's 50000th job.
        priority = Math.min(count, 100000); // Cap priority just in case
      } catch (err) {
        log.warn(`[Processor] Failed to calculate priority for ${data.clientId}:`, err.message);
      }
    }

    await queue.add(jobName, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
      priority
    });
  } else {
    // Inline fallback — import dispatcher and call directly
    log.warn(`[Processor] Queue unavailable — executing ${jobName} inline`);
    const dispatcher = require('../controllers/igAutomation/messageDispatcher');
    try {
      switch (jobName) {
        case 'comment-dm': await dispatcher.sendOpeningDM(data.automationId, data.commenterIgsid, data.clientId); break;
        case 'comment-reply': await dispatcher.sendCommentReply(data.automationId, data.commentId, data.clientId); break;
        case 'follow-gate': await dispatcher.checkFollowStatus(data.automationId, data.igsid, data.clientId); break;
        case 'story-dm': await dispatcher.sendStoryDM(data.automationId, data.igsid, data.clientId); break;
      }
    } catch (err) {
      log.error(`[Processor] Inline execution failed for ${jobName}:`, err.message);
    }
  }
}

/**
 * Save an incoming Instagram message to IGConversation and emit Socket.io event.
 * This is called after processing automation triggers for real-time inbox updates.
 */
async function saveToIGConversation(clientId, igsid, messageText, messageType = 'text', attachmentUrl = null) {
  try {
    const IGConversation = require('../models/IGConversation');
    
    const messageEntry = {
      role: 'user',
      content: messageText || '',
      messageType,
      attachmentUrl,
      timestamp: new Date()
    };

    const conversation = await IGConversation.findOneAndUpdate(
      { clientId, igsid },
      {
        $set: {
          lastMessageText: messageText || '',
          lastMessageAt: new Date(),
          isRead: false,
          channel: 'instagram'
        },
        $push: { messages: messageEntry },
        $setOnInsert: {
          clientId,
          igsid,
          igUsername: null,
          igProfilePic: null,
          createdAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    // Emit Socket.io event for real-time updates
    if (global.io) {
      global.io.to(`client_${clientId}`).emit('igMessageNew', {
        conversationId: conversation._id.toString(),
        channel: 'instagram',
        participantId: igsid,
        participantName: conversation.igUsername || `IG User ${igsid.slice(-6)}`,
        participantAvatar: conversation.igProfilePic || null,
        lastMessageText: messageText || '',
        lastMessageAt: new Date().toISOString()
      });
    }

    return conversation;
  } catch (err) {
    log.error('[IGConversation] Failed to save incoming message:', err.message, { clientId, igsid });
  }
}

/**
 * Main entry point — routes webhook payload to handlers
 */
async function processIGWebhookPayload(body) {
  // Checklist item 4: Log the entry point
  console.log('[IG Webhook] Received payload. Entry count:', body?.entry?.length || 0);

  // Checklist item 5: Handle empty or malformed payloads gracefully
  if (!Array.isArray(body?.entry) || body.entry.length === 0) {
    console.warn('[IG Webhook] Received empty or malformed payload:', JSON.stringify(body));
    return;
  }

  const entries = body.entry;

  for (const entry of entries) {
    const pageId = entry.id;

    // Handle field changes (comments, mentions)
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field === 'comments') {
        await handleCommentEvent(pageId, change.value);
      } else if (change.field === 'mentions') {
        await handleStoryMentionEvent(pageId, change.value);
      }
    }

    // Handle messaging events (button clicks, story replies)
    const messaging = entry.messaging || [];
    for (const msg of messaging) {
      if (msg.message?.attachments?.[0]?.type === 'story_mention') {
        await handleStoryReplyEvent(pageId, msg);
      } else if (msg.postback) {
        await handleButtonPostback(pageId, msg);
      } else if (msg.message) {
        // Generic incoming DM — save to IGConversation for unified inbox
        await handleIncomingDM(pageId, msg);
      }
    }
  }
}

/**
 * Handle generic incoming DMs (not automation-triggered) for the unified inbox
 */
async function handleIncomingDM(pageId, msg) {
  try {
    const senderId = msg.sender?.id;
    if (!senderId) return;

    // Ignore our own messages (echo)
    if (senderId === pageId) return;

    const messageText = msg.message?.text || '';
    const attachments = msg.message?.attachments || [];
    let messageType = 'text';
    let attachmentUrl = null;

    if (attachments.length > 0) {
      const firstAttachment = attachments[0];
      if (firstAttachment.type === 'image') {
        messageType = 'image';
        attachmentUrl = firstAttachment.payload?.url || null;
      } else if (firstAttachment.type === 'story_mention') {
        messageType = 'story_reply';
        attachmentUrl = firstAttachment.payload?.url || null;
      } else {
        messageType = 'unsupported';
      }
    }

    const client = await Client.findOne({
      $or: [
        { instagramPageId: pageId },
        { 'social.instagram.pageId': pageId }
      ]
    }).lean();
    if (!client) return;

    await saveToIGConversation(client.clientId, senderId, messageText, messageType, attachmentUrl);
  } catch (err) {
    log.error('[IncomingDM] Error handling incoming DM:', err.message, { payload: JSON.stringify(msg).substring(0, 500) });
  }
}

/**
 * Handle comment events — match against active automations
 */
async function handleCommentEvent(pageId, commentData) {
  try {
    const { id: commentId, text: commentText, from, media } = commentData;
    const commenterIgsid = from?.id;
    const mediaId = media?.id;

    if (!commentId || !commenterIgsid || !mediaId) {
      console.warn('[IG Comment] Missing required fields in webhook payload:', JSON.stringify(commentData));
      return;
    }

    // Step 1: Deduplication check — insert first, check after
    try {
      const client = await Client.findOne({
        $or: [
          { instagramPageId: pageId },
          { 'social.instagram.pageId': pageId },
          { igPageId: pageId }
        ]
      }).lean();

      if (!client) {
        console.warn('[IG Comment] No client found for pageId:', pageId);
        return;
      }

      await IGProcessedComment.create({
        commentId,
        clientId: client.clientId,
        processedAt: new Date()
      });
    } catch (dupErr) {
      if (dupErr.code === 11000) {
        console.log('[IG Comment] Duplicate comment detected, skipping:', commentId);
        return;
      }
      throw dupErr;
    }

    // Fetch client again with full data
    const client = await Client.findOne({
      $or: [
        { instagramPageId: pageId },
        { 'social.instagram.pageId': pageId },
        { igPageId: pageId }
      ]
    }).lean();

    // Step 2: Find matching active automations (deletedAt:null guard prevents
    // soft-deleted automations from continuing to fire after delete races a
    // webhook event already in flight from Meta).
    const automations = await IGAutomation.find({
      clientId: client.clientId,
      type: 'comment_to_dm',
      status: 'active',
      deletedAt: null
    }).lean();

    for (const automation of automations) {
      const matches = await evaluateAutomationMatch(automation, mediaId, commentText, client.clientId);
      if (!matches) continue;

      // Step 3: Check for existing unexpired session (24-hour dedup per user per automation)
      const existingSession = await IGAutomationSession.findOne({
        automationId: automation._id,
        igsid: commenterIgsid
      });
      if (existingSession) {
        console.log('[IG Comment] Session exists for igsid:', commenterIgsid, 'automation:', automation._id, '— skipping.');
        continue;
      }

      // Step 4: Handle next_post mode — claim the mediaId
      if (automation.targeting.mode === 'next_post' && !automation.targeting.nextPostClaimed) {
        const claimed = await IGAutomation.findOneAndUpdate(
          { _id: automation._id, 'targeting.nextPostClaimed': false },
          {
            $set: {
              'targeting.nextPostClaimed': true,
              'targeting.mediaId': mediaId
            }
          },
          { new: true }
        );
        if (!claimed) {
          console.log('[IG Comment] next_post already claimed for automation:', automation._id);
          continue;
        }
        console.log('[IG Comment] next_post automation claimed mediaId:', mediaId);
      }

      // Step 5: Enqueue comment reply job if preset comments configured
      const hasPresetReplies = automation.trigger?.commentReplies?.length > 0;
      if (hasPresetReplies) {
        await enqueueOrInline(commentReplyQueue, 'comment-reply', {
          automationId: automation._id.toString(),
          commentId,
          clientId: client.clientId,
          mediaId
        });
      }

      // Step 6: Enqueue DM job
      await enqueueOrInline(commentDmQueue, 'comment-dm', {
        automationId: automation._id.toString(),
        commenterIgsid,
        commentId,
        clientId: client.clientId
      });

      // Step 7: Increment triggered counter
      await IGAutomation.findByIdAndUpdate(automation._id, {
        $inc: { 'stats.totalTriggered': 1 }
      });

      console.log('[IG Comment] Queued automation', automation._id, 'for commenter', commenterIgsid);
    }
  } catch (err) {
    console.error('[IG Comment] Unhandled error in handleCommentEvent:', err);
  }
}

async function evaluateAutomationMatch(automation, incomingMediaId, commentText, clientId) {
  const { mode, mediaId: savedMediaId, nextPostClaimed } = automation.targeting || {};

  // Check targeting mode
  if (mode === 'specific_post') {
    if (savedMediaId !== incomingMediaId) return false;
  } else if (mode === 'next_post') {
    if (nextPostClaimed && savedMediaId !== incomingMediaId) return false;
    // If not yet claimed, any mediaId matches (this is the first post after setup)
  }
  // mode === 'every_post': always matches

  // Check keyword trigger
  const { mode: triggerMode, keywords, triggerCaseSensitive } = automation.trigger || {};
  // Backward compatibility check for caseSensitive
  const caseSensitive = triggerCaseSensitive !== undefined ? triggerCaseSensitive : automation.trigger?.caseSensitive;

  if (triggerMode === 'specific_words') {
    if (!keywords || keywords.length === 0) return false;
    const textToCheck = caseSensitive ? commentText : commentText.toLowerCase();
    const matched = keywords.some(kw => {
      const k = caseSensitive ? kw : kw.toLowerCase();
      return textToCheck.includes(k);
    });
    if (!matched) return false;
  }
  // triggerMode === 'every_comment': always matches

  return true;
}

/**
 * Handle story mention events
 */
async function handleStoryMentionEvent(pageId, mentionData) {
  try {
    const { comment_id: mentionCommentId, media_id: storyId } = mentionData;
    if (!mentionCommentId) return;

    const client = await Client.findOne({
      $or: [
        { instagramPageId: pageId },
        { 'social.instagram.pageId': pageId }
      ]
    }).lean();
    if (!client) {
      console.warn('[IG StoryMention] No client found for pageId:', pageId);
      return;
    }

    const clientId = client.clientId;

    const automations = await IGAutomation.find({
      clientId,
      type: 'story_to_dm',
      status: 'active',
      deletedAt: null,
      'storyTrigger.event': 'story_mention'
    }).lean();

    if (!automations.length) {
      console.log('[IG StoryMention] No active story_mention automations for client:', clientId);
      return;
    }

    for (const auto of automations) {
      // De-duplication
      const existingSession = await IGAutomationSession.findOne({
        automationId: auto._id,
        igsid: mentionCommentId
      });
      if (existingSession) {
        console.log('[IG StoryMention] Duplicate session found for mention:', mentionCommentId, 'automation:', auto._id, 'Skipping.');
        continue;
      }

      await IGAutomation.findByIdAndUpdate(auto._id, {
        $inc: { 'stats.totalTriggered': 1 }
      });

      await enqueueOrInline(storyDmQueue, 'story-dm', {
        automationId: auto._id.toString(),
        igsid: mentionCommentId,
        clientId
      });

      log.info(`[StoryMention] Triggered automation "${auto.name}" for mention=${mentionCommentId}`);
    }
  } catch (err) {
    log.error('[StoryMention] Error handling story mention:', err.message, { payload: JSON.stringify(mentionData).substring(0, 500), stack: err.stack });
    try {
      const WebhookErrorLog = require('../models/WebhookErrorLog');
      await WebhookErrorLog.create({ payload: mentionData, error: err.message, stack: err.stack });
    } catch (e) {}
  }
}

/**
 * Handle story reply events (messaging webhook)
 * AUTHORITATIVE VERSION — replaces previous implementation with keyword filtering
 */
async function handleStoryReplyEvent(pageId, messagingEvent) {
  try {
    const igsid = messagingEvent.sender?.id;
    const replyText = messagingEvent.message?.text || '';
    const storyContext = messagingEvent.message?.attachments?.[0];

    if (!igsid) {
      console.log('[IG Story Reply] Event has no sender ID. Skipping.');
      return;
    }

    // Find the client by their Instagram Page ID
    const client = await Client.findOne({
      $or: [
        { instagramPageId: pageId },
        { 'social.instagram.pageId': pageId }
      ]
    }).lean();
    if (!client) {
      console.warn('[IG Story Reply] No client found for pageId:', pageId);
      return;
    }

    const clientId = client.clientId;

    // Save to IGConversation for unified inbox
    const attachmentUrl = storyContext?.payload?.url || null;
    await saveToIGConversation(clientId, igsid, replyText, 'story_reply', attachmentUrl);

    // Find all active Story to DM automations for this client with story_reply event
    const automations = await IGAutomation.find({
      clientId,
      type: 'story_to_dm',
      status: 'active',
      deletedAt: null,
      'storyTrigger.event': 'story_reply'
    }).lean();

    if (!automations.length) {
      console.log('[IG Story Reply] No active story_reply automations for client:', clientId);
      return;
    }

    for (const automation of automations) {
      const triggerMode = automation.storyTrigger?.replyTriggerMode || 'every_reply';

      let shouldFire = false;

      if (triggerMode === 'every_reply') {
        shouldFire = true;
      } else if (triggerMode === 'specific_words') {
        const keywords = automation.storyTrigger?.replyKeywords || [];
        const caseSensitive = automation.storyTrigger?.replyCaseSensitive || false;

        if (keywords.length === 0) {
          console.warn('[IG Story Reply] Automation has specific_words mode but no keywords. Skipping automation:', automation._id);
          continue;
        }

        const textToCheck = caseSensitive ? replyText : replyText.toLowerCase();
        shouldFire = keywords.some(keyword => {
          const k = caseSensitive ? keyword : keyword.toLowerCase();
          return textToCheck.includes(k);
        });
      }

      if (!shouldFire) {
        console.log('[IG Story Reply] Keyword match failed. Skipping automation:', automation._id);
        continue;
      }

      // De-duplication check
      const existingSession = await IGAutomationSession.findOne({
        automationId: automation._id,
        igsid
      });

      if (existingSession) {
        console.log('[IG Story Reply] Duplicate session found for igsid:', igsid, 'automation:', automation._id, 'Skipping.');
        continue;
      }

      // Enqueue the story DM job
      await enqueueOrInline(storyDmQueue, 'story-dm', {
        automationId: automation._id.toString(),
        igsid,
        clientId
      });

      await IGAutomation.findByIdAndUpdate(automation._id, {
        $inc: { 'stats.totalTriggered': 1 }
      });

      console.log('[IG Story Reply] Queued story DM for igsid:', igsid, 'automation:', automation._id);
    }
  } catch (err) {
    console.error('[IG Story Reply] Unhandled error in handleStoryReplyEvent:', err, { payload: JSON.stringify(messagingEvent).substring(0, 500) });
    try {
      const WebhookErrorLog = require('../models/WebhookErrorLog');
      await WebhookErrorLog.create({ payload: messagingEvent, error: err.message, stack: err.stack });
    } catch (e) {}
  }
}

/**
 * Handle button postback events (follow gate check / retry)
 */
async function handleButtonPostback(pageId, msg) {
  try {
    const payload = msg.postback?.payload;
    const senderId = msg.sender?.id;
    if (!payload || !senderId || !payload.startsWith('IG_AUTO:')) return;

    // Payload format: IG_AUTO:{automationId}:{action}
    const parts = payload.split(':');
    if (parts.length < 3) return;

    const automationId = parts[1];
    const action = parts[2];

    const client = await Client.findOne({
      $or: [
        { instagramPageId: pageId },
        { 'social.instagram.pageId': pageId }
      ]
    }).lean();
    if (!client) return;

    const clientId = client.clientId;

    if (action === 'GATE_CHECK' || action === 'GATE_RETRY') {
      // Load the session
      const session = await IGAutomationSession.findOne({
        automationId,
        igsid: senderId
      });

      if (!session) {
        log.warn(`[Postback] No session found for automation=${automationId} igsid=${senderId}`);
        return;
      }

      // Check attempt count — terminal after 2
      if (session.attemptCount >= 2) {
        log.info(`[Postback] User ${senderId} exceeded max attempts for automation=${automationId}`);
        return;
      }

      // Increment attempt count
      await IGAutomationSession.findByIdAndUpdate(session._id, {
        $inc: { attemptCount: 1 }
      });

      // Enqueue follow gate check
      await enqueueOrInline(followGateQueue, 'follow-gate', {
        automationId,
        igsid: senderId,
        clientId
      });

      log.info(`[Postback] Follow gate check enqueued for automation=${automationId} igsid=${senderId} action=${action}`);
    } else if (action === 'VIEW_LINK' || payload.startsWith('VIEW_CONTENT:')) {
      // Standard link flow — send the second message with links
      const actualAutoId = payload.startsWith('VIEW_CONTENT:') ? parts[1] : automationId;
      await enqueueOrInline(commentDmQueue, 'comment-dm', {
        automationId: actualAutoId,
        commenterIgsid: senderId,
        clientId,
        action: 'VIEW_CONTENT'
      });
      console.log('[IG Postback] Queued VIEW_CONTENT for automation:', actualAutoId, 'igsid:', senderId);
    }
  } catch (err) {
    log.error('[Postback] Error handling button postback:', err.message, { payload: JSON.stringify(msg).substring(0, 500), stack: err.stack });
    try {
      const WebhookErrorLog = require('../models/WebhookErrorLog');
      await WebhookErrorLog.create({ payload: msg, error: err.message, stack: err.stack });
    } catch (e) {}
  }
}

module.exports = {
  processIGWebhookPayload,
  handleCommentEvent,
  handleStoryMentionEvent,
  handleStoryReplyEvent,
  handleButtonPostback,
  handleIncomingDM,
  saveToIGConversation,
  registerQueues
};
