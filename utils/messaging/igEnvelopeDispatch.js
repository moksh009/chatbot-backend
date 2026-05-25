const { sendEnvelope } = require('./sendEnvelope');
const { ensureIgContact } = require('./ensureIgContact');

/**
 * Instagram automation/worker send via sendEnvelope.
 */
async function dispatchIgEnvelope({
  client,
  clientId,
  igsid,
  intent = 'service',
  payload,
  idempotencyKey,
  source = 'igAutomation',
  jobType = 'dm',
}) {
  const cid = clientId || client?.clientId;
  const commentId = payload?.igCommentReply?.commentId;
  const contact = await ensureIgContact({ clientId: cid, igsid, commentId });
  if (!contact) {
    return { handled: true, sent: false, blocked: true, result: { status: 'blocked', reason: 'invalid_contact' } };
  }

  const key =
    idempotencyKey ||
    `ig:${jobType}:${commentId || igsid}:${String(contact._id)}`;

  const result = await sendEnvelope({
    clientId: cid,
    channel: 'instagram',
    intent,
    contactId: String(contact._id),
    idempotency: { key },
    payload,
    context: { source, igsid },
  });

  if (result.status === 'sent' || result.status === 'queued' || result.status === 'duplicate') {
    return { handled: true, sent: result.status !== 'duplicate', duplicate: result.status === 'duplicate', result };
  }

  return {
    handled: true,
    sent: false,
    blocked: true,
    result,
  };
}

module.exports = { dispatchIgEnvelope };
