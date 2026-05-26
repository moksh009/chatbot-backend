'use strict';

const Notification = require('../../models/Notification');
const Client = require('../../models/Client');
const User = require('../../models/User');
const { sendSystemEmail, isWorkspaceEmailReady } = require('../core/emailService');
const log = require('../core/logger')('InventoryAlerts');

async function createInventoryAlert(clientId, { type, title, message, metadata = {}, emailAdmins = false }) {
  await Notification.create({
    clientId,
    type: 'system',
    title,
    message,
    metadata: { category: 'inventory', alertType: type, ...metadata },
  });

  if (!emailAdmins) return;

  const client = await Client.findOne({ clientId }).lean();
  if (!client || !isWorkspaceEmailReady(client)) return;

  const admins = await User.find({ clientId, role: 'CLIENT_ADMIN' })
    .select('email name')
    .lean();
  const emails = [...new Set(admins.map((u) => u.email).filter(Boolean))];
  if (!emails.length && client.adminEmail) emails.push(client.adminEmail);

  for (const to of emails.slice(0, 5)) {
    try {
      await sendSystemEmail({
        to,
        subject: `[TopEdge] ${title}`,
        html: `<p>${message}</p><p style="color:#64748b;font-size:12px">Client: ${clientId}</p>`,
        client,
      });
    } catch (e) {
      log.warn(`Alert email to ${to} failed: ${e.message}`);
    }
  }
}

async function alertStockout(clientId, sku, productName) {
  return createInventoryAlert(clientId, {
    type: 'stockout',
    title: 'SKU went out of stock',
    message: `${productName || sku} is now at 0 units.`,
    metadata: { sku },
    emailAdmins: true,
  });
}

async function alertUnmappedAmazonSku(clientId, sellerSku, orderId) {
  return createInventoryAlert(clientId, {
    type: 'amazon_unmapped',
    title: 'Unmapped Amazon SKU',
    message: `Order ${orderId} includes Amazon SKU "${sellerSku}" with no channel mapping. Map it under Inventory → Channel SKUs.`,
    metadata: { sellerSku, orderId },
    emailAdmins: true,
  });
}

module.exports = {
  createInventoryAlert,
  alertStockout,
  alertUnmappedAmazonSku,
};
