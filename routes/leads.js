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
const { stringify } = require('csv-stringify');

// Multer setup for temporary CSV storage
const upload = multer({ 
    dest: path.join(__dirname, '../uploads/csv_tmp/'),
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

const uploadMiddleware = (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ success: false, message: 'File too large. Maximum size is 10MB.' });
            }
            return res.status(400).json({ success: false, message: err.message });
        } else if (err) {
            return res.status(500).json({ success: false, message: 'Unknown upload error' });
        }
        next();
    });
};

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
router.post('/:clientId/import', protect, logAction('IMPORT_LEADS'), uploadMiddleware, async (req, res) => {
    const { clientId } = req.params;
    const batchId = `BATCH_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    try {
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             if (req.file) fs.unlinkSync(req.file.path);
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

        const filename = req.file.originalname;
        let mapping = {};
        
        if (req.body.mapping) {
            try {
                mapping = JSON.parse(req.body.mapping);
            } catch (pErr) {
                console.error('[IMPORT_MAPPING_PARSE_ERROR]', pErr);
                if (req.file) fs.unlinkSync(req.file.path);
                return res.status(400).json({ success: false, message: 'Invalid mapping data provided' });
            }
        }
        
        // Ensure imports directory exists
        const importDir = path.join(__dirname, '../uploads/imports');
        if (!fs.existsSync(importDir)) fs.mkdirSync(importDir, { recursive: true });

        // Move file to a persistent location for the background worker
        const persistentPath = path.join(importDir, `${batchId}.csv`);
        
        try {
            // Enterprise Fix: fs.renameSync can fail across filesystems (e.g. /tmp to /app)
            fs.renameSync(req.file.path, persistentPath);
        } catch (renameErr) {
            if (renameErr.code === 'EXDEV') {
                // Cross-device link error: copy and delete instead
                fs.copyFileSync(req.file.path, persistentPath);
                fs.unlinkSync(req.file.path);
            } else {
                throw renameErr;
            }
        }

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
            listName: req.body.listName || filename,
            user: { id: req.user._id, role: req.user.role }
        });

        // Respond immediately
        res.status(202).json({
            success: true,
            message: 'Import started in background',
            batchId
        });

    } catch (err) {
        console.error('[IMPORT_TRIGGER_ERROR] Full Context:', err);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to start import',
            details: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});

// DELETE /api/leads/:clientId/import/:batchId
router.delete('/:clientId/import/:batchId', protect, logAction('DELETE_IMPORT'), async (req, res) => {
    const { clientId, batchId } = req.params;
    const { confirmText } = req.body;

    if (confirmText !== 'DELETE') {
        return res.status(400).json({ success: false, message: 'Invalid confirmation text' });
    }

    try {
        const session = await ImportSession.findOne({ clientId, batchId });
        if (!session) return res.status(404).json({ message: 'Import session not found' });
        
        if (session.status === 'rolled_back') return res.status(400).json({ message: 'Already rolled back' });

        // Logic: Delete leads where phoneNumber is in session.newPhones
        let deletedCount = 0;
        if (session.newPhones && session.newPhones.length > 0) {
            const result = await AdLead.deleteMany({ 
                clientId, 
                phoneNumber: { $in: session.newPhones }
            });
            deletedCount = result.deletedCount;
        }

        session.status = 'rolled_back';
        await session.save();

        res.json({
            success: true,
            message: `Batch permanently deleted. ${deletedCount} new contacts removed.`,
            deletedCount: deletedCount
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Delete failed' });
    }
});

const buildCsvStream = (cursor, selectedFields) => {
    const allColumns = [
        { key: 'phoneNumber', header: 'Phone Number' },
        { key: 'name', header: 'Name' },
        { key: 'email', header: 'Email' },
        { key: 'city', header: 'City' },
        { key: 'source', header: 'Source' },
        { key: 'optStatus', header: 'Opt Status' },
        { key: 'totalSpent', header: 'Total Spent' },
        { key: 'ordersCount', header: 'Orders Count' },
        { key: 'tags', header: 'Tags' },
        { key: 'leadScore', header: 'Lead Score' },
        { key: 'lastInteraction', header: 'Last Active' },
        { key: 'createdAt', header: 'Created Date' }
    ];

    const targetColumns = selectedFields 
        ? allColumns.filter(c => selectedFields.includes(c.key))
        : allColumns;

    return cursor.pipe(stringify({
         header: true,
         columns: targetColumns,
         cast: {
             date: (value) => value ? value.toISOString() : '',
             object: (value) => value ? (Array.isArray(value) ? value.join(', ') : JSON.stringify(value)) : ''
         }
    }));
};

// POST /api/leads/export
router.post('/export', protect, logAction('EXPORT_LEADS'), async (req, res) => {
    req.setTimeout(30000); // 30s timeout
    try {
        const { clientId, mode, pages = [], filter = {}, fields } = req.body;
        
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        let query = { clientId };
        let selectedFields = fields ? fields.split(',').map(f => f.trim()) : null;

        if (mode === 'pages' && pages.length) {
            const limit = 20; // Default page size
            const phoneNumbers = [];
            for (const p of pages) {
                const batch = await AdLead.find({ clientId }).sort({ lastInteraction: -1 }).skip((p - 1) * limit).limit(limit).lean();
                phoneNumbers.push(...batch.map(b => b.phoneNumber));
            }
            query.phoneNumber = { $in: phoneNumbers };
        } else if (mode === 'filter') {
            Object.assign(query, filter);
        } else if (mode === 'custom' && req.body.pageFrom && req.body.pageTo) {
            const limit = 20;
            const skip = (req.body.pageFrom - 1) * limit;
            const limitDocs = (req.body.pageTo - req.body.pageFrom + 1) * limit;
            const batch = await AdLead.find({ clientId }).sort({ lastInteraction: -1 }).skip(skip).limit(limitDocs).lean();
            query.phoneNumber = { $in: batch.map(b => b.phoneNumber) };
        }
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="contacts_export_${clientId}_${Date.now()}.csv"`);
        
        const cursor = AdLead.find(query).sort({ lastInteraction: -1 }).cursor();
        buildCsvStream(cursor, selectedFields).pipe(res);
    } catch (err) {
        console.error('[/api/leads/export]', err);
        if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    }
});

// GET /api/leads/export/batch/:batchId
router.get('/export/batch/:batchId', protect, async (req, res) => {
    try {
        const batch = await ImportSession.findOne({ batchId: req.params.batchId }).lean();
        if (!batch) return res.status(404).json({ error: 'Batch not found' });
        
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== batch.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${batch.batchName || 'import_batch'}.csv"`);
        
        const cursor = AdLead.find({ importBatchId: batch._id }).cursor();
        buildCsvStream(cursor, null).pipe(res);
    } catch (err) {
        console.error('[/api/leads/export/batch]', err);
        if (!res.headersSent) res.status(500).json({ error: 'Batch export failed' });
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
        
        const leads = await AdLead.find({ _id: { $in: leadIds }, clientId }).lean();
        
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
        const { leadIds, sequenceName, steps, type } = req.body;
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
                name: sequenceName || 'Automated Sequence',
                type: type || 'custom',
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


// POST /api/leads/:leadId/send-recovery
router.post('/:leadId/send-recovery', protect, async (req, res) => {
    try {
        const { leadId } = req.params;
        const clientId = req.user.clientId;

        const lead = await AdLead.findOne({ _id: leadId, clientId })
            .select('phoneNumber name cartSnapshot activityLog recoveryStep recoveryStartedAt')
            .lean();
        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

        const client = await Client.findOne({ clientId })
            .select('phoneNumberId whatsappToken syncedMetaTemplates nicheData businessName')
            .lean();
        if (!client) return res.status(404).json({ message: 'Client not found' });

        const cartTitles = lead.cartSnapshot?.titles?.slice(0, 2).join(', ') || 'items in your cart';
        const cartValue = lead.cartSnapshot?.totalPrice
            ? `₹${Number(lead.cartSnapshot.totalPrice).toLocaleString('en-IN')}`
            : '';

        // Find approved cart recovery template
        const recoveryTemplate = (client.syncedMetaTemplates || []).find(t =>
            (t.name.includes('cart_recovery') || t.name.includes('abandoned')) &&
            t.status === 'APPROVED'
        );

        const { sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
        
        try {
            if (recoveryTemplate) {
                await sendWhatsAppTemplate({
                    phoneNumberId: client.phoneNumberId,
                    to: lead.phoneNumber,
                    templateName: recoveryTemplate.name,
                    languageCode: 'en',
                    components: [{
                        type: 'body',
                        parameters: [
                            { type: 'text', text: lead.name || 'friend' },
                            { type: 'text', text: cartTitles },
                            { type: 'text', text: cartValue || 'a great deal' }
                        ]
                    }],
                    token: client.whatsappToken
                });
            } else {
                // Fallback to plain text if no approved template
                const { sendWhatsAppText } = require('../utils/whatsapp');
                const storeUrl = client.nicheData?.storeUrl || '';
                await sendWhatsAppText
                    ? await require('../utils/whatsapp').sendText(client, lead.phoneNumber, 
                        `Hey ${lead.name || 'there'}! 🛒 You left ${cartTitles}${cartValue ? ` worth ${cartValue}` : ''} in your cart. Complete your order${storeUrl ? ` here: ${storeUrl}` : '!'}`)
                    : await sendWhatsAppTemplate({
                        phoneNumberId: client.phoneNumberId,
                        to: lead.phoneNumber,
                        templateName: 'abandoned_cart_recovery',
                        languageCode: 'en',
                        components: [],
                        token: client.whatsappToken
                    });
            }

            // Update lead with recovery tracking + activity log
            await AdLead.findByIdAndUpdate(lead._id, {
                $set: {
                    recoveryStep: (lead.recoveryStep || 0) + 1,
                    recoveryStartedAt: new Date()
                },
                $push: {
                    activityLog: {
                        action: 'cart_recovery_sent',
                        details: `Manual recovery sent${recoveryTemplate ? ' via template' : ' via text'}. Cart: ${cartTitles}`,
                        timestamp: new Date()
                    }
                }
            });

            res.json({ success: true, message: 'Recovery message sent', method: recoveryTemplate ? 'template' : 'text' });
        } catch (err) {
            console.error('[SendRecovery] Send failed:', err.message);
            res.status(500).json({ success: false, message: 'Failed to send: ' + err.message });
        }
    } catch (err) {
        console.error('[SendRecovery] Error:', err);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// POST /api/leads/bulk-recovery
router.post('/bulk-recovery', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ message: 'Client not found' });
        
        const leads = await AdLead.find({ 
            clientId, 
            cartStatus: 'abandoned'
        });

        if (!leads.length) return res.json({ success: true, message: 'No abandoned carts to recover' });

        const { sendWhatsAppTemplate } = require('../utils/whatsappHelpers');
        let successCount = 0;
        let failCount = 0;

        for (const lead of leads) {
            try {
                await sendWhatsAppTemplate({
                    phoneNumberId: client.phoneNumberId,
                    to: lead.phoneNumber,
                    templateName: 'abandoned_cart_recovery',
                    languageCode: 'en',
                    components: [],
                    token: client.whatsappToken
                });
                lead.recoveryStep = (lead.recoveryStep || 0) + 1;
                lead.recoveryStartedAt = new Date();
                await lead.save();
                successCount++;
            } catch (err) {
                console.error(`[BulkRecovery] Failed for ${lead.phoneNumber}:`, err.message);
                failCount++;
            }
        }

        res.json({ success: true, summary: { total: leads.length, success: successCount, failed: failCount } });
    } catch (err) {
        console.error('[BulkRecovery] Error:', err);
        res.status(500).json({ success: false, message: 'Internal server error' });
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
            .limit(parseInt(limit))
            .select('phoneNumber name email leadScore cartStatus lastInteraction tags checkoutInitiatedCount addToCartCount source')
            .lean();

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

// POST /api/leads/bulk-delete
// Supports filtering and hard/soft deletion
router.post('/bulk-delete', protect, async (req, res) => {
    try {
        const { filters, hardDelete, leadIds } = req.body;
        const clientId = req.user.clientId;

        const query = { clientId };

        // 1. Apply Filters or direct selection
        if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
            query._id = { $in: leadIds };
        } else if (filters) {
            if (filters.segmentScore) {
                const [min, max] = filters.segmentScore.split('-').map(Number);
                query.leadScore = { $gte: min, $lte: max || 100 };
            }
            if (filters.lastSeen) {
                const now = new Date();
                let lastSeenDate;
                switch (filters.lastSeen) {
                    case '24h': lastSeenDate = new Date(now - 24 * 60 * 60 * 1000); break;
                    case '7d': lastSeenDate = new Date(now - 7 * 24 * 60 * 60 * 1000); break;
                    case '14d': lastSeenDate = new Date(now - 14 * 24 * 60 * 60 * 1000); break;
                    case '1m': lastSeenDate = new Date(now - 30 * 24 * 60 * 60 * 1000); break;
                    case '6m': lastSeenDate = new Date(now - 180 * 24 * 60 * 60 * 1000); break;
                }
                if (lastSeenDate) query.lastInteraction = { $lte: lastSeenDate };
            }
            if (filters.importId) {
                query['meta.lastImportId'] = filters.importId;
            }
        }

        // 2. Fetch Leads to get Phone Numbers (for Message/Conversation deletion)
        const leads = await AdLead.find(query).select('phoneNumber').lean();
        const phoneNumbers = leads.map(l => l.phoneNumber);

        if (leads.length === 0) {
            return res.json({ success: true, message: 'No leads found matching filters.', count: 0 });
        }

        const Conversation = require('../models/Conversation');
        const Message = require('../models/Message');

        if (hardDelete) {
            // Enterprise Hard Delete: Purge everything related to these leads
            await AdLead.deleteMany(query);
            await Conversation.deleteMany({ phone: { $in: phoneNumbers }, clientId });
            await Message.deleteMany({ phone: { $in: phoneNumbers }, clientId });
            
            return res.json({ 
                success: true, 
                message: `Bulk hard delete complete. ${leads.length} contacts and their histories purged.`,
                count: leads.length 
            });
        } else {
            // Enterprise Soft Reset: Wipe memory only
            await Conversation.updateMany(
                { phone: { $in: phoneNumbers }, clientId },
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

            await AdLead.updateMany(
                query,
                {
                    $set: {
                        sentimentScore: 50,
                        leadScore: 10,
                        inboundMessageCount: 0
                    }
                }
            );

            await Message.deleteMany({ phone: { $in: phoneNumbers }, clientId });

            return res.json({ 
                success: true, 
                message: `Bulk soft reset complete. Memory cleared for ${leads.length} contacts.`,
                count: leads.length 
            });
        }
    } catch (err) {
        console.error('[BulkDelete] Error:', err);
        res.status(500).json({ success: false, message: 'Bulk deletion failed' });
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

// GET /api/leads/ai-tasks
// Returns tasks where CustomerIntelligence or sequence jobs are running
router.get('/ai-tasks', protect, async (req, res) => {
    try {
        const { clientId } = req.query;
        if (!clientId) return res.status(400).json({ success: false, message: 'clientId is required' });
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const FollowUpSequence = require('../models/FollowUpSequence');
        
        // Find active AI sequences or intelligence tasks
        const activeTasks = await FollowUpSequence.find({ 
            clientId, 
            status: 'active' 
        })
        .sort({ createdAt: -1 })
        .limit(50)
        .select('phone name type status createdAt steps')
        .lean();

        const formattedTasks = activeTasks.map(t => ({
            id: t._id,
            leadId: t.leadId,
            phone: t.phone,
            name: t.name || 'Unknown',
            taskType: t.type || 'follow_up',
            status: t.status,
            steps: t.steps || [],
            startedAt: t.createdAt,
            completedAt: null,
            result: t.steps?.length ? `${t.steps.length} steps scheduled` : 'Processing'
        }));

        res.json({ success: true, tasks: formattedTasks });
    } catch (err) {
        console.error('[AITasks] Error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch AI tasks' });
    }
});

// PATCH /api/leads/:id (Update specific fields from Lead Profile)
router.patch('/:id', protect, async (req, res) => {
    try {
        const { id } = req.params;
        const clientId = req.user.clientId;
        if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
           // allow override
        }

        const updates = { ...req.body };
        // prevent restricted fields from being updated directly
        delete updates.clientId;
        delete updates._id;

        const lead = await AdLead.findOneAndUpdate(
            { _id: id, clientId },
            { $set: updates },
            { new: true, runValidators: true }
        );

        if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

        // Sync name to conversation if it changed
        if (updates.name) {
             const Conversation = require('../models/Conversation');
             await Conversation.updateMany(
                 { phone: lead.phoneNumber, clientId },
                 { $set: { customerName: updates.name } }
             );
        }

        res.json({ success: true, lead });
    } catch (error) {
        console.error('[PATCH /api/leads/:id] Error:', error);
        res.status(500).json({ success: false, message: 'Failed to update lead' });
    }
});

module.exports = router;
