'use strict';

const ProductWatch = require('../../models/ProductWatch');
const AdLead = require('../../models/AdLead');

const YES_PATTERN = /^(yes|y|yeah|yep|notify|ok|sure|please|haan|ha|ji)\b/i;

async function upsertProductWatch({ clientId, leadId, phone, sku, productName, productUrl, variantId, productId }) {
  const skuKey = String(sku || productId || variantId || '');
  if (!skuKey || !phone) return null;

  const doc = await ProductWatch.findOneAndUpdate(
    { phone, sku: skuKey, status: { $in: ['active', 'watching'] } },
    {
      $set: {
        clientId,
        leadId,
        phone,
        sku: skuKey,
        productName: productName || 'Product',
        productUrl: productUrl || '',
        variantId: variantId || '',
        productId: productId || '',
        status: 'active',
        watchedAt: new Date(),
        condition: 'back_in_stock',
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true }
  );
  return doc;
}

async function resolveLeadId(clientId, phone) {
  const lead = await AdLead.findOne({ clientId, phoneNumber: phone }).select('_id').lean();
  return lead?._id || null;
}

function isAffirmativeReply(text) {
  return YES_PATTERN.test(String(text || '').trim());
}

module.exports = { upsertProductWatch, resolveLeadId, isAffirmativeReply };
