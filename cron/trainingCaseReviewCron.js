'use strict';

const cron = require('node-cron');
const TrainingCase = require('../models/TrainingCase');
const NotificationService = require('../utils/core/notificationService');
const log = require('../utils/core/logger')('TrainingCaseReview');

function scheduleTrainingCaseReviewCron() {
  cron.schedule('15 4 * * *', async () => {
    try {
      const cases = await TrainingCase.find({ status: 'active' }).lean();
      for (const tc of cases) {
        const helpful = tc.helpfulCount || 0;
        const less = tc.lessHelpfulCount || 0;
        const total = helpful + less;
        if (total < 10) continue;
        const ratio = helpful / total;
        if (ratio >= 0.4) continue;
        const updated = await TrainingCase.findOneAndUpdate(
          { _id: tc._id, status: 'active' },
          { $set: { status: 'flagged_for_review' } },
          { new: true }
        );
        if (!updated) continue;
        await NotificationService.createNotification(tc.clientId, {
          type: 'training_flagged',
          title: 'Training case needs review',
          message: `Case "${String(tc.userMessage).slice(0, 60)}..." has low helpful ratio (${Math.round(ratio * 100)}%).`,
          metadata: { trainingCaseId: String(tc._id), helpfulRatio: ratio },
        }).catch(() => {});
      }
    } catch (e) {
      log.error(`Training review cron failed: ${e.message}`);
    }
  });
}

module.exports = scheduleTrainingCaseReviewCron;
