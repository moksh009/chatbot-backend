'use strict';

const axios = require('axios');
const MetaTemplate = require('../../models/MetaTemplate');
const Client = require('../../models/Client');
const User = require('../../models/User');
const { decrypt } = require('../core/encryption');
const { buildComponentsForMetaSubmit } = require('./templateSubmitComponents');
const { getPrebuiltTemplates } = require('../flow/flowGenerator');
const { normalizePurpose } = require('./templateEligibility');

async function getClientCredentials(clientId, userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  if (user.role !== 'SUPER_ADMIN' && user.clientId !== clientId) {
    throw new Error('Unauthorized: You can only manage templates for your own client.');
  }
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');
  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  const rawToken = client.whatsappToken || client.whatsapp?.accessToken;
  if (!wabaId) throw new Error('WABA ID is not configured for this client.');
  if (!rawToken) throw new Error('WhatsApp Token is not configured for this client.');
  client.wabaId = wabaId;
  client.whatsappToken = decrypt(rawToken) || rawToken;
  return client;
}

/**
 * Submit a workspace template (messageTemplates row or MetaTemplate doc) to Meta.
 * Mirrors POST /api/templates/push-local for batch / internal use.
 */
async function submitWorkspaceTemplateToMeta({ clientId, templateName, userId }) {
  if (!clientId || !templateName) {
    return { success: false, status: 400, message: 'clientId and templateName are required' };
  }

  const client = await getClientCredentials(clientId, userId);
  const templates = Array.isArray(client.messageTemplates) ? client.messageTemplates : [];
  let local = templates.find((t) => t && t.name === templateName);
  let source = 'message_templates';

  if (!local) {
    const metaDoc = await MetaTemplate.findOne({ clientId, name: templateName })
      .sort({ updatedAt: -1 })
      .lean();
    if (metaDoc) {
      local = {
        name: metaDoc.name,
        category: metaDoc.category,
        language: metaDoc.language,
        components: [],
        body: metaDoc.body,
        headerType: metaDoc.headerType,
        headerValue: metaDoc.headerValue,
        footerText: metaDoc.footerText,
        buttons: metaDoc.buttons,
        variableMapping: metaDoc.variableMapping,
        primaryPurpose: metaDoc.primaryPurpose,
        secondaryPurposes: metaDoc.secondaryPurposes,
        source: metaDoc.source || 'meta_template',
      };
      source = 'meta_template';
    }
  }

  if (!local) {
    const { blueprintToWorkspaceTemplate } = require('../../constants/orderMessageWaBlueprints');
    const { ensureMetaTemplateDraftFromBlueprint } = require('./orderMessageBlueprintService');
    const bpLocal = blueprintToWorkspaceTemplate(templateName);
    if (bpLocal) {
      await ensureMetaTemplateDraftFromBlueprint(clientId, templateName);
      local = bpLocal;
      source = 'order_message_blueprint';
    }
  }

  if (!local) {
    return { success: false, status: 404, message: 'Template not found in workspace' };
  }

  let rawComponents = buildComponentsForMetaSubmit(local);
  if (!rawComponents.length && Array.isArray(local.components)) {
    rawComponents = local.components;
  }
  if (rawComponents.length === 0) {
    const wd = {
      businessName: client.businessName || client.name || 'Your brand',
      businessLogo: client.businessLogo || client.logoUrl || '',
    };
    const canned =
      getPrebuiltTemplates(wd).find((t) => t.name === templateName) ||
      getPrebuiltTemplates({}).find((t) => t.name === templateName);
    if (canned?.components?.length) {
      local = { ...local, ...canned, components: canned.components };
      rawComponents = local.components;
    }
  }
  if (rawComponents.length === 0) {
    return { success: false, status: 400, message: 'Template has no components to submit' };
  }

  const components = rawComponents.map((c) => {
    const comp = { ...c };
    delete comp._imageUrl;
    if (comp.type === 'HEADER' && comp.format === 'IMAGE') {
      const url =
        local.imageUrl ||
        rawComponents.find((x) => x.type === 'HEADER' && x._imageUrl)?._imageUrl ||
        'https://via.placeholder.com/800x400.png?text=Header';
      comp.example = comp.example?.header_handle?.length
        ? comp.example
        : { header_handle: [url] };
    }
    return comp;
  });

  const category = (local.category || 'MARKETING').toUpperCase();
  const language = local.language || 'en';
  const name = String(local.name).toLowerCase().replace(/[^a-z0-9_]/g, '_');

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  let recentSubmissions = client.templateSubmissionTimestamps || [];
  recentSubmissions = recentSubmissions.filter((ts) => new Date(ts) > oneHourAgo);
  if (recentSubmissions.length >= 6) {
    return {
      success: false,
      status: 429,
      message: 'Meta allows roughly 6 new template submissions per hour. Try again shortly.',
    };
  }

  if (!client.wabaId || !client.whatsappToken) {
    return { success: false, status: 400, message: 'WhatsApp credentials not configured' };
  }

  const url = `https://graph.facebook.com/v21.0/${client.wabaId}/message_templates`;
  const payload = { name, language, category, components };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${client.whatsappToken}`,
        'Content-Type': 'application/json',
      },
    });

    recentSubmissions.push(new Date());
    await Client.updateOne(
      { clientId },
      {
        $set: { templateSubmissionTimestamps: recentSubmissions },
        $pull: { messageTemplates: { name: templateName }, pendingTemplates: { name: templateName } },
      }
    );

    const newTemplate = {
      id: response.data.id || `pending_${name}`,
      name,
      status: 'PENDING',
      category,
      components: rawComponents,
      source: local.source || source || 'push_local',
      primaryPurpose: normalizePurpose(local.primaryPurpose || 'utility'),
      secondaryPurposes: Array.isArray(local.secondaryPurposes)
        ? local.secondaryPurposes.map((p) => normalizePurpose(p))
        : [],
      createdAt: new Date(),
    };

    await Client.updateOne(
      { clientId },
      {
        $push: {
          messageTemplates: newTemplate,
          pendingTemplates: {
            name,
            status: 'PENDING',
            metaId: response.data.id || '',
            submittedAt: new Date(),
          },
        },
      }
    );

    await MetaTemplate.updateOne(
      { clientId, name: templateName },
      { $set: { submissionStatus: 'pending_meta_review', updatedAt: new Date() } }
    );

    return {
      success: true,
      status: 200,
      message: 'Template submitted to Meta for approval',
      data: response.data,
    };
  } catch (metaErr) {
    const msg = metaErr.response?.data?.error?.message || metaErr.message;
    if (/already exists|duplicate/i.test(String(msg))) {
      return {
        success: true,
        status: 200,
        duplicate: true,
        message: 'Template already exists on Meta — sync to refresh status.',
      };
    }
    return {
      success: false,
      status: metaErr.response?.status >= 400 && metaErr.response?.status < 500 ? 400 : 500,
      message: msg || 'Failed to submit template to Meta',
    };
  }
}

module.exports = { submitWorkspaceTemplateToMeta };
