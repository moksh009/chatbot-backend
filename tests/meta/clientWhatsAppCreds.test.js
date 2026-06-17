'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Client = require('../../models/Client');
const { WHATSAPP_CREDENTIAL_SELECT } = require('../../utils/meta/clientWhatsAppCreds');

test('WHATSAPP_CREDENTIAL_SELECT must not mix bare config with config.* paths', () => {
  const fields = WHATSAPP_CREDENTIAL_SELECT.split(/\s+/).filter(Boolean);
  assert.ok(fields.includes('config.phoneNumberId'));
  assert.ok(!fields.includes('config'), 'bare config collides with config.* on Mixed schema');
});

test('Client.findOne().select(WHATSAPP_CREDENTIAL_SELECT) builds a valid projection', () => {
  const q = Client.findOne({ clientId: '__nonexistent__' }).select(WHATSAPP_CREDENTIAL_SELECT);
  const projection = q.projection();
  assert.ok(projection);
  assert.equal(projection.config, undefined, 'must not project whole Mixed config object');
  assert.equal(projection['config.phoneNumberId'], 1);
});
