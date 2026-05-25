'use strict';

const { normalizeTemplateStatus } = require('../../constants/templateLifecycle');
const { filterTemplatesForManagerList } = require('./templateListPolicy');
const {
  isSystemExcluded,
  isCampaignEligible,
  isSequenceEligible,
  isOrderMessageEligible,
  normalizePurpose,
  filterTemplatesForContext,
} = require('./templatePolicy');

function attachUnifiedEligibility(template) {
  const row = { ...template };
  row.eligibleFor = {
    campaign: isCampaignEligible(row),
    sequence: isSequenceEligible(row),
    order_status: isOrderMessageEligible(row),
  };
  row.primaryPurpose = normalizePurpose(row.primaryPurpose || 'utility');
  row.displaySource = row.source || 'synced_meta';
  return row;
}

function buildUnifiedMeta(allMerged, displayList) {
  const list = Array.isArray(allMerged) ? allMerged : [];
  const shown = Array.isArray(displayList) ? displayList : list;

  let approved = 0;
  let pending = 0;
  let draft = 0;
  let rejected = 0;

  for (const t of list) {
    const norm = normalizeTemplateStatus(t.status || t.submissionStatus);
    if (norm === 'APPROVED') approved += 1;
    else if (['PENDING', 'SUBMITTING', 'QUEUED'].includes(norm)) pending += 1;
    else if (['REJECTED', 'FAILED'].includes(norm)) rejected += 1;
    else draft += 1;
  }

  const campaignCtx = filterTemplatesForContext(list, 'campaign');
  const sequenceCtx = filterTemplatesForContext(list, 'sequence');
  const orderCtx = filterTemplatesForContext(list, 'order_status');

  return {
    total: list.length,
    shown: shown.length,
    approved,
    pending,
    draft,
    rejected,
    systemExcluded: list.filter(isSystemExcluded).length,
    campaignEligible: campaignCtx.eligible.length,
    sequenceEligible: sequenceCtx.eligible.length,
    orderEligible: orderCtx.eligible.length,
    hidden: {
      systemExcluded: campaignCtx.hidden.systemExcluded,
      notApproved: campaignCtx.hidden.notApproved,
      wrongCategory: campaignCtx.hidden.wrongCategory,
    },
  };
}

/**
 * Manager library view: displayable rows + eligibility annotations + meta counts.
 */
function buildUnifiedLibraryResponse(merged) {
  const filtered = filterTemplatesForManagerList(merged).filter((t) => !isSystemExcluded(t));
  const data = filtered.map(attachUnifiedEligibility);
  const meta = buildUnifiedMeta(merged, data);
  return { data, meta };
}

/**
 * Context picker view (campaign / sequence / order_status).
 */
function buildUnifiedContextResponse(merged, contextPurpose) {
  const { eligible, hidden, approvedTotal, syncedTotal } = filterTemplatesForContext(
    merged,
    contextPurpose
  );
  const data = eligible.map(attachUnifiedEligibility);
  return {
    data,
    meta: {
      contextPurpose: normalizePurpose(contextPurpose, 'campaign'),
      syncedTotal,
      approvedTotal,
      eligibleTotal: data.length,
      hiddenSystem: hidden.systemExcluded,
      hiddenNotApproved: hidden.notApproved,
      hiddenWrongCategory: hidden.wrongCategory,
      campaignEligible: filterTemplatesForContext(merged, 'campaign').eligible.length,
      sequenceEligible: filterTemplatesForContext(merged, 'sequence').eligible.length,
      orderEligible: filterTemplatesForContext(merged, 'order_status').eligible.length,
    },
  };
}

module.exports = {
  attachUnifiedEligibility,
  buildUnifiedMeta,
  buildUnifiedLibraryResponse,
  buildUnifiedContextResponse,
};
