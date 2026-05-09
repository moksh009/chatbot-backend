"use strict";

const cron = require("node-cron");
const CheckoutLink = require("../models/CheckoutLink");
const Client = require("../models/Client");
const Conversation = require("../models/Conversation");
const AdLead = require("../models/AdLead");
const WhatsApp = require("../utils/whatsapp");
const { normalizePhone } = require("../utils/helpers");
const { createMessage } = require("../utils/createMessage");
const { publicApiBase } = require("../utils/commerceCheckoutService");
const log = require("../utils/logger")("CheckoutLinkRecovery");

const DELAY_MIN = Math.max(5, Number(process.env.CHECKOUT_LINK_RECOVERY_MIN || 25));
const BATCH = Number(process.env.CHECKOUT_LINK_RECOVERY_BATCH || 40);

function canSendRecovery(client, lead) {
  const strict = client?.growthCompliance?.cartRecoveryRequiresOptIn === true;
  if (!lead) return !strict;
  if (strict) return lead.optStatus === "opted_in";
  return lead.optStatus !== "opted_out";
}

function composeRecoveryText(client, shortUrl) {
  const raw =
    client.commerceBotSettings?.cartReminderMessage ||
    client.commerceBotSettings?.checkoutMessage ||
    "Still thinking it over? Complete checkout in one tap: {{checkout_url}}";
  let text = String(raw);
  text = text.replace(/\{\{\s*checkout_url\s*\}\}/gi, shortUrl);
  if (!text.includes(shortUrl)) {
    text = `${text.trim()}\n\n${shortUrl}`;
  }
  return text.substring(0, 4096);
}

async function processOne(linkDoc) {
  const client = await Client.findOne({ clientId: linkDoc.clientId });
  if (!client) return false;

  const normalizedPhone = normalizePhone(linkDoc.phone);
  if (!normalizedPhone) return false;

  const convo = await Conversation.findOne({ clientId: linkDoc.clientId, phone: normalizedPhone })
    .select("_id status")
    .lean();
  if (convo?.status === "HUMAN_TAKEOVER") return false;

  const lead = await AdLead.findOne({ clientId: linkDoc.clientId, phoneNumber: normalizedPhone })
    .select("optStatus")
    .lean();
  if (!canSendRecovery(client, lead)) return false;

  const base = publicApiBase();
  const shortUrl = base ? `${base}/api/r/${linkDoc.shortCode}` : linkDoc.fullUrl;
  const text = composeRecoveryText(client, shortUrl || linkDoc.fullUrl);

  await WhatsApp.sendText(client, normalizedPhone, text);
  await createMessage({
    clientId: linkDoc.clientId,
    conversationId: convo?._id,
    phone: normalizedPhone,
    direction: "outgoing",
    type: "text",
    body: text,
    metadata: { checkout_link_recovery_cron: true, shortCode: linkDoc.shortCode }
  });

  await CheckoutLink.updateOne(
    { _id: linkDoc._id },
    { $set: { cartRecoverySent: true, cartRecoverySentAt: new Date() } }
  );
  return true;
}

function scheduleCheckoutLinkRecoveryCron() {
  cron.schedule("*/12 * * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - DELAY_MIN * 60 * 1000);
      const rows = await CheckoutLink.find({
        converted: false,
        cartRecoverySent: false,
        phone: { $exists: true, $nin: ["", null] },
        createdAt: { $lte: cutoff },
      })
        .sort({ createdAt: 1 })
        .limit(BATCH)
        .lean();

      for (const row of rows) {
        try {
          const sent = await processOne(row);
          if (sent) log.info(`Checkout recovery → ${normalizePhone(row.phone)} (${row.shortCode})`);
        } catch (e) {
          log.warn(`Skipped ${row.shortCode}: ${e.message}`);
        }
      }
    } catch (err) {
      log.error(`Cron fatal: ${err.message}`);
    }
  });
  log.info(`CheckoutLink recovery cron armed (${DELAY_MIN}m delay, batch ${BATCH})`);
}

module.exports = scheduleCheckoutLinkRecoveryCron;
