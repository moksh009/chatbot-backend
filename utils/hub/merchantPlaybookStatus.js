'use strict';

const moment = require('moment');
const Client = require('../../models/Client');
const ScoreTierConfig = require('../../models/ScoreTierConfig');
const MetaTemplate = require('../../models/MetaTemplate');
const PixelEvent = require('../../models/PixelEvent');
const { MERCHANT_PLAYBOOK_STEPS, SOFT_COMPLETE_MIN } = require('../../constants/merchantPlaybookSteps');
const { buildConnectionStatusPayload } = require('../core/connectionStatus');

const ECO_TEMPLATE_NAMES = ['eco_order_confirmed', 'eco_shipping_update', 'eco_delivered'];
const ORDER_STATUS_KEYS = ['paid', 'shipped', 'delivered'];

function getPlaybookPrefs(client) {
  const ob = client?.onboarding && typeof client.onboarding === 'object' ? client.onboarding : {};
  const checklist = ob.checklist && typeof ob.checklist === 'object' ? ob.checklist : {};
  return {
    hidden: !!checklist.hidden,
    hiddenAt: checklist.hiddenAt || null,
    manualDone: checklist.manualDone && typeof checklist.manualDone === 'object' ? checklist.manualDone : {},
    skipped: Array.isArray(checklist.skipped) ? checklist.skipped : [],
  };
}

function isFresh(date, maxDays = 7) {
  if (!date) return false;
  return moment(date).isAfter(moment().subtract(maxDays, 'days'));
}

async function detectStep(client, stepId, ctx) {
  const flags = ctx.flags || buildConnectionStatusPayload(client);
  const wf = ctx.wizardFeatures || {};
  const niche = client.nicheData || {};
  const orderTriggers = niche.orderStatusTemplates || {};

  switch (stepId) {
    case 'connect_shopify':
      return !!(client.shopifyAccessToken && client.shopDomain);

    case 'connect_whatsapp':
      return !!flags.whatsapp_connected;

    case 'sync_catalog': {
      const productsOk = isFresh(client.catalogSyncedAt, 14);
      const ordersOk = ctx.lastOrderAt ? isFresh(ctx.lastOrderAt, 14) : false;
      return productsOk && ordersOk;
    }

    case 'install_pixel': {
      if (ctx.pixelLive) return true;
      const recent = await PixelEvent.findOne({ clientId: client.clientId })
        .sort({ timestamp: -1 })
        .select('timestamp')
        .lean();
      return !!(recent && moment(recent.timestamp).isAfter(moment().subtract(24, 'hours')));
    }

    case 'sync_templates': {
      const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
      if (synced.length > 0) return true;
      const n = await MetaTemplate.countDocuments({ clientId: client.clientId });
      return n > 0;
    }

    case 'push_eco_templates': {
      const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
      const hasEco = synced.some((t) => ECO_TEMPLATE_NAMES.includes(String(t?.name || '')));
      if (hasEco) return true;
      const pushed = await MetaTemplate.countDocuments({
        clientId: client.clientId,
        name: { $in: ECO_TEMPLATE_NAMES },
      });
      return pushed > 0;
    }

    case 'enable_order_messages': {
      const enabled = ORDER_STATUS_KEYS.filter((k) => !!orderTriggers[k]).length;
      return enabled >= 1;
    }

    case 'configure_persona': {
      const voice = String(client.onboardingData?.brandVoice || wf.brandVoice || niche.brandVoice || '').trim();
      const goal = String(client.onboardingData?.primaryGoal || wf.primaryGoal || '').trim();
      const customPrompt = String(niche.customSystemPrompt || niche.botSystemPrompt || '').trim();
      return !!(voice || goal || (customPrompt.length > 80));
    }

    case 'score_rules': {
      const cfg = await ScoreTierConfig.findOne({ clientId: client.clientId }).select('tiers isActive').lean();
      return !!(cfg && Array.isArray(cfg.tiers) && cfg.tiers.length > 0);
    }

    case 'detect_stack': {
      const ac = client.audienceContext || {};
      const checkout = ac.manualOverrides?.thirdPartyCheckout || ac.thirdPartyCheckout;
      return !!(checkout && checkout !== 'unknown' && checkout !== 'not_sure');
    }

    case 'opt_in_policy': {
      const gc = client.growthCompliance || {};
      const customizedStop =
        Array.isArray(gc.stopKeywords) &&
        gc.stopKeywords.length > 0 &&
        !(gc.stopKeywords.length === 5 && gc.stopKeywords.includes('STOP'));
      return !!(gc.defaultOptInPolicy || customizedStop || gc.cartRecoveryRequiresOptIn);
    }

    case 'consent_rules':
      return false;

    default:
      return false;
  }
}

/**
 * Build full playbook status for a client.
 */
async function buildMerchantPlaybookStatus(clientId) {
  const client = await Client.findOne({ clientId })
    .select(
      'clientId businessName shopDomain shopifyAccessToken whatsappToken phoneNumberId wabaId ' +
        'catalogSyncedAt templatesSyncedAt syncedMetaTemplates nicheData wizardFeatures ' +
        'onboardingData onboarding growthWidgetConfig growthEmbedPublicKey growthEmbedEnabled growthCompliance audienceContext'
    )
    .lean();

  if (!client) return null;

  const Order = require('../../models/Order');
  const [lastOrder, commerceHealth] = await Promise.all([
    Order.findOne({ clientId }).sort({ createdAt: -1 }).select('createdAt').lean(),
    (async () => {
      try {
        const { buildTrackingHealth } = require('../commerce/trackingHealth');
        return await buildTrackingHealth(clientId, 1);
      } catch {
        return { storefrontActive: false };
      }
    })(),
  ]);

  const flags = buildConnectionStatusPayload(client);
  const prefs = getPlaybookPrefs(client);

  const ctx = {
    flags,
    wizardFeatures: client.wizardFeatures || {},
    lastOrderAt: lastOrder?.createdAt || null,
    pixelLive: !!commerceHealth?.storefrontActive,
  };

  const steps = [];
  for (const def of MERCHANT_PLAYBOOK_STEPS) {
    const autoComplete = await detectStep(client, def.id, ctx);
    const manual = !!prefs.manualDone[def.id];
    const skipped = prefs.skipped.includes(def.id);
    const complete = !skipped && (autoComplete || manual);
    steps.push({
      ...def,
      autoComplete,
      manual,
      skipped,
      complete,
      status: skipped ? 'skipped' : complete ? 'complete' : 'pending',
    });
  }

  const completedCount = steps.filter((s) => s.complete).length;
  const total = steps.length;
  const requiredComplete = steps.filter((s) => !s.skipped && s.complete).length;

  return {
    clientId,
    hidden: prefs.hidden,
    hiddenAt: prefs.hiddenAt,
    steps,
    completedCount,
    requiredComplete,
    total,
    percent: total ? Math.round((completedCount / total) * 100) : 0,
    allComplete: requiredComplete >= total,
    softComplete: completedCount >= SOFT_COMPLETE_MIN,
    softCompleteMin: SOFT_COMPLETE_MIN,
  };
}

module.exports = {
  buildMerchantPlaybookStatus,
  getPlaybookPrefs,
  detectStep,
  MERCHANT_PLAYBOOK_STEPS,
};
