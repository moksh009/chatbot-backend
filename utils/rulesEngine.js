const moment = require('moment');

/**
 * Rules Engine Evaluator
 * Evaluates a list of automation rules against the current incoming context.
 */

// Evaluate if a single condition is met
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
        case 'in_list': return Array.isArray(value) ? value.includes(actualValue) : String(value).split(',').map(s=>s.trim()).includes(String(actualValue));
        case 'is_empty': return !actualValue || actualValue.length === 0;
        case 'not_empty': return !!actualValue && actualValue.length > 0;
        default: return false;
    }
};

// Evaluate the trigger logic
const evaluateTrigger = (trigger, messageText, context) => {
    const { type, keywords, matchType } = trigger;

    if (type === 'all_messages') return true;

    if (type === 'keyword') {
        if (!messageText) return false;
        const textStr = messageText.toLowerCase().trim();
        const kws = Array.isArray(keywords) ? keywords : String(keywords || '').split(',').map(k => k.trim().toLowerCase());
        
        if (matchType === 'exact') {
            return kws.includes(textStr);
        } else if (matchType === 'contains') {
            return kws.some(kw => textStr.includes(kw));
        }
    }

    if (type === 'first_message') {
        // Prefer count supplied by dualBrainEngine (Message collection). The flat
        // variableContext from buildVariableContext does not include convo.messages,
        // so the old check was always 0 and treated every inbound as "first".
        if (typeof context._inboundCountPostSave === 'number' && context._inboundCountPostSave > 0) {
            return context._inboundCountPostSave === 1;
        }
        const historyCount = context.convo?.messages?.length || 0;
        return historyCount <= 1;
    }

    return false;
};

/**
 * Evaluate all active rules for a client against an incoming message.
 * Returns the actions of the FIRST matching rule (highest priority).
 * 
 * @param {Array} rules Array of rule objects from Client.automationRules
 * @param {String} messageText The incoming message text
 * @param {Object} evalContext Context dictionary containing lead, convo, cart info
 * @returns {Array|null} Array of actions to take, or null if no match
 */
const evaluateRules = (rules, messageText, evalContext) => {
    const rule = findMatchingRule(rules, messageText, evalContext);
    return rule ? rule.actions : null;
};

/**
 * Returns the first matching automation rule (full object), or null.
 * Used by DualBrain to run actions in order and honor continueToFlowAfterActions.
 */
const findMatchingRule = (rules, messageText, evalContext) => {
    if (!rules || !Array.isArray(rules) || rules.length === 0) return null;

    const activeRules = rules.filter(r => r.isActive).sort((a, b) => (a.priority || 10) - (b.priority || 10));

    for (const rule of activeRules) {
        const triggerMatch = evaluateTrigger(rule.trigger, messageText, evalContext);
        if (!triggerMatch) continue;

        let conditionsMatch = true;
        if (rule.conditions && Array.isArray(rule.conditions) && rule.conditions.length > 0) {
            conditionsMatch = rule.conditions.every(cond => evaluateCondition(cond, evalContext));
        }

        if (conditionsMatch) {
            console.log(`[RulesEngine] Match found: ${rule.name}`);
            return rule;
        }
    }

    return null;
};

/**
 * Run the specified actions (side-effects or return execution directives)
 */
const executeRuleActions = async (actions, client, phone, dependencies) => {
    // dependencies: { WhatsApp, AdLead, FollowUpSequence, etc }
    const results = {
        messages: [],
        handoff: null, // e.g. { type: 'ROUND_ROBIN' }
        tags: [],
        enrollSequences: [],
        webhooks: [],
        scoreAdjustments: 0
    };

    if (!actions || !Array.isArray(actions)) return results;

    for (const action of actions) {
        try {
            switch (action.type) {
                case 'send_message':
                    results.messages.push(action.text);
                    break;
                case 'send_template':
                    results.messages.push(`[TEMPLATE] ${action.templateName}`);
                    // Note: Actual injection/sending logic should be handled by caller by using WhatsApp.sendSmartTemplate
                    break;
                case 'assign_agent':
                    results.handoff = action.agentId; // Or 'round_robin'
                    break;
                case 'add_tag':
                    results.tags.push(action.tag);
                    break;
                case 'enroll_sequence':
                    results.enrollSequences.push(action.sequenceId);
                    break;
                case 'pause_bot':
                    results.pauseBot = true;
                    break;
                case 'execute_webhook':
                    results.webhooks.push(action.webhookUrl);
                    break;
                case 'adjust_score':
                    results.scoreAdjustments += (action.score || 0);
                    break;
            }
        } catch (err) {
            console.error('[RulesEngine] Action err:', err);
        }
    }

    return results;
};

module.exports = {
    evaluateRules,
    executeRuleActions,
    findMatchingRule,
};
