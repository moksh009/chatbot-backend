const mongoose = require('mongoose');

const IGAutomationSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  type: { type: String, enum: ['comment_to_dm', 'story_to_dm'], required: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  status: { type: String, enum: ['draft', 'active', 'paused', 'archived'], default: 'draft' },

  // Targeting — for comment_to_dm only
  targeting: {
    mode: { type: String, enum: ['every_post', 'specific_post', 'next_post'] },
    mediaId: { type: String, default: null },
    mediaUrl: { type: String, default: null },
    mediaPreview: {
      thumbnailUrl: String,
      authorName: String,
      caption: String,
      providerName: String
    },
    nextPostClaimed: { type: Boolean, default: false }
  },

  // Trigger — for comment_to_dm only
  trigger: {
    mode: { type: String, enum: ['specific_words', 'every_comment'] },
    keywords: [{ type: String }],
    caseSensitive: { type: Boolean, default: false },
    commentReplies: [{ type: String, maxlength: 500 }]
  },

  // Story trigger — for story_to_dm only
  storyTrigger: {
    event: { type: String, enum: ['story_mention', 'story_reply'] }
  },

  // The DM message flow
  flow: {
    openingDm: { type: String, maxlength: 1000 },
    openingButton: { type: String, maxlength: 20 },

    flowType: { type: String, enum: ['standard_link', 'follow_gate'] },

    // Standard link flow
    secondMessage: { type: String, maxlength: 1000 },
    linkButtons: [{
      label: { type: String, maxlength: 20 },
      url: { type: String }
    }],

    // Follow gate flow
    followGate: {
      gateButtonLabel: { type: String, maxlength: 20 },
      successMessage: { type: String, maxlength: 1000 },
      successLinkButtons: [{ label: String, url: String }],
      failMessage: { type: String, maxlength: 1000 },
      failRetryButtonLabel: { type: String, maxlength: 20 },
      terminalMessage: { type: String, maxlength: 1000 }
    }
  },

  // Performance counters (incremented atomically, never recalculated on read)
  stats: {
    totalTriggered: { type: Number, default: 0 },
    totalDmsSent: { type: Number, default: 0 },
    totalCommentReplies: { type: Number, default: 0 },
    totalFollowGatePassed: { type: Number, default: 0 },
    totalFollowGateFailed: { type: Number, default: 0 }
  },

  commentReplyIndex: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Compound indexes for efficient querying
IGAutomationSchema.index({ clientId: 1, status: 1 });
IGAutomationSchema.index({ clientId: 1, 'targeting.mediaId': 1 });
IGAutomationSchema.index({ clientId: 1, type: 1, status: 1 });

module.exports = mongoose.model('IGAutomation', IGAutomationSchema);
