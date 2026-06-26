'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validatePrizeProbabilities,
  pickWeightedPrize,
  claimPrizeCoupon,
} = require('../../services/optInPrizeService');

const PRIZES = [
  { label: '10% off', couponMode: 'unique', probability: 40, discountValue: 10, autoCreateOnShopify: false },
  { label: 'FREESHIP', couponMode: 'fixed', couponCode: 'FREESHIP', probability: 30 },
  { label: 'Lose', couponMode: 'lose', probability: 30 },
];

describe('optInPrizeService', () => {
  it('validatePrizeProbabilities requires sum 100', () => {
    assert.equal(validatePrizeProbabilities(PRIZES).valid, true);
    const bad = validatePrizeProbabilities([{ probability: 50 }, { probability: 40 }]);
    assert.equal(bad.valid, false);
    assert.equal(bad.sum, 90);
  });

  it('pickWeightedPrize respects random roll', () => {
    const r1 = pickWeightedPrize(PRIZES, 0.1);
    assert.equal(r1.index, 0);
    assert.equal(r1.prize.label, '10% off');
    const r2 = pickWeightedPrize(PRIZES, 0.75);
    assert.equal(r2.index, 2);
    assert.equal(r2.prize.couponMode, 'lose');
  });

  it('claimPrizeCoupon returns fixed code', async () => {
    const res = await claimPrizeCoupon('tenant', { id: 't1' }, PRIZES[1]);
    assert.equal(res.code, 'FREESHIP');
    assert.equal(res.isLose, false);
  });

  it('claimPrizeCoupon handles lose slice', async () => {
    const res = await claimPrizeCoupon('tenant', { id: 't1' }, PRIZES[2]);
    assert.equal(res.isLose, true);
    assert.equal(res.code, '');
  });
});
