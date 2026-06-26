'use strict';

const OptInSavedTemplate = require('../models/OptInSavedTemplate');
const OptInTool = require('../models/OptInTool');

function serializeSaved(doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  return {
    id: String(o._id),
    name: o.name,
    type: o.type,
    design: o.design || {},
    triggers: o.triggers || {},
    prizes: o.prizes || [],
    mysteryRevealType: o.mysteryRevealType || 'scratch',
    previewColor:
      o.previewColor ||
      o.design?.colors?.buttonBackground ||
      o.design?.backgroundRight ||
      '#7C3AED',
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function listSavedTemplates(clientId, { type } = {}) {
  const query = { clientId };
  if (type) query.type = type;
  const rows = await OptInSavedTemplate.find(query).sort({ updatedAt: -1 }).lean();
  return rows.map(serializeSaved);
}

async function saveTemplateFromTool(clientId, toolId, name) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId }).lean();
  if (!tool) return null;
  const label = String(name || '').trim() || `${tool.name} template`;
  const doc = await OptInSavedTemplate.create({
    clientId,
    name: label,
    type: tool.type,
    design: tool.design || {},
    triggers: tool.triggers || {},
    prizes: tool.prizes || [],
    mysteryRevealType: tool.mysteryRevealType || 'scratch',
    previewColor:
      tool.design?.colors?.buttonBackground ||
      tool.design?.backgroundRight ||
      tool.design?.widgetColor ||
      '#7C3AED',
  });
  return serializeSaved(doc);
}

async function deleteSavedTemplate(clientId, savedId) {
  const result = await OptInSavedTemplate.deleteOne({ _id: savedId, clientId });
  return result.deletedCount > 0;
}

module.exports = {
  listSavedTemplates,
  saveTemplateFromTool,
  deleteSavedTemplate,
  serializeSaved,
};
