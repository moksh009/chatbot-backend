'use strict';

/**
 * Push dashboard order status changes to Shopify using Fulfillment Orders API (2024+).
 */

function extractShopifyError(err) {
  const data = err?.response?.data;
  if (!data) return err?.message || 'Unknown Shopify error';
  if (typeof data === 'string') return data;
  if (data.errors) {
    return typeof data.errors === 'string' ? data.errors : JSON.stringify(data.errors);
  }
  if (data.error) return String(data.error);
  return JSON.stringify(data);
}

function isLocalOnlyFallbackError(err) {
  const status = err?.response?.status;
  if (status === 404 || status === 422) return true;
  const msg = extractShopifyError(err).toLowerCase();
  return (
    /not found|already fulfilled|no open fulfillment|cannot be fulfilled|closed/i.test(msg)
  );
}

async function resolveLocationId(shopifyApi, nicheData = {}) {
  let activeLocId = nicheData?.shopifyLocationId;
  if (!activeLocId) {
    try {
      const locRes = await shopifyApi.get('/locations.json');
      activeLocId = locRes.data?.locations?.[0]?.id;
    } catch (locErr) {
      console.error('[ShopifyFulfillment] locations fetch:', locErr.message);
    }
  }
  return activeLocId || null;
}

async function fetchFulfillmentOrders(shopifyApi, shopifyOrderId) {
  const { data } = await shopifyApi.get(`/orders/${shopifyOrderId}/fulfillment_orders.json`);
  return data?.fulfillment_orders || [];
}

async function fetchExistingFulfillments(shopifyApi, shopifyOrderId) {
  const { data } = await shopifyApi.get(`/orders/${shopifyOrderId}/fulfillments.json`);
  return data?.fulfillments || [];
}

async function fulfillOpenOrders(shopifyApi, shopifyOrderId, { trackingNumber, trackingUrl, notifyCustomer = false }) {
  const fos = await fetchFulfillmentOrders(shopifyApi, shopifyOrderId);
  const open = fos.filter(
    (fo) => fo.status === 'open' || fo.status === 'in_progress' || fo.status === 'scheduled'
  );
  if (!open.length) {
    const existing = await fetchExistingFulfillments(shopifyApi, shopifyOrderId);
    if (existing.length) return existing;
    return [];
  }

  const trackingInfo = {};
  if (trackingNumber) trackingInfo.number = trackingNumber;
  if (trackingUrl) trackingInfo.url = trackingUrl;

  const created = [];
  for (const fo of open) {
    const payload = {
      fulfillment: {
        line_items_by_fulfillment_order: [{ fulfillment_order_id: fo.id }],
        notify_customer: notifyCustomer,
      },
    };
    if (trackingNumber || trackingUrl) {
      payload.fulfillment.tracking_info = trackingInfo;
    }
    const res = await shopifyApi.post('/fulfillments.json', payload);
    if (res.data?.fulfillment) created.push(res.data.fulfillment);
  }
  return created.length ? created : await fetchExistingFulfillments(shopifyApi, shopifyOrderId);
}

async function updateFulfillmentTracking(shopifyApi, shopifyOrderId, fulfillment, trackingNumber, trackingUrl) {
  if (!fulfillment?.id) return;
  const tn = trackingNumber || fulfillment.tracking_number;
  const tu = trackingUrl || (fulfillment.tracking_urls || [])[0];
  if (!tn && !tu) return;
  try {
    await shopifyApi.put(`/orders/${shopifyOrderId}/fulfillments/${fulfillment.id}.json`, {
      fulfillment: {
        tracking_number: tn || undefined,
        tracking_urls: tu ? [tu] : fulfillment.tracking_urls,
      },
    });
  } catch (trackErr) {
    console.error('[ShopifyFulfillment] tracking update:', trackErr.message);
  }
}

async function ensureFulfillments(shopifyApi, shopifyOrderId, opts = {}) {
  const { trackingNumber, trackingUrl } = opts;
  let fulfillments = await fetchExistingFulfillments(shopifyApi, shopifyOrderId);
  if (!fulfillments.length) {
    fulfillments = await fulfillOpenOrders(shopifyApi, shopifyOrderId, opts);
  } else if (trackingNumber || trackingUrl) {
    const latest = fulfillments[fulfillments.length - 1];
    await updateFulfillmentTracking(shopifyApi, shopifyOrderId, latest, trackingNumber, trackingUrl);
    fulfillments = await fetchExistingFulfillments(shopifyApi, shopifyOrderId);
  }
  return fulfillments;
}

async function postFulfillmentEvent(shopifyApi, shopifyOrderId, eventStatus) {
  const fulfillments = await ensureFulfillments(shopifyApi, shopifyOrderId, {});
  const latest = fulfillments[fulfillments.length - 1];
  if (!latest?.id) {
    return { ok: false, error: 'Could not create or find fulfillment on Shopify' };
  }
  const shipmentStatus = String(latest.shipment_status || '').toLowerCase();
  if (shipmentStatus === eventStatus) {
    return { ok: true, skipped: true };
  }
  await shopifyApi.post(`/orders/${shopifyOrderId}/fulfillments/${latest.id}/events.json`, {
    event: { status: eventStatus },
  });
  return { ok: true };
}

/**
 * @param {object} params
 * @param {import('axios').AxiosInstance} params.shopifyApi
 * @param {string} params.shopifyOrderId
 * @param {string} params.status
 * @param {string} [params.trackingNumber]
 * @param {string} [params.trackingUrl]
 * @param {object} [params.nicheData]
 */
async function pushOrderStatusToShopify({
  shopifyApi,
  shopifyOrderId,
  status,
  trackingNumber = '',
  trackingUrl = '',
  nicheData = {},
}) {
  const st = String(status || '').toLowerCase();

  try {
    if (st === 'paid' || st === 'confirmed') {
      const { data: shopData } = await shopifyApi.get(`/orders/${shopifyOrderId}.json`);
      const shopOrder = shopData?.order;
      if (!shopOrder) return { ok: false, error: 'Order not found on Shopify' };
      const fin = String(shopOrder.financial_status || '').toLowerCase();
      if (fin === 'paid' || fin === 'partially_paid') {
        return { ok: true, skipped: true, reason: 'already_paid' };
      }
      if (st === 'paid') {
        const amount = shopOrder.total_price || shopOrder.current_total_price;
        await shopifyApi.post(`/orders/${shopifyOrderId}/transactions.json`, {
          transaction: {
            kind: 'sale',
            status: 'success',
            amount,
            currency: shopOrder.currency || 'INR',
            gateway: 'manual',
            source: 'external',
          },
        });
      }
      return { ok: true, skipped: st === 'confirmed' };
    }

    if (st === 'shipped' || st === 'fulfilled') {
      await ensureFulfillments(shopifyApi, shopifyOrderId, {
        trackingNumber,
        trackingUrl,
        notifyCustomer: false,
        nicheData,
      });
      return { ok: true };
    }

    if (st === 'out_for_delivery') {
      await ensureFulfillments(shopifyApi, shopifyOrderId, { trackingNumber, trackingUrl });
      return postFulfillmentEvent(shopifyApi, shopifyOrderId, 'out_for_delivery');
    }

    if (st === 'delivered') {
      await ensureFulfillments(shopifyApi, shopifyOrderId, { trackingNumber, trackingUrl });
      return postFulfillmentEvent(shopifyApi, shopifyOrderId, 'delivered');
    }

    if (st === 'cancelled') {
      await shopifyApi.post(`/orders/${shopifyOrderId}/cancel.json`, { reason: 'customer' });
      return { ok: true };
    }

    return { ok: true, skipped: true, reason: 'unsupported_status' };
  } catch (err) {
    const detail = extractShopifyError(err);
    const allowLocalFallback = isLocalOnlyFallbackError(err);
    console.error('[ShopifyFulfillment] status push failed:', detail);
    return { ok: false, error: detail, allowLocalFallback };
  }
}

module.exports = {
  pushOrderStatusToShopify,
  extractShopifyError,
  isLocalOnlyFallbackError,
  ensureFulfillments,
};
