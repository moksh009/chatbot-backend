const express = require('express');
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

        const filePath = req.file.path;
        const filename = req.file.originalname;
        const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};
        
        // Create an Import Session
        const session = await ImportSession.create({
            clientId,
            batchId,
            filename,
            status: 'processing'
        });

        // First pass: Count total rows for progress tracking
        let totalRows = 0;
        await new Promise((resolve) => {
            fs.createReadStream(filePath)
                .pipe(csv())
                .on('data', () => totalRows++)
                .on('end', resolve);
        });

        session.totalRows = totalRows;
        await session.save();

        // Second pass: Process data
        const results = [];
        const batchTag = `Import_${new Date().toLocaleString('en-US', { month: 'short', day: '2-digit' })}_${filename.replace(/\.[^/.]+$/, "").slice(0, 10)}`;

        const clientDoc = await Client.findOne({ clientId });
        const limits = await checkLimit(clientDoc?._id, 'contacts');

        if (!limits.allowed) {
            session.status = 'failed';
            session.errorLog.push({ row: 0, error: 'Contact limit reached' });
            await session.save();
            fs.unlinkSync(filePath);
            return res.status(403).json({ success: false, message: 'Contact limit reached' });
        }

        let processed = 0;
        let success = 0;
        let updated = 0;
        let failed = 0;

        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', async (row) => {
                processed++;
                
                // Heuristic Mapping
                const rawPhone = row[mapping.phone] || row[findBestMatch(Object.keys(row), 'phone')];
                const rawName = row[mapping.name] || row[findBestMatch(Object.keys(row), 'name')];
                const rawEmail = row[mapping.email] || row[findBestMatch(Object.keys(row), 'email')];

                const phoneNumber = normalizePhone(rawPhone);
                
                if (!phoneNumber) {
                    failed++;
                    session.errorLog.push({ row: processed, error: 'Invalid phone number', data: row });
                    return;
                }

                // Handle missing name as "Guest contact (from [Filename])"
                const name = rawName?.trim() || `Guest contact (from ${filename.split('.')[0]})`;

                // Meta-Field Mapping: Capture everything else into capturedData
                const customData = {};
                Object.keys(row).forEach(key => {
                    const k = key.toLowerCase();
                    if (!['phone', 'name', 'email', 'ph', 'mob', 'mobilenumber', 'phonenumber'].some(x => k.includes(x))) {
                        customData[key] = row[key];
                    }
                });

                const leadData = {
                    clientId,
                    phoneNumber,
                    name,
                    email: rawEmail?.toLowerCase().trim(),
                    source: 'CSV_Import',
                    optStatus: 'opted_in',
                    tags: _.uniq([...(row.tags ? row.tags.split(',') : []), 'Imported', batchTag]),
                    capturedData: customData,
                    meta: { lastImportId: batchId, importedAt: new Date() }
                };

                results.push(leadData);

                // Batch Update via socket.io every 50 rows or at the end
                if (processed % 50 === 0 || processed === totalRows) {
                    if (global.io) {
                        global.io.to(`client_${clientId}`).emit('import_progress', {
                            batchId,
                            processed,
                            total: totalRows,
                            percent: Math.round((processed / totalRows) * 100)
                        });
                    }
                }
            })
            .on('end', async () => {
                try {
                    fs.unlinkSync(filePath);

                    // Bulk Upsert Logic
                    const batchSize = 100;
                    for (let i = 0; i < results.length; i += batchSize) {
                        const batch = results.slice(i, i + batchSize);
                        const bulkOps = batch.map(lead => ({
                            updateOne: {
                                filter: { phoneNumber: lead.phoneNumber, clientId },
                                // Deep merge using $set for base and $merge for capturedData if possible, 
                                // but for now simple upsert with $set works as a "Cleaner"
                                update: { $set: lead }, 
                                upsert: true
                            }
                        }));

                        const bulkResult = await AdLead.bulkWrite(bulkOps);
                        success += bulkResult.upsertedCount || 0;
                        updated += bulkResult.modifiedCount || 0;
                        
                        // Small throttle for DB stability on large imports
                        if (i + batchSize < results.length) await new Promise(r => setTimeout(r, 200));
                    }

                    session.status = 'completed';
                    session.processedRows = processed;
                    session.successCount = success;
                    session.duplicateCount = updated;
                    session.errorCount = failed;
                    await session.save();

                    if (success > 0) await incrementUsage(clientId, 'contacts', success);

                    if (global.io) {
                        global.io.to(`client_${clientId}`).emit('import_completed', {
                            batchId,
                            success,
                            updated,
                            failed,
                            batchTag
                        });
                    }

                    // Return final result to the HTTP request as fallback
                    if (!res.headersSent) {
                        res.json({
                            success: true,
                            batchId,
                            batchTag,
                            summary: { total: totalRows, inserted: success, updated, failed }
                        });
                    }
                } catch (err) {
                    console.error('[IMPORT_ERROR]', err);
                    session.status = 'failed';
                    await session.save();
                }
            });

    } catch (err) {
        console.error('[IMPORT_CRITICAL]', err);
        res.status(500).json({ success: false, message: 'Import logic failed' });
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

module.exports = router;
