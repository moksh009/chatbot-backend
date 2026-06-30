'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkKeywordMatch,
  intentTriggerMatches,
  getTriggerConfigFromNode,
  findKeywordTriggerEntry,
} = require('../../utils/flow/triggerEngine');

test('checkKeywordMatch contains is case-insensitive', () => {
  assert.equal(checkKeywordMatch('I want PRICE list', 'price', 'contains'), true);
  assert.equal(checkKeywordMatch('random message', 'price', 'contains'), false);
});

test('checkKeywordMatch exact requires full message', () => {
  assert.equal(checkKeywordMatch('hi', 'hi', 'exact'), true);
  assert.equal(checkKeywordMatch('hi there', 'hi', 'exact'), false);
});

test('getTriggerConfigFromNode reads nested trigger keywords', () => {
  const cfg = getTriggerConfigFromNode({
    type: 'trigger',
    data: {
      trigger: {
        type: 'keyword',
        keywords: ['buy', 'price'],
        matchMode: 'contains',
      },
    },
  });
  assert.equal(cfg.type, 'keyword');
  assert.deepEqual(cfg.keywords, ['buy', 'price']);
  assert.equal(cfg.matchMode, 'contains');
});

test('getTriggerConfigFromNode supports multi-intent', () => {
  const cfg = getTriggerConfigFromNode({
    type: 'trigger',
    data: {
      triggerType: 'intent_match',
      trigger: {
        type: 'intent_match',
        intentIds: ['id1', 'id2'],
        intentNames: ['refund', 'track_order'],
      },
    },
  });
  assert.equal(cfg.type, 'intent_match');
  assert.deepEqual(cfg.intentIds, ['id1', 'id2']);
  assert.deepEqual(cfg.intentNames, ['refund', 'track_order']);
});

test('intentTriggerMatches any intent when lists empty', () => {
  const trigger = { type: 'intent_match', intentIds: [], intentNames: [] };
  assert.equal(
    intentTriggerMatches(trigger, { detectedIntentName: 'refund' }),
    true
  );
  assert.equal(intentTriggerMatches(trigger, {}), false);
});

test('intentTriggerMatches selected intents only', () => {
  const trigger = {
    type: 'intent_match',
    intentIds: ['id1'],
    intentNames: ['refund'],
  };
  assert.equal(
    intentTriggerMatches(trigger, { detectedIntentId: 'id1' }),
    true
  );
  assert.equal(
    intentTriggerMatches(trigger, { detectedIntentName: 'refund' }),
    true
  );
  assert.equal(
    intentTriggerMatches(trigger, { detectedIntentId: 'id2' }),
    false
  );
});

test('findKeywordTriggerEntry respects contains mode', () => {
  const nodes = [
    {
      id: 't1',
      type: 'trigger',
      data: {
        trigger: { type: 'keyword', keywords: ['price'], matchMode: 'contains' },
      },
    },
  ];
  const edges = [{ source: 't1', target: 'n2' }];
  const hit = findKeywordTriggerEntry('show me the price', nodes, edges);
  assert.equal(hit?.startNodeId, 'n2');
  const miss = findKeywordTriggerEntry('hello random', nodes, edges);
  assert.equal(miss, null);
});

test('findKeywordTriggerEntry returns null when keywords empty', () => {
  const nodes = [
    {
      id: 't1',
      type: 'trigger',
      data: { trigger: { type: 'keyword', keywords: [] } },
    },
  ];
  const edges = [{ source: 't1', target: 'n2' }];
  assert.equal(findKeywordTriggerEntry('price', nodes, edges), null);
});
