'use strict';

const axios = require('axios');
const Client = require('../../models/Client');
const MetaTemplate = require('../../models/MetaTemplate');
const { decrypt } = require('../../utils/core/encryption');
const log = require('../../utils/core/logger')('MetaTemplateSubmit');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

function buildTemplateComponents(template) {
  const components = [];
  const body = template?.components?.find((c) => String(c.type).toUpperCase() === 'BODY');
  if (body?.text) {
    components.push({ type: 'BODY', text: body.text });
  }
  const header = template?.components?.find((c) => String(c.type).toUpperCase() === 'HEADER');
  if (header?.text) {
    components.push({ type: 'HEADER', format: header.format || 'TEXT', text: header.text });
  }
  const footer = template?.components?.find((c) => String(c.type).toUpperCase() === 'FOOTER');
  if (footer?.text) {
    components.push({ type: 'FOOTER', text: footer.text });
  }
  const buttons = template?.components?.find((c) => String(c.type).toUpperCase() === 'BUTTONS');
  if (buttons?.buttons?.length) {
    components.push({ type: 'BUTTONS', buttons: buttons.buttons });
  }
  return components;
}

async function resolveWabaClient(clientId) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client?.wabaId) throw new Error('missing_waba');
  const token = decrypt(client.whatsappToken || '');
  if (!token) throw new Error('missing_whatsapp_token');
  return { client, token, wabaId: client.wabaId };
}

async function submitToMeta({ clientId, templateName, language = 'en', category = 'MARKETING', components }) {
  const { token, wabaId } = await resolveWabaClient(clientId);
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates`;
  const body = {
    name: templateName,
    language,
    category,
    components: components || [],
  };
  try {
    const res = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    });
    const metaTemplateId = res.data?.id || res.data?.message_template_id;
    await MetaTemplate.findOneAndUpdate(
      { clientId, name: templateName, language },
      {
        $set: {
          clientId,
          name: templateName,
          language,
          category,
          status: res.data?.status || 'PENDING',
          metaTemplateId,
          submittedAt: new Date(),
          components: body.components,
        },
      },
      { upsert: true, new: true }
    );
    return { metaTemplateId, status: res.data?.status || 'PENDING', submittedAt: new Date() };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    log.error(`submitToMeta failed: ${msg}`);
    return { error: msg };
  }
}

async function pollSubmittedStatus({ clientId, metaTemplateId, templateName }) {
  const { token, wabaId } = await resolveWabaClient(clientId);
  const url = metaTemplateId
    ? `https://graph.facebook.com/${GRAPH_VERSION}/${metaTemplateId}`
    : `https://graph.facebook.com/${GRAPH_VERSION}/${wabaId}/message_templates?name=${templateName}`;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const row = res.data?.data?.[0] || res.data;
    const status = row?.status || 'UNKNOWN';
    if (templateName) {
      await MetaTemplate.updateOne(
        { clientId, name: templateName },
        { $set: { status, rejectedReason: row?.rejected_reason || null } }
      );
    }
    return { status, rejectedReason: row?.rejected_reason || null };
  } catch (err) {
    return { status: 'UNKNOWN', error: err.message };
  }
}

module.exports = {
  buildTemplateComponents,
  submitToMeta,
  pollSubmittedStatus,
  GRAPH_VERSION,
};
