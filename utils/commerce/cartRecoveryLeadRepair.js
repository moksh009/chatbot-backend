'use strict';

const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');
const {
  normalizeIndianPhone,
  indianPhoneLookupVariants,
  indianPhoneSuffix,
} = require('../core/normalizeIndianPhone');
const log = require('../core/logger')('CartRecoveryLeadRepair');

const PLACEHOLDER_NAMES = new Set(['', 'checkout customer', 'guest', 'a customer']);

function isPlaceholderName(name) {
  return PLACEHOLDER_NAMES.has(String(name || '').trim().toLowerCase());
}

function isPlaceholderPhone(phone) {
  const p = String(phone || '');
  return !p || p.startsWith('unknown_checkout_') || p.startsWith('unknown_email_');
}

function leadPriorityScore(lead) {
  let score = 0;
  if (!isPlaceholderPhone(lead.phoneNumber)) score += 40;
  if (lead.cartStatus === 'abandoned') score += 30;
  else if (lead.cartStatus === 'active') score += 20;
  else if (lead.cartStatus === 'purchased' || lead.isOrderPlaced) score += 10;
  if (lead.contactCapturedAt) score += 5;
  if (lead.checkoutToken || lead.cartSnapshot?.checkoutToken) score += 3;
  if (!isPlaceholderName(lead.name)) score += 8;
  return score;
}

function pickCanonicalLead(a, b) {
  const aPlaceholder = isPlaceholderPhone(a.phoneNumber);
  const bPlaceholder = isPlaceholderPhone(b.phoneNumber);
  if (aPlaceholder !== bPlaceholder) return aPlaceholder ? b : a;

  const scoreA = leadPriorityScore(a);
  const scoreB = leadPriorityScore(b);
  if (scoreA !== scoreB) return scoreB > scoreA ? b : a;

  const timeA = new Date(a.lastCartEventAt || a.updatedAt || 0).getTime();
  const timeB = new Date(b.lastCartEventAt || b.updatedAt || 0).getTime();
  return timeB >= timeA ? b : a;
}

async function resolveNameForLead(clientId, lead) {
  if (!isPlaceholderName(lead.name)) return null;

  const token = String(lead.checkoutToken || lead.cartSnapshot?.checkoutToken || '').trim();
  if (token) {
    const byToken = await Order.findOne({ clientId, checkoutToken: token })
      .sort({ createdAt: -1 })
      .select('customerName name')
      .lean();
    const fromOrder = byToken?.customerName || byToken?.name;
    if (fromOrder && !isPlaceholderName(fromOrder)) return fromOrder.trim();
  }

  if (!isPlaceholderPhone(lead.phoneNumber)) {
    const variants = indianPhoneLookupVariants(lead.phoneNumber);
    const suffix = indianPhoneSuffix(lead.phoneNumber);
    const or = [];
    if (variants.length) or.push({ customerPhone: { $in: variants } }, { phone: { $in: variants } });
    if (suffix.length >= 8) {
      or.push(
        { customerPhone: { $regex: new RegExp(`${suffix}$`) } },
        { phone: { $regex: new RegExp(`${suffix}$`) } }
      );
    }
    if (or.length) {
      const byPhone = await Order.findOne({ clientId, $or: or })
        .sort({ createdAt: -1 })
        .select('customerName name')
        .lean();
      const fromOrder = byPhone?.customerName || byPhone?.name;
      if (fromOrder && !isPlaceholderName(fromOrder)) return fromOrder.trim();
    }
  }

  const metaName =
    lead.meta?.checkoutContact?.name ||
    lead.meta?.checkoutContact?.shipping?.name ||
    lead.meta?.checkoutContact?.billing?.name;
  if (metaName && !isPlaceholderName(metaName)) return String(metaName).trim();

  return null;
}

function buildMergePatch(canonical, duplicate) {
  const $set = {};

  if (isPlaceholderName(canonical.name) && !isPlaceholderName(duplicate.name)) {
    $set.name = duplicate.name;
  }

  const canonPhone = normalizeIndianPhone(canonical.phoneNumber);
  const dupPhone = normalizeIndianPhone(duplicate.phoneNumber);
  if (
    (!canonPhone || isPlaceholderPhone(canonical.phoneNumber)) &&
    dupPhone &&
    !isPlaceholderPhone(duplicate.phoneNumber)
  ) {
    $set.phoneNumber = dupPhone;
  }

  const cSnapTime = new Date(canonical.cartSnapshot?.updatedAt || 0).getTime();
  const dSnapTime = new Date(duplicate.cartSnapshot?.updatedAt || 0).getTime();
  if (dSnapTime > cSnapTime && duplicate.cartSnapshot) {
    $set.cartSnapshot = duplicate.cartSnapshot;
    if (duplicate.cartValue != null) $set.cartValue = duplicate.cartValue;
  }

  if ((duplicate.recoveryStep || 0) > (canonical.recoveryStep || 0)) {
    $set.recoveryStep = duplicate.recoveryStep;
  }

  if (!canonical.contactCapturedAt && duplicate.contactCapturedAt) {
    $set.contactCapturedAt = duplicate.contactCapturedAt;
  }

  if (!canonical.checkoutToken && duplicate.checkoutToken) {
    $set.checkoutToken = duplicate.checkoutToken;
  }

  if (!canonical.email && duplicate.email) {
    $set.email = duplicate.email;
  }

  return $set;
}

async function repairCartRecoveryLeadsForClient(clientId, { dryRun = false } = {}) {
  if (!clientId) {
    return {
      phonesNormalized: 0,
      namesFixed: 0,
      merged: 0,
      deleted: 0,
      conflicts: 0,
      skipped: 0,
      details: [],
    };
  }

  let phonesNormalized = 0;
  let namesFixed = 0;
  let merged = 0;
  let deleted = 0;
  let conflicts = 0;
  let skipped = 0;
  const details = [];

  async function loadLeads() {
    return AdLead.find({ clientId })
      .select(
        'phoneNumber email name checkoutToken cartSnapshot cartStatus cartValue recoveryStep contactCapturedAt isOrderPlaced lastCartEventAt updatedAt createdAt meta'
      )
      .lean();
  }

  let refreshed = await loadLeads();

  const byToken = new Map();
  for (const lead of refreshed) {
    const token = String(lead.checkoutToken || lead.cartSnapshot?.checkoutToken || '').trim();
    if (!token) continue;
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(lead);
  }

  for (const [token, group] of byToken.entries()) {
    if (group.length < 2) continue;

    let canonical = group[0];
    for (let i = 1; i < group.length; i += 1) {
      canonical = pickCanonicalLead(canonical, group[i]);
    }

    const duplicates = group.filter((l) => String(l._id) !== String(canonical._id));
    for (const dup of duplicates) {
      if (!dryRun) {
        await CartRecoveryAttempt.updateMany(
          { clientId, leadId: dup._id },
          { $set: { leadId: canonical._id } }
        );
        await AdLead.deleteOne({ _id: dup._id });
      }
      deleted += 1;
      details.push({
        status: 'duplicate_removed',
        canonicalId: String(canonical._id),
        duplicateId: String(dup._id),
        token,
        dupPhone: dup.phoneNumber,
        dupName: dup.name,
      });
    }

    let patch = {};
    for (const dup of duplicates) {
      patch = { ...patch, ...buildMergePatch({ ...canonical, ...patch }, dup) };
    }
    if (Object.keys(patch).length) {
      if (!dryRun) {
        await AdLead.updateOne({ _id: canonical._id }, { $set: patch });
      }
      merged += 1;
      details.push({
        status: 'merged_fields',
        canonicalId: String(canonical._id),
        token,
        fields: Object.keys(patch),
      });
    }
  }

  refreshed = await loadLeads();

  const byPhoneSuffix = new Map();
  for (const lead of refreshed) {
    if (isPlaceholderPhone(lead.phoneNumber)) continue;
    const suffix = indianPhoneSuffix(lead.phoneNumber);
    if (suffix.length < 8) continue;
    if (!byPhoneSuffix.has(suffix)) byPhoneSuffix.set(suffix, []);
    byPhoneSuffix.get(suffix).push(lead);
  }

  for (const [, group] of byPhoneSuffix.entries()) {
    if (group.length < 2) continue;

    let canonical = group[0];
    for (let i = 1; i < group.length; i += 1) {
      canonical = pickCanonicalLead(canonical, group[i]);
    }

    const duplicates = group.filter((l) => String(l._id) !== String(canonical._id));
    for (const dup of duplicates) {
      if (!dryRun) {
        await CartRecoveryAttempt.updateMany(
          { clientId, leadId: dup._id },
          { $set: { leadId: canonical._id } }
        );
        await AdLead.deleteOne({ _id: dup._id });
      }
      merged += 1;
      deleted += 1;
      details.push({
        status: 'phone_suffix_merged',
        canonicalId: String(canonical._id),
        duplicateId: String(dup._id),
        phone: canonical.phoneNumber,
      });
    }

    let patch = {};
    for (const dup of duplicates) {
      patch = { ...patch, ...buildMergePatch({ ...canonical, ...patch }, dup) };
    }
    const normalizedPhone = normalizeIndianPhone(
      patch.phoneNumber || canonical.phoneNumber || duplicates[0]?.phoneNumber || ''
    );
    if (normalizedPhone) patch.phoneNumber = normalizedPhone;

    if (Object.keys(patch).length) {
      if (!dryRun) {
        await AdLead.updateOne({ _id: canonical._id }, { $set: patch });
      }
      details.push({
        status: 'phone_suffix_updated',
        canonicalId: String(canonical._id),
        fields: Object.keys(patch),
      });
    }
  }

  refreshed = await loadLeads();

  for (const lead of refreshed) {
    const current = lead.phoneNumber;
    if (!current || isPlaceholderPhone(current)) {
      skipped += 1;
      continue;
    }

    const e164 = normalizeIndianPhone(current);
    if (!e164 || e164 === current) {
      skipped += 1;
      continue;
    }

    const variants = indianPhoneLookupVariants(e164);
    const existing = await AdLead.findOne({
      clientId,
      _id: { $ne: lead._id },
      phoneNumber: { $in: variants.length ? variants : [e164] },
    })
      .select('_id phoneNumber')
      .lean();

    if (existing) {
      if (!dryRun) {
        await CartRecoveryAttempt.updateMany(
          { clientId, leadId: lead._id },
          { $set: { leadId: existing._id } }
        );
        await AdLead.deleteOne({ _id: lead._id });
      }
      deleted += 1;
      details.push({
        status: 'phone_duplicate_removed',
        canonicalId: String(existing._id),
        duplicateId: String(lead._id),
        from: current,
        to: e164,
      });
      continue;
    }

    if (!dryRun) {
      await AdLead.updateOne({ _id: lead._id }, { $set: { phoneNumber: e164 } });
    }
    phonesNormalized += 1;
    details.push({ status: 'phone_normalized', leadId: String(lead._id), from: current, to: e164 });
  }

  refreshed = await loadLeads();

  for (const lead of refreshed) {
    const resolvedName = await resolveNameForLead(clientId, lead);
    if (!resolvedName) continue;

    if (!dryRun) {
      await AdLead.updateOne({ _id: lead._id }, { $set: { name: resolvedName } });
    }
    namesFixed += 1;
    details.push({
      status: 'name_fixed',
      leadId: String(lead._id),
      from: lead.name,
      to: resolvedName,
    });
  }

  log.info(
    `[${clientId}] cart recovery repair: phones=${phonesNormalized} names=${namesFixed} merged=${merged} deleted=${deleted} conflicts=${conflicts}`
  );

  return {
    phonesNormalized,
    namesFixed,
    merged,
    deleted,
    conflicts,
    skipped,
    details,
  };
}

module.exports = {
  repairCartRecoveryLeadsForClient,
  isPlaceholderName,
  isPlaceholderPhone,
  pickCanonicalLead,
};
