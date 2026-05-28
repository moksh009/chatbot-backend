const CustomUsageTag = require('../../models/CustomUsageTag');
const MetaTemplate = require('../../models/MetaTemplate');

const MAX_TAGS_PER_TEMPLATE = 3;
const MAX_TAGS_PER_WORKSPACE = 20;

async function listWorkspaceTagNames(clientId) {
  const rows = await CustomUsageTag.find({ clientId }).sort({ name: 1 }).lean();
  return rows.map((r) => r.name);
}

async function validateUsageTagsForClient(clientId, usageTags) {
  if (!Array.isArray(usageTags)) {
    return { ok: false, error: 'usageTags must be an array.' };
  }
  if (usageTags.length > MAX_TAGS_PER_TEMPLATE) {
    return { ok: false, error: `Maximum ${MAX_TAGS_PER_TEMPLATE} usage tags per template.` };
  }
  const names = usageTags.map((t) => String(t || '').trim()).filter(Boolean);
  if (names.length !== usageTags.length) {
    return { ok: false, error: 'Usage tag names cannot be empty.' };
  }
  const unique = new Set(names.map((n) => n.toLowerCase()));
  if (unique.size !== names.length) {
    return { ok: false, error: 'Duplicate usage tags are not allowed.' };
  }

  const allowedRows = await CustomUsageTag.find({ clientId }).lean();
  const canonical = [];
  for (const inputName of names) {
    const match = allowedRows.find((r) => r.name.toLowerCase() === inputName.toLowerCase());
    if (!match) {
      return { ok: false, error: `Usage tag "${inputName}" does not exist for this workspace.` };
    }
    canonical.push(match.name);
  }
  return { ok: true, tags: canonical };
}

async function removeTagFromAllTemplates(clientId, tagName) {
  if (!clientId || !tagName) return;
  const needle = String(tagName).toLowerCase();
  const templates = await MetaTemplate.find({
    clientId,
    usageTags: { $exists: true, $not: { $size: 0 } },
  })
    .select('usageTags')
    .lean();

  const ops = [];
  for (const tpl of templates) {
    const tags = Array.isArray(tpl.usageTags) ? tpl.usageTags : [];
    const next = tags.filter((t) => String(t).toLowerCase() !== needle);
    if (next.length !== tags.length) {
      ops.push({
        updateOne: {
          filter: { _id: tpl._id },
          update: { $set: { usageTags: next, updatedAt: new Date() } },
        },
      });
    }
  }
  if (ops.length) await MetaTemplate.bulkWrite(ops);
}

module.exports = {
  MAX_TAGS_PER_TEMPLATE,
  MAX_TAGS_PER_WORKSPACE,
  listWorkspaceTagNames,
  validateUsageTagsForClient,
  removeTagFromAllTemplates,
};
