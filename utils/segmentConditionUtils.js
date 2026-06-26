'use strict';

const {
  inferRuleKind,
  RULE_KINDS,
  getCatalogEntryByAssetId,
  PROPERTY_BY_ID,
  BEHAVIOR_BY_ID,
} = require('../constants/segmentRuleCatalog');

const MAX_TREE_DEPTH = 3;
const MAX_RULE_COUNT = 25;

function isGroupNode(node) {
  return Boolean(node && node.type === 'group');
}

function groupChildren(node) {
  return Array.isArray(node?.children) ? node.children : [];
}

function isRuleNode(node) {
  if (!node || node.type === 'group') return false;
  if (node.ruleKind === RULE_KINDS.SEGMENT_MEMBERSHIP || node.segmentId) return true;
  if (node.ruleKind === RULE_KINDS.BEHAVIOR || node.behaviorId) return true;
  if (node.ruleKind === RULE_KINDS.PROPERTY) return true;
  return Boolean(node.assetId);
}

function normalizeRuleNode(rule = {}) {
  const ruleKind = inferRuleKind(rule);

  if (ruleKind === RULE_KINDS.SEGMENT_MEMBERSHIP) {
    return {
      type: 'rule',
      ruleKind: RULE_KINDS.SEGMENT_MEMBERSHIP,
      segmentId: String(rule.segmentId || '').trim(),
      membershipOperator: rule.membershipOperator === 'not_in' ? 'not_in' : 'in',
    };
  }

  let assetId = String(rule.assetId || '').trim();
  let behaviorId = rule.behaviorId ? String(rule.behaviorId).trim() : null;

  if (ruleKind === RULE_KINDS.BEHAVIOR && behaviorId && BEHAVIOR_BY_ID[behaviorId]) {
    assetId = BEHAVIOR_BY_ID[behaviorId].assetId;
  }

  const entry = getCatalogEntryByAssetId(assetId);
  const normalized = {
    type: 'rule',
    ruleKind: ruleKind === RULE_KINDS.BEHAVIOR ? RULE_KINDS.BEHAVIOR : RULE_KINDS.PROPERTY,
    assetId,
    operator: rule.operator || '>=',
    targetValue: rule.targetValue,
    frequency: rule.frequency || null,
    timeFrame: rule.timeFrame || 'all_time',
    timeValue: rule.timeValue ?? '',
    timeValueEnd: rule.timeValueEnd ?? '',
    textOperator: rule.textOperator || null,
    targetValueEnd: rule.targetValueEnd ?? null,
  };

  if (behaviorId) normalized.behaviorId = behaviorId;

  if (entry?.valueType === 'text' && !normalized.textOperator) {
    normalized.textOperator = 'contains';
    normalized.operator = 'text';
  }

  if (ruleKind === RULE_KINDS.BEHAVIOR && behaviorId && BEHAVIOR_BY_ID[behaviorId]?.fixedTargetValue) {
    normalized.targetValue = BEHAVIOR_BY_ID[behaviorId].fixedTargetValue;
    normalized.operator = '===';
    normalized.frequency = null;
    normalized.timeFrame = 'all_time';
  }

  return normalized;
}

function isCompleteRule(rule = {}) {
  try {
    const normalized = normalizeRuleNode(rule);
    const kind = normalized.ruleKind;

    if (kind === RULE_KINDS.SEGMENT_MEMBERSHIP) {
      return Boolean(normalized.segmentId);
    }

    if (!normalized.assetId) return false;

    const entry = PROPERTY_BY_ID[normalized.assetId] || getCatalogEntryByAssetId(normalized.assetId);
    if (!entry && !BEHAVIOR_BY_ID[normalized.behaviorId]) return false;

    if (entry?.valueType === 'text') {
      const op = normalized.textOperator || 'contains';
      if (!['is_set', 'is_not_set'].includes(op) && !String(normalized.targetValue ?? '').trim()) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function filterCompleteRulesFromTree(node) {
  if (!node) return null;
  if (isRuleNode(node)) {
    return isCompleteRule(node) ? normalizeRuleNode(node) : null;
  }
  if (!isGroupNode(node)) return null;

  const children = groupChildren(node)
    .map((child) => filterCompleteRulesFromTree(child))
    .filter(Boolean);

  if (!children.length) return null;

  const operator = String(node.operator || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
  return { type: 'group', operator, children };
}

function validateRuleNode(rule) {
  const normalized = normalizeRuleNode(rule);
  const kind = normalized.ruleKind;

  if (kind === RULE_KINDS.SEGMENT_MEMBERSHIP) {
    if (!normalized.segmentId) throw new Error('Segment membership rule requires a segment.');
    return normalized;
  }

  if (!normalized.assetId) throw new Error('Rule requires a property or behavior.');

  const entry = PROPERTY_BY_ID[normalized.assetId] || getCatalogEntryByAssetId(normalized.assetId);
  if (!entry && !BEHAVIOR_BY_ID[normalized.behaviorId]) {
    throw new Error(`Unknown segment field: ${normalized.assetId}`);
  }

  if (entry?.valueType === 'text') {
    const op = normalized.textOperator || 'contains';
    if (!['is_set', 'is_not_set'].includes(op) && !String(normalized.targetValue ?? '').trim()) {
      throw new Error(`${entry.label || normalized.assetId} requires a value.`);
    }
  }

  return normalized;
}

function flatConditionsToTree(conditions = []) {
  const rules = (Array.isArray(conditions) ? conditions : [])
    .filter((c) => c && (c.assetId || c.segmentId || c.ruleKind === RULE_KINDS.SEGMENT_MEMBERSHIP))
    .map((c) => normalizeRuleNode({ type: 'rule', ...c }));
  return {
    type: 'group',
    operator: 'AND',
    children: rules,
  };
}

function countRulesInTree(node, depth = 0) {
  if (!node) return 0;
  if (isRuleNode(node)) return 1;
  if (!isGroupNode(node)) return 0;
  if (depth > MAX_TREE_DEPTH) return MAX_RULE_COUNT + 1;
  return groupChildren(node).reduce(
    (sum, child) => sum + countRulesInTree(child, depth + 1),
    0
  );
}

function flattenRulesFromTree(node, out = []) {
  if (!node) return out;
  if (isRuleNode(node)) {
    const n = normalizeRuleNode(node);
    out.push({ ...n });
    return out;
  }
  if (isGroupNode(node)) {
    for (const child of groupChildren(node)) flattenRulesFromTree(child, out);
  }
  return out;
}

function normalizeGroupNode(node, depth = 0) {
  if (!isGroupNode(node)) return flatConditionsToTree([]);
  const operator = String(node.operator || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
  const children = groupChildren(node)
    .map((child) => {
      if (!child || typeof child !== 'object') return null;
      if (child.type === 'group' && depth < MAX_TREE_DEPTH) {
        return normalizeGroupNode(child, depth + 1);
      }
      if (isRuleNode(child) || child.assetId || child.segmentId || child.ruleKind) {
        return normalizeRuleNode(child);
      }
      return null;
    })
    .filter(Boolean);
  return { type: 'group', operator, children };
}

function resolveSegmentDefinition(payload = {}, { strict = true } = {}) {
  let conditionTree = payload.conditionTree;
  let conditions = Array.isArray(payload.conditions) ? payload.conditions : [];

  if (conditionTree && isGroupNode(conditionTree)) {
    conditionTree = normalizeGroupNode(conditionTree);
    conditions = flattenRulesFromTree(conditionTree);
  } else if (conditions.length) {
    conditionTree = flatConditionsToTree(conditions);
  } else {
    conditionTree = flatConditionsToTree([]);
  }

  const ruleCount = countRulesInTree(conditionTree);
  if (ruleCount > MAX_RULE_COUNT) {
    throw new Error(`Segment cannot have more than ${MAX_RULE_COUNT} rules.`);
  }

  if (strict) {
    for (const rule of conditions) {
      validateRuleNode(rule);
    }
  } else {
    conditions = conditions.filter((rule) => isCompleteRule(rule));
    conditionTree = filterCompleteRulesFromTree(conditionTree) || flatConditionsToTree([]);
  }

  return { conditionTree, conditions };
}

function resolveSegmentDefinitionForPreview(payload = {}) {
  return resolveSegmentDefinition(payload, { strict: false });
}

function ensureConditionTree(segment = {}) {
  if (segment.conditionTree && isGroupNode(segment.conditionTree)) {
    return normalizeGroupNode(segment.conditionTree);
  }
  if (Array.isArray(segment.conditions) && segment.conditions.length) {
    return flatConditionsToTree(segment.conditions);
  }
  return flatConditionsToTree([]);
}

function serializeSegment(segment = {}) {
  const conditionTree = ensureConditionTree(segment);
  return {
    ...segment,
    conditionTree,
    conditions: flattenRulesFromTree(conditionTree),
  };
}

module.exports = {
  MAX_TREE_DEPTH,
  MAX_RULE_COUNT,
  RULE_KINDS,
  flatConditionsToTree,
  flattenRulesFromTree,
  normalizeGroupNode,
  normalizeRuleNode,
  validateRuleNode,
  isCompleteRule,
  filterCompleteRulesFromTree,
  resolveSegmentDefinition,
  resolveSegmentDefinitionForPreview,
  ensureConditionTree,
  serializeSegment,
  isGroupNode,
  isRuleNode,
  inferRuleKind,
  groupChildren,
};
