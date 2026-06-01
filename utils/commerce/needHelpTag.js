const AdLead = require('../../models/AdLead');

const NEED_HELP_TAG = 'Need help';

const LEGACY_HUMAN_TAGS = ['Human', 'human', 'pending-human', 'Pending Human'];

function phoneLookupFilter(clientId, phone) {
  const raw = String(phone || '').trim();
  if (!raw || !clientId) return null;
  const digits = raw.replace(/\D/g, '');
  const variants = new Set([raw]);
  if (digits) {
    variants.add(digits);
    if (digits.length === 10) variants.add(`91${digits}`);
    if (digits.length === 12 && digits.startsWith('91')) {
      variants.add(digits.slice(2));
      variants.add(`+${digits}`);
    }
    if (!raw.startsWith('+') && digits.length >= 10) variants.add(`+${digits}`);
  }
  return { clientId, phoneNumber: { $in: [...variants] } };
}

/**
 * Mark contact as needing agent help (replaces legacy Human / pending-human tags).
 */
async function applyNeedHelpTag(clientId, phone) {
  const filter = phoneLookupFilter(clientId, phone);
  if (!filter) return;
  await AdLead.updateMany(filter, {
    $addToSet: { tags: NEED_HELP_TAG },
    $pull: { tags: { $in: LEGACY_HUMAN_TAGS } },
  });
}

/** Normalize flow/automation tag adds — block legacy human tags. */
function normalizeLeadTagForAdd(tag) {
  const t = String(tag || '').trim();
  if (!t) return null;
  if (LEGACY_HUMAN_TAGS.some((x) => x.toLowerCase() === t.toLowerCase())) return NEED_HELP_TAG;
  if (/^pending[\s_-]*human$/i.test(t)) return NEED_HELP_TAG;
  return t;
}

module.exports = {
  NEED_HELP_TAG,
  LEGACY_HUMAN_TAGS,
  applyNeedHelpTag,
  normalizeLeadTagForAdd,
};
