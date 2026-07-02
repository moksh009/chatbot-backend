'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractWebhookSnapshot,
  buildInitialSequenceContext,
  applySequenceContextToSendContext,
  flattenSequenceContextForTemplates,
  assertSequenceContextForStep,
  assertOrderContextAvailable,
  assertCodPrepaidEnrollmentContext,
  stepNeedsContextResolution,
} = require('../../services/journeyBuilder/sequenceContextService');

describe('extractWebhookSnapshot', () => {
  it('captures only commerce-critical fields from Shopify order payload', () => {
    const snap = extractWebhookSnapshot({
      id: 5678901234,
      name: '#1042',
      financial_status: 'pending',
      payment_gateway_names: ['Cash on Delivery (COD)'],
      customer: { id: 99887766 },
      shipping_address: {
        first_name: 'Ada',
        address1: '12 MG Road',
        city: 'Bengaluru',
        province: 'KA',
        zip: '560001',
        country_code: 'IN',
      },
      line_items: [
        { variant_id: 111, product_id: 222, quantity: 2, price: '499.00', title: 'Hoodie' },
        { variant_id: null, product_id: null, quantity: 1 },
      ],
      note_attributes: [{ name: 'utm', value: 'should-not-persist' }],
      admin_graphql_api_id: 'gid://shopify/Order/5678901234',
    });

    assert.ok(snap);
    assert.equal(snap.customer, '99887766');
    assert.equal(snap.customerGid, 'gid://shopify/Customer/99887766');
    assert.equal(snap.financial_status, 'pending');
    assert.deepEqual(snap.payment_gateway_names, ['Cash on Delivery (COD)']);
    assert.equal(snap.shopifyOrderNumericId, '5678901234');
    assert.equal(snap.shopifyOrderGid, 'gid://shopify/Order/5678901234');
    assert.equal(snap.lineItems.length, 1);
    assert.equal(snap.lineItems[0].variant_id, '111');
    assert.equal(snap.lineItems[0].variantGid, 'gid://shopify/ProductVariant/111');
    assert.equal(snap.lineItems[0].quantity, 2);
    assert.equal(snap.lineItems[0].unitPrice, '499.00');
    assert.equal(snap.shippingAddress.city, 'Bengaluru');
    assert.equal(snap.shippingAddress.countryCode, 'IN');
    assert.equal(snap.orderId, '#1042');
    assert.ok(snap.capturedAt);
    assert.equal(snap.note_attributes, undefined);
    assert.equal(snap.admin_graphql_api_id, undefined);
  });
});

describe('buildInitialSequenceContext', () => {
  it('injects webhookSnapshot at enrollment for order_placed', () => {
    const ctx = buildInitialSequenceContext({
      triggerType: 'order_placed',
      rawPayload: {
        name: '#99',
        financial_status: 'paid',
        payment_gateway_names: ['razorpay'],
        line_items: [{ variant_id: 1, product_id: 2, quantity: 1, price: '10.00' }],
      },
      blueprintFlowId: 'journey-flow-1',
      normalizedPhone: '919876543210',
    });

    assert.equal(ctx.triggerType, 'order_placed');
    assert.equal(ctx.blueprintFlowId, 'journey-flow-1');
    assert.equal(ctx._lifecycle, 'active');
    assert.equal(ctx._frozen, false);
    assert.equal(ctx.normalizedPhone, '919876543210');
    assert.ok(ctx.webhookSnapshot);
    assert.equal(ctx.webhookSnapshot.orderId, '#99');
  });
});

describe('assertCodPrepaidEnrollmentContext (Part 3)', () => {
  const validSequence = {
    phone: '919876543210',
    sequenceContext: {
      normalizedPhone: '919876543210',
      webhookSnapshot: {
        shopifyOrderNumericId: '5678901234',
        shopifyOrderGid: 'gid://shopify/Order/5678901234',
        lineItems: [{
          variantGid: 'gid://shopify/ProductVariant/111',
          quantity: 1,
          unitPrice: '499.00',
        }],
        shippingAddress: {
          address1: '12 MG Road',
          city: 'Bengaluru',
          zip: '560001',
          countryCode: 'IN',
        },
      },
    },
  };

  it('passes when all COD prepaid fields are present', () => {
    const result = assertCodPrepaidEnrollmentContext(validSequence);
    assert.equal(result.ok, true);
  });

  it('fails gracefully when webhook snapshot is missing', () => {
    const result = assertCodPrepaidEnrollmentContext({ sequenceContext: {} });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_cod_prepaid_context');
    assert.ok(result.missing.includes('webhookSnapshot'));
  });

  it('fails when line items lack variant GID or unit price', () => {
    const result = assertCodPrepaidEnrollmentContext({
      phone: '919876543210',
      sequenceContext: {
        normalizedPhone: '919876543210',
        webhookSnapshot: {
          shopifyOrderNumericId: '1',
          shopifyOrderGid: 'gid://shopify/Order/1',
          lineItems: [{ quantity: 1 }],
          shippingAddress: {
            address1: 'A',
            city: 'B',
            zip: '1',
            countryCode: 'IN',
          },
        },
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((m) => m.includes('variantGid') || m.includes('unitPrice')));
  });
});

describe('applySequenceContextToSendContext precedence', () => {
  it('sequenceContext overrides normalized order fields', () => {
    const merged = applySequenceContextToSendContext(
      {
        order_id: '#OLD',
        payment_method: 'card',
        first_name: 'FromDB',
      },
      {
        webhookSnapshot: {
          orderId: '#SNAP',
          payment_gateway_names: ['cod'],
          financial_status: 'pending',
          lineItems: [{ variant_id: '9', product_id: '8', quantity: 1 }],
        },
        draftInvoiceUrl: 'https://shop.example/draft/1',
      }
    );

    assert.equal(merged.order_id, '#SNAP');
    assert.equal(merged.payment_method, 'cod');
    assert.equal(merged.financial_status, 'pending');
    assert.equal(merged.draftInvoiceUrl, 'https://shop.example/draft/1');
    assert.ok(merged._sequenceContext);
  });
});

describe('assertSequenceContextForStep', () => {
  it('passes when no required keys', () => {
    const result = assertSequenceContextForStep({ sequenceContext: {} }, { type: 'whatsapp' });
    assert.equal(result.ok, true);
  });

  it('fails gracefully when webhookSnapshot required but missing', () => {
    const result = assertSequenceContextForStep(
      { sequenceContext: {} },
      { requiresWebhookSnapshot: true }
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing_sequence_context/);
    assert.deepEqual(result.missing, ['webhookSnapshot']);
  });
});

describe('assertOrderContextAvailable', () => {
  it('requires order doc or snapshot when mappings need order fields', () => {
    const fail = assertOrderContextAvailable({ sequenceContext: {} }, null, {
      mappingsNeedOrder: true,
    });
    assert.equal(fail.ok, false);
    assert.equal(fail.reason, 'missing_order_context');

    const pass = assertOrderContextAvailable(
      { sequenceContext: { webhookSnapshot: { lineItems: [{ variant_id: '1' }] } } },
      null,
      { mappingsNeedOrder: true }
    );
    assert.equal(pass.ok, true);
  });
});

describe('stepNeedsContextResolution', () => {
  it('skips ghost-style steps without action types', () => {
    assert.equal(stepNeedsContextResolution({ type: 'condition' }), false);
  });

  it('includes whatsapp, email, and cod_prepaid action steps', () => {
    assert.equal(stepNeedsContextResolution({ type: 'whatsapp' }), true);
    assert.equal(stepNeedsContextResolution({ type: 'email' }), true);
    assert.equal(stepNeedsContextResolution({ type: 'cod_prepaid' }), true);
  });
});

describe('flattenSequenceContextForTemplates', () => {
  it('does not leak reserved internal keys as template vars', () => {
    const flat = flattenSequenceContextForTemplates({
      _frozen: true,
      _lifecycle: 'active',
      triggerType: 'order_placed',
      draftUrl: 'https://example.com/draft',
    });
    assert.equal(flat._frozen, undefined);
    assert.equal(flat.triggerType, undefined);
    assert.equal(flat.draftUrl, 'https://example.com/draft');
  });
});
