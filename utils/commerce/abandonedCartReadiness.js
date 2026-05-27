'use strict';

const crypto = require('crypto');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const MetaTemplate = require('../../models/MetaTemplate');
const PixelEvent = require('../../models/PixelEvent');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');
const { buildTrackingHealth } = require('./trackingHealth');
const commerceAutomationService = require('./commerceAutomationService');
const { mergeSystemAutomations } = require('./commerceAutomationPresets');
const { planCartRuleActivation } = require('../../constants/cartRecoverySlotPresets');

const CART_TEMPLATE_KEYS = ['cart_recovery_1', 'cart_recovery_2', 'cart_recovery_3'];

const THIRD_PARTY_PROVIDERS = [
  { id: 'gokwik', label: 'GoKwik', path: 'gokwik', integrationKey: 'gokwik' },
  { id: 'razorpay', label: 'Razorpay Magic', path: 'razorpay-magic', integrationKey: 'razorpay_magic' },
  { id: 'shiprocket', label: 'Shiprocket Checkout', path: 'shiprocket-checkout', integrationKey: 'shiprocket_checkout' },
];

function getPublicApiBase() {
  const raw =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.SERVER_URL ||
    process.env.API_BASE_URL ||
    'https://api.topedgeai.com';
  return String(raw).replace(/\/api\/?$/, '').replace(/\/$/, '');
}

function resolveTemplateStatus(templateName, syncedTemplates = [], metaRows = []) {
  const synced = syncedTemplates.find((t) => String(t?.name || '') === templateName);
  if (synced && String(synced.status || '').toUpperCase() === 'APPROVED') {
    return 'approved';
  }
  const row = metaRows.find((t) => String(t?.name || '') === templateName);
  if (row) {
    const st = String(row.status || '').toLowerCase();
    if (st === 'approved') return 'approved';
    if (['pending_meta_review', 'submitting', 'queued', 'draft', 'rejected'].includes(st)) {
      return 'pending';
    }
    return 'pending';
  }
  return 'missing';
}

function countActiveCartRules(automations = []) {
  return automations.filter(
    (a) =>
      a.meta?.category === 'abandoned_cart' &&
      a.isActive === true &&
      String(a.templateName || '').trim()
  ).length;
}

function maskSecret(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function buildThirdPartyBlock(clientId, audienceContext = {}) {
  const base = getPublicApiBase();
  const ints = audienceContext.integrations || {};
  return THIRD_PARTY_PROVIDERS.map((p) => {
    const cfg = ints[p.integrationKey] || {};
    return {
      id: p.id,
      label: p.label,
      webhookUrl: `${base}/api/webhooks/${p.path}/${clientId}`,
      configured: Boolean(cfg.webhookSecret),
      secretMasked: maskSecret(cfg.webhookSecret),
      hasSecret: Boolean(cfg.webhookSecret),
      lastReceivedAt: cfg.lastWebhookAt || null,
      lastTestAt: cfg.lastTestAt || null,
      consentStrategy: cfg.consentStrategy || 'explicit',
    };
  });
}

/**
 * Build merchant-facing abandoned cart go-live readiness snapshot.
 */
async function buildAbandonedCartReadiness(clientId) {
  const client = await Client.findOne({ clientId })
    .select(
      'clientId shopDomain shopifyAccessToken shopifyConnected shopifyWebPixelId whatsappToken phoneNumberId wabaId ' +
        'wizardFeatures commerceAutomations syncedMetaTemplates audienceContext adminPhone platformVars'
    )
    .lean();

  if (!client) return null;

  const flags = buildConnectionStatusPayload(client);
  const wf = client.wizardFeatures || {};
  const automations = mergeSystemAutomations(client.commerceAutomations || []);
  const cartRulesActive = countActiveCartRules(automations);

  const [metaRows, tracking, phoneStats, lastCheckoutLead, lastCartLead, lastPixel] =
    await Promise.all([
      MetaTemplate.find({ clientId, name: { $in: CART_TEMPLATE_KEYS } })
        .select('name status')
        .lean(),
      buildTrackingHealth(clientId, 7).catch(() => null),
      AdLead.aggregate([
        {
          $match: {
            clientId,
            cartStatus: { $in: ['abandoned', 'checkout_started'] },
            cartAbandonedAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            unknown: {
              $sum: {
                $cond: [{ $regexMatch: { input: '$phoneNumber', regex: /^unknown_checkout_/ } }, 1, 0],
              },
            },
          },
        },
      ]),
      AdLead.findOne({ clientId, checkoutInitiatedCount: { $gt: 0 } })
        .sort({ checkoutInitiatedAt: -1, updatedAt: -1 })
        .select('checkoutInitiatedAt updatedAt')
        .lean(),
      AdLead.findOne({
        clientId,
        cartStatus: { $in: ['abandoned', 'checkout_started'] },
      })
        .sort({ cartAbandonedAt: -1, lastCartEventAt: -1, updatedAt: -1 })
        .select('cartAbandonedAt lastCartEventAt updatedAt')
        .lean(),
      PixelEvent.findOne({
        clientId,
        eventName: {
          $in: ['checkout_contact_identified', 'checkout_contact_info_submitted'],
        },
      })
        .sort({ timestamp: -1 })
        .select('timestamp')
        .lean(),
    ]);

  const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const templates = {};
  for (const key of CART_TEMPLATE_KEYS) {
    templates[key] = resolveTemplateStatus(key, synced, metaRows);
  }

  const approvedCount = CART_TEMPLATE_KEYS.filter((k) => templates[k] === 'approved').length;
  const stats = phoneStats[0] || { total: 0, unknown: 0 };
  const unknownPhonePct =
    stats.total > 0 ? Math.round((stats.unknown / stats.total) * 10000) / 100 : 0;

  const pixelInstalled = Boolean(
    tracking?.webPixelInstalled || client.shopifyWebPixelId
  );
  const lastEventAt =
    lastPixel?.timestamp ||
    tracking?.lastCheckoutEventAt ||
    null;

  const recoveryOn =
    wf.enableAbandonedCart !== false && cartRulesActive > 0 && approvedCount >= 1;

  return {
    shopifyConnected: flags.shopify_connected,
    whatsappConnected: flags.whatsapp_connected,
    enableAbandonedCart: wf.enableAbandonedCart !== false,
    recoveryActive: recoveryOn,
    cartRulesActive,
    cartRulesTotal: 3,
    templates,
    templatesApprovedCount: approvedCount,
    allTemplatesApproved: approvedCount === 3,
    pixel: {
      installed: pixelInstalled,
      lastEventAt,
    },
    pcd: {
      unknownPhonePct,
      unknownPhoneCount: stats.unknown || 0,
      sampleTotal: stats.total || 0,
      warn: unknownPhonePct > 30,
    },
    lastCheckoutWebhookAt:
      lastCheckoutLead?.checkoutInitiatedAt ||
      lastCheckoutLead?.updatedAt ||
      null,
    lastCartLeadAt:
      lastCartLead?.cartAbandonedAt ||
      lastCartLead?.lastCartEventAt ||
      lastCartLead?.updatedAt ||
      null,
    thirdParty: buildThirdPartyBlock(clientId, client.audienceContext || {}),
    checklist: buildChecklist({
      flags,
      wf,
      cartRulesActive,
      templates,
      approvedCount,
      pixelInstalled,
      lastEventAt,
      unknownPhonePct,
      recoveryOn,
    }),
    apiBase: getPublicApiBase(),
  };
}

function buildChecklist(ctx) {
  const items = [
    {
      id: 'shopify',
      label: 'Shopify store connected',
      status: ctx.flags.shopify_connected ? 'ok' : 'error',
      href: '/settings?tab=integrations',
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp Business connected',
      status: ctx.flags.whatsapp_connected ? 'ok' : 'error',
      href: '/settings?tab=integrations',
    },
    {
      id: 'templates',
      label: 'Cart recovery templates approved on Meta',
      status:
        ctx.approvedCount === 3 ? 'ok' : ctx.approvedCount > 0 ? 'warn' : 'error',
      detail: `${ctx.approvedCount}/3 approved`,
      href: '/meta-manager?tab=library',
    },
    {
      id: 'rules',
      label: 'Cart follow-up rules active',
      status: ctx.cartRulesActive >= 3 ? 'ok' : ctx.cartRulesActive > 0 ? 'warn' : 'error',
      detail: `${ctx.cartRulesActive}/3 live`,
      href: '/shopify-automation-center?section=automations',
    },
    {
      id: 'pixel',
      label: 'Checkout pixel receiving events',
      status: ctx.pixelInstalled && ctx.lastEventAt ? 'ok' : ctx.pixelInstalled ? 'warn' : 'error',
      href: '/audience-hub?tab=cart-recovery',
      actionLabel: 'Deep sync',
    },
    {
      id: 'pcd',
      label: 'Checkout phone numbers captured',
      status: ctx.unknownPhonePct > 30 ? 'warn' : 'ok',
      detail: ctx.unknownPhonePct > 30 ? `${ctx.unknownPhonePct}% missing phones` : 'Phones look healthy',
    },
    {
      id: 'recovery',
      label: 'Recovery sending enabled',
      status: ctx.recoveryOn ? 'ok' : 'warn',
    },
  ];
  return items;
}

function generateWebhookSecret() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Enable abandoned cart: wizard flag + activate rules when all 3 templates approved.
 */
async function enableAbandonedCartRecovery(clientId) {
  const client = await Client.findOne({ clientId })
    .select('syncedMetaTemplates commerceAutomations wizardFeatures')
    .lean();
  if (!client) throw new Error('Client not found');

  const readiness = await buildAbandonedCartReadiness(clientId);
  if (!readiness) throw new Error('Client not found');

  const setFields = {
    'wizardFeatures.enableAbandonedCart': true,
    'wizardFeatures.cartNudgeMinutes1': 45,
    'wizardFeatures.cartNudgeHours2': 8,
    'wizardFeatures.cartNudgeHours3': 36,
  };

  await Client.findOneAndUpdate({ clientId }, { $set: setFields });

  let rulesActivated = 0;
  const activationPlan = planCartRuleActivation(readiness);
  if (activationPlan.count > 0) {
    for (const templateName of activationPlan.templateNames) {
      await commerceAutomationService.upsertAutomation(clientId, {
        id: `sys_cart_followup_${String(templateName).replace(/\D/g, '')}`,
        isActive: true,
        templateName,
        language: 'en',
      });
      rulesActivated += 1;
    }
  }

  const updated = await buildAbandonedCartReadiness(clientId);
  return {
    success: true,
    rulesActivated,
    templatesApproved: readiness.templatesApprovedCount,
    allTemplatesApproved: readiness.allTemplatesApproved,
    readiness: updated,
    message:
      rulesActivated === 3
        ? 'Cart recovery enabled — all 3 follow-up rules are live.'
        : readiness.allTemplatesApproved
          ? 'Cart recovery flag enabled.'
          : `Cart recovery enabled. Submit and approve cart_recovery_1/2/3 in Meta Manager to activate all ${3 - rulesActivated} remaining rules.`,
  };
}

async function saveThirdPartyWebhookSecret(clientId, provider, secret) {
  const map = {
    gokwik: 'gokwik',
    razorpay: 'razorpay_magic',
    razorpay_magic: 'razorpay_magic',
    shiprocket: 'shiprocket_checkout',
    shiprocket_checkout: 'shiprocket_checkout',
  };
  const key = map[provider];
  if (!key) throw new Error('Unknown provider');

  const trimmed = String(secret || '').trim();
  if (!trimmed) throw new Error('Webhook secret is required');

  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        [`audienceContext.integrations.${key}.webhookSecret`]: trimmed,
        'audienceContext.updatedAt': new Date(),
      },
    }
  );

  return { success: true, secretMasked: maskSecret(trimmed) };
}

async function sendTestRecoveryMessage(clientId, phone, templateName = 'cart_recovery_1') {
  const client = await Client.findOne({ clientId })
    .select('clientId shopDomain syncedMetaTemplates whatsappToken phoneNumberId wabaId')
    .lean();
  if (!client) throw new Error('Client not found');

  const { normalizeIndianPhone } = require('../core/normalizeIndianPhone');
  const normalized = normalizeIndianPhone(phone);
  if (!normalized) throw new Error('Enter a valid Indian mobile number');

  const synced = (client.syncedMetaTemplates || []).find((t) => t.name === templateName);
  if (!synced || String(synced.status || '').toUpperCase() !== 'APPROVED') {
    throw new Error(`${templateName} must be approved on Meta before sending a test`);
  }

  const { sendWhatsAppTemplate } = require('../meta/whatsappHelpers');
  const { getEffectiveWhatsAppAccessToken, getEffectiveWhatsAppPhoneNumberId } = require('../meta/clientWhatsAppCreds');
  const { buildCartRecoveryComponents } = require('./buildCartRecoveryComponents');

  const sampleLead = {
    firstName: 'Test',
    name: 'Test Customer',
    phoneNumber: normalized,
    cartSnapshot: {
      items: [
        {
          title: 'Sample product',
          image: 'https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-product-1_large.png',
          price: 999,
        },
      ],
      totalPrice: 999,
    },
    cartValue: 999,
    checkoutUrl: client.shopDomain
      ? `https://${String(client.shopDomain).replace(/^https?:\/\//, '')}/cart`
      : 'https://example.com/cart',
  };

  const stepNum = Number(String(templateName).replace(/\D/g, '')) || 1;
  const { components } = buildCartRecoveryComponents(sampleLead, client, stepNum);

  const token = await getEffectiveWhatsAppAccessToken(client);
  const phoneNumberId = await getEffectiveWhatsAppPhoneNumberId(client);
  if (!token || !phoneNumberId) {
    throw new Error('WhatsApp credentials not configured');
  }

  const langCode = String(synced.language || 'en').includes('_')
    ? synced.language
    : `${synced.language || 'en'}_US`;

  const result = await sendWhatsAppTemplate({
    phoneNumberId,
    to: normalized,
    templateName,
    languageCode: langCode,
    components,
    token,
  });

  if (!result.success) {
    throw new Error(result.error || 'Meta API rejected test send');
  }

  return { success: true, message: `Test ${templateName} sent to ${normalized}` };
}

module.exports = {
  buildAbandonedCartReadiness,
  enableAbandonedCartRecovery,
  saveThirdPartyWebhookSecret,
  sendTestRecoveryMessage,
  generateWebhookSecret,
  getPublicApiBase,
  CART_TEMPLATE_KEYS,
  THIRD_PARTY_PROVIDERS,
  resolveTemplateStatus,
  buildChecklist,
  countActiveCartRules,
  buildThirdPartyBlock,
};
