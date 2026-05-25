'use strict';

const assert = require('assert');

function testSentimentModule() {
  const mod = require('../../services/sentiment/runSentimentScoring');
  assert.ok(typeof mod.runSentimentScoring === 'function');
}

function testLeadScoringBreakdown() {
  const { buildBreakdown, DEFAULT_WEIGHTS } = require('../../utils/commerce/leadScoringService');
  const b = buildBreakdown(
    {
      inboundMessageCount: 5,
      linkClicks: 1,
      addToCartCount: 1,
      checkoutInitiatedCount: 0,
      appointmentsBooked: 0,
      sentimentScore: 85,
      tags: [],
      lastActivityAt: new Date(),
    },
    DEFAULT_WEIGHTS
  );
  assert.ok(b.totalCapped >= 0);
  assert.ok(b.sentiment_bonus.points === 10);
}

function testProductIntent() {
  const { detectProductIntent } = require('../../utils/commerce/liveProductLookup');
  const r = detectProductIntent('what is the price of blue shirt');
  assert.ok(r && r.type === 'price_check');
}

function testTrainingRetrieval() {
  const { buildTrainingFewShot } = require('../../utils/core/trainingCaseRetrieval');
  const s = buildTrainingFewShot([{ userMessage: 'hi', agentCorrection: 'hello' }]);
  assert.ok(s.includes('TRAINING'));
}

async function main() {
  testSentimentModule();
  testLeadScoringBreakdown();
  testProductIntent();
  testTrainingRetrieval();
  console.log('✓ phase6IntelligenceSmoke passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
