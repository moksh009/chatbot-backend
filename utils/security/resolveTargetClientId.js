'use strict';

const LOOKUP = {
  campaign: { model: () => require('../../models/Campaign'), field: 'clientId' },
  campaignMessage: { model: () => require('../../models/CampaignMessage'), field: 'clientId' },
  conversation: { model: () => require('../../models/Conversation'), field: 'clientId' },
  igConversation: { model: () => require('../../models/IGConversation'), field: 'clientId' },
  order: { model: () => require('../../models/Order'), field: 'clientId' },
  lead: { model: () => require('../../models/AdLead'), field: 'clientId' },
  sequence: { model: () => require('../../models/FollowUpSequence'), field: 'clientId' },
  segment: { model: () => require('../../models/Segment'), field: 'clientId' },
  template: { model: () => require('../../models/MetaTemplate'), field: 'clientId' },
  trainingCase: { model: () => require('../../models/TrainingCase'), field: 'clientId' },
  knowledgeDocument: { model: () => require('../../models/KnowledgeDocument'), field: 'clientId' },
  notification: { model: () => require('../../models/Notification'), field: 'clientId' },
  exportJob: { model: () => require('../../models/ExportJob'), field: 'clientId' },
  optInTool: { model: () => require('../../models/OptInTool'), field: 'clientId' },
};

async function resolveTargetClientId(req, opts = {}) {
  const fromParam = req.params?.clientId;
  if (fromParam) return String(fromParam).trim();

  const fromBody = req.body?.clientId;
  if (fromBody) return String(fromBody).trim();

  const fromQuery = req.query?.clientId;
  if (fromQuery) return String(fromQuery).trim();

  if (opts.lookupBy && opts.param) {
    const id =
      req.params?.[opts.param] ||
      req.params?.id ||
      req.params?.leadId ||
      req.params?.contactId ||
      req.params?.sequenceId;
    if (!id) return null;
    const spec = LOOKUP[opts.lookupBy];
    if (!spec) return null;
    const Model = spec.model();
    const doc = await Model.findById(id).select(spec.field).setOptions({ bypassClientScope: true }).lean();
    return doc?.[spec.field] ? String(doc[spec.field]) : null;
  }

  if (opts.lookupBy === 'campaign' && req.params?.id) {
    const doc = await LOOKUP.campaign.model().findById(req.params.id).select('clientId').lean();
    return doc?.clientId || null;
  }

  return null;
}

module.exports = { resolveTargetClientId, LOOKUP };
