'use strict';

/**
 * Unified COD → prepaid nudge on Shopify order create.
 * Gated by wizardFeatures.enableCodToPrepaid; deduped via Order.codNudgeSentAt.
 */

const axios = require('axios');
const Order = require('../../models/Order');
const shopifyAdminApiVersion = require('../shopify/shopifyAdminApiVersion');
const log = require('../core/logger')('CodPrepaidDispatch');
const { readFeatureFromClient } = require('../core/featureFlags');

async function createShopifyDraftOrder(client, originalOrder, discountCode) {
  if (!client.shopifyAccessToken || !client.shopDomain) return null;
  const url = `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}/draft_orders.json`;
  const payload = {
    draft_order: {
      line_items: (originalOrder.line_items || []).map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
      })),
      customer: { id: originalOrder.customer?.id },
      use_customer_default_address: true,
      applied_discount: {
        description: 'Prepaid conversion discount',
        value_type: 'percentage',
        value: '5.0',
        title: discountCode,
      },
    },
  };
  const res = await axios.post(url, payload, {
    headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken },
  });
  return res.data?.draft_order || null;
}

function isCodPrepaidEnabled(client) {
  // Merchant Settings marks this Coming soon — keep dispatch off until COD_PREPAID_LIVE=true.
  if (process.env.COD_PREPAID_LIVE !== 'true') return false;
  if (readFeatureFromClient(client, 'codToPrepaid')) return true;
  const flow = (client.automationFlows || []).find((f) => f.id === 'cod_to_prepaid');
  return flow?.isActive === true;
}

async function buildPaymentLink(client, shopifyPayload, orderDoc) {
  const niche = client.nicheData || {};
  let paymentLinkUrl = null;
  const paymentGateway = client.activePaymentGateway || 'none';

  if (paymentGateway === 'razorpay' && client.razorpayKeyId) {
    const { createCODPaymentLink } = require('./razorpay');
    const link = await createCODPaymentLink(orderDoc, client);
    paymentLinkUrl = link?.short_url;
  } else if (paymentGateway === 'cashfree' && client.cashfreeAppId) {
    const { createCashfreePaymentLink } = require('./cashfree');
    const link = await createCashfreePaymentLink(orderDoc, client);
    paymentLinkUrl = link?.short_url;
  } else {
    const draftOrder = await createShopifyDraftOrder(
      client,
      shopifyPayload,
      niche.cod_discount_code || niche.globalDiscountCode || 'PREPAID5'
    );
    paymentLinkUrl = draftOrder?.invoice_url;
  }

  return { paymentLinkUrl, paymentGateway };
}

/**
 * @param {object} opts
 * @param {object} opts.client - Client document
 * @param {object} opts.orderDoc - Local Order mongoose doc or plain object with _id
 * @param {object} opts.shopifyPayload - Raw Shopify order webhook body
 * @param {string} opts.phone - Normalized customer phone
 */
async function maybeDispatchCodPrepaidNudge({
  client,
  orderDoc,
  shopifyPayload,
  phone,
  forceSend = false,
}) {
  if (!client?.clientId || !phone) return { skipped: 'missing_context' };
  if (!isCodPrepaidEnabled(client)) return { skipped: 'feature_off' };

  const oid = orderDoc?._id || orderDoc?.id;
  let order = orderDoc;
  if (oid && typeof orderDoc?.codNudgeSentAt === 'undefined') {
    order = await Order.findById(oid).lean();
  }
  if (!order) return { skipped: 'no_order' };
  if (order.codNudgeSentAt || order.paidViaLink) {
    return { skipped: 'already_sent_or_paid' };
  }

  const flowCfg =
    (client.automationFlows || []).find((f) => f.id === 'cod_to_prepaid')?.config || {};
  const delayMin = forceSend ? 0 : Number(flowCfg.delayMinutes ?? 0);
  if (delayMin > 0) {
    const scheduledAt = new Date(Date.now() + delayMin * 60 * 1000);
    await Order.findByIdAndUpdate(order._id, {
      $set: { codNudgeScheduledAt: scheduledAt, codNudgeStatus: 'scheduled' },
    });
    return { scheduled: true, at: scheduledAt };
  }

  let paymentLinkUrl;
  let paymentGateway;
  try {
    ({ paymentLinkUrl, paymentGateway } = await buildPaymentLink(
      client,
      shopifyPayload,
      order
    ));
  } catch (linkErr) {
    log.warn(`[CodPrepaid] payment link failed: ${linkErr.message}`);
    await Order.findByIdAndUpdate(order._id, {
      $set: { codNudgeStatus: 'failed' },
    });
    return { ok: false, error: linkErr.message };
  }

  if (!paymentLinkUrl) {
    await Order.findByIdAndUpdate(order._id, {
      $set: { codNudgeStatus: 'failed' },
    });
    return { skipped: 'no_payment_link' };
  }

  const customerName = shopifyPayload.customer?.first_name || 'Guest';
  const orderId = shopifyPayload.name || shopifyPayload.id;

  try {
    const { sendForAutomation } = require('../../services/templateSender');
    const codResult = await sendForAutomation({
      clientId: client.clientId,
      phone,
      slotId: 'eco_cod_prepaid',
      contextType: 'cod_prepaid',
      contextData: {
        order: shopifyPayload,
        extra: {
          payment_link: paymentLinkUrl,
          payment_gateway: paymentGateway,
          name: customerName,
        },
      },
    });

    if (codResult?.whatsapp?.sent) {
      await Order.findByIdAndUpdate(order._id, {
        $set: { codNudgeSentAt: new Date(), codNudgeStatus: 'sent' },
      });
      log.info(`[CodPrepaid] template sent to ${phone} (${codResult.metaName})`);
      return { ok: true, mode: 'template' };
    }

    throw new Error(codResult?.failureCode || codResult?.whatsapp?.reason || 'cod_send_skipped');
  } catch (metaErr) {
    log.warn(`[CodPrepaid] template failed (${metaErr.message}), interactive fallback`);
    const WhatsApp = require('../meta/whatsapp');
    const total = shopifyPayload.total_price;
    const fallbackBody = `Hi ${customerName}! Want to save more on your order? Pay online securely now and get an extra discount!\n\nPay here: ${paymentLinkUrl}\n\nOrder: #${orderId}\nAmount: ₹${total}`;
    const interactive = {
      type: 'button',
      header: { type: 'text', text: 'Convert to Prepaid' },
      body: { text: fallbackBody },
      footer: { text: client.businessName || 'Smart Store' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: `cod_upi_${shopifyPayload.id}`, title: 'Pay now' },
          },
        ],
      },
    };
    await WhatsApp.sendInteractive(client, phone, interactive, fallbackBody);
    const { persistAutomationOutbound } = require('../messaging/persistAutomationOutbound');
    await persistAutomationOutbound({
      clientId: client.clientId,
      phone,
      templateName: 'cod_prepaid_interactive',
      bodyPreview: fallbackBody.slice(0, 500),
      metadata: { source: 'automation', kind: 'cod_prepaid_fallback' },
    });
    await Order.findByIdAndUpdate(order._id, {
      $set: { codNudgeSentAt: new Date(), codNudgeStatus: 'sent' },
    });
    return { ok: true, mode: 'interactive_fallback' };
  }
}

module.exports = {
  isCodPrepaidEnabled,
  maybeDispatchCodPrepaidNudge,
};
