'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  contactPhoneKey,
  buildWhatsappFollowupDisplay,
  recoveryStatusFromAttempt,
} = require('../../utils/commerce/cartRecoveryAttemptService');

test('contactPhoneKey normalizes to digit key', () => {
  assert.equal(contactPhoneKey('9876543210'), '919876543210');
  assert.equal(contactPhoneKey('+919876543210'), '919876543210');
});

test('buildWhatsappFollowupDisplay — pending with no sends', () => {
  const out = buildWhatsappFollowupDisplay({ status: 'pending', whatsappTemplatesSent: [] }, { followups: [] });
  assert.match(out.lines[0].text, /no message sent/i);
});

test('buildWhatsappFollowupDisplay — sent + scheduled next', () => {
  const attempt = {
    status: 'pending',
    whatsappTemplatesSent: [{ followupNumber: 1, templateName: 'cart_recovery_1', sentAt: new Date() }],
  };
  const config = {
    followups: [
      { followupNumber: 1, label: 'Followup 1' },
      { followupNumber: 2, label: 'Followup 2' },
    ],
  };
  const out = buildWhatsappFollowupDisplay(attempt, config);
  assert.ok(out.lines.some((l) => /Followup 1 — Sent/.test(l.text)));
  assert.ok(out.lines.some((l) => /Followup 2 — Scheduled/.test(l.text)));
});

test('buildWhatsappFollowupDisplay — recovered via WhatsApp', () => {
  const out = buildWhatsappFollowupDisplay({
    status: 'recovered',
    recoveredViaWhatsapp: true,
  });
  assert.match(out.lines[0].text, /Recovered via WhatsApp/i);
});

test('recoveryStatusFromAttempt — organic vs whatsapp', () => {
  assert.equal(
    recoveryStatusFromAttempt({ status: 'recovered', organicRecovery: true }).key,
    'organic'
  );
  assert.equal(
    recoveryStatusFromAttempt({ status: 'recovered', recoveredViaWhatsapp: true }).key,
    'whatsapp'
  );
});
