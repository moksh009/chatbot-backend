'use strict';

const MetaTemplate = require('../../models/MetaTemplate');
const {
  getOrderMessageBlueprint,
  blueprintToWorkspaceTemplate,
  normalizeTemplateKey,
} = require('../../constants/orderMessageWaBlueprints');

async function ensureMetaTemplateDraftFromBlueprint(clientId, nameOrKey) {
  const local = blueprintToWorkspaceTemplate(nameOrKey);
  if (!local) return null;

  const name = normalizeTemplateKey(local.name);
  const existing = await MetaTemplate.findOne({ clientId, name }).sort({ updatedAt: -1 }).lean();
  if (existing && !['generation_failed'].includes(existing.submissionStatus)) {
    return existing;
  }

  const doc = await MetaTemplate.findOneAndUpdate(
    { clientId, name },
    {
      $set: {
        clientId,
        name,
        category: local.category,
        language: local.language,
        body: local.body,
        components: local.components,
        source: 'order_message_blueprint',
        templateKind: 'prebuilt',
        isPrebuilt: true,
        submissionStatus: 'draft',
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true, new: true }
  );
  return doc.toObject();
}

module.exports = {
  getOrderMessageBlueprint,
  blueprintToWorkspaceTemplate,
  ensureMetaTemplateDraftFromBlueprint,
};
