/**
 * Routing Engine Evaluator
 * Evaluates a list of routing rules to determine which agent should be assigned to a conversation.
 */

const evaluateCondition = (condition, context) => {
    const { field, operator, value } = condition;
    let actualValue = context[field];

    if (actualValue === undefined) return false;

    switch (operator) {
        case 'equals': return String(actualValue).toLowerCase() === String(value).toLowerCase();
        case 'not_equals': return String(actualValue).toLowerCase() !== String(value).toLowerCase();
        case 'contains': return String(actualValue).toLowerCase().includes(String(value).toLowerCase());
        case 'not_contains': return !String(actualValue).toLowerCase().includes(String(value).toLowerCase());
        case 'greater_than': return Number(actualValue) > Number(value);
        case 'less_than': return Number(actualValue) < Number(value);
        default: return false;
    }
};

/**
 * Evaluates routing rules to find the most appropriate agent or routing strategy.
 * @param {Array} rules Array of routing rules
 * @param {Object} context Context dictionary containing lead, convo info
 * @returns {Object|null} Routing directive e.g. { agentId: 'XYZ', type: 'round_robin', agentIds: [...] }
 */
const evaluateRouting = (rules, context) => {
    if (!rules || !Array.isArray(rules) || rules.length === 0) return null;

    // Sort by priority (lowest number = highest priority)
    const activeRules = rules.sort((a, b) => (a.priority || 10) - (b.priority || 10));

    for (const rule of activeRules) {
        let conditionsMatch = true;
        if (rule.conditions && Array.isArray(rule.conditions) && rule.conditions.length > 0) {
            conditionsMatch = rule.conditions.every(cond => evaluateCondition(cond, context));
        }

        if (conditionsMatch) {
            if (rule.routeType === 'specific_agent') {
                return { type: 'specific', agentId: rule.fallbackAgentId };
            } else if (rule.routeType === 'round_robin') {
                return { type: 'round_robin', agentIds: rule.agentIds };
            } else if (rule.routeType === 'escalate') {
                return { type: 'escalate' };
            }
        }
    }

    return null; // Fallback to default manual/hybrid handoff
};

module.exports = {
    evaluateRouting
};
