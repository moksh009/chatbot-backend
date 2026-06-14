'use strict';

const EmailTemplate = require('../models/EmailTemplate');
const { detectMergeVariables, htmlToPlainText } = require('../utils/core/emailTrackingService');

const CATEGORY_MAP = {
  custom: 'custom',
  marketing: 'marketing',
  order: 'order',
  cart: 'cart_recovery',
  cart_recovery: 'cart_recovery',
  sequence: 'sequence',
  utility: 'utility',
};

function normalizeCategory(raw) {
  const key = String(raw || 'custom').toLowerCase().replace(/\s+/g, '_');
  return CATEGORY_MAP[key] || 'custom';
}

function mapTemplateForApi(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    name: doc.name,
    category: doc.category,
    subject: doc.subject,
    content: doc.bodyHtml,
    bodyHtml: doc.bodyHtml,
    bodyText: doc.bodyText || htmlToPlainText(doc.bodyHtml),
    previewText: doc.previewText || '',
    variables: doc.variables || [],
    isSystem: !!doc.isSystem,
    isActive: doc.isActive !== false,
    isCustom: !doc.isSystem,
    tags: doc.tags || [],
    sentCount: doc.sentCount || 0,
    lastSentAt: doc.lastSentAt || null,
    version: doc.version || 1,
    legacyLocalId: doc.legacyLocalId || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function listEmailTemplates(clientId, { category, search, includeInactive = false } = {}) {
  const filter = { clientId, ...(includeInactive ? {} : { isActive: true }) };
  if (category && category !== 'all' && category !== 'custom') {
    filter.category = normalizeCategory(category);
  }
  if (category === 'custom') {
    filter.category = 'custom';
    filter.isSystem = false;
  }
  if (search && String(search).trim()) {
    const q = String(search).trim();
    filter.$or = [{ name: { $regex: q, $options: 'i' } }, { subject: { $regex: q, $options: 'i' } }];
  }

  const rows = await EmailTemplate.find(filter).sort({ updatedAt: -1 }).lean();
  return rows.map(mapTemplateForApi);
}

async function getEmailTemplate(clientId, templateId) {
  const row = await EmailTemplate.findOne({ clientId, _id: templateId, isActive: true }).lean();
  return mapTemplateForApi(row);
}

async function createEmailTemplate(clientId, body = {}, actorUserId = null) {
  const subject = String(body.subject || '').trim();
  const bodyHtml = String(body.bodyHtml || body.content || '').trim();
  const name = String(body.name || '').trim();
  if (!name || !subject || !bodyHtml) {
    const err = new Error('Name, subject, and body are required.');
    err.status = 400;
    throw err;
  }

  const doc = await EmailTemplate.create({
    clientId,
    name,
    category: normalizeCategory(body.category),
    subject,
    bodyHtml,
    bodyText: htmlToPlainText(bodyHtml),
    previewText: String(body.previewText || '').trim(),
    variables: detectMergeVariables(subject, bodyHtml),
    isSystem: false,
    isActive: true,
    tags: Array.isArray(body.tags) ? body.tags : [],
    createdBy: actorUserId || null,
    legacyLocalId: String(body.legacyLocalId || body.id || '').trim(),
  });
  return mapTemplateForApi(doc.toObject());
}

async function updateEmailTemplate(clientId, templateId, body = {}) {
  const existing = await EmailTemplate.findOne({ clientId, _id: templateId, isActive: true });
  if (!existing) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  if (existing.isSystem) {
    const err = new Error('System templates cannot be edited. Duplicate to customize.');
    err.status = 400;
    throw err;
  }

  if (body.name) existing.name = String(body.name).trim();
  if (body.subject) existing.subject = String(body.subject).trim();
  if (body.bodyHtml || body.content) {
    existing.bodyHtml = String(body.bodyHtml || body.content).trim();
    existing.bodyText = htmlToPlainText(existing.bodyHtml);
  }
  if (body.category) existing.category = normalizeCategory(body.category);
  if (body.previewText != null) existing.previewText = String(body.previewText).trim();
  if (Array.isArray(body.tags)) existing.tags = body.tags;
  existing.variables = detectMergeVariables(existing.subject, existing.bodyHtml);
  existing.version = (existing.version || 1) + 1;
  await existing.save();
  return mapTemplateForApi(existing.toObject());
}

async function deleteEmailTemplate(clientId, templateId) {
  const existing = await EmailTemplate.findOne({ clientId, _id: templateId, isActive: true });
  if (!existing) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  if (existing.isSystem) {
    const err = new Error('System templates cannot be deleted.');
    err.status = 400;
    throw err;
  }
  existing.isActive = false;
  await existing.save();
  return { success: true };
}

async function duplicateEmailTemplate(clientId, templateId, actorUserId = null) {
  const existing = await EmailTemplate.findOne({ clientId, _id: templateId }).lean();
  if (!existing) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  const doc = await EmailTemplate.create({
    clientId,
    name: `${existing.name} (copy)`,
    category: existing.isSystem ? 'custom' : existing.category,
    subject: existing.subject,
    bodyHtml: existing.bodyHtml,
    bodyText: existing.bodyText,
    previewText: existing.previewText,
    variables: existing.variables || [],
    isSystem: false,
    isActive: true,
    tags: existing.tags || [],
    createdBy: actorUserId || null,
  });
  return mapTemplateForApi(doc.toObject());
}

async function migrateLocalTemplates(clientId, templates = [], actorUserId = null) {
  if (!Array.isArray(templates) || !templates.length) {
    return { migrated: 0, skipped: 0 };
  }

  let migrated = 0;
  let skipped = 0;

  for (const tpl of templates) {
    const legacyId = String(tpl.id || '').trim();
    if (legacyId) {
      const exists = await EmailTemplate.findOne({ clientId, legacyLocalId: legacyId }).lean();
      if (exists) {
        skipped += 1;
        continue;
      }
    }
    await createEmailTemplate(clientId, {
      ...tpl,
      legacyLocalId: legacyId,
      category: 'custom',
    }, actorUserId);
    migrated += 1;
  }

  return { migrated, skipped };
}

async function bumpTemplateSentStats(clientId, templateId) {
  if (!templateId) return;
  await EmailTemplate.updateOne(
    { clientId, _id: templateId, isActive: true },
    { $inc: { sentCount: 1 }, $set: { lastSentAt: new Date() } }
  ).catch(() => {});
}

module.exports = {
  listEmailTemplates,
  getEmailTemplate,
  createEmailTemplate,
  updateEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  migrateLocalTemplates,
  bumpTemplateSentStats,
  mapTemplateForApi,
};
