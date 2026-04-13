const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const _ = require('lodash');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const ImportSession = require('../models/ImportSession');
const { protect } = require('../middleware/auth');
const { logAction } = require('../middleware/audit');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const TaskQueueService = require('../services/TaskQueueService');
const path = require('path');

// Multer setup for temporary CSV storage
const upload = multer({ dest: '/tmp/csv_uploads/' });

/**
 * Enterprise Cleaner: Phone Normalization
 * Handles: + prefix, stripping non-digits, auto-prefixing country code
 */
const normalizePhone = (phone, defaultCountryCode = '91') => {
    if (!phone) return null;
    let cleaned = String(phone).replace(/\D/g, '');
    
    // Auto-fix 10-digit numbers for common regions (default India)
    if (cleaned.length === 10) {
        cleaned = defaultCountryCode + cleaned;
    }
    
    return cleaned;
};

/**
 * Enterprise Cleaner: Fuzzy Mapping logic
 */
const FUZZY_KEYS = {
    phone: ['ph', 'mob', 'contact', 'whatsapp', 'number', 'tel', 'cell'],
    name: ['first', 'full', 'customer', 'lead', 'client', 'person'],
    email: ['e-mail', 'mail', 'address']
};

const findBestMatch = (headers, target) => {
    const targetKeywords = FUZZY_KEYS[target] || [];
    return headers.find(h => {
        const lowerH = h.toLowerCase();
        return lowerH === target || targetKeywords.some(kw => lowerH.includes(kw));
    });
};

// POST /api/leads/:clientId/import
router.post('/:clientId/import', protect, logAction('IMPORT_LEADS'), upload.single('file'), async (req, res) => {
    const { clientId } = req.params;
    const batchId = `BATCH_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    try {
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             if (req.file) fs.unlinkSync(req.file.path);
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const filename = req.file.originalname;
        const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};
        
        // Ensure imports directory exists
        const importDir = path.join(__dirname, '../uploads/imports');
        if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });

        // Move file to a persistent location for the background worker
        const persistentPath = path.join(importDir, `${batchId}.csv`);
        fs.renameSync(req.file.path, persistentPath);

        // Create an Import Session
        await ImportSession.create({
            clientId,
            batchId,
            filename,
            status: 'processing'
        });

        // Add to Task Queue
        await TaskQueueService.addTask('IMPORT_LEADS', {
            clientId,
            batchId,
            filePath: persistentPath,
            filename,
            mapping,
            user: { id: req.user._id, role: req.user.role }
        });

        // Respond immediately
        res.status(202).json({
            success: true,
            message: 'Import started in background',
            batchId
        });

    } catch (err) {
        console.error('[IMPORT_TRIGGER_ERROR]', err);
        res.status(500).json({ success: false, message: 'Failed to start import' });
    }
});

// POST /api/leads/:clientId/rollback/:batchId
router.post('/:clientId/rollback/:batchId', protect, logAction('ROLLBACK_IMPORT'), async (req, res) => {
    const { clientId, batchId } = req.params;

    try {
        const session = await ImportSession.findOne({ clientId, batchId });
        if (!session) return res.status(404).json({ message: 'Import session not found' });
        
        if (session.status === 'rolled_back') return res.status(400).json({ message: 'Already rolled back' });

        // Logic: Delete leads where meta.lastImportId === batchId AND were NEWly created in this batch
        // We know they were new if they have this batchId in meta.lastImportId.
        // For updated ones, we don't rollback the data (keep it enterprise-safe).
        const result = await AdLead.deleteMany({ 
            clientId, 
            'meta.lastImportId': batchId 
        });

        session.status = 'rolled_back';
        await session.save();

        res.json({
            success: true,
            message: `Rollback complete. ${result.deletedCount} new contacts removed.`,
            deletedCount: result.deletedCount
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Rollback failed' });
    }
});

// GET /api/leads/:clientId/export
router.get('/:clientId/export', protect, logAction('EXPORT_LEADS'), async (req, res) => {

    try {
        const { clientId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const filter = { clientId };
        // Basic filtering query string parsing
        if (req.query.source) filter.source = req.query.source;
        if (req.query.optStatus) filter.optStatus = req.query.optStatus;

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="leads_export_${clientId}_${new Date().toISOString().slice(0,10)}.csv"`);

        const cursor = AdLead.find(filter)
             .select('phoneNumber name email source optStatus totalSpent ordersCount tags createdAt')
             .cursor();

        const stringifier = stringify({
             header: true,
             columns: [
                 { key: 'phoneNumber', header: 'Phone Number' },
                 { key: 'name', header: 'Name' },
                 { key: 'email', header: 'Email' },
                 { key: 'source', header: 'Source' },
                 { key: 'optStatus', header: 'Opt Status' },
                 { key: 'totalSpent', header: 'Total Spent' },
                 { key: 'ordersCount', header: 'Orders Count' },
                 { key: 'tags', header: 'Tags' },
                 { key: 'createdAt', header: 'Created Date' }
             ],
             cast: {
                 date: (value) => value ? value.toISOString() : '',
                 object: (value) => value ? (Array.isArray(value) ? value.join(', ') : JSON.stringify(value)) : ''
             }
        });

        cursor.pipe(stringifier).pipe(res);

    } catch (err) {
        console.error('[CSV Export] Error:', err);
        res.status(500).json({ success: false, message: 'General Server Error' });
    }
});

// GET /api/leads/:clientId/tags
router.get('/:clientId/tags', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        let targetClientId = clientId;
        // In case clientId string is passed and needs to be resolved to ObjectId or just string match
        // based on how AdLead stores clientId. Typically stored as String or ObjectId.
        
        const tags = await AdLead.distinct('tags', { clientId: targetClientId });
        res.json({ success: true, tags: tags || [] });
    } catch (err) {
        console.error('[Tags Fetch] Error:', err);
        res.status(500).json({ success: false, message: 'General Server Error' });
    }
});

// POST /api/leads/bulk-template
router.post('/bulk-template', protect, async (req, res) => {
    try {
        const { leadIds, templateName, languageCode, components } = req.body;
        const clientId = req.user.clientId;

        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Valid leadIds array is required' });
        }
        if (!templateName) {
            return res.status(400).json({ success: false, message: 'templateName is required' });
        }

        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ message: 'Client not found' });

        const { sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
        
        const leads = await AdLead.find({ _id: { $in: leadIds }, clientId });
        
        let successCount = 0;
        let failCount = 0;

        for (const lead of leads) {
            try {
                await sendWhatsAppTemplate({
                    phoneNumberId: client.phoneNumberId,
                    to: lead.phoneNumber,
                    templateName,
                    languageCode: languageCode || 'en',
                    components: components || [],
                    token: client.whatsappToken
                });
                successCount++;
            } catch (err) {
                console.error(`[BulkSend] Failed for ${lead.phoneNumber}:`, err.message);
                failCount++;
            }
        }

        res.json({ success: true, summary: { total: leads.length, success: successCount, failed: failCount } });
    } catch (err) {
        console.error('[BulkSend] Critical Error:', err);
        res.status(500).json({ success: false, message: 'Bulk send failed' });
    }
});

// POST /api/leads/bulk-sequence
// Triggers an automated multi-step sequence for multiple leads
router.post('/bulk-sequence', protect, async (req, res) => {
    try {
        const { leadIds, sequenceName, steps } = req.body;
        const clientId = req.user.clientId;

        if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Valid leadIds required' });
        }

        const FollowUpSequence = require('../models/FollowUpSequence');
        const leads = await AdLead.find({ _id: { $in: leadIds }, clientId });

        const results = [];
        for (const lead of leads) {
            // Calculate send times for steps based on delays
            let cumulativeDelay = 0;
            const sequenceSteps = steps.map(step => {
                const delayMs = (step.delayValue || 0) * (step.delayUnit === 'm' ? 60000 : step.delayUnit === 'h' ? 3600000 : 86400000);
                cumulativeDelay += delayMs;
                
                return {
                    ...step,
                    sendAt: new Date(Date.now() + cumulativeDelay),
                    status: 'pending'
                };
            });

            const sequence = await FollowUpSequence.create({
                clientId,
                leadId: lead._id,
                phone: lead.phoneNumber,
                email: lead.email,
                name: sequenceName || 'Abandoned Cart Recovery',
                status: 'active',
                steps: sequenceSteps
            });

            // Mark lead as recovery-in-progress
            await AdLead.findByIdAndUpdate(lead._id, { 
                cartStatus: 'abandoned',
                recoveryStep: 1,
                recoveryStartedAt: new Date()
            });

            results.push(sequence._id);
        }

        res.json({ success: true, count: results.length, message: `Started ${results.length} recovery sequences.` });
    } catch (err) {
        console.error('[BulkSequence] Error:', err);
        res.status(500).json({ success: false, message: 'Failed to start bulk sequence' });
    }
});


// GET /api/leads/high-intent
router.get('/high-intent', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const { limit = 50, next_cursor } = req.query;

        const query = { 
            clientId,
            $or: [
                { cartStatus: 'abandoned' },
                { addToCartCount: { $gt: 0 }, isOrderPlaced: { $ne: true } },
                { checkoutInitiatedCount: { $gt: 0 }, isOrderPlaced: { $ne: true } }
            ]
        };

        if (next_cursor) {
            query._id = { $lt: next_cursor };
        }

        const leads = await AdLead.find(query)
            .sort({ lastInteraction: -1 })
            .limit(parseInt(limit));

        const total = await AdLead.countDocuments(query);
        const new_cursor = leads.length > 0 ? leads[leads.length - 1]._id : null;

        res.json({
            success: true,
            leads,
            next_cursor: new_cursor,
            total
        });
    } catch (err) {
        console.error('[HighIntentLeads] Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch high-intent leads' });
    }
});

// POST /api/leads/:clientId/deploy-weights
// Used by the Intent Simulator to save custom lead scoring rules
router.post('/:clientId/deploy-weights', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const { baseWeight, interactionMultiplier, cartAbandonBonus, tagWeights } = req.body;
        
        const client = await Client.findOneAndUpdate(
            { clientId }, 
            {
                $set: {
                    'intentWeights': {
                        baseWeight: baseWeight || 20,
                        interactionMultiplier: interactionMultiplier || 5,
                        cartAbandonBonus: cartAbandonBonus || 30,
                        tagWeights: tagWeights || []
                    }
                }
            },
            { new: true }
        );

        // Immediately trigger score recomputation asynchronously
        const { recomputeAllScores } = require('../utils/leadScoring');
        recomputeAllScores(clientId).catch(err => {
            console.error(`[DeployWeights] Background recompute failed for ${clientId}:`, err)
        });

        res.json({ success: true, message: 'Scoring weights deployed successfully. Recomputing standard scores...' });
    } catch (err) {
        console.error('[DeployWeights] Error:', err);
        res.status(500).json({ success: false, message: 'Failed to deploy weights' });
    }
});

router.post('/:contactId/reset', protect, async (req, res) => {
    try {
        const { contactId } = req.params;
        const { hardDelete } = req.body;
        const clientId = req.user.clientId;

        const lead = await AdLead.findOne({ _id: contactId, clientId });
        if (!lead) return res.status(404).json({ message: 'Contact not found' });

        const Conversation = require('../models/Conversation');
        const Message = require('../models/Message');

        if (hardDelete) {
            // MODULE 3 Hard Delete: Wipe everything
            await AdLead.deleteOne({ _id: contactId, clientId });
            await Conversation.deleteOne({ phone: lead.phoneNumber, clientId });
            await Message.deleteMany({ phone: lead.phoneNumber, clientId });
            
            return res.json({ success: true, action: 'deleted', message: 'Contact and history permanently purged.' });
        } else {
            // MODULE 3 Soft Reset: Wipe memory only
            await Conversation.findOneAndUpdate(
                { phone: lead.phoneNumber, clientId },
                { 
                    $set: { 
                        lastMessage: '',
                        summary: '',
                        lastDetectedIntent: null,
                        unreadCount: 0,
                        botPaused: false,
                        requiresAttention: false,
                        processedMessageIds: []
                    }
                }
            );

            // Wipe specific lead metrics
            lead.sentimentScore = 50;
            lead.leadScore = 10;
            lead.inboundMessageCount = 0;
            await lead.save();

            // Clear chat messages
            await Message.deleteMany({ phone: lead.phoneNumber, clientId });

            return res.json({ success: true, action: 'reset', message: 'AI memory cleared. Contact preserved.' });
        }
    } catch (err) {
        console.error('[ContactReset] Error:', err);
        res.status(500).json({ success: false, message: 'Reset protocol failed' });
    }
});

module.exports = router;

