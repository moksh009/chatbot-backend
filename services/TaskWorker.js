const { Worker } = require('bullmq');
const Redis = require('ioredis');
const log = require('../utils/logger')('TaskWorker');
const fs = require('fs');
const csv = require('csv-parser');
const _ = require('lodash');
const AdLead = require('../models/AdLead');
const ImportSession = require('../models/ImportSession');
const { normalizePhone, findBestMatch } = require('../utils/leadCleaner');
const { checkLimit, incrementUsage } = require('../utils/planLimits');
const { incrementStat } = require('../utils/statCacheEngine');

const isInternalRenderRedis = (process.env.REDIS_URL || '').includes('red-');
const isRunningOnRender = !!process.env.RENDER;

let redisConnection = null;

if (isInternalRenderRedis && !isRunningOnRender) {
  log.warn('[TaskWorker] ⚠️ Render-internal Redis detected locally. Worker is DISABLED.');
} else {
  redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      if (times > 3) {
        log.error('[TaskWorker] Redis connection failed persistently. Disabling worker.');
        return null; // Stop retrying
      }
      return Math.min(times * 100, 3000);
    }
  });

  redisConnection.on('error', (err) => {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      log.warn('[TaskWorker] ⚠️ Redis unreachable. Background Enterprise Tasks are DISABLED.');
    } else {
      log.error('[TaskWorker] Redis Error:', err.message);
    }
  });
}

/**
 * TaskWorker
 */
const taskWorker = redisConnection ? new Worker('enterprise-tasks', async (job) => {
    const { type, data } = job;
    log.info(`[TaskWorker] Picked up job ${job.id} of type: ${job.name}`);

    try {
        switch (job.name) {
            case 'SHOPIFY_SYNC':
                // Logic for background Shopify sync 
                const { syncStoreData } = require('../utils/storeSyncService'); // Example hypothetical service
                await syncStoreData(data.clientId, data.shopUrl);
                break;
            
            case 'BROADCAST_CAMPAIGN':
                // Logic for mass campaign sending
                const { processBroadcast } = require('../utils/broadcastEngine');
                await processBroadcast(data);
                break;

            case 'AI_PERSONA_SYNC':
                // Logic for syncing persona across 100+ nodes in background
                const { syncPersonaToNodes } = require('../utils/personaEngine');
                await syncPersonaToNodes(data.clientId, data.persona);
                break;

            case 'IMPORT_LEADS':
                await handleImportLeads(data, job);
                break;

            case 'BACKFILL_LOYALTY':
                await handleBackfillLoyalty(data, job);
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
    const { clientId, batchId, filePath, filename, mapping, listName } = data;
    const session = await ImportSession.findOne({ batchId });
    if (!session) return log.error(`[Import] Session not found for ${batchId}`);

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
            const rawPhone = row[mapping.phone] || row[findBestMatch(headers, 'phone')];
            const rawName = row[mapping.name] || row[findBestMatch(headers, 'name')];
            const rawEmail = row[mapping.email] || row[findBestMatch(headers, 'email')];
            const rawCity = mapping.city ? row[mapping.city] : null;
            const rawTag = mapping.tag ? row[mapping.tag] : null;

            const phoneNumber = normalizePhone(rawPhone);
            if (!phoneNumber) {
                failed++;
                if (session.errorLog.length < 100) {
                    session.errorLog.push({ row: processed, phone: rawPhone, reason: 'Invalid phone number format' });
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

            const setObj = {
                clientId,
                phoneNumber,
                importBatchId: session._id,
                meta: { lastImportId: batchId, importedAt: new Date(), importFilename: filename, importListName: batchName }
            };
            
            const setOnInsertObj = {
                source: 'CSV_Import',
                optStatus: 'opted_in',
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
    const ScoreTierConfig = require('../models/ScoreTierConfig');
    const AdLead = require('../models/AdLead');
    const { evaluateCustomerScore } = require('../services/ScoreEvaluationService');

    try {
        const config = await ScoreTierConfig.findOne({ clientId });
        if (!config) return log.warn(`[Recompute] No config found for ${clientId}`);

        // Fetch leads in batches to avoid memory overflow
        const totalLeads = await AdLead.countDocuments({ clientId });
        log.info(`[Recompute] Starting for ${clientId} (${totalLeads} leads)`);

        let processed = 0;
        const batchSize = 100;

        for (let i = 0; i < totalLeads; i += batchSize) {
            const leads = await AdLead.find({ clientId }).skip(i).limit(batchSize);
            
            const bulkOps = leads.map(lead => {
                const score = evaluateCustomerScore(lead, config);
                return {
                    updateOne: {
                        filter: { _id: lead._id },
                        update: { $set: { leadScore: score } }
                    }
                };
            });

            if (bulkOps.length > 0) {
                await AdLead.bulkWrite(bulkOps);
            }

            processed += leads.length;
            const percent = Math.round((processed / totalLeads) * 100);
            
            if (global.io) {
                global.io.to(`client_${clientId}`).emit('scoring_recompute_progress', { percent, processed, totalLeads });
            }
        }

        log.info(`[Recompute] Successfully finished for ${clientId}`);

        if (global.io) {
            global.io.to(`client_${clientId}`).emit('scoring_recompute_complete', { totalLeads });
        }
    } catch (err) {
        log.error(`[Recompute] Failed for ${clientId}:`, err.message);
        throw err;
    }
}

async function handleBackfillLoyalty(data, job) {
    const { clientId } = data;
    const Client = require('../models/Client');
    const Order = require('../models/Order');
    const { awardLoyaltyPoints } = require('../utils/loyaltyEngine');

    try {
        const client = await Client.findOne({ clientId }).select('loyaltyConfig');
        if (!client) {
            log.error(`[Backfill] Client not found: ${clientId}`);
            return;
        }

        // Auto-apply defaults if loyaltyConfig not configured yet
        if (!client.loyaltyConfig) {
            client.loyaltyConfig = { isEnabled: true, currencyUnit: 100, pointsPerUnit: 10, pointsPerCurrency: 100, expiryDays: 90 };
            await Client.updateOne({ clientId }, { loyaltyConfig: client.loyaltyConfig });
        }
        if (!client.loyaltyConfig.isEnabled) {
            await Client.updateOne({ clientId }, { 'loyaltyConfig.isEnabled': true });
        }

        const orders = await Order.find({ 
            clientId, 
            status: { $in: ['Paid', 'paid', 'PAID', 'fulfilled', 'Fulfilled'] } 
        }).lean();

        if (orders.length === 0) {
            if (global.io) {
                global.io.to(`client_${clientId}`).emit('backfill_complete', { 
                    success: true, total: 0, awarded: 0, skipped: 0, failed: 0 
                });
            }
            return;
        }

        let awarded = 0;
        let skipped = 0;
        let failed = 0;
        let processed = 0;

        const chunkSize = 50;
        for (let i = 0; i < orders.length; i += chunkSize) {
            const chunk = orders.slice(i, i + chunkSize);
            const promises = chunk.map(order => {
                const phone = order.phone || order.customerPhone;
                const amount = parseFloat(order.totalPrice || order.amount || 0);
                const orderId = order.orderId || order._id?.toString();

                if (!phone || !amount || !orderId) return Promise.resolve(null);
                
                return awardLoyaltyPoints({ 
                    clientId, 
                    phone, 
                    orderId, 
                    orderAmount: amount, 
                    isBackfill: true 
                });
            });

            const results = await Promise.allSettled(promises);
            results.forEach(res => {
                if (res.status === "fulfilled" && res.value) {
                    if (res.value.success) awarded++;
                    else if (res.value.skipped) skipped++;
                    else failed++;
                } else failed++;
            });

            processed += chunk.length;
            const percent = Math.round((processed / orders.length) * 100);

            if (global.io) {
                global.io.to(`client_${clientId}`).emit('backfill_progress', { 
                    percent, processed, total: orders.length 
                });
            }
            
            // Sleep briefly to yield event loop
            await new Promise(r => setTimeout(r, 50));
        }

        log.info(`[Backfill] Complete for ${clientId}: awarded=${awarded}, skipped=${skipped}, failed=${failed}`);
        
        if (global.io) {
            global.io.to(`client_${clientId}`).emit('backfill_complete', { 
                success: true, total: orders.length, awarded, skipped, failed 
            });
        }
    } catch (err) {
        log.error(`[Backfill] Error for ${clientId}:`, err.message);
        throw err;
    }
}

module.exports = taskWorker;
