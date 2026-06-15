'use strict';

const crypto = require('crypto');
const AdLead = require('../../models/AdLead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Order = require('../../models/Order');
const CampaignMessage = require('../../models/CampaignMessage');
const FollowUpSequence = require('../../models/FollowUpSequence');
const VisitorIdentity = require('../../models/VisitorIdentity');
const PixelEvent = require('../../models/PixelEvent');
const LinkClickEvent = require('../../models/LinkClickEvent');
const WarrantyRecord = require('../../models/WarrantyRecord');
const ConversationNote = require('../../models/ConversationNote');
const { auditLog } = require('../audit/auditWriter');

const PII_MODELS = [
  { name: 'AdLead', model: AdLead, phoneField: 'phoneNumber' },
  { name: 'Conversation', model: Conversation, phoneField: 'phone' },
  { name: 'Message', model: Message },
  { name: 'Order', model: Order },
  { name: 'CampaignMessage', model: CampaignMessage, phoneField: 'phone' },
  { name: 'FollowUpSequence', model: FollowUpSequence, phoneField: 'phone' },
  { name: 'VisitorIdentity', model: VisitorIdentity },
  { name: 'PixelEvent', model: PixelEvent },
  { name: 'LinkClickEvent', model: LinkClickEvent },
  { name: 'WarrantyRecord', model: WarrantyRecord },
  { name: 'ConversationNote', model: ConversationNote },
];

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

async function resolveLead(leadId, phone) {
  if (leadId) {
    return AdLead.findById(leadId).lean();
  }
  if (phone) {
    return AdLead.findOne({ phoneNumber: phone }).lean();
  }
  return null;
}

async function exportLeadBundle({ leadId, phone, actor, clientId }) {
  const lead = await resolveLead(leadId, phone);
  if (!lead) throw new Error('lead_not_found');
  const cid = lead.clientId;
  const bundle = { exportedAt: new Date().toISOString(), leadId: lead._id, clientId: cid, records: {} };

  bundle.records.AdLead = [lead];
  bundle.records.Conversation = await Conversation.find({ clientId: cid, phone: lead.phoneNumber }).lean();
  const convIds = bundle.records.Conversation.map((c) => c._id);
  bundle.records.Message = await Message.find({ conversationId: { $in: convIds } }).lean();

  const orderOr = [{ phone: lead.phoneNumber }, { customerPhone: lead.phoneNumber }];
  const orderIdRefs = [lead.recoveredOrderId, lead.lastOrderId].filter(Boolean);
  for (const ref of orderIdRefs) {
    orderOr.push({ orderId: String(ref) }, { shopifyOrderId: String(ref) }, { orderNumber: String(ref) });
  }
  bundle.records.Order = await Order.find({ clientId: cid, $or: orderOr }).sort({ createdAt: -1 }).lean();
  bundle.records.CampaignMessage = await CampaignMessage.find({ clientId: cid, phone: lead.phoneNumber }).lean();
  bundle.records.FollowUpSequence = await FollowUpSequence.find({ clientId: cid, leadId: lead._id }).lean();
  bundle.records.VisitorIdentity = await VisitorIdentity.find({ clientId: cid, phone: lead.phoneNumber }).lean();
  bundle.records.PixelEvent = await PixelEvent.find({ clientId: cid, phone: lead.phoneNumber }).limit(500).lean();
  bundle.records.LinkClickEvent = await LinkClickEvent.find({ clientId: cid, phone: lead.phoneNumber }).limit(500).lean();
  bundle.records.WarrantyRecord = await WarrantyRecord.find({ clientId: cid, phone: lead.phoneNumber }).lean();
  bundle.records.ConversationNote = await ConversationNote.find({ clientId: cid }).limit(200).lean();

  const size = JSON.stringify(bundle).length;
  auditLog({
    category: 'pii',
    action: 'pii.exported',
    severity: 'high',
    clientId: cid,
    actor,
    details: { leadId: lead._id, bundleBytes: size },
    blocking: true,
  });

  return bundle;
}

async function eraseLeadPii({ leadId, phone, actor, dryRun = false }) {
  const lead = await resolveLead(leadId, phone);
  if (!lead) throw new Error('lead_not_found');
  const cid = lead.clientId;
  const phoneHash = sha256(lead.phoneNumber || '');
  const emailHash = lead.email ? sha256(lead.email) : null;

  if (dryRun) {
    return { dryRun: true, leadId: lead._id, wouldRedact: PII_MODELS.map((m) => m.name) };
  }

  await AdLead.updateOne(
    { _id: lead._id, clientId: cid },
    {
      $set: {
        name: '[redacted]',
        email: emailHash,
        phoneNumber: phoneHash,
        erased: true,
        gdprErasedAt: new Date(),
      },
      $unset: { customFields: 1, cartSnapshot: 1 },
    }
  );

  await Message.updateMany(
    { clientId: cid },
    { $set: { text: '[redacted]' } }
  );

  await Order.updateMany(
    { clientId: cid, phone: lead.phoneNumber },
    { $set: { customerName: '[redacted]', phone: phoneHash, email: emailHash } }
  );

  await Conversation.updateMany(
    { clientId: cid, phone: lead.phoneNumber },
    { $set: { customerName: '[redacted]', phone: phoneHash } }
  );

  auditLog({
    category: 'pii',
    action: 'pii.erased',
    severity: 'critical',
    clientId: cid,
    actor,
    details: { leadId: lead._id },
    blocking: true,
  });

  return { erased: true, leadId: lead._id };
}

module.exports = { exportLeadBundle, eraseLeadPii, PII_MODELS };
