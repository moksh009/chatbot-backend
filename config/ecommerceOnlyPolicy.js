/**
 * E-commerce-first platform policy.
 * Legacy salon/clinic/turf automation stays in the codebase but is gated by env
 * so production e-commerce tenants are protected without deleting files.
 *
 * BLOCK_LEGACY_NICHE_AUTOMATION=true (default) — stop sending legacy appointment sequences
 * ENABLE_LEGACY_APPOINTMENT_REMINDERS=true — allow sendAppointmentReminder + appointment campaigns
 * HIDE_DEPRECATED_NICHE_TEMPLATES=true — hide deprecated templates in API lists (default: show with flag)
 */

const DEPRECATED_SEQUENCE_TEMPLATE_IDS = new Set(['tmpl_appointment_reminder']);
const DEPRECATED_PLAYBOOK_IDS = new Set(['appointment_reminder']);

const LEGACY_SEQUENCE_NAME_RE = /appointment\s*reminder/i;
const LEGACY_STEP_CONTENT_RE =
  /appointment\s+(tomorrow|is in 1 hour)|you have an appointment/i;

function envTruthy(name, defaultValue = false) {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultValue;
  return v === 'true' || v === '1';
}

/** Default true — blocks legacy niche sends unless explicitly disabled. */
function isLegacyNicheAutomationBlocked() {
  return envTruthy('BLOCK_LEGACY_NICHE_AUTOMATION', true);
}

function isLegacyAppointmentSendingEnabled() {
  return envTruthy('ENABLE_LEGACY_APPOINTMENT_REMINDERS', false);
}

function shouldHideDeprecatedTemplatesInUi() {
  return envTruthy('HIDE_DEPRECATED_NICHE_TEMPLATES', false);
}

function isDeprecatedSequenceTemplateId(templateId) {
  if (!templateId) return false;
  return DEPRECATED_SEQUENCE_TEMPLATE_IDS.has(String(templateId).trim());
}

function isDeprecatedPlaybookId(playbookId) {
  if (!playbookId) return false;
  return DEPRECATED_PLAYBOOK_IDS.has(String(playbookId).trim());
}

function isLegacyFollowUpSequence(seq) {
  if (!seq) return false;
  const name = String(seq.name || '');
  if (LEGACY_SEQUENCE_NAME_RE.test(name)) return true;
  const steps = seq.steps || [];
  return steps.some((s) => LEGACY_STEP_CONTENT_RE.test(String(s.content || '')));
}

function annotateSequenceTemplates(templates) {
  return (templates || []).map((t) => ({
    ...t,
    deprecated: isDeprecatedSequenceTemplateId(t.id),
    deprecatedReason: isDeprecatedSequenceTemplateId(t.id)
      ? 'Service-industry playbook. Disabled by default for e-commerce workspaces. Set ENABLE_LEGACY_APPOINTMENT_REMINDERS=true to send.'
      : undefined,
  }));
}

function filterSequenceTemplates(templates) {
  const annotated = annotateSequenceTemplates(templates);
  if (!shouldHideDeprecatedTemplatesInUi()) return annotated;
  return annotated.filter((t) => !t.deprecated);
}

function annotatePlaybooks(playbooks) {
  return (playbooks || []).map((p) => ({
    ...p,
    deprecated: isDeprecatedPlaybookId(p.id),
  }));
}

function filterPlaybooks(playbooks) {
  const annotated = annotatePlaybooks(playbooks);
  if (!shouldHideDeprecatedTemplatesInUi()) return annotated;
  return annotated.filter((p) => !p.deprecated);
}

async function cancelLegacyFollowUpSequences({ reason = 'legacy_niche_disabled' } = {}) {
  if (!isLegacyNicheAutomationBlocked()) return 0;

  const FollowUpSequence = require('../models/FollowUpSequence');
  const now = new Date();

  const byName = await FollowUpSequence.updateMany(
    { status: 'active', name: { $regex: LEGACY_SEQUENCE_NAME_RE } },
    { $set: { status: 'cancelled', cancelledAt: now, cancelReason: reason } }
  );

  const byContent = await FollowUpSequence.updateMany(
    { status: 'active', 'steps.content': { $regex: LEGACY_STEP_CONTENT_RE } },
    { $set: { status: 'cancelled', cancelledAt: now, cancelReason: reason } }
  );

  const cancelled = (byName.modifiedCount || 0) + (byContent.modifiedCount || 0);
  if (cancelled > 0) {
    const log = require('../utils/logger')('EcommerceOnly');
    log.warn(`Cancelled ${cancelled} legacy follow-up sequence(s)`, { reason });
  }
  return cancelled;
}

module.exports = {
  DEPRECATED_SEQUENCE_TEMPLATE_IDS,
  DEPRECATED_PLAYBOOK_IDS,
  isLegacyNicheAutomationBlocked,
  isLegacyAppointmentSendingEnabled,
  shouldHideDeprecatedTemplatesInUi,
  isDeprecatedSequenceTemplateId,
  isDeprecatedPlaybookId,
  isLegacyFollowUpSequence,
  annotateSequenceTemplates,
  filterSequenceTemplates,
  annotatePlaybooks,
  filterPlaybooks,
  cancelLegacyFollowUpSequences,
};
