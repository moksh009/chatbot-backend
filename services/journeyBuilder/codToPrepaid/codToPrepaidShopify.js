'use strict';

const { executeGraphQL } = require('../../../utils/shopify/shopifyGraphQL');
const log = require('../../../utils/core/logger')('CodToPrepaidShopify');

const DRAFT_ORDER_CREATE_MUTATION = `
mutation draftOrderCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      invoiceUrl
      tags
    }
    userErrors {
      field
      message
    }
  }
}`;

const DRAFT_ORDER_DELETE_MUTATION = `
mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
  draftOrderDelete(input: $input) {
    deletedId
    userErrors {
      field
      message
    }
  }
}`;

const ORDER_CANCEL_MUTATION = `
mutation orderCancel($orderId: ID!, $notifyCustomer: Boolean, $staffNote: String, $restock: Boolean!, $reason: OrderCancelReason!) {
  orderCancel(orderId: $orderId, notifyCustomer: $notifyCustomer, staffNote: $staffNote, restock: $restock, reason: $reason) {
    job {
      id
    }
    userErrors {
      field
      message
    }
  }
}`;

function gidToNumericId(gid) {
  const s = String(gid || '');
  const m = /(\d+)\s*$/.exec(s);
  return m ? m[1] : s.replace(/\D/g, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('429') || msg.includes('throttl') || msg.includes('rate limit');
}

async function withShopifyRetry(fn, { maxAttempts = 3, clientId, operation } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt >= maxAttempts - 1) {
        if (isRateLimitError(err) && clientId) {
          log.error(`Shopify rate limit exhausted for ${operation || 'request'}`, {
            clientId,
            attempts: maxAttempts,
            error: err.message,
          });
        }
        throw err;
      }
      const delayMs = 1000 * 2 ** attempt;
      log.warn(`Shopify rate limit — retry in ${delayMs}ms (attempt ${attempt + 1})`, {
        clientId,
        operation: operation || 'request',
      });
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

async function createDraftOrder(clientId, input) {
  const data = await withShopifyRetry(
    () => executeGraphQL(clientId, DRAFT_ORDER_CREATE_MUTATION, { input }),
    { clientId, operation: 'draftOrderCreate' }
  );
  const payload = data?.draftOrderCreate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    return { ok: false, userErrors, draftOrder: null };
  }
  return { ok: true, userErrors: [], draftOrder: payload?.draftOrder || null };
}

async function deleteDraftOrder(clientId, draftOrderGid) {
  const data = await withShopifyRetry(() =>
    executeGraphQL(clientId, DRAFT_ORDER_DELETE_MUTATION, {
      input: { id: String(draftOrderGid) },
    })
  );
  const payload = data?.draftOrderDelete;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    const notFound = userErrors.some((e) =>
      /not found|does not exist|invalid/i.test(String(e.message || ''))
    );
    return { ok: notFound, userErrors, deletedId: payload?.deletedId || null, notFound };
  }
  return { ok: true, userErrors: [], deletedId: payload?.deletedId || null, notFound: false };
}

async function cancelCodOrder(clientId, originalCodOrderGid) {
  const data = await withShopifyRetry(() =>
    executeGraphQL(clientId, ORDER_CANCEL_MUTATION, {
      orderId: String(originalCodOrderGid),
      notifyCustomer: false,
      staffNote: 'Canceled by System: Customer converted to Prepaid.',
      restock: true,
      reason: 'OTHER',
    })
  );
  const payload = data?.orderCancel;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    return { ok: false, userErrors, job: null };
  }
  return { ok: true, userErrors: [], job: payload?.job || null };
}

module.exports = {
  DRAFT_ORDER_CREATE_MUTATION,
  DRAFT_ORDER_DELETE_MUTATION,
  ORDER_CANCEL_MUTATION,
  gidToNumericId,
  isRateLimitError,
  withShopifyRetry,
  createDraftOrder,
  deleteDraftOrder,
  cancelCodOrder,
};
