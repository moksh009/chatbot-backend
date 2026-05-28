const axios = require('axios');
const mongoose = require('mongoose');
const MetaTemplate = require('../../models/MetaTemplate');
const { tenantClientId } = require('../../utils/core/queryHelpers');
const { extractVariablesRaw, resolveClientForTenant } = require('./templateSubmitController');
const { validateUsageTagsForClient } = require('../../utils/meta/templateUsageTags');
const CustomUsageTag = require('../../models/CustomUsageTag');

const META_GRAPH_VERSION = 'v19.0';

function toSafeMetaName(raw) {
  return String(raw || 'draft')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 512);
}

function formatInternalNameFromMetaName(raw) {
  return String(raw || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function saveDraft(req, res) {
  try {
    const tenantId = tenantClientId(req);
    const {
      clientId,
      internalName = null,
      name = '',
      category = 'MARKETING',
      language = 'en',
      usageTags = [],
      variableType = 'Number',
      mediaSample = 'None',
      headerImageUrl = null,
      headerText = null,
      bodyText = '',
      footerText = null,
      headerSamples = [],
      bodySamples = [],
      buttons = [],
      variableSamples = null,
      upsertByName = false,
      templateId = null,
    } = req.body;

    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required.' });
    }

    const formData = {
      variableType,
      mediaSample,
      headerImageUrl,
      headerText,
      bodyText: bodyText || ' ',
      footerText,
      headerSamples: Array.isArray(headerSamples) ? headerSamples : [],
      bodySamples: Array.isArray(bodySamples) ? bodySamples : [],
      buttons: Array.isArray(buttons) ? buttons : [],
    };

    if (variableSamples && typeof variableSamples === 'object') {
      const hTok = extractVariablesRaw(headerText);
      const bTok = extractVariablesRaw(bodyText);
      formData.headerSamples = hTok.map((t) => String(variableSamples[t] || ''));
      formData.bodySamples = bTok.map((t) => String(variableSamples[t] || ''));
    }

    const safeName = toSafeMetaName(name) || `draft_${Date.now()}`;

    let usageTagsPersist = [];
    if (Array.isArray(usageTags) && usageTags.length) {
      const tagCheck = await validateUsageTagsForClient(clientId, usageTags);
      if (!tagCheck.ok) return res.status(400).json({ error: tagCheck.error });
      usageTagsPersist = tagCheck.tags;
    }

    const internalTrimmed = internalName != null ? String(internalName).trim() : '';
    const internalNamePersist = internalTrimmed || formatInternalNameFromMetaName(safeName) || null;
    const persist = {
      clientId,
      name: safeName,
      internalName: internalNamePersist,
      category: ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category) ? category : 'MARKETING',
      language: language || 'en',
      usageTags: usageTagsPersist,
      formData,
      body: bodyText || ' ',
      footerText: footerText || null,
      headerType:
        mediaSample === 'Image' && headerImageUrl
          ? 'IMAGE'
          : headerText && String(headerText).trim()
            ? 'TEXT'
            : 'NONE',
      headerValue:
        mediaSample === 'Image' && headerImageUrl
          ? headerImageUrl
          : headerText && String(headerText).trim()
            ? headerText
            : '',
      buttons: (buttons || []).map((b) => ({
        type: b.buttonType,
        text: b.text,
        url: b.url || null,
        phone_number: b.phoneNumber || null,
      })),
      submissionStatus: 'draft',
      source: 'manual',
      metaApiError: null,
    };

    if (templateId && mongoose.Types.ObjectId.isValid(templateId)) {
      const existing = await MetaTemplate.findOne({ _id: templateId, clientId });
      if (!existing) return res.status(404).json({ error: 'Template not found.' });
      await MetaTemplate.updateOne({ _id: existing._id }, { $set: persist });
      return res.status(200).json({ success: true, templateId: existing._id, upserted: true });
    }

    if (upsertByName) {
      const existingByName = await MetaTemplate.findOne({ clientId, name: safeName });
      if (existingByName) {
        const $set = {
          updatedAt: new Date(),
          usageTags: usageTagsPersist,
        };
        if (internalName != null) {
          $set.internalName = internalTrimmed || null;
        }
        await MetaTemplate.updateOne({ _id: existingByName._id }, { $set });
        return res.status(200).json({ success: true, templateId: existingByName._id, upserted: true });
      }
    }

    const created = await MetaTemplate.create({
      ...persist,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return res.status(200).json({ success: true, templateId: created._id });
  } catch (err) {
    console.error('[meta-templates/draft]', err);
    return res.status(500).json({ error: 'Failed to save draft.' });
  }
}

async function listTemplates(req, res) {
  try {
    const tenantId = tenantClientId(req);
    const clientId = req.query.clientId || tenantId;
    const status = (req.query.status || 'all').toLowerCase();
    const statusesRaw = String(req.query.statuses || '')
      .split(',')
      .map((v) => String(v || '').trim().toLowerCase())
      .filter(Boolean);
    const usageTagFilters = String(req.query.usageTags || '')
      .split(',')
      .map((v) => String(v || '').trim())
      .filter(Boolean);
    const search = String(req.query.search || '').trim();
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = 100;

    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const q = { clientId };
    const statusMap = {
      approved: 'approved',
      in_review: 'pending_meta_review',
      pending: 'pending_meta_review',
      rejected: 'rejected',
      draft: 'draft',
      failed: 'submission_failed',
      not_on_meta: '__NOT_ON_META__',
    };
    const mappedStatuses = statusesRaw
      .map((s) => statusMap[s] || s)
      .filter(Boolean);

    if (mappedStatuses.length > 0) {
      if (mappedStatuses.includes('__NOT_ON_META__')) {
        const nonMissing = mappedStatuses.filter((s) => s !== '__NOT_ON_META__');
        q.$or = [
          ...(q.$or || []),
          { metaTemplateId: { $in: [null, ''] } },
          ...(nonMissing.length ? [{ submissionStatus: { $in: nonMissing } }] : []),
        ];
      } else {
        q.submissionStatus = { $in: mappedStatuses };
      }
    } else if (status && status !== 'all') {
      q.submissionStatus = status;
    }
    if (usageTagFilters.length > 0) {
      q.usageTags = { $in: usageTagFilters };
    }
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      const searchOr = [{ internalName: searchRegex }, { name: searchRegex }];
      if (Array.isArray(q.$or) && q.$or.length > 0) {
        q.$and = [{ $or: q.$or }, { $or: searchOr }];
        delete q.$or;
      } else {
        q.$or = searchOr;
      }
    }

    const [total, rows, workspaceTagRows] = await Promise.all([
      MetaTemplate.countDocuments(q),
      MetaTemplate.find(q)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CustomUsageTag.find({ clientId }).sort({ name: 1 }).lean(),
    ]);

    const normalized = rows.map((row) => {
      const fallback = formatInternalNameFromMetaName(row?.name);
      return {
        ...row,
        internalName: String(row?.internalName || '').trim() || fallback || null,
      };
    });

    return res.json({
      success: true,
      data: normalized,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
      availableUsageTags: workspaceTagRows.map((tag) => tag.name),
    });
  } catch (err) {
    console.error('[meta-templates list]', err);
    return res.status(500).json({ error: 'Failed to list templates.' });
  }
}

async function getOne(req, res) {
  try {
    const tenantId = tenantClientId(req);
    const clientId = req.query.clientId || tenantId;
    const { id } = req.params;

    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const doc = await MetaTemplate.findOne({ _id: id, clientId }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const client = await require('../../models/Client').findOne({ clientId }).select('businessName brandName businessLogo nicheData').lean();
    const { hydrateTemplateDocForEditor } = require('../../utils/meta/metaTemplateFormHydration');
    return res.json({ success: true, data: hydrateTemplateDocForEditor(doc, client || {}) });
  } catch (err) {
    console.error('[meta-templates get]', err);
    return res.status(500).json({ error: 'Failed to load template.' });
  }
}

async function patchTemplate(req, res) {
  try {
    const tenantId = tenantClientId(req);
    const clientId = req.body.clientId || tenantId;
    const { id } = req.params;

    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const doc = await MetaTemplate.findOne({ _id: id, clientId });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (doc.submissionStatus === 'pending_meta_review') {
      return res.status(400).json({ error: 'Cannot update a template pending Meta review.' });
    }

    const updates = req.body || {};
    const flatKeys = [
      'internalName',
      'name',
      'category',
      'language',
      'usageTags',
      'variableType',
      'mediaSample',
      'headerImageUrl',
      'headerText',
      'bodyText',
      'footerText',
      'headerSamples',
      'bodySamples',
      'buttons',
      'variableSamples',
    ];
    const hasFlat = flatKeys.some((k) => updates[k] !== undefined);

    let $set = { updatedAt: new Date() };

    if (updates.internalName !== undefined && !hasFlat) {
      const trimmed = String(updates.internalName || '').trim();
      if (trimmed.length > 150) {
        return res.status(400).json({ error: 'Internal name cannot exceed 150 characters.' });
      }
      $set.internalName = trimmed || formatInternalNameFromMetaName(updates.name || doc.name) || null;
    }

    if (updates.usageTags !== undefined && !hasFlat) {
      const tagCheck = await validateUsageTagsForClient(clientId, updates.usageTags);
      if (!tagCheck.ok) return res.status(400).json({ error: tagCheck.error });
      $set.usageTags = tagCheck.tags;
    }

    if (hasFlat) {
      const {
        internalName = doc.internalName,
        name = doc.name,
        category = doc.category,
        language = doc.language,
        usageTags = doc.usageTags || [],
        variableType = doc.formData?.variableType || 'Number',
        mediaSample = doc.formData?.mediaSample || 'None',
        headerImageUrl = doc.formData?.headerImageUrl,
        headerText = doc.formData?.headerText,
        bodyText = doc.body || doc.formData?.bodyText,
        footerText = doc.footerText,
        headerSamples = doc.formData?.headerSamples,
        bodySamples = doc.formData?.bodySamples,
        buttons = doc.formData?.buttons,
        variableSamples = null,
      } = updates;

      const formData = {
        variableType,
        mediaSample,
        headerImageUrl,
        headerText,
        bodyText: bodyText || ' ',
        footerText,
        headerSamples: Array.isArray(headerSamples) ? headerSamples : [],
        bodySamples: Array.isArray(bodySamples) ? bodySamples : [],
        buttons: Array.isArray(buttons) ? buttons : [],
      };
      if (variableSamples && typeof variableSamples === 'object') {
        const hTok = extractVariablesRaw(headerText);
        const bTok = extractVariablesRaw(bodyText);
        formData.headerSamples = hTok.map((t) => String(variableSamples[t] || ''));
        formData.bodySamples = bTok.map((t) => String(variableSamples[t] || ''));
      }

      const safeName = toSafeMetaName(name) || doc.name;

      let usageTagsPersist = Array.isArray(doc.usageTags) ? doc.usageTags : [];
      if (updates.usageTags !== undefined) {
        const tagCheck = await validateUsageTagsForClient(clientId, usageTags);
        if (!tagCheck.ok) return res.status(400).json({ error: tagCheck.error });
        usageTagsPersist = tagCheck.tags;
      }

      let internalNamePersist = doc.internalName;
      if (updates.internalName !== undefined) {
        const internalTrimmed = String(internalName || '').trim();
        if (internalTrimmed.length > 150) {
          return res.status(400).json({ error: 'Internal name cannot exceed 150 characters.' });
        }
        internalNamePersist = internalTrimmed || formatInternalNameFromMetaName(safeName) || null;
      }

      $set = {
        ...$set,
        name: safeName,
        internalName: internalNamePersist,
        category: ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category) ? category : doc.category,
        language: language || 'en',
        usageTags: usageTagsPersist,
        formData,
        body: bodyText || ' ',
        footerText: footerText || null,
        headerType:
          mediaSample === 'Image' && headerImageUrl
            ? 'IMAGE'
            : headerText && String(headerText).trim()
              ? 'TEXT'
              : 'NONE',
        headerValue:
          mediaSample === 'Image' && headerImageUrl
            ? headerImageUrl
            : headerText && String(headerText).trim()
              ? headerText
              : '',
        buttons: (formData.buttons || []).map((b) => ({
          type: b.buttonType,
          text: b.text,
          url: b.url || null,
          phone_number: b.phoneNumber || null,
        })),
      };
    } else {
      const allowed = ['internalName', 'name', 'category', 'language', 'usageTags', 'formData', 'body', 'footerText', 'headerType', 'headerValue', 'buttons'];
      for (const k of allowed) {
        if (updates[k] !== undefined) $set[k] = updates[k];
      }
    }

    await MetaTemplate.updateOne({ _id: id }, { $set });
    const next = await MetaTemplate.findById(id).lean();
    return res.json({ success: true, data: next });
  } catch (err) {
    console.error('[meta-templates patch]', err);
    return res.status(500).json({ error: 'Failed to update template.' });
  }
}

async function deleteTemplate(req, res) {
  try {
    const tenantId = tenantClientId(req);
    const clientId = req.query.clientId || tenantId;
    const { id } = req.params;

    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }

    const doc = await MetaTemplate.findOne({ _id: id, clientId });
    if (!doc) return res.status(404).json({ error: 'Not found' });

    if (doc.metaTemplateId && doc.name) {
      try {
        const client = await resolveClientForTenant(clientId, req.user.id);
        await axios.delete(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/${client.wabaId}/message_templates`,
          {
            params: { name: doc.name },
            headers: { Authorization: `Bearer ${client.whatsappToken}` },
            timeout: 20000,
          }
        );
      } catch (metaErr) {
        const errData = metaErr.response?.data?.error || {};
        const userMsg =
          errData.error_user_msg || errData.message || 'Meta could not delete this template.';
        console.error('[meta-templates delete] Meta error:', JSON.stringify(errData));
        return res.status(422).json({ error: userMsg });
      }
    }

    await MetaTemplate.deleteOne({ _id: id });
    return res.json({ success: true });
  } catch (err) {
    console.error('[meta-templates delete]', err);
    return res.status(500).json({ error: 'Failed to delete template.' });
  }
}

module.exports = {
  saveDraft,
  listTemplates,
  getOne,
  patchTemplate,
  deleteTemplate,
};
