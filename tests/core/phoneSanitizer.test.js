'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  repairPhoneDigits,
  unwrapUsFromIndianPrefix,
  pickCanonicalPhone,
  isCorruptedPhoneStorage,
} = require('../../utils/core/phoneSanitizer');
const { normalizePhone, formatPhoneForDisplay } = require('../../utils/core/helpers');

describe('phoneSanitizer', () => {
  it('unwraps 91 prefixed US Shopify test numbers', () => {
    assert.equal(unwrapUsFromIndianPrefix('9116135550135'), '16135550135');
    assert.equal(repairPhoneDigits('9116135550135', 'IN'), '16135550135');
  });

  it('rejects 15-digit garbage — extracts embedded mobile if present', () => {
    assert.equal(repairPhoneDigits('911781436906893', 'IN'), '917814369068');
  });

  it('normalizes valid Indian numbers', () => {
    assert.equal(repairPhoneDigits('9313045439', 'IN'), '919313045439');
    assert.equal(repairPhoneDigits('+919313045439', 'IN'), '919313045439');
  });

  it('pickCanonicalPhone prefers Shopify over corrupted lead', () => {
    const picked = pickCanonicalPhone(['919313045439', '911781436906893'], { country: 'IN' });
    assert.equal(picked, '919313045439');
  });

  it('normalizePhone no longer passes through 15-digit strings', () => {
    assert.equal(normalizePhone('911781436906893', 'IN'), '917814369068');
    assert.equal(normalizePhone('9116135550135', 'IN'), '16135550135');
  });

  it('formatPhoneForDisplay returns formatted Indian mobile or null', () => {
    assert.equal(formatPhoneForDisplay('9313045439', 'IN'), '9313045439');
    assert.equal(formatPhoneForDisplay('not-a-phone', 'IN'), null);
  });

  it('flags corrupted storage', () => {
    assert.equal(isCorruptedPhoneStorage('9116135550135'), true);
    assert.equal(isCorruptedPhoneStorage('+919313045439'), false);
  });
});
