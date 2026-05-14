const axios = require('axios');
const mongoose = require('mongoose');
const MetaTemplate = require('../../models/MetaTemplate');
const Client = require('../../models/Client');
const User = require('../../models/User');
const { decrypt } = require('../../utils/encryption');
const { tenantClientId } = require('../../utils/queryHelpers');

const META_GRAPH_VERSION = 'v19.0';

async function resolveClientForTenant(clientId, userId) {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  if (user.role !== 'SUPER_ADMIN' && user.clientId !== clientId) {
    throw new Error('Unauthorized: You can only manage templates for your own client.');
  }
  const client = await Client.findOne({ clientId })
    .select('wabaId whatsappToken phoneNumberId whatsapp')
    .lean();
  if (!client) throw new Error('Client not found');
  const wabaId = client.wabaId || client.whatsapp?.wabaId;
  const rawToken = client.whatsappToken || client.whatsapp?.accessToken;
  if (!wabaId) throw new Error('WABA ID not configured');
  if (!rawToken) throw new Error('WhatsApp token not configured');
  const whatsappToken = decrypt(rawToken) || rawToken;
  return { ...client, wabaId, whatsappToken };
}

function extractVariablesRaw(text) {
  if (!text) return [];
  return text.match(/\{\{[^}]+\}\}/g) || [];
}

function extractVariables(text) {
  return extractVariablesRaw(text);
}

function validateVariableFormat(text, variableType) {
  const vars = extractVariablesRaw(text);
  for (const v of vars) {
    const inner = v.slice(2, -2);
    if (variableType === 'Number') {
      if (!/^\d+$/.test(inner)) {
        return 'Variable parameters must be whole numbers with two sets of curly brackets (for example, {{1}}, {{2}}).';
      }
    } else if (variableType === 'Name') {
      if (!/^[a-z][a-z0-9_]*$/.test(inner)) {
        return 'Variable parameters must be lowercase characters, underscores and numbers with two sets of curly brackets (for example, {{customer_name}}, {{order_id}}).';
      }
    }
  }
  return null;
}

function buildMetaComponents({
  mediaSample,
  headerImageUrl,
  headerText,
  bodyText,
  footerText,
  headerSamples,
  bodySamples,
  buttons,
}) {
  const components = [];

  if (mediaSample === 'Image' && headerImageUrl) {
    components.push({
      type: 'HEADER',
      format: 'IMAGE',
      example: {
        header_handle: [headerImageUrl],
      },
    });
  } else if (headerText && headerText.trim().length > 0) {
    const headerVars = extractVariablesRaw(headerText);
    const headerComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: headerText,
    };
    if (headerVars.length > 0 && headerSamples.length > 0) {
      headerComponent.example = {
        header_text: headerSamples.slice(0, headerVars.length),
      };
    }
    components.push(headerComponent);
  }

  const bodyVars = extractVariablesRaw(bodyText);
  const bodyComponent = {
    type: 'BODY',
    text: bodyText,
  };
  if (bodyVars.length > 0 && bodySamples.length > 0) {
    bodyComponent.example = {
      body_text: [bodySamples.slice(0, bodyVars.length)],
    };
  }
  components.push(bodyComponent);

  if (footerText && footerText.trim().length > 0) {
    components.push({
      type: 'FOOTER',
      text: footerText,
    });
  }

  if (buttons && buttons.length > 0) {
    const metaButtons = buttons
      .map((btn) => {
        if (btn.buttonType === 'QUICK_REPLY') {
          return { type: 'QUICK_REPLY', text: btn.text };
        }
        if (btn.buttonType === 'URL') {
          const btnObj = { type: 'URL', text: btn.text, url: btn.url };
          if (btn.urlType === 'Dynamic' && btn.sampleUrl) {
            btnObj.example = [btn.sampleUrl];
          }
          return btnObj;
        }
        if (btn.buttonType === 'PHONE_NUMBER') {
          return { type: 'PHONE_NUMBER', text: btn.text, phone_number: btn.phoneNumber };
        }
        return null;
      })
      .filter(Boolean);

    if (metaButtons.length > 0) {
      components.push({ type: 'BUTTONS', buttons: metaButtons });
    }
  }

  return components;
}

function mapSamplesByTokenOrder(text, samplesArray) {
  const tokens = extractVariablesRaw(text);
  return tokens.map((_, i) => (samplesArray[i] != null ? String(samplesArray[i]) : ''));
}

async function upsertTemplateDraft(existingId, data) {
  if (existingId) {
    return MetaTemplate.findByIdAndUpdate(
      existingId,
      { $set: { ...data, updatedAt: new Date() } },
      { new: true }
    );
  }
  return MetaTemplate.create({ ...data, createdAt: new Date(), updatedAt: new Date() });
}

async function submitTemplateToMeta(req, res) {
  try {
    const tenantId = tenantClientId(req);
    const {
      clientId,
      name,
      category,
      language = 'en',
      usageTags = [],
      variableType,
      mediaSample,
      headerImageUrl,
      headerText,
      bodyText,
      footerText,
      headerSamples = [],
      bodySamples = [],
      buttons = [],
      existingTemplateId = null,
      variableSamples = null,
    } = req.body;

    if (!tenantId || tenantId !== clientId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    let headerSamplesUse = Array.isArray(headerSamples) ? headerSamples : [];
    let bodySamplesUse = Array.isArray(bodySamples) ? bodySamples : [];
    if (variableSamples && typeof variableSamples === 'object') {
      const hTokens = extractVariablesRaw(headerText);
      const bTokens = extractVariablesRaw(bodyText);
      headerSamplesUse = hTokens.map((t) => String(variableSamples[t] || '').trim());
      bodySamplesUse = bTokens.map((t) => String(variableSamples[t] || '').trim());
    }

    if (!clientId || !name || !category || !bodyText) {
      return res.status(400).json({ error: 'clientId, name, category, and bodyText are required.' });
    }

    if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(category)) {
      return res.status(400).json({ error: 'Invalid category. Must be MARKETING, UTILITY, or AUTHENTICATION.' });
    }

    if (category === 'AUTHENTICATION') {
      return res.status(400).json({ error: 'Authentication templates must be created in Meta Business Suite.' });
    }

    const nameRegex = /^[a-z0-9_]{1,512}$/;
    if (!nameRegex.test(name)) {
      return res.status(400).json({
        error: 'Template name must be lowercase letters, numbers, and underscores only. No spaces.',
      });
    }

    if (existingTemplateId) {
      if (!mongoose.Types.ObjectId.isValid(existingTemplateId)) {
        return res.status(400).json({ error: 'Invalid existingTemplateId.' });
      }
      const owned = await MetaTemplate.findOne({ _id: existingTemplateId, clientId }).lean();
      if (!owned) {
        return res.status(404).json({ error: 'Template not found for this workspace.' });
      }
    }

    const duplicateQuery = {
      clientId,
      name,
      submissionStatus: { $nin: ['rejected'] },
    };
    if (existingTemplateId) {
      duplicateQuery._id = { $ne: existingTemplateId };
    }
    const existingName = await MetaTemplate.findOne(duplicateQuery).lean();
    if (existingName) {
      return res.status(409).json({ error: `A template named "${name}" already exists. Use a different name.` });
    }

    if (!bodyText || bodyText.trim().length === 0) {
      return res.status(400).json({ error: 'Body text is required.' });
    }
    if (bodyText.length > 1024) {
      return res.status(400).json({ error: 'Body text cannot exceed 1024 characters.' });
    }

    const variablesInBody = extractVariables(bodyText, variableType);
    const variablesInHeader = headerText ? extractVariables(headerText, variableType) : [];

    const bodyVariableError = validateVariableFormat(bodyText, variableType);
    if (bodyVariableError) return res.status(400).json({ error: bodyVariableError });

    if (headerText) {
      const headerVariableError = validateVariableFormat(headerText, variableType);
      if (headerVariableError) return res.status(400).json({ error: headerVariableError });
      if (variablesInHeader.length > 1) {
        return res.status(400).json({ error: 'Header can contain at most one variable.' });
      }
    }

    const bodyWithoutVars = bodyText.replace(/\{\{[^}]+\}\}/g, '');
    if (variablesInBody.length > 0 && bodyWithoutVars.length < variablesInBody.length * 10) {
      return res.status(400).json({
        error: 'Too many variables for the message length. Reduce variables or increase message length.',
      });
    }

    const trimmedBody = bodyText.trim();
    const startsWithVar = /^\{\{[^}]+\}\}/.test(trimmedBody);
    const endsWithVar = /\{\{[^}]+\}\}$/.test(trimmedBody);
    if (startsWithVar || endsWithVar) {
      return res.status(400).json({ error: 'Variables cannot appear at the start or end of the body text.' });
    }

    if (footerText && /\{\{[^}]+\}\}/.test(footerText)) {
      return res.status(400).json({ error: 'Variables are not supported in the footer.' });
    }

    if (variablesInBody.length > 0 && bodySamplesUse.length < variablesInBody.length) {
      return res.status(400).json({
        error: `Please provide sample values for all ${variablesInBody.length} body variable(s).`,
      });
    }
    if (variablesInHeader.length > 0 && headerSamplesUse.length < variablesInHeader.length) {
      return res.status(400).json({ error: 'Please provide a sample value for the header variable.' });
    }

    if (buttons.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 buttons allowed.' });
    }
    for (const btn of buttons) {
      if (!btn.text || btn.text.length > 40) {
        return res.status(400).json({ error: 'Each button must have text of 40 characters or less.' });
      }
      if (btn.buttonType === 'URL' && !btn.url) {
        return res.status(400).json({ error: 'Visit Website buttons require a URL.' });
      }
      if (btn.buttonType === 'PHONE_NUMBER' && !btn.phoneNumber) {
        return res.status(400).json({ error: 'Call Number buttons require a phone number.' });
      }
    }

    let client;
    try {
      client = await resolveClientForTenant(clientId, req.user.id);
    } catch (credErr) {
      const msg = credErr.message || '';
      if (msg.includes('Unauthorized')) return res.status(403).json({ error: msg });
      if (msg.includes('not found')) return res.status(404).json({ error: msg });
      if (msg.includes('not configured')) {
        return res.status(422).json({
          error:
            msg.includes('token')
              ? 'WhatsApp access token not configured. Please reconnect your WhatsApp account.'
              : 'WhatsApp Business Account ID not configured. Please complete WhatsApp setup first.',
        });
      }
      throw credErr;
    }

    const orderedHeaderSamples = headerText
      ? mapSamplesByTokenOrder(headerText, headerSamplesUse)
      : [];
    const orderedBodySamples = mapSamplesByTokenOrder(bodyText, bodySamplesUse);

    const components = buildMetaComponents({
      mediaSample,
      headerImageUrl,
      headerText,
      bodyText,
      footerText,
      headerSamples: orderedHeaderSamples,
      bodySamples: orderedBodySamples,
      buttons,
    });

    const metaPayload = {
      name,
      language,
      category,
      components,
    };

    console.log('[TemplateSubmit] Submitting to Meta for clientId:', clientId, 'template:', name);
    console.log('[TemplateSubmit] Payload:', JSON.stringify(metaPayload, null, 2));

    const formDataDoc = {
      variableType: variableType || 'Number',
      mediaSample: mediaSample || 'None',
      headerImageUrl: headerImageUrl || null,
      headerText: headerText || null,
      bodyText,
      footerText: footerText || null,
      headerSamples: orderedHeaderSamples,
      bodySamples: orderedBodySamples,
      buttons: Array.isArray(buttons) ? buttons : [],
    };

    const persistBase = {
      clientId,
      name,
      category,
      language,
      usageTags: Array.isArray(usageTags) ? usageTags : [],
      formData: formDataDoc,
      body: bodyText,
      footerText: footerText || null,
      headerType:
        mediaSample === 'Image' && headerImageUrl
          ? 'IMAGE'
          : headerText && headerText.trim()
            ? 'TEXT'
            : 'NONE',
      headerValue:
        mediaSample === 'Image' && headerImageUrl
          ? headerImageUrl
          : headerText && headerText.trim()
            ? headerText
            : '',
      buttons: (buttons || []).map((b) => ({
        type: b.buttonType,
        text: b.text,
        url: b.url || null,
        phone_number: b.phoneNumber || null,
      })),
      source: 'manual',
    };

    let metaResponse;
    try {
      const response = await axios.post(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${client.wabaId}/message_templates`,
        metaPayload,
        {
          headers: {
            Authorization: `Bearer ${client.whatsappToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );
      metaResponse = response.data;
    } catch (metaErr) {
      const errData = metaErr.response?.data?.error || {};
      const userMsg =
        errData.error_user_msg ||
        errData.message ||
        'Meta API rejected the template. Check the fields and try again.';
      const errorCode = errData.code;

      console.error('[TemplateSubmit] Meta API error:', JSON.stringify(errData));

      const savedTemplate = await upsertTemplateDraft(existingTemplateId, {
        ...persistBase,
        submissionStatus: 'submission_failed',
        metaApiError: userMsg,
      });

      return res.status(422).json({
        error: userMsg,
        errorCode,
        templateId: savedTemplate._id,
      });
    }

    const savedTemplate = await upsertTemplateDraft(existingTemplateId, {
      ...persistBase,
      submissionStatus: 'pending_meta_review',
      metaTemplateId: metaResponse.id,
      submittedAt: new Date(),
      metaApiError: null,
      rejectionReason: null,
    });

    console.log('[TemplateSubmit] Success — metaTemplateId:', metaResponse.id, 'status:', metaResponse.status);

    return res.status(200).json({
      success: true,
      message: 'Template submitted to Meta for approval. You can track status in the Templates section.',
      templateId: savedTemplate._id,
      metaTemplateId: metaResponse.id,
      status: 'pending_meta_review',
    });
  } catch (err) {
    console.error('[TemplateSubmit] Unexpected error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

module.exports = {
  submitTemplateToMeta,
  buildMetaComponents,
  extractVariablesRaw,
  validateVariableFormat,
  upsertTemplateDraft,
  resolveClientForTenant,
};
