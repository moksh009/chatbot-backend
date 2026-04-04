const express = require('express');
const router = express.Router();
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');

const { stringify } = require('csv-stringify');
const { checkLimit, incrementUsage } = require('../utils/planLimits');

// Multer setup for temporary CSV storage
const upload = multer({ dest: '/tmp/csv_uploads/' });

// POST /api/leads/:clientId/import
router.post('/:clientId/import', protect, upload.single('file'), async (req, res) => {
    try {
        const { clientId } = req.params;
        
        if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
             if (req.file) fs.unlinkSync(req.file.path);
             return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        if (!req.file) {
             return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const filePath = req.file.path;
        const results = [];
        
        let mapping = {};
        if (req.body.mapping) {
            try {
                mapping = JSON.parse(req.body.mapping);
            } catch (e) {}
        }

        // Parse CSV
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => {
                // Apply mapping rules if provided, fallback to defaults
                const phoneField = mapping.phone ? data[mapping.phone] : (data.phone || data.phoneNumber || data['Phone Number']);
                const nameField = mapping.name ? data[mapping.name] : (data.name || data.Name || data.first_name || '');
                const emailField = mapping.email ? data[mapping.email] : (data.email || data.Email || '');

                if (phoneField) {
                     results.push({
                         clientId,
                         phoneNumber: phoneField.trim().replace(/\D/g, ''),
                         name: nameField,
                         email: emailField,
                         source: 'CSV_Import',
                         optStatus: 'opted_in',
                         tags: data.tags ? data.tags.split(',').map(t=>t.trim()) : ['Imported']
                     });
                }
            })
            .on('end', async () => {
                try {
                     fs.unlinkSync(filePath); // Cleanup

                     if (results.length === 0) {
                          return res.status(400).json({ success: false, message: 'No valid rows found' });
                     }

                     const limits = await checkLimit(req.user?.clientId || clientId, 'contacts');
                     if (!limits.allowed) {
                         return res.status(403).json({ success: false, message: 'Contacts Limit reached for your current plan.' });
                     }

                     // Batch insert logic using MongoDB bulkWrite to handle upserts without crashing M0
                     let inserted = 0;
                     let updated = 0;
                     const batchSize = 500;
                     
                     for (let i = 0; i < results.length; i += batchSize) {
                         const batch = results.slice(i, i + batchSize);
                         const bulkOps = batch.map(lead => ({
                              updateOne: {
                                   filter: { phoneNumber: lead.phoneNumber, clientId },
                                   update: { $set: lead },
                                   upsert: true
                              }
                         }));

                         const bulkResult = await AdLead.bulkWrite(bulkOps);
                         inserted += bulkResult.upsertedCount || 0;
                         updated += bulkResult.modifiedCount || 0;
                         
                         // Pause for a moment to let M0 catch up (prevent connection drop)
                         if (i + batchSize < results.length) {
                             await new Promise(resolve => setTimeout(resolve, 500));
                         }
                     }
                     
                     if (inserted > 0) {
                         await incrementUsage(req.user?.clientId || clientId, 'contacts', inserted);
                     }

                     res.json({
                         success: true,
                         message: `Import complete. ${inserted} inserted, ${updated} updated.`,
                         inserted,
                         updated
                     });
                } catch (batchErr) {
                     console.error('[CSV Import] Batch processing error:', batchErr);
                     res.status(500).json({ success: false, message: 'Error processing imported leads' });
                }
            })
            .on('error', (err) => {
                 console.error('[CSV Import] Stream error:', err);
                 fs.unlinkSync(filePath);
                 res.status(500).json({ success: false, message: 'File parsing error' });
            });

    } catch (err) {
         console.error('[CSV Import] General error:', err);
         res.status(500).json({ success: false, message: 'General Server Error' });
    }
});

// GET /api/leads/:clientId/export
router.get('/:clientId/export', protect, async (req, res) => {
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

module.exports = router;
