const mongoose = require('mongoose');

const instagramAutomationSchema = new mongoose.Schema({
  clientId:     { type: String, required: true },
  name:         { type: String, required: true },
  isActive:     { type: Boolean, default: false },
  status:       { type: String, default: 'draft' }, // 'live' | 'draft' | 'paused'

  // TRIGGER
  trigger: {
    type:     { type: String, default: 'comment' },   // "comment" | "story_reply" | "dm_keyword"
    postType: { type: String, default: 'any_post' },   // "specific_post" | "any_post" | "next_post"
    posts: [{           // for specific_post
      postId:      String,
      permalink:   String,
      thumbnailUrl:String,
      caption:     String
    }],
    keywords: [String], // match mode: contains
    matchAny: { type: Boolean, default: false } // true = any word/reaction triggers it
  },

  // ACTIONS
  actions: {
    publicReply: {
      enabled:  { type: Boolean, default: false },
      messages: [String]  // rotates randomly to avoid spam detection
    },
    dmFlow: {
      enabled:    { type: Boolean, default: true },
      openingDm: {
        text:    { type: String, default: '' },
        buttons: [{ title: String, url: String }]
      },
      askEmail:   { type: Boolean, default: false },
      askFollow:  { type: Boolean, default: false },
      sendLink: {
        enabled: { type: Boolean, default: false },
        url:     { type: String, default: '' },
        buttonText: { type: String, default: 'Get the link' }
      },
      followUpDm: {
        enabled:      { type: Boolean, default: false },
        delayMinutes: { type: Number, default: 30 },
        text:         { type: String, default: '' },
        condition:    { type: String, default: 'if_no_click' } // "if_no_click" | "always"
      }
    }
  },

  // ANALYTICS
  stats: {
    totalSends:   { type: Number, default: 0 },
    uniqueSends:  { type: Number, default: 0 },
    linkClicks:   { type: Number, default: 0 },
    buttonClicks: { type: Number, default: 0 }
  },

  // Added logs for duplicate protection
  sentLogs: [{
    facebookId: String,
    postId: String,
    sentAt: Date
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('InstagramAutomation', instagramAutomationSchema);
