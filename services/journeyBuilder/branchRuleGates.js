'use strict';

/**
 * Branch rule → compile-time condition gates + merchant-facing path labels.
 * Mirror FE `branchRuleGates.js`.
 */

const BRANCH_RULE_KEYS = Object.freeze({
  ALWAYS: 'reply:always',
  NO_REPLY: 'reply:no_reply',
  REPLIED: 'reply:replied',
  COD: 'order:COD order only',
  PREPAID: 'order:Prepaid order only',
  ORDER_VALUE: 'order:Order value > ₹1000',
  FIRST_TIME: 'order:First time customer',
  RETURNING: 'order:Returning customer',
  SPECIFIC_PRODUCT: 'order:Specific product',
});

function resolveBranchRuleKey(nodeData = {}) {
  if (nodeData.splitOn) {
    const splitOn = String(nodeData.splitOn).trim();
    if (splitOn === 'Order value > ₹1,000') return BRANCH_RULE_KEYS.ORDER_VALUE;
    if (splitOn === 'Specific product') return BRANCH_RULE_KEYS.SPECIFIC_PRODUCT;
    return `order:${splitOn}`;
  }
  if (nodeData.condition === 'no_reply') return BRANCH_RULE_KEYS.NO_REPLY;
  if (nodeData.condition === 'replied') return BRANCH_RULE_KEYS.REPLIED;
  return BRANCH_RULE_KEYS.ALWAYS;
}

function specificProductGate(nodeData = {}) {
  const ids = Array.isArray(nodeData.splitValue) ? nodeData.splitValue.filter(Boolean) : [];
  if (!ids.length) return 'specific_product';
  return `specific_product:${ids.join(',')}`;
}

/**
 * @returns {{ yesGate: string, noGate: string, isPassthrough: boolean, ruleKey: string }}
 */
function branchRuleToGates(nodeData = {}) {
  const ruleKey = resolveBranchRuleKey(nodeData);

  if (ruleKey === BRANCH_RULE_KEYS.ALWAYS) {
    return { yesGate: '', noGate: '', isPassthrough: true, ruleKey };
  }

  if (ruleKey === BRANCH_RULE_KEYS.NO_REPLY) {
    return { yesGate: 'no_reply', noGate: 'replied', isPassthrough: false, ruleKey };
  }
  if (ruleKey === BRANCH_RULE_KEYS.REPLIED) {
    return { yesGate: 'replied', noGate: 'no_reply', isPassthrough: false, ruleKey };
  }
  if (ruleKey === BRANCH_RULE_KEYS.COD) {
    return { yesGate: 'cod_order', noGate: 'not_cod_order', isPassthrough: false, ruleKey };
  }
  if (ruleKey === BRANCH_RULE_KEYS.PREPAID) {
    return { yesGate: 'prepaid_order', noGate: 'not_prepaid_order', isPassthrough: false, ruleKey };
  }
  if (ruleKey === BRANCH_RULE_KEYS.ORDER_VALUE) {
    return {
      yesGate: 'order_value_gt_1000',
      noGate: 'not_order_value_gt_1000',
      isPassthrough: false,
      ruleKey,
    };
  }
  if (ruleKey === BRANCH_RULE_KEYS.FIRST_TIME) {
    return {
      yesGate: 'first_time_customer',
      noGate: 'not_first_time_customer',
      isPassthrough: false,
      ruleKey,
    };
  }
  if (ruleKey === BRANCH_RULE_KEYS.RETURNING) {
    return {
      yesGate: 'returning_customer',
      noGate: 'not_returning_customer',
      isPassthrough: false,
      ruleKey,
    };
  }
  if (ruleKey === BRANCH_RULE_KEYS.SPECIFIC_PRODUCT) {
    const gate = specificProductGate(nodeData);
    return { yesGate: gate, noGate: `not_${gate}`, isPassthrough: false, ruleKey };
  }

  return { yesGate: '', noGate: '', isPassthrough: true, ruleKey };
}

const PATH_LABELS = Object.freeze({
  [BRANCH_RULE_KEYS.ALWAYS]: { yes: 'Path A', no: 'Path B' },
  [BRANCH_RULE_KEYS.NO_REPLY]: { yes: 'No reply', no: 'Replied' },
  [BRANCH_RULE_KEYS.REPLIED]: { yes: 'Replied', no: 'No reply' },
  [BRANCH_RULE_KEYS.COD]: { yes: 'COD', no: 'Not COD' },
  [BRANCH_RULE_KEYS.PREPAID]: { yes: 'Prepaid', no: 'Not prepaid' },
  [BRANCH_RULE_KEYS.ORDER_VALUE]: { yes: 'Over ₹1,000', no: 'Under ₹1,000' },
  [BRANCH_RULE_KEYS.FIRST_TIME]: { yes: 'First order', no: 'Returning' },
  [BRANCH_RULE_KEYS.RETURNING]: { yes: 'Returning', no: 'First order' },
  [BRANCH_RULE_KEYS.SPECIFIC_PRODUCT]: { yes: 'Has product', no: 'No match' },
});

function getBranchPathLabels(nodeData = {}) {
  const ruleKey = resolveBranchRuleKey(nodeData);
  return PATH_LABELS[ruleKey] || { yes: 'Yes', no: 'No' };
}

function branchRuleSummary(nodeData = {}) {
  if (nodeData.splitOn) return String(nodeData.splitOn).trim();
  const cond = nodeData.condition;
  const labels = {
    no_reply: 'Does not reply',
    replied: 'Replies',
    '': 'Always continue',
  };
  if (cond != null && cond in labels) return labels[cond];
  return 'Set branch rule';
}

module.exports = {
  BRANCH_RULE_KEYS,
  resolveBranchRuleKey,
  branchRuleToGates,
  getBranchPathLabels,
  branchRuleSummary,
};
