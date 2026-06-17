'use strict';

const TemplateSendLog = require('../../models/TemplateSendLog');

/**
 * Update automation send log when Meta reports delivery / read.
 */
async function updateTemplateSendLogStatus({ messageId, status, timestamp = new Date() }) {
  const mid = String(messageId || '').trim();
  if (!mid) return null;

  const set = {};
  if (status === 'delivered') {
    set.deliveredAt = timestamp;
    set.status = 'delivered';
  } else if (status === 'read') {
    set.readAt = timestamp;
    set.status = 'delivered';
    if (!set.deliveredAt) set.deliveredAt = timestamp;
  } else {
    return null;
  }

  return TemplateSendLog.findOneAndUpdate(
    { messageId: mid },
    { $set: set },
    { new: true }
  ).lean();
}

/**
 * Record button / link engagement on automation TemplateSendLog rows.
 */
async function recordTemplateSendLogClick({ messageId, timestamp = new Date() }) {
  const mid = String(messageId || '').trim();
  if (!mid) return null;

  return TemplateSendLog.findOneAndUpdate(
    { messageId: mid },
    {
      $set: {
        clickedAt: timestamp,
        status: 'delivered',
      },
    },
    { new: true }
  ).lean();
}

module.exports = { updateTemplateSendLogStatus, recordTemplateSendLogClick };
