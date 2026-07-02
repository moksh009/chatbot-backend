'use strict';

const CodToPrepaidConversion = require('../models/CodToPrepaidConversion');
const { deleteDraftOrder } = require('../services/journeyBuilder/codToPrepaid/codToPrepaidShopify');
const log = require('../utils/core/logger')('CodToPrepaidExpirationCron');

const MAX_DELETE_RETRIES = 5;

function readRetryCount(record) {
  return Number(record?.retryCount ?? record?.deletionRetryCount ?? 0);
}

/** Pure helper — race with conversion webhook vs expiration cron (Part 8 edge case 1). */
function expirationStatusAfterDelete(currentStatus, { notFound = false } = {}) {
  if (currentStatus === 'converted') {
    return { action: 'skip', reason: 'already_converted' };
  }
  if (['expired_by_fulfillment', 'expired_by_timer'].includes(currentStatus)) {
    return { action: 'skip', reason: 'already_resolved' };
  }
  if (currentStatus === 'message_sent') {
    return {
      action: 'expire',
      status: 'expired_by_timer',
      lastErrorMessage: notFound ? 'draft_already_gone' : '',
    };
  }
  return { action: 'skip', reason: 'status_changed' };
}

async function expireOneRecord(record) {
  if (['converted', 'expired_by_fulfillment', 'expired_by_timer'].includes(record.status)) {
    return { skipped: true, reason: 'already_resolved' };
  }

  const fresh = await CodToPrepaidConversion.findById(record._id).select('status').lean();
  if (!fresh || ['converted', 'expired_by_fulfillment', 'expired_by_timer'].includes(fresh.status)) {
    return { skipped: true, reason: 'already_resolved' };
  }

  const del = await deleteDraftOrder(record.clientId, record.draftOrderGid);
  if (!del.ok && !del.notFound) {
    const retryCount = readRetryCount(record) + 1;
    const patch = {
      retryCount,
      deletionRetryCount: retryCount,
      lastErrorMessage: del.userErrors?.[0]?.message || 'draft_delete_failed',
      lastErrorAt: new Date(),
    };
    if (retryCount >= MAX_DELETE_RETRIES) {
      const afterFail = await CodToPrepaidConversion.findById(record._id).select('status').lean();
      const resolution = expirationStatusAfterDelete(afterFail?.status || '', { notFound: false });
      if (resolution.action === 'expire') {
        patch.status = resolution.status;
        patch.expiredAt = new Date();
      }
      log.error('COD prepaid draft delete gave up after retries', {
        clientId: record.clientId,
        conversionId: String(record._id),
        userErrors: del.userErrors,
      });
    }
    await CodToPrepaidConversion.findOneAndUpdate(
      { _id: record._id, status: 'message_sent' },
      { $set: patch }
    );
    return { ok: false, retryCount };
  }

  const afterDel = await CodToPrepaidConversion.findById(record._id).select('status').lean();
  const resolution = expirationStatusAfterDelete(afterDel?.status || '', { notFound: del.notFound });

  if (resolution.action === 'skip' && resolution.reason === 'already_converted') {
    log.info('COD prepaid expiration — draft already gone, order converted before timer expiry', {
      clientId: record.clientId,
      conversionId: String(record._id),
      draftNotFound: del.notFound,
    });
    return { skipped: true, reason: 'already_converted' };
  }

  if (resolution.action !== 'expire') {
    log.info('COD prepaid expiration skipped — status changed during delete', {
      clientId: record.clientId,
      conversionId: String(record._id),
      currentStatus: afterDel?.status,
      reason: resolution.reason,
    });
    return { skipped: true, reason: resolution.reason || 'status_changed' };
  }

  const updated = await CodToPrepaidConversion.findOneAndUpdate(
    { _id: record._id, status: 'message_sent' },
    {
      $set: {
        status: resolution.status,
        expiredAt: new Date(),
        lastErrorMessage: resolution.lastErrorMessage,
      },
    },
    { new: true }
  );

  if (!updated) {
    log.info('COD prepaid expiration skipped — status changed during delete', {
      clientId: record.clientId,
      conversionId: String(record._id),
    });
    return { skipped: true, reason: 'status_changed' };
  }

  return { ok: true, notFound: del.notFound };
}

async function runCodToPrepaidExpirationTick() {
  const due = await CodToPrepaidConversion.find({
    status: 'message_sent',
    freezeMode: 'by_duration',
    expiresAt: { $lte: new Date() },
  })
    .limit(50)
    .lean();

  if (!due.length) return { processed: 0 };

  let processed = 0;
  for (const record of due) {
    try {
      await expireOneRecord(record);
      processed += 1;
    } catch (err) {
      log.warn(`expiration tick error ${record._id}: ${err.message}`);
    }
  }

  return { processed };
}

function codToPrepaidExpirationCron() {
  if (process.env.CRON_USE_COORDINATOR !== 'false') return;
  const cron = require('node-cron');
  cron.schedule('*/2 * * * *', () => {
    runCodToPrepaidExpirationTick().catch((err) => {
      log.error(`tick failed: ${err.message}`);
    });
  });
}

codToPrepaidExpirationCron.runTick = runCodToPrepaidExpirationTick;
codToPrepaidExpirationCron.expireOneRecord = expireOneRecord;
codToPrepaidExpirationCron.expirationStatusAfterDelete = expirationStatusAfterDelete;

module.exports = codToPrepaidExpirationCron;
