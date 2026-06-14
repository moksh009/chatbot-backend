'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { predictRecoveryValue } = require('../../utils/commerce/cartRecoveryPrediction');

test('predictRecoveryValue scales cart value by step probability', () => {
  assert.equal(predictRecoveryValue(1000, 0), 50);
  assert.equal(predictRecoveryValue(1000, 1), 120);
  assert.equal(predictRecoveryValue(1000, 2), 180);
  assert.equal(predictRecoveryValue(1000, 3), 250);
});

test('predictRecoveryValue clamps invalid inputs', () => {
  assert.equal(predictRecoveryValue(-100, 1), 0);
  assert.equal(predictRecoveryValue(1000, 99), 250);
});
