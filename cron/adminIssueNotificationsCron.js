'use strict';

const cron = require('node-cron');
const Notification = require('../models/Notification');
const { emitAdminNotification } = require('../utils/admin/emitAdminNotification');
const DeadLetterWebhook = require('../models/DeadLetterWebhook');
const SupportChat = require('../models/SupportChat');

async function scanAdminIssues() {
  const [deadLetters, handoffs] = await Promise.all([
    DeadLetterWebhook.countDocuments({}),
    SupportChat.countDocuments({ status: 'human_requested' }),
  ]);

  if (deadLetters >= 5) {
    const exists = await Notification.findOne({
      clientId: 'TOPEDGE_ADMIN',
      title: 'Dead letter queue elevated',
      readAt: null,
      createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
    }).lean();
    if (!exists) {
      const doc = await Notification.create({
        clientId: 'TOPEDGE_ADMIN',
        audience: 'super_admin',
        title: 'Dead letter queue elevated',
        message: `${deadLetters} webhook dead letters need attention.`,
        type: 'webhook_dead_letter',
      });
      emitAdminNotification(doc);
    }
  }

  if (handoffs >= 3) {
    const exists = await Notification.findOne({
      clientId: 'TOPEDGE_ADMIN',
      title: 'Support handoffs waiting',
      readAt: null,
      createdAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) },
    }).lean();
    if (!exists) {
      const doc = await Notification.create({
        clientId: 'TOPEDGE_ADMIN',
        audience: 'super_admin',
        title: 'Support handoffs waiting',
        message: `${handoffs} chats requested human assistance.`,
        type: 'support_handoff',
      });
      emitAdminNotification(doc);
    }
  }
}

function registerAdminIssueNotificationsCron() {
  cron.schedule('*/5 * * * *', () => {
    scanAdminIssues().catch((err) => {
      console.error('[adminIssueNotificationsCron]', err.message);
    });
  });
}

module.exports = { registerAdminIssueNotificationsCron, scanAdminIssues };
