'use strict';

const moment = require('moment');
const Client = require('../../models/Client');
const MetaTemplate = require('../../models/MetaTemplate');
const WhatsApp = require('../meta/whatsapp');
const { buildOrderMessagesOverview } = require('../commerce/orderMessagesOverview');

function relTime(date) {
  if (!date) return null;
  return moment(date).fromNow();
}

async function buildMetaHubHealth(clientId, clientConfig) {
  const client =
    clientConfig ||
    (await Client.findOne({ clientId })
      .select(
        'whatsappToken phoneNumberId wabaId facebookCatalogId waCatalogId metaCatalogAccessToken shopifyAccessToken shopDomain syncedMetaTemplates templatesSyncedAt catalogSyncedAt'
      )
      .lean());

  if (!client) return null;

  const waConnected = !!(client.whatsappToken && client.phoneNumberId);
  const catalogId = String(client.facebookCatalogId || client.waCatalogId || '').trim();
  const catalogToken = String(client.metaCatalogAccessToken || '').trim();
  const shopifyConnected = !!(client.shopifyAccessToken && client.shopDomain);

  const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const approvedSynced = synced.filter((t) => String(t?.status || '').toUpperCase() === 'APPROVED').length;

  let canonicalApproved = 0;
  try {
    canonicalApproved = await MetaTemplate.countDocuments({
      clientId,
      submissionStatus: 'APPROVED',
    });
  } catch (_) {
    /* optional */
  }

  let orderMessages = null;
  try {
    if (clientConfig) {
      orderMessages = await buildOrderMessagesOverview(clientConfig);
    }
  } catch (_) {
    /* optional */
  }

  const webhooks = orderMessages?.webhooks;
  const liveStatuses = ['paid', 'shipped', 'delivered'].filter(
    (s) => orderMessages?.orderTriggers?.[s]
  ).length;

  const qualityRaw = String(
    client.whatsappQualityRating ||
      client.wabaAccounts?.[0]?.qualityRating ||
      client.config?.whatsappQualityRating ||
      ''
  ).toUpperCase();
  let qualityRating = qualityRaw || 'UNKNOWN';
  if (!qualityRaw && waConnected) {
    try {
      const qual = await WhatsApp.getPhoneNumberQuality(client);
      qualityRating = String(qual?.qualityRating || 'UNKNOWN').toUpperCase();
    } catch {
      qualityRating = 'UNKNOWN';
    }
  }

  const qualityLabel =
    qualityRating === 'GREEN'
      ? 'Good'
      : qualityRating === 'YELLOW'
        ? 'At risk'
        : qualityRating === 'RED'
          ? 'Low'
          : 'Unknown';

  return {
    whatsapp: {
      connected: waConnected,
      wabaId: client.wabaId || null,
      qualityRating,
      qualityLabel,
    },
    templates: {
      syncedApproved: approvedSynced,
      canonicalApproved,
      syncedLabel: relTime(client.templatesSyncedAt),
      stale: client.templatesSyncedAt
        ? moment().diff(moment(client.templatesSyncedAt), 'days') >= 3
        : true,
    },
    catalog: {
      linked: !!catalogId,
      catalogId: catalogId || null,
      hasToken: !!catalogToken,
      syncedLabel: relTime(client.catalogSyncedAt),
      shopifyConnected,
    },
    orderMessages: {
      liveCount: liveStatuses,
      webhooksOk: webhooks?.allOk !== false,
      webhooksMissing: webhooks?.missing?.length || 0,
      shippedAuto: orderMessages?.features?.enableAutoShopifyShippedWhatsApp !== false,
    },
  };
}

module.exports = { buildMetaHubHealth };
