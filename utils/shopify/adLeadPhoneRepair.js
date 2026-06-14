'use strict';

const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const Client = require('../../models/Client');
const { normalizeEmailKey } = require('./shopifyCustomerWorkspaceSignals');
const {
  phoneForAdLeadStorage,
  repairPhoneDigits,
  isCorruptedPhoneStorage,
  pickCanonicalPhone,
} = require('../core/phoneSanitizer');
const { indianPhoneLookupVariants } = require('../core/normalizeIndianPhone');
const log = require('../core/logger')('AdLeadPhoneRepair');

function phoneFromShopifyCache(cache, email) {
  const em = normalizeEmailKey(email);
  if (!em || !Array.isArray(cache)) return null;
  for (const c of cache) {
    const custEmail = normalizeEmailKey(c.email);
    const linked = (c.linkedEmails || []).map(normalizeEmailKey);
    if (custEmail === em || linked.includes(em)) {
      return pickCanonicalPhone([c.phone, ...(c.linkedPhones || [])], { country: 'IN' });
    }
  }
  return null;
}

async function resolvePhoneFromOrders(clientId, email) {
  const em = normalizeEmailKey(email);
  if (!em) return null;
  const order = await Order.findOne({
    clientId,
    customerEmail: { $regex: new RegExp(`^${em.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    customerPhone: { $exists: true, $ne: '' },
  })
    .sort({ createdAt: -1 })
    .select('customerPhone phone')
    .lean();
  if (!order) return null;
  return repairPhoneDigits(order.customerPhone || order.phone, 'IN');
}

async function repairAdLeadPhonesForClient(clientId, { dryRun = false } = {}) {
  if (!clientId) return { repaired: 0, skipped: 0, conflicts: 0, failed: 0, details: [] };

  const client = await Client.findOne({ clientId })
    .select('shopifyCustomersCache')
    .lean();

  const leads = await AdLead.find({ clientId })
    .select('phoneNumber email name')
    .lean();

  let repaired = 0;
  let skipped = 0;
  let conflicts = 0;
  let failed = 0;
  const details = [];

  for (const lead of leads) {
    const current = lead.phoneNumber;
    if (!current || !isCorruptedPhoneStorage(current)) {
      skipped += 1;
      continue;
    }

    let fixedDigits =
      repairPhoneDigits(current, 'IN') ||
      (lead.email ? await resolvePhoneFromOrders(clientId, lead.email) : null) ||
      (lead.email ? phoneFromShopifyCache(client?.shopifyCustomersCache, lead.email) : null);

    const storage = fixedDigits ? phoneForAdLeadStorage(fixedDigits, 'IN') : null;
    if (!storage) {
      failed += 1;
      details.push({ leadId: String(lead._id), email: lead.email, from: current, status: 'failed' });
      continue;
    }

    const variants = indianPhoneLookupVariants(storage);
    const dup = await AdLead.findOne({
      clientId,
      _id: { $ne: lead._id },
      phoneNumber: { $in: variants.length ? variants : [storage] },
    })
      .select('_id email name phoneNumber')
      .lean();

    if (dup) {
      conflicts += 1;
      details.push({
        leadId: String(lead._id),
        email: lead.email,
        from: current,
        to: storage,
        status: 'conflict',
        conflictWith: String(dup._id),
      });
      continue;
    }

    if (!dryRun) {
      await AdLead.updateOne({ _id: lead._id }, { $set: { phoneNumber: storage } });
    }
    repaired += 1;
    details.push({ leadId: String(lead._id), email: lead.email, from: current, to: storage, status: 'repaired' });
  }

  log.info(`[${clientId}] phone repair: repaired=${repaired} skipped=${skipped} conflicts=${conflicts} failed=${failed}`);
  return { repaired, skipped, conflicts, failed, details };
}

module.exports = {
  repairAdLeadPhonesForClient,
  resolvePhoneFromOrders,
  phoneFromShopifyCache,
};
