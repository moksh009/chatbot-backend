'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CodToPrepaidConversion = require('../../models/CodToPrepaidConversion');

describe('CodToPrepaidConversion model (Part 1)', () => {
  it('defines all required lifecycle status values', () => {
    const statuses = CodToPrepaidConversion.schema.path('status').enumValues;
    const required = [
      'draft_order_pending',
      'draft_order_created',
      'message_sent',
      'converted',
      'expired_by_timer',
      'expired_by_fulfillment',
      'draft_creation_failed',
      'message_send_failed',
    ];
    for (const s of required) {
      assert.ok(statuses.includes(s), `missing status enum: ${s}`);
    }
  });

  it('requires core journey + order identity fields', () => {
    const requiredPaths = [
      'clientId',
      'journeyId',
      'enrollmentId',
      'contactPhone',
      'originalCodOrderId',
      'originalCodOrderName',
      'originalCodOrderGid',
      'metaTemplateId',
      'metaTemplateName',
      'freezeMode',
    ];
    for (const path of requiredPaths) {
      assert.equal(CodToPrepaidConversion.schema.path(path).isRequired, true, path);
    }
  });

  it('registers all Part 1 indexes including expiresAt + status', () => {
    const keys = CodToPrepaidConversion.schema.indexes().map((idx) => JSON.stringify(idx[0]));
    assert.ok(keys.some((k) => k.includes('clientId') && k.includes('status')));
    assert.ok(keys.some((k) => k.includes('enrollmentId')));
    assert.ok(keys.some((k) => k.includes('draftOrderId')));
    assert.ok(keys.some((k) => k.includes('originalCodOrderId')));
    assert.ok(keys.some((k) => k.includes('expiresAt') && k.includes('status')));
  });
});
