'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCustomerScoreDetailed } = require('../services/ScoreEvaluationService');
const { buildWaterfallScoreBreakdown } = require('../utils/core/waterfallScoreBreakdown');
const ScoreTierConfig = require('../models/ScoreTierConfig');

test('waterfall breakdown — tier match and persisted shape', () => {
  const lead = {
    inboundMessageCount: 5,
    ordersCount: 2,
    totalSpent: 5000,
    checkoutInitiatedCount: 1,
  };
  const tierConfig = ScoreTierConfig.getDefaultConfig('test_client');
  const evaluation = evaluateCustomerScoreDetailed(lead, tierConfig);
  const breakdown = buildWaterfallScoreBreakdown(lead, evaluation);

  assert.equal(breakdown.engine, 'waterfall');
  assert.ok(typeof breakdown.totalCapped === 'number');
  assert.ok(Array.isArray(breakdown.tier_conditions));
  assert.ok(breakdown.tier_label);
});
