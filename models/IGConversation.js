"use strict";

const mongoose = require('mongoose');

/**
 * IGConversation — Lightweight Instagram conversation model.
 * Strictly message-focused. No WhatsApp CRM fields — prevents schema pollution.
 * 
 * Design:
 * - Embedded messages[] array for fast single-document reads
 * - Compound indexes for inbox sort and participant lookup
 * - channel field hardcoded to 'instagram' — enables merge-sort with WhatsApp Conversation model
 */
const IGConversationSchema = new mongoose.Schema({
  clientId:       { type: String, required: true, index: true },
  igsid:          { type: String, required: true }, // Instagram Scoped User ID
  igUsername:     { type: String, default: null },
  igProfilePic:  { type: String, default: null },
  channel:        { type: String, default: 'instagram', enum: ['instagram'] },
  
  // Quick-access fields for inbox list rendering
  lastMessageText: { type: String, default: '' },
  lastMessageAt:   { type: Date, default: Date.now },
  isRead:          { type: Boolean, default: false },
  
  // Optional reference to the automation that created this conversation
  automationId:   { type: mongoose.Schema.Types.ObjectId, ref: 'IGAutomation', default: null },

  // Embedded messages — fast single-document reads, no joins
  messages: [{
    role:          { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content:       { type: String, default: '' },
    messageType:   { type: String, enum: ['text', 'image', 'story_reply', 'story_mention', 'unsupported'], default: 'text' },
    attachmentUrl: { type: String, default: null },
    timestamp:     { type: Date, default: Date.now },
    // Outbound-only fields
    status:        { type: String, enum: ['pending', 'sent', 'delivered', 'failed'], default: 'sent' },
    _id:           { type: mongoose.Schema.Types.ObjectId, auto: true }
  }]
}, { timestamps: true });

// Compound indexes for performance
IGConversationSchema.index({ clientId: 1, lastMessageAt: -1 });                    // Inbox sort
IGConversationSchema.index({ clientId: 1, igsid: 1 }, { unique: true });            // Participant lookup
IGConversationSchema.index({ clientId: 1, channel: 1, lastMessageAt: -1 });         // Channel filter

module.exports = mongoose.model('IGConversation', IGConversationSchema);
