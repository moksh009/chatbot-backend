'use strict';

const Client = require('../../models/Client');
const User = require('../../models/User');
const { sendSystemEmail, isWorkspaceEmailReady } = require('../../utils/core/emailService');
const log = require('../../utils/core/logger')('InventoryMigration');

const DOC_URL = process.env.PUBLIC_BASE_URL
  ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/docs/inventory-truth-migration`
  : 'https://docs.topedge.ai/inventory-truth-migration';

async function schedulePreNotice(clientId, { daysBefore = 7 } = {}) {
  const shipped = new Date();
  shipped.setDate(shipped.getDate() + daysBefore);
  const pre = new Date();
  await Client.updateOne(
    { clientId },
    {
      $set: {
        inventoryTruthPreNoticeAt: pre,
        inventoryTruthShippedAt: shipped,
      },
    }
  );
  return { clientId, inventoryTruthPreNoticeAt: pre, inventoryTruthShippedAt: shipped };
}

async function shipNow(clientId) {
  const now = new Date();
  await Client.updateOne(
    { clientId },
    { $set: { inventoryTruthShippedAt: now, inventoryTruthPreNoticeAt: now } }
  );
  return { clientId, inventoryTruthShippedAt: now };
}

async function sendMigrationEmails(clientId) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) throw new Error('Client not found');
  if (client.inventoryTruthEmailSentAt) {
    return { skipped: true, reason: 'already_sent' };
  }

  const admins = await User.find({ clientId, role: 'CLIENT_ADMIN' }).select('email name').lean();
  const emails = [...new Set(admins.map((u) => u.email).filter(Boolean))];
  if (!emails.length && client.adminEmail) emails.push(client.adminEmail);

  const subject = 'Important: Stock health calculations updated';
  const html = `
    <p>Hi,</p>
    <p>We've updated how TopEdge calculates <strong>stock health</strong>. SKUs that showed "Healthy" while Shopify had <strong>0 stock</strong> will now correctly show <strong>Out of stock</strong>.</p>
    <p><a href="${DOC_URL}">Read what changed and what to do</a></p>
    <p>— TopEdge Team</p>
  `;

  let sent = 0;
  for (const to of emails) {
    try {
      if (isWorkspaceEmailReady(client)) {
        await sendSystemEmail({ to, subject, html, client });
      }
      sent += 1;
    } catch (e) {
      log.warn(`Migration email failed ${to}: ${e.message}`);
    }
  }

  await Client.updateOne({ clientId }, { $set: { inventoryTruthEmailSentAt: new Date() } });
  return { sent, emails };
}

async function rolloutAllClients({ preNoticeDays = 7, sendEmail = true } = {}) {
  const clients = await Client.find({ shopifyAccessToken: { $exists: true, $ne: '' }, isActive: true })
    .select('clientId')
    .lean();
  const results = [];
  for (const c of clients) {
    await schedulePreNotice(c.clientId, { daysBefore: preNoticeDays });
    if (sendEmail) {
      try {
        results.push({ clientId: c.clientId, email: await sendMigrationEmails(c.clientId) });
      } catch (e) {
        results.push({ clientId: c.clientId, error: e.message });
      }
    }
  }
  return results;
}

module.exports = {
  schedulePreNotice,
  shipNow,
  sendMigrationEmails,
  rolloutAllClients,
};
