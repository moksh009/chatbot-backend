const CampaignMessage = require('../../../models/CampaignMessage');
const FollowUpSequence = require('../../../models/FollowUpSequence');

const timers = new Map();

function timerKey(type, recordId, stepIdx) {
  return `${type}:${recordId}:${stepIdx ?? ''}`;
}

function startHeartbeat({ workerId, type, recordId, stepIdx = null, intervalMs = 30000 }) {
  const key = timerKey(type, recordId, stepIdx);
  stopHeartbeat(key);
  const tick = async () => {
    const now = new Date();
    if (type === 'campaign_message') {
      await CampaignMessage.updateOne(
        { _id: recordId, status: 'processing' },
        { $set: { lockedAt: now, lockedBy: workerId } }
      );
    } else if (type === 'sequence_step') {
      await FollowUpSequence.updateOne(
        { _id: recordId },
        { $set: { [`steps.${stepIdx}.lockedAt`]: now, [`steps.${stepIdx}.lockedBy`]: workerId } }
      );
    }
  };
  const handle = setInterval(() => tick().catch(() => {}), intervalMs);
  timers.set(key, handle);
  return key;
}

function stopHeartbeat(keyOrParams) {
  const key =
    typeof keyOrParams === 'string'
      ? keyOrParams
      : timerKey(keyOrParams.type, keyOrParams.recordId, keyOrParams.stepIdx);
  const h = timers.get(key);
  if (h) {
    clearInterval(h);
    timers.delete(key);
  }
}

module.exports = { startHeartbeat, stopHeartbeat };
