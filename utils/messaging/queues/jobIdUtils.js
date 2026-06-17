'use strict';

/**
 * BullMQ custom job IDs must not contain ":" (and other reserved chars).
 * Join parts with a single hyphen after sanitizing each segment.
 */
function sanitizeBullMqJobId(...parts) {
  return parts
    .map((p) => String(p ?? '').replace(/[^a-zA-Z0-9_-]/g, '-'))
    .filter(Boolean)
    .join('-');
}

function campaignMessageJobId(campaignMessageId) {
  return sanitizeBullMqJobId('cm', campaignMessageId);
}

function sequenceStepJobId(sequenceId, stepIdx) {
  return sanitizeBullMqJobId('seq', sequenceId, stepIdx);
}

function webhookDeliveryJobId(deliveryId, attempt) {
  return sanitizeBullMqJobId('wh', deliveryId, attempt);
}

function signupWelcomeJobId(userId) {
  return sanitizeBullMqJobId('signup-welcome', userId);
}

function inboundEngineJobId(clientId, phone) {
  return sanitizeBullMqJobId('inbound', clientId, phone);
}

function nlpProcessJobId(clientId, phone) {
  return sanitizeBullMqJobId('nlp', clientId, phone);
}

module.exports = {
  sanitizeBullMqJobId,
  campaignMessageJobId,
  sequenceStepJobId,
  webhookDeliveryJobId,
  signupWelcomeJobId,
  inboundEngineJobId,
  nlpProcessJobId,
};
