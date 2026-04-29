const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const log = require('../utils/logger')('ProductTriggers');

/**
 * Product Trigger Schema (stored in Client.productTriggers[]):
 * {
 *   id: String (UUID),
 *   name: String,
 *   isActive: Boolean,
 *   matchType: 'sku' | 'product_id' | 'collection',
 *   matchValue: String,
 *   action: {
 *     type: 'immediate_template' | 'enroll_sequence',
 *     templateName: String,
 *     sequenceTemplateId: String,
 *     variables: [String],
 *     delayMinutes: Number
 *   },
 *   createdAt: Date
 * }
 */

// GET all product triggers
router.get('/:clientId', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId }).select('productTriggers');
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        res.json({ success: true, triggers: client.productTriggers || [] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// POST create a new product trigger
router.post('/:clientId', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const { name, matchType, matchValue, action } = req.body;

        if (!matchType || !matchValue || !action?.type) {
            return res.status(400).json({ success: false, message: 'matchType, matchValue, and action.type are required' });
        }

        const trigger = {
            id: uuidv4(),
            name: name || `Trigger: ${matchValue}`,
            isActive: true,
            matchType,
            matchValue,
            action: {
                type: action.type,
                templateName: action.templateName || '',
                sequenceTemplateId: action.sequenceTemplateId || '',
                variables: action.variables || [],
                delayMinutes: action.delayMinutes || 0
            },
            createdAt: new Date()
        };

        const client = await Client.findOneAndUpdate(
            { clientId },
            { $push: { productTriggers: trigger } },
            { new: true }
        ).select('productTriggers');

        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        log.info(`[ProductTrigger] Created trigger "${trigger.name}" for ${clientId} | ${matchType}=${matchValue}`);
        res.json({ success: true, trigger, triggers: client.productTriggers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT update a trigger
router.put('/:clientId/:triggerId', protect, async (req, res) => {
    try {
        const { clientId, triggerId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        let updated = false;
        client.productTriggers = (client.productTriggers || []).map(t => {
            if (t.id === triggerId) {
                updated = true;
                return {
                    ...t,
                    name: req.body.name || t.name,
                    matchType: req.body.matchType || t.matchType,
                    matchValue: req.body.matchValue || t.matchValue,
                    isActive: req.body.isActive !== undefined ? req.body.isActive : t.isActive,
                    action: req.body.action || t.action
                };
            }
            return t;
        });

        if (!updated) return res.status(404).json({ success: false, message: 'Trigger not found' });

        await client.save();
        res.json({ success: true, triggers: client.productTriggers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// PATCH toggle trigger active/inactive
router.patch('/:clientId/:triggerId/toggle', protect, async (req, res) => {
    try {
        const { clientId, triggerId } = req.params;
        const { isActive } = req.body;

        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        let updated = false;
        client.productTriggers = (client.productTriggers || []).map(t => {
            if (t.id === triggerId) {
                updated = true;
                return { ...t, isActive: !!isActive };
            }
            return t;
        });

        if (!updated) return res.status(404).json({ success: false, message: 'Trigger not found' });

        await client.save();
        res.json({ success: true, triggers: client.productTriggers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// DELETE a trigger
router.delete('/:clientId/:triggerId', protect, async (req, res) => {
    try {
        const { clientId, triggerId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const before = (client.productTriggers || []).length;
        client.productTriggers = (client.productTriggers || []).filter(t => t.id !== triggerId);

        if (client.productTriggers.length === before) {
            return res.status(404).json({ success: false, message: 'Trigger not found' });
        }

        await client.save();
        log.info(`[ProductTrigger] Deleted trigger ${triggerId} for ${clientId}`);
        res.json({ success: true, triggers: client.productTriggers });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * Evaluates product triggers against a Shopify order's line items.
 * Called from shopifyWebhook.js after order processing.
 * 
 * @param {Object} client - Client document
 * @param {Object} order - Shopify order object
 * @returns {Array} Array of { trigger, lineItem } matches
 */
async function evaluateProductTriggers(client, order) {
    const triggers = (client.productTriggers || []).filter(t => t.isActive);
    if (triggers.length === 0) return [];

    const lineItems = order.line_items || [];
    const matches = [];

    for (const item of lineItems) {
        for (const trigger of triggers) {
            let matched = false;

            if (trigger.matchType === 'sku' && item.sku) {
                matched = item.sku.toLowerCase() === trigger.matchValue.toLowerCase();
            } else if (trigger.matchType === 'product_id') {
                matched = String(item.product_id) === String(trigger.matchValue);
            } else if (trigger.matchType === 'collection') {
                // Collection matching requires product tags or collection data
                matched = (item.properties || []).some(p => 
                    p.name === 'collection' && p.value.toLowerCase() === trigger.matchValue.toLowerCase()
                );
            }

            if (matched) {
                matches.push({ trigger, lineItem: item });
            }
        }
    }

    return matches;
}

/**
 * Executes matched product triggers by sending templates or enrolling in sequences.
 * 
 * @param {Object} client - Client document
 * @param {string} customerPhone - Customer phone number
 * @param {string} customerName - Customer name
 * @param {Array} matches - Array of { trigger, lineItem } from evaluateProductTriggers
 */
async function executeProductTriggers(client, customerPhone, customerName, matches) {
    const WhatsApp = require('../utils/whatsapp');
    const FollowUpSequence = require('../models/FollowUpSequence');
    const SEQUENCE_TEMPLATES = require('../data/sequenceTemplates');
    const moment = require('moment');

    for (const { trigger, lineItem } of matches) {
        try {
            if (trigger.action.type === 'immediate_template') {
                // Send template immediately
                const variables = [
                    customerName || 'Customer',
                    lineItem.title || lineItem.name || 'your product',
                    ...(trigger.action.variables || [])
                ];

                await WhatsApp.sendSmartTemplate(
                    client,
                    customerPhone,
                    trigger.action.templateName,
                    variables,
                    null,
                    client.languageCode || 'en'
                );

                log.info(`[ProductTrigger] ✅ Sent template "${trigger.action.templateName}" to ${customerPhone} for SKU=${lineItem.sku}`);

            } else if (trigger.action.type === 'enroll_sequence') {
                // Enroll in a follow-up sequence
                const template = SEQUENCE_TEMPLATES.find(t => t.id === trigger.action.sequenceTemplateId);
                const delayMinutes = trigger.action.delayMinutes || 0;

                let currentSendAt = moment().add(delayMinutes, 'minutes');
                const steps = template ? template.steps.map(s => {
                    currentSendAt = currentSendAt.add(s.delayValue || 0, s.delayUnit || 'm');
                    return {
                        type: s.type || 'whatsapp',
                        templateName: s.templateName,
                        content: s.content,
                        delayValue: s.delayValue,
                        delayUnit: s.delayUnit,
                        sendAt: currentSendAt.toDate(),
                        status: 'pending'
                    };
                }) : [{
                    type: 'whatsapp',
                    templateName: trigger.action.templateName,
                    sendAt: currentSendAt.toDate(),
                    status: 'pending'
                }];

                await FollowUpSequence.create({
                    clientId: client.clientId,
                    phone: customerPhone,
                    name: `Product Trigger: ${trigger.name} (${lineItem.title || lineItem.sku})`,
                    type: 'custom',
                    status: 'active',
                    steps
                });

                log.info(`[ProductTrigger] ✅ Enrolled ${customerPhone} in sequence for trigger "${trigger.name}"`);
            }
        } catch (err) {
            log.error(`[ProductTrigger] ❌ Failed to execute trigger "${trigger.name}" for ${customerPhone}:`, err.message);
        }
    }
}

module.exports = router;
module.exports.evaluateProductTriggers = evaluateProductTriggers;
module.exports.executeProductTriggers = executeProductTriggers;
