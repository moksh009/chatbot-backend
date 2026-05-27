const { Worker } = require('bullmq');
const log = require('../utils/core/logger')('TaskWorker');
const { getQueueRedis } = require('../utils/core/redisFactory');
const fs = require('fs');
const csv = require('csv-parser');
const _ = require('lodash');
const AdLead = require('../models/AdLead');
const ImportSession = require('../models/ImportSession');
const { normalizePhone, findBestMatch, resolveMappedHeader } = require('../utils/commerce/leadCleaner');
const { checkLimit, incrementUsage } = require('../utils/core/planLimits');
const { buildDefaultOptInSetFields } = require('../utils/commerce/marketingOptStatusRules');

const redisConnection = getQueueRedis();
if (!redisConnection) {
  log.warn('[TaskWorker] ⚠️ Redis unavailable. Background Enterprise Tasks are DISABLED.');
}

/**
 * TaskWorker
 */
const taskWorker = redisConnection ? new Worker('enterprise-tasks', async (job) => {
    const { type, data } = job;
    log.info(`[TaskWorker] Picked up job ${job.id} of type: ${job.name}`);

    try {
        switch (job.name) {
            case 'SHOPIFY_SYNC': {
                const { syncNicheDataProducts } = require('../utils/shopify/shopifyNicheProductSync');
                await syncNicheDataProducts(data.clientId);
                break;
            }
            
            case 'AI_PERSONA_SYNC':
                // Logic for syncing persona across 100+ nodes in background
                const { syncPersonaToNodes } = require('../utils/core/personaEngine');
                await syncPersonaToNodes(data.clientId, data.persona);
                break;

            case 'IMPORT_LEADS':
                await handleImportLeads(data, job);
                break;

            case 'RECOMPUTE_ALL_LEAD_SCORES':
                await handleRecomputeScores(data, job);
                break;

            default:
                log.warn(`[TaskWorker] No handler found for task type: ${job.name}`);
        }
    } catch (err) {
        log.error(`[TaskWorker] Job ${job.id} failed:`, err);
        throw err; // Ensure BullMQ increments attempt count
    }
}, {
    connection: redisConnection,
    concurrency: 10, // Process 10 scale-tasks in parallel per worker instance
}) : null;

if (taskWorker) {
    taskWorker.on('completed', (job) => {
        log.info(`[TaskWorker] Job ${job.id} (${job.name}) completed successfully.`);
    });

    taskWorker.on('failed', (job, err) => {
        log.error(`[TaskWorker] Job ${job.id} (${job.name}) failed with error: ${err.message}`);
    });
}

async function handleImportLeads(data, job) {
    const { clientId, batchId, filePath, filename, mapping, listName, importConsentType, consentAcknowledged } = data;
    const session = await ImportSession.findOne({ batchId });
    if (!session) return log.error(`[Import] Session not found for ${batchId}`);
    if (!Array.isArray(session.errorLog)) session.errorLog = [];

    try {
        const batchName = listName || filename.replace(/\.[^/.]+$/, "");
        const batchTag = `Import_${new Date().toLocaleString('en-US', { month: 'short', day: '2-digit' })}_${batchName.slice(0, 10)}`;
        
        session.batchName = batchName;
        await session.save();

        let processed = 0;
        let success = 0;
        let updated = 0;
        let failed = 0;
        let batch = [];
        const allNewPhones = [];
        const BATCH_SIZE = 500;
        const fileSize = fs.statSync(filePath).size;
        let lastReportedPercent = 0;

        const processBatch = async (currentBatch) => {
            if (currentBatch.length === 0) return;
            
            const bulkOps = currentBatch.map(item => ({
                updateOne: {
                    filter: { phoneNumber: item.setObj.phoneNumber, clientId },
                    update: { 
                        $set: item.setObj,
                        $setOnInsert: item.setOnInsertObj,
                        $addToSet: item.addToSetObj
                    }, 
                    upsert: true
                }
            }));

            try {
                const bulkResult = await AdLead.bulkWrite(bulkOps, { ordered: false });
                success += bulkResult.upsertedCount || 0;
                updated += bulkResult.modifiedCount || 0;
                if (bulkResult.upsertedIds) {
                    Object.keys(bulkResult.upsertedIds).forEach(idx => {
                        if (currentBatch[idx]) allNewPhones.push(currentBatch[idx].setObj.phoneNumber);
                    });
                }
            } catch (err) {
                log.error('[Import] Bulk write error on batch:', err.message);
                if (err.result) {
                    success += err.result.upsertedCount || 0;
                    updated += err.result.modifiedCount || 0;
                    if (err.result.upsertedIds) {
                        Object.keys(err.result.upsertedIds).forEach(idx => {
                            if (currentBatch[idx]) allNewPhones.push(currentBatch[idx].setObj.phoneNumber);
                        });
                    }
                }
            }
        };

        const fileStream = fs.createReadStream(filePath);
        const parser = fileStream.pipe(csv());

        for await (const row of parser) {
            processed++;
            
            const headers = Object.keys(row);
            const phoneCol = resolveMappedHeader(mapping, 'phone');
            const nameCol = resolveMappedHeader(mapping, 'name');
            const emailCol = resolveMappedHeader(mapping, 'email');
            const cityCol = resolveMappedHeader(mapping, 'city');
            const tagCol = resolveMappedHeader(mapping, 'tag');

            const rawPhone = (phoneCol && row[phoneCol]) || row[findBestMatch(headers, 'phone')];
            const rawName = (nameCol && row[nameCol]) || row[findBestMatch(headers, 'name')];
            const rawEmail = (emailCol && row[emailCol]) || row[findBestMatch(headers, 'email')];
            const rawCity = cityCol ? row[cityCol] : null;
            const rawTag = tagCol ? row[tagCol] : null;

            const phoneNumber = normalizePhone(rawPhone);
            if (!phoneNumber) {
                failed++;
                if (session.errorLog.length < 100) {
                    session.errorLog.push({
                        row: processed,
                        phone: rawPhone,
                        reason: 'Invalid phone number format',
                        error: 'Invalid phone number format'
                    });
                }
                continue;
            }

            const customData = {};
            headers.forEach(key => {
                const k = key.toLowerCase();
                if (!['phone', 'name', 'email', 'city', 'tag', 'ph', 'mob', 'mobilenumber', 'phonenumber'].some(x => k.includes(x))) {
                    if (row[key]) customData[key] = row[key];
                }
            });

            const consentType = String(importConsentType || 'unknown');
            const isDeclaredOptIn = ['whatsapp_reply', 'website_widget', 'checkout_explicit'].includes(consentType) && consentAcknowledged === true;
            const setObj = {
                clientId,
                phoneNumber,
                importBatchId: session._id,
                meta: {
                    lastImportId: batchId,
                    importedAt: new Date(),
                    importFilename: filename,
                    importListName: batchName,
                    importConsentType: consentType,
                    optInDeclarationTimestamp: isDeclaredOptIn ? new Date() : null,
                    optInDeclaredBy: isDeclaredOptIn ? String(data?.user?.id || '') : ''
                }
            };
            
            const setOnInsertObj = {
                source: 'CSV_Import',
                ...buildDefaultOptInSetFields('csv_import'),
                name: `Guest contact (from ${filename.split('.')[0]})`
            };
            
            const addToSetObj = {
                tags: { $each: ['Imported', batchTag] }
            };

            if (rawName?.trim()) {
                setObj.name = rawName.trim();
                setObj.isNameCustom = true;
                setObj.nameSource = 'imported';
                delete setOnInsertObj.name;
            }
            if (rawEmail?.trim()) {
                setObj.email = rawEmail.trim().toLowerCase();
            }
            if (rawCity?.trim()) {
                setObj.city = rawCity.trim();
            }
            if (rawTag?.trim()) {
                addToSetObj.tags.$each.push(rawTag.trim());
            }
            if (Object.keys(customData).length > 0) {
                setObj.capturedData = customData; 
            }

            batch.push({ setObj, setOnInsertObj, addToSetObj });

            if (batch.length >= BATCH_SIZE) {
                await processBatch(batch);
                batch = [];
                
                const percent = Math.floor((fileStream.bytesRead / fileSize) * 100);
                if (percent > lastReportedPercent) {
                    lastReportedPercent = percent;
                    emitProgress(clientId, batchId, processed, processed, percent);
                }
                await new Promise(r => setTimeout(r, 10)); // Yield event loop
            }
        }

        if (batch.length > 0) {
            await processBatch(batch);
            emitProgress(clientId, batchId, processed, processed, 100);
        }

        session.status = 'completed';
        session.processedRows = processed;
        session.successCount = success;
        session.duplicateCount = updated;
        session.errorCount = failed;
        session.newPhones = allNewPhones;
        await session.save();

        if (success > 0) {
            await incrementUsage(clientId, 'contacts', success);
            // Enterprise Fix: Update StatCache atomically for real-time dashboard
            await incrementStat(clientId, { 
                totalLeads: success, 
                leadsToday: success 
            });
        }

        if (global.io) {
            global.io.to(`client_${clientId}`).emit('import_completed', {
                batchId, success, updated, failed, batchTag, errors: session.errorLog
            });
        }

        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    } catch (err) {
        log.error(`[Import] Failed for batch ${batchId}:`, err);
        session.status = 'failed';
        await session.save();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

function emitProgress(clientId, batchId, processed, total, percent) {
    if (global.io) {
        global.io.to(`client_${clientId}`).emit('import_progress', {
            batchId, processed, total, percent
        });
    }
}

async function handleRecomputeScores(data, job) {
    const { clientId } = data;
    const { recomputeAllWaterfallScores } = require('../utils/core/scoringHelper');

    try {
        log.info(`[Recompute] Starting waterfall recompute for ${clientId}`);
        const processed = await recomputeAllWaterfallScores(clientId);
        log.info(`[Recompute] Successfully finished for ${clientId} (${processed} leads)`);
    } catch (err) {
        log.error(`[Recompute] Failed for ${clientId}:`, err.message);
        throw err;
    }
}

module.exports = taskWorker;
