'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseIndianMobile,
  parsePincode,
  parseAddressAndPincode,
  resolveAwb,
  canAutoPushToShiprocket,
} = require('../utils/commerce/ndrCaptureService');

describe('ndrCaptureService', () => {
  it('parses Indian mobile from free text', () => {
    assert.equal(parseIndianMobile('My number is 9876543210 thanks'), '9876543210');
    assert.equal(parseIndianMobile('call me at +91 8765432109'), '8765432109');
    assert.equal(parseIndianMobile('no number here'), '');
  });

  it('parses 6-digit pincode', () => {
    assert.equal(parsePincode('Flat 12 MG Road Bangalore 560001'), '560001');
    assert.equal(parsePincode('no pin'), '');
  });

  it('parses address with pincode', () => {
    const parsed = parseAddressAndPincode('Flat 12, MG Road, Bangalore 560001');
    assert.equal(parsed.pincode, '560001');
    assert.match(parsed.address, /MG Road/i);
  });

  it('resolves AWB from order tracking number', () => {
    assert.equal(resolveAwb({ trackingNumber: 'SR123456789' }), 'SR123456789');
    assert.equal(resolveAwb({ shiprocketOrderId: '999' }), '999');
    assert.equal(resolveAwb({}), '');
  });

  it('requires shiprocket partner + credentials for auto push', () => {
    assert.equal(
      canAutoPushToShiprocket({
        logisticsPartner: 'shiprocket',
        rtoProtection: { enableNdrAutoPush: true },
        logisticsIntegration: {
          shiprocketApiEmail: 'a@b.com',
          shiprocketApiPasswordEnc: 'enc:xxx',
        },
      }),
      true
    );
    assert.equal(
      canAutoPushToShiprocket({
        logisticsPartner: 'nimbuspost',
        logisticsIntegration: {
          shiprocketApiEmail: 'a@b.com',
          shiprocketApiPasswordEnc: 'enc:xxx',
        },
      }),
      false
    );
    assert.equal(
      canAutoPushToShiprocket({
        logisticsPartner: 'shiprocket',
        rtoProtection: { enableNdrAutoPush: false },
        logisticsIntegration: {
          shiprocketApiEmail: 'a@b.com',
          shiprocketApiPasswordEnc: 'enc:xxx',
        },
      }),
      false
    );
  });
});
