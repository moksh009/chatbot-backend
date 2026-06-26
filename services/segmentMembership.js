'use strict';

const Segment = require('../models/Segment');
const { translateConditionsToQuery: translateTreeQuery } = require('./SegmentQueryBuilderV2');
const { ensureConditionTree } = require('../utils/segmentConditionUtils');
const { leadMatchesUnifiedSegment } = require('./segmentAudienceEvaluation');

function compileSegmentQuery(segment) {
  if (segment?.query && typeof segment.query === 'object' && Object.keys(segment.query).length) {
    return segment.query;
  }
  const tree = ensureConditionTree(segment || {});
  return translateTreeQuery(tree);
}

/**
 * Check whether a lead matches an Audience Hub saved segment (unified evaluator).
 */
async function leadMatchesAudienceSegment(clientId, lead, segmentId) {
  return leadMatchesUnifiedSegment(clientId, lead, segmentId);
}

module.exports = {
  leadMatchesAudienceSegment,
  compileSegmentQuery,
};
