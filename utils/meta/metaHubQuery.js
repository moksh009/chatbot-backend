'use strict';

/**
 * Meta webhook verification uses query keys hub.mode, hub.verify_token, hub.challenge.
 * express-mongo-sanitize replaces "." in keys with "_", so we accept both shapes.
 */
function getMetaWebhookVerifyQuery(req) {
  const q = req && req.query ? req.query : {};
  const mode = q['hub.mode'] ?? q.hub_mode ?? (q.hub && q.hub.mode);
  const token = q['hub.verify_token'] ?? q.hub_verify_token ?? (q.hub && q.hub.verify_token);
  const challenge = q['hub.challenge'] ?? q.hub_challenge ?? (q.hub && q.hub.challenge);
  return { mode, token, challenge };
}

module.exports = { getMetaWebhookVerifyQuery };
