'use strict';

const { checkConsent } = require('../../utils/messaging/checks/checkConsent');
const { isEcoTemplateName } = require('../../utils/commerce/orderMessageTemplatePolicy');
const { findOrderDocForSequence } = require('./journeySequenceWhatsApp');

const WARNING_COPY = {
  no_phone: 'No WhatsApp number on this contact',
  no_email: 'No email address — email step will be skipped',
  email_opted_out: 'Unsubscribed from email — email step will be skipped',
  email_bounced: 'Email previously bounced — email step will be skipped',
  wa_opted_out: 'Opted out of WhatsApp — WhatsApp step will be skipped',
  no_order_context: 'No recent order found — order fields may be empty',
  no_contact: 'No phone or email on this contact',
};

function warning(code, stepType = null) {
  return {
    code,
    message: WARNING_COPY[code] || code.replace(/_/g, ' '),
    stepType,
  };
}

function journeyNeedsOrderContext(steps = []) {
  return steps.some((s) => {
    const type = String(s.type || 'whatsapp').toLowerCase();
    if (type === 'email') {
      const subj = String(s.subject || '');
      const body = String(s.content || '');
      return /\{\{order_/.test(subj) || /\{\{order_/.test(body);
    }
    const tpl = String(s.templateName || '');
    return isEcoTemplateName(tpl) || tpl.startsWith('eco_') || tpl.includes('order_');
  });
}

async function evaluateLeadEnrollPreflight({
  clientId,
  leadInput = {},
  leadDoc = null,
  hasWaSteps = false,
  hasEmailSteps = false,
  needsOrder = false,
}) {
  const phone = String(leadDoc?.phoneNumber || leadInput.phone || '').trim();
  const email = String(leadDoc?.email || leadInput.email || '').trim();
  const normalizedPhone = phone.replace(/\D/g, '');
  const hasPhone = normalizedPhone.length >= 10;
  const hasEmail = email.includes('@');

  const warnings = [];
  let waStatus = 'eligible';
  let emailStatus = 'eligible';

  if (!hasPhone && !hasEmail) {
    warnings.push(warning('no_contact'));
    waStatus = 'blocked';
    emailStatus = 'blocked';
  }

  if (hasWaSteps) {
    if (!hasPhone) {
      waStatus = 'blocked';
      warnings.push(warning('no_phone', 'whatsapp'));
    } else if (leadDoc) {
      const consent = checkConsent({
        contact: leadDoc,
        channel: 'whatsapp',
        intent: 'marketing',
      });
      if (!consent.pass) {
        waStatus = 'skipped';
        warnings.push(warning(consent.reason === 'recipient_opted_out' ? 'wa_opted_out' : consent.reason, 'whatsapp'));
      }
    }
  }

  if (hasEmailSteps) {
    if (!hasEmail) {
      emailStatus = 'skipped';
      warnings.push(warning('no_email', 'email'));
    } else if (leadDoc) {
      const consent = checkConsent({
        contact: leadDoc,
        channel: 'email',
        intent: 'marketing',
      });
      if (!consent.pass) {
        emailStatus = 'skipped';
        warnings.push(warning(consent.reason || 'email_opted_out', 'email'));
      }
    }
  }

  if (needsOrder && hasPhone) {
    const orderDoc = await findOrderDocForSequence(clientId, null, normalizedPhone);
    if (!orderDoc && !leadInput.sourceOrderId) {
      warnings.push(warning('no_order_context'));
    }
  }

  const enrollMeta = resolveEnrollStatus({
    hasWaSteps,
    hasEmailSteps,
    waStatus,
    emailStatus,
    warnings,
  });

  return {
    leadId: leadDoc?._id ? String(leadDoc._id) : String(leadInput.leadId || ''),
    name: leadDoc?.name || leadDoc?.fullName || leadInput.name || 'Customer',
    phone,
    email,
    waStatus: hasWaSteps ? waStatus : null,
    emailStatus: hasEmailSteps ? emailStatus : null,
    warnings,
    enrollStatus: enrollMeta.enrollStatus,
    blockedReason: enrollMeta.blockedReason || null,
  };
}

function resolveEnrollStatus({
  hasWaSteps,
  hasEmailSteps,
  waStatus,
  emailStatus,
  warnings = [],
}) {
  const noContact = warnings.some((w) => w.code === 'no_contact');
  if (noContact) {
    return { enrollStatus: 'blocked', blockedReason: 'no_contact' };
  }

  const blockedReasonFromWarnings = () =>
    warnings.find((w) =>
      ['wa_opted_out', 'no_phone', 'email_opted_out', 'email_bounced', 'no_email'].includes(w.code)
    )?.code || 'no_contact';

  if (hasWaSteps && !hasEmailSteps) {
    if (waStatus !== 'eligible') {
      return { enrollStatus: 'blocked', blockedReason: blockedReasonFromWarnings() };
    }
    return { enrollStatus: 'eligible', blockedReason: null };
  }

  if (hasEmailSteps && !hasWaSteps) {
    if (emailStatus !== 'eligible') {
      return { enrollStatus: 'blocked', blockedReason: blockedReasonFromWarnings() };
    }
    return { enrollStatus: 'eligible', blockedReason: null };
  }

  const waUsable = waStatus === 'eligible';
  const emailUsable = emailStatus === 'eligible';

  if (!waUsable && !emailUsable) {
    return { enrollStatus: 'blocked', blockedReason: blockedReasonFromWarnings() };
  }

  if (!waUsable || !emailUsable) {
    return { enrollStatus: 'partial', blockedReason: null };
  }

  return { enrollStatus: 'eligible', blockedReason: null };
}

async function buildEnrollPreflightReport({
  clientId,
  leads = [],
  leadDocs = [],
  steps = [],
}) {
  const hasWaSteps = steps.some((s) => String(s.type || 'whatsapp').toLowerCase() !== 'email');
  const hasEmailSteps = steps.some((s) => String(s.type).toLowerCase() === 'email');
  const needsOrder = journeyNeedsOrderContext(steps);
  const leadMap = new Map(leadDocs.map((l) => [String(l._id), l]));

  const evaluated = [];
  for (const leadInput of leads) {
    const leadDoc = leadMap.get(String(leadInput.leadId || '')) || null;
    evaluated.push(
      await evaluateLeadEnrollPreflight({
        clientId,
        leadInput,
        leadDoc,
        hasWaSteps,
        hasEmailSteps,
        needsOrder,
      })
    );
  }

  const waEligible = evaluated.filter((r) => r.waStatus === 'eligible').length;
  const emailEligible = evaluated.filter((r) => r.emailStatus === 'eligible').length;
  const noPhone = evaluated.filter((r) => r.warnings.some((w) => w.code === 'no_phone')).length;
  const noEmail = evaluated.filter((r) => r.warnings.some((w) => w.code === 'no_email')).length;
  const noContact = evaluated.filter((r) => r.warnings.some((w) => w.code === 'no_contact')).length;
  const wouldSkip = evaluated.filter((r) => r.warnings.length > 0).length;
  const eligibleCount = evaluated.filter((r) => r.enrollStatus === 'eligible' || r.enrollStatus === 'partial').length;
  const blockedCount = evaluated.filter((r) => r.enrollStatus === 'blocked').length;

  return {
    total: leads.length,
    waEligible: hasWaSteps ? waEligible : null,
    emailEligible: hasEmailSteps ? emailEligible : null,
    noPhone: hasWaSteps ? noPhone : null,
    noEmail: hasEmailSteps ? noEmail : null,
    noContact,
    wouldSkip,
    eligibleCount,
    blockedCount,
    hasWaSteps,
    hasEmailSteps,
    needsOrderContext: needsOrder,
    leads: evaluated,
  };
}

module.exports = {
  WARNING_COPY,
  journeyNeedsOrderContext,
  evaluateLeadEnrollPreflight,
  buildEnrollPreflightReport,
  resolveEnrollStatus,
};
