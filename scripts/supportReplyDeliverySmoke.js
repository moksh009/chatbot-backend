function evaluateDelivery({ sendEmailCopy, requesterEmail, emailSendResult, emailError }) {
  if (!sendEmailCopy) {
    return { attempted: false, sent: false, reason: 'disabled' };
  }
  if (!requesterEmail) {
    return { attempted: true, sent: false, reason: 'missing_requester_email' };
  }
  if (emailError) {
    return { attempted: true, sent: false, reason: 'email_exception' };
  }
  if (!emailSendResult) {
    return { attempted: true, sent: false, reason: 'provider_send_failed' };
  }
  return { attempted: true, sent: true, reason: '' };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run() {
  const disabled = evaluateDelivery({ sendEmailCopy: false, requesterEmail: 'a@b.com', emailSendResult: true });
  assert(disabled.attempted === false && disabled.reason === 'disabled', 'toggle OFF should skip email');

  const missingEmail = evaluateDelivery({ sendEmailCopy: true, requesterEmail: '', emailSendResult: true });
  assert(missingEmail.sent === false && missingEmail.reason === 'missing_requester_email', 'missing recipient should fail safely');

  const providerFail = evaluateDelivery({ sendEmailCopy: true, requesterEmail: 'a@b.com', emailSendResult: false });
  assert(providerFail.sent === false && providerFail.reason === 'provider_send_failed', 'provider false should fail safely');

  const exceptionPath = evaluateDelivery({ sendEmailCopy: true, requesterEmail: 'a@b.com', emailSendResult: false, emailError: new Error('boom') });
  assert(exceptionPath.sent === false && exceptionPath.reason === 'email_exception', 'exception should fail safely');

  const success = evaluateDelivery({ sendEmailCopy: true, requesterEmail: 'a@b.com', emailSendResult: true });
  assert(success.sent === true, 'email on should send on happy path');

  console.log('supportReplyDeliverySmoke: all scenarios passed');
}

run();
