'use strict';

const { flatConditionsToTree } = require('../utils/segmentConditionUtils');
const { translateConditionsToQuery: translateTreeQuery } = require('./SegmentQueryBuilderV2');

/** Legacy flat AND translator — delegates to V2 tree compiler. */
function translateConditionsToQuery(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return {};
  return translateTreeQuery(flatConditionsToTree(conditions));
}

module.exports = { translateConditionsToQuery };
