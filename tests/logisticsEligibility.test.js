'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { canEnableShipmentRule } = require('../services/logisticsEligibilityService');
const {
  shipmentStatusToRuleId,
  getPartnerDef,
  listPartnersForUi,
} = require('../constants/logisticsPartnerRegistry');

describe('logisticsEligibilityService', () => {
  it('allows delivered on shopify_only without direct webhook', () => {
    const client = {
      logisticsPartner: 'shiprocket',
      logisticsMode: 'shopify_only',
      logisticsHealth: { observedShopifyStatuses: [] },
    };
    const gate = canEnableShipmentRule(client, shipmentStatusToRuleId('delivered'));
    assert.equal(gate.allowed, true);
  });

  it('blocks out_for_delivery on shopify_only when not observed', () => {
    const client = {
      logisticsPartner: 'shiprocket',
      logisticsMode: 'shopify_only',
      logisticsHealth: { observedShopifyStatuses: [] },
    };
    const gate = canEnableShipmentRule(client, 'sys_shipment_out_for_delivery');
    assert.equal(gate.allowed, false);
    assert.match(gate.message, /Direct webhook/i);
  });

  it('allows granular status when direct webhook is live', () => {
    const client = {
      logisticsPartner: 'shiprocket',
      logisticsMode: 'direct',
      logisticsIntegration: { planDeclared: true },
      logisticsHealth: {
        directWebhookActive: true,
        directWebhookLastSeenAt: new Date(),
        observedShopifyStatuses: [],
      },
    };
    const gate = canEnableShipmentRule(client, 'sys_shipment_out_for_delivery');
    assert.equal(gate.allowed, true);
    assert.equal(gate.path, 'direct_webhook');
  });

  it('allows granular status when observed on Shopify path', () => {
    const client = {
      logisticsPartner: 'shiprocket',
      logisticsMode: 'shopify_only',
      logisticsHealth: { observedShopifyStatuses: ['out_for_delivery'] },
    };
    const gate = canEnableShipmentRule(client, 'sys_shipment_out_for_delivery');
    assert.equal(gate.allowed, true);
    assert.equal(gate.path, 'shopify_observed');
  });

  it('resolves expanded partner catalog entries', () => {
    const del = getPartnerDef('delhivery');
    assert.equal(del.id, 'delhivery');
    assert.equal(del.providerCode, 'del');
    assert.ok(del.setupCopy.length > 0);

    const usps = getPartnerDef('usps');
    assert.equal(usps.supportsDirectWebhook, false);

    const partners = listPartnersForUi().map((p) => p.id);
    assert.ok(partners.includes('shipway'));
    assert.ok(partners.includes('dhl'));
    assert.ok(partners.includes('delhivery'));
  });
});
