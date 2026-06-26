'use strict';

const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const OptInTool = require('../models/OptInTool');
const { validateOptInPhoneInput, indianPhoneLookupVariants } = require('../utils/optIn/indianPhoneValidator');
const { stitchVisitorIdentity } = require('../utils/commerce/visitorIdentityService');
const { isManualReOptInBlocked, normalizeOptStatus } = require('../utils/commerce/marketingOptStatusRules');
const { claimCoupon } = require('./optInCouponService');
const { pickWeightedPrize, claimPrizeCoupon } = require('./optInPrizeService');
const { buildWaMeLink, resolveMerchantWaPhone } = require('../utils/optIn/resolveMerchantWaPhone');

const OPT_IN_SOURCE_BY_TYPE = {
  popup: 'website_popup',
  spin_wheel: 'spin_wheel',
  mystery_discount: 'mystery_discount',
  whatsapp_widget: 'whatsapp_widget',
};

function optInSourceForTool(tool) {
  return OPT_IN_SOURCE_BY_TYPE[tool?.type] || 'website_popup';
}

function normalizeSpinExtraFields(tool, body = {}) {
  const design = tool?.design || {};
  const extra = {};
  if (design.collectName === true && body.name) {
    extra.name = String(body.name).trim().slice(0, 80);
  }
  if (design.collectEmail === true && body.email) {
    const email = String(body.email).trim().toLowerCase().slice(0, 120);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) extra.email = email;
  }
  if (design.collectDob === true && body.dateOfBirth) {
    const dob = String(body.dateOfBirth).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) extra.dateOfBirth = dob;
  }
  return extra;
}

async function resolveClientByEmbedKey(embedKey) {
  return Client.findOne({
    growthEmbedPublicKey: embedKey,
    growthEmbedEnabled: { $ne: false },
    isActive: { $ne: false },
  })
    .select('clientId businessName brand.businessName growthWidgetConfig shopDomain whatsappConnected whatsappDisplayPhoneNumber platformVars wabaAccounts')
    .lean();
}

async function sendOptInWelcomeMessage(client, phone, { brandName, couponCode, storeUrl, templateSlot }) {
  if (!client?.whatsappConnected) return { sent: false, reason: 'whatsapp_not_connected' };
  const clientDoc = await Client.findOne({ clientId: client.clientId });
  if (!clientDoc) return { sent: false, reason: 'client_not_found' };

  const text =
    `Welcome to ${brandName}! 🎉\n` +
    (couponCode ? `Your discount code: ${couponCode}\n` : '') +
    `Shop now: ${storeUrl || client.shopDomain || 'your store'}`;

  try {
    const { sendForAutomation } = require('./templateSender');
    const slot = templateSlot || 'optin_welcome_v1';
    const result = await sendForAutomation({
      clientId: client.clientId,
      phone,
      slotId: slot,
      contextType: 'utility',
      trigger: 'opt_in_welcome',
      contextData: {
        brand_name: brandName,
        coupon_code: couponCode || '',
        store_url: storeUrl || '',
        extra: { couponCode, storeUrl, brandName },
      },
    });
    if (result?.whatsapp?.sent) return { sent: true, mode: 'template' };
  } catch (e) {
    console.warn('[optInSubscribe] template welcome failed', e.message);
  }

  try {
    const WhatsApp = require('../utils/meta/whatsapp');
    await WhatsApp.sendText(clientDoc, phone, text, 'whatsapp', { complianceExempt: true });
    return { sent: true, mode: 'text' };
  } catch (e) {
    console.warn('[optInSubscribe] text welcome failed', e.message);
    return { sent: false, reason: e.message };
  }
}

async function upsertOptInLead({
  client,
  phoneStored,
  consent,
  tool,
  pageUrl,
  visitorId,
  ipAddress,
  userAgent,
  couponCode,
  prizeLabel = '',
  partial = false,
  extraFields = {},
}) {
  if (!consent) {
    return { ok: false, status: 400, message: 'WhatsApp marketing requires explicit consent' };
  }

  const phoneLookup = indianPhoneLookupVariants(phoneStored);
  const existing = await AdLead.findOne({ clientId: client.clientId, phoneNumber: { $in: phoneLookup } }).lean();
  const currentStatus = normalizeOptStatus(existing?.channelConsent?.whatsapp?.status || existing?.optStatus);
  if (isManualReOptInBlocked(currentStatus, 'opted_in')) {
    return {
      ok: false,
      status: 403,
      message: 'This number opted out. Reply START on WhatsApp to re-subscribe.',
    };
  }

  const doubleOptIn = client.growthWidgetConfig?.doubleOptInEnabled === true;
  const sourceField = optInSourceForTool(tool);
  const now = new Date();

  const DISPLAY_SOURCE_BY_TYPE = {
    popup: 'Website Popup',
    spin_wheel: 'Spin Wheel',
    mystery_discount: 'Mystery Discount',
    whatsapp_widget: 'WhatsApp Widget',
  };
  const displaySource = DISPLAY_SOURCE_BY_TYPE[tool?.type] || 'Website';

  const setDoc = {
    optStatus: doubleOptIn && !partial ? 'pending' : 'opted_in',
    optInDate: now,
    optInMethod: doubleOptIn && !partial ? 'double' : 'single',
    optInSource: sourceField,
    optInToolId: tool?._id || null,
    optInToolName: tool?.name || '',
    source: displaySource,
    lastInteraction: now,
    whatsappMarketingEligible: true,
    'channelConsent.whatsapp.status': doubleOptIn && !partial ? 'pending' : 'opted_in',
    'channelConsent.whatsapp.source': sourceField,
    'channelConsent.whatsapp.timestamp': now,
    'channelConsent.whatsapp.lastUpdated': now,
  };
  if (couponCode) {
    setDoc.spinWheelCode = couponCode;
    setDoc['capturedData.optInCouponCode'] = couponCode;
  }
  if (tool?.type === 'spin_wheel' || tool?.type === 'mystery_discount') {
    setDoc['capturedData.prizeLabel'] = prizeLabel || '';
  }
  if (visitorId) {
    setDoc['capturedData.visitorId'] = visitorId;
    setDoc['capturedData.te_visitor_id'] = visitorId;
  }
  if (tool?._id) {
    setDoc['capturedData.optInToolId'] = String(tool._id);
    setDoc['capturedData.optInToolType'] = tool.type;
  }
  if (extraFields.name) {
    setDoc.name = extraFields.name;
    setDoc['capturedData.optInName'] = extraFields.name;
  }
  if (extraFields.email) {
    setDoc.email = extraFields.email;
    setDoc['capturedData.optInEmail'] = extraFields.email;
  }
  if (extraFields.dateOfBirth) {
    setDoc['capturedData.dateOfBirth'] = extraFields.dateOfBirth;
  }

  if (doubleOptIn && !partial) {
    setDoc.pendingOptInCode = String(Math.floor(100000 + Math.random() * 900000));
    setDoc.pendingOptInExpiry = new Date(Date.now() + 15 * 60 * 1000);
  }

  await stitchVisitorIdentity(client.clientId, client, {
    visitorId,
    phone: phoneStored,
    email: extraFields.email || null,
  }).catch(() => {});

  const lead = await AdLead.findOneAndUpdate(
    { clientId: client.clientId, phoneNumber: { $in: phoneLookup } },
    {
      $set: { ...setDoc, phoneNumber: phoneStored },
      $setOnInsert: { clientId: client.clientId },
      $push: {
        optInHistory: {
          $each: [
            {
              event: doubleOptIn && !partial ? 'pending' : 'opted_in',
              action: partial ? 'capture_phone' : doubleOptIn ? 'pending' : 'opted_in',
              timestamp: now,
              source: sourceField,
              method: doubleOptIn && !partial ? 'double' : 'single',
              pageUrl: pageUrl || '',
              ipAddress,
              userAgent,
              widgetType: tool?.type || 'popup',
              note: partial ? 'Auto phone capture' : 'Opt-in tool subscribe',
            },
          ],
          $position: 0,
          $slice: 40,
        },
      },
    },
    { upsert: true, new: true }
  );

  if (!partial && lead?._id) {
    const autoTags = [`opt-in:${tool?.type || 'popup'}`];
    if (prizeLabel) autoTags.push(`prize:${prizeLabel}`);
    if (tool?.name) autoTags.push(`tool:${tool.name}`);
    await AdLead.updateOne(
      { _id: lead._id },
      { $addToSet: { tags: { $each: autoTags } } }
    ).catch(() => {});
  }

  if (!partial && tool?._id) {
    const day = new Date().toISOString().slice(0, 10);
    await OptInTool.updateOne(
      { _id: tool._id, clientId: client.clientId },
      { $inc: { 'signups.total': 1, [`signups.byDay.${day}`]: 1 } }
    );
  }

  const io = global.io;
  if (io && lead && !partial) {
    const d = String(phoneStored).replace(/\D/g, '');
    io.to(`client_${client.clientId}`).emit('capture:new', {
      id: String(lead._id),
      source: sourceField,
      canonicalSource: 'website_widgets',
      status: setDoc.optStatus,
      phoneMasked: d.length >= 4 ? `•••• ${d.slice(-4)}` : '••••',
      name: 'Customer',
      when: now,
    });
  }

  return { ok: true, lead, doubleOptIn: doubleOptIn && !partial };
}

async function capturePhone({ embedKey, phone, consent, toolId, pageUrl, visitorId, req }) {
  const phoneCheck = validateOptInPhoneInput(phone);
  if (!phoneCheck.ok) {
    return { success: false, status: 400, message: phoneCheck.message };
  }
  const phoneStored = phoneCheck.stored;
  const client = await resolveClientByEmbedKey(embedKey);
  if (!client) return { success: false, status: 404, message: 'Unknown or disabled embed key' };

  const tool = toolId
    ? await OptInTool.findOne({ _id: toolId, clientId: client.clientId, status: 'live' }).lean()
    : null;

  const ipAddress = String((req?.headers?.['x-forwarded-for'] || '').split(',')[0] || req?.ip || '').slice(0, 120);
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 255);

  const result = await upsertOptInLead({
    client,
    phoneStored,
    consent: consent === true || consent === 'true' || consent === '1',
    tool,
    pageUrl,
    visitorId,
    ipAddress,
    userAgent,
    partial: true,
  });
  if (!result.ok) return { success: false, status: result.status, message: result.message };
  return { success: true, status: 'captured' };
}

async function subscribe({ embedKey, phone, consent, toolId, pageUrl, visitorId, name, email, dateOfBirth, req }) {
  const phoneCheck = validateOptInPhoneInput(phone);
  if (!phoneCheck.ok) {
    return { success: false, status: 400, message: phoneCheck.message };
  }
  const phoneStored = phoneCheck.stored;
  if (!(consent === true || consent === 'true' || consent === '1')) {
    return { success: false, status: 400, message: 'WhatsApp marketing requires explicit consent' };
  }

  const client = await resolveClientByEmbedKey(embedKey);
  if (!client) return { success: false, status: 404, message: 'Unknown or disabled embed key' };

  const tool = await OptInTool.findOne({ _id: toolId, clientId: client.clientId, status: 'live' }).lean();
  if (!tool) return { success: false, status: 404, message: 'Tool not found or not live' };

  const ipAddress = String((req?.headers?.['x-forwarded-for'] || '').split(',')[0] || req?.ip || '').slice(0, 120);
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 255);

  let couponCode = '';
  let prizeMeta = null;
  try {
    if (tool.type === 'spin_wheel' || tool.type === 'mystery_discount') {
      const picked = pickWeightedPrize(tool.prizes || []);
      const prize = picked.prize;
      prizeMeta = {
        index: picked.index,
        label: prize?.label || '',
        isLose: prize?.couponMode === 'lose',
      };
      if (prize && prize.couponMode !== 'lose') {
        const claimed = await claimPrizeCoupon(client.clientId, tool, prize);
        couponCode = claimed.code || '';
        prizeMeta.isLose = claimed.isLose;
      }
    } else if (tool.type === 'popup') {
      const claimed = await claimCoupon(client.clientId, tool);
      couponCode = claimed.code || '';
    }
  } catch (e) {
    console.warn('[optInSubscribe] coupon claim failed', e.message);
  }

  const extraFields = normalizeSpinExtraFields(tool, { name, email, dateOfBirth });

  const result = await upsertOptInLead({
    client,
    phoneStored,
    consent: true,
    tool,
    pageUrl,
    visitorId,
    ipAddress,
    userAgent,
    couponCode,
    prizeLabel: prizeMeta?.label || '',
    partial: false,
    extraFields,
  });
  if (!result.ok) return { success: false, status: result.status, message: result.message };

  if (prizeMeta?.label && tool?._id) {
    const { recordPrizeWin } = require('./optInAnalyticsService');
    recordPrizeWin(client.clientId, tool._id, prizeMeta.label).catch(() => {});
  }

  if (result.doubleOptIn) {
    try {
      const WhatsApp = require('../utils/meta/whatsapp');
      const clientDoc = await Client.findOne({ clientId: client.clientId });
      if (clientDoc) {
        await WhatsApp.sendText(
          clientDoc,
          phoneStored,
          `Please confirm your WhatsApp subscription. Reply YES within 15 minutes to confirm updates from ${client.businessName || 'our brand'}.`
        );
      }
    } catch (e) {
      console.warn('[optInSubscribe] double opt-in prompt failed', e.message);
    }
    return {
      success: true,
      status: 'pending',
      couponCode,
      message: 'Confirmation message sent. Reply YES on WhatsApp to complete opt-in.',
    };
  }

  let whatsAppDelivery = { sent: false };
  if (tool.sendWhatsAppWelcome !== false) {
    const brandName = client.brand?.businessName || client.businessName || 'our brand';
    const storeUrl = tool.thankYouConfig?.shopNowUrl || (client.shopDomain ? `https://${client.shopDomain}` : '');
    whatsAppDelivery = await sendOptInWelcomeMessage(client, phoneStored, {
      brandName,
      couponCode,
      storeUrl,
      templateSlot: tool.welcomeTemplateSlot,
    });
  }

  const waLink =
    tool.type === 'whatsapp_widget' ? buildWaMeLink(client, tool.design || {}) : '';

  return {
    success: true,
    status: 'opted_in',
    couponCode,
    prize: prizeMeta,
    whatsAppDelivery,
    waLink,
    merchantWaPhone: resolveMerchantWaPhone(client, tool.design || {}),
    thankYou: {
      showBestsellers: tool.thankYouConfig?.showBestsellers !== false,
      shopNowUrl: tool.thankYouConfig?.shopNowUrl || '',
    },
  };
}

module.exports = { subscribe, capturePhone, optInSourceForTool, normalizeSpinExtraFields };
