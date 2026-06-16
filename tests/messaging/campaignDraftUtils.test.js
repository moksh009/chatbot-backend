'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cloneCampaignDocument,
  applyCampaignPatch,
  CAMPAIGN_DRAFT_STATUSES,
} = require('../../utils/messaging/campaignDraftUtils');

test('cloneCampaignDocument resets send stats and assigns copy name', () => {
  const source = {
    name: 'Summer Sale',
    clientId: 'tenant_a',
    status: 'COMPLETED',
    sentCount: 420,
    templateName: 'promo_1',
    audience: [{ phone: '919999999999' }],
    toObject() {
      return { ...this };
    },
  };
  const clone = cloneCampaignDocument(source);
  assert.equal(clone.name, 'Summer Sale (copy)');
  assert.equal(clone.status, 'DRAFT');
  assert.equal(clone.sentCount, 0);
  assert.equal(clone.clientId, 'tenant_a');
  assert.equal(clone.templateName, 'promo_1');
  assert.equal(clone.audience.length, 1);
  assert.equal(clone._id, undefined);
});

test('applyCampaignPatch updates editable fields and channel', () => {
  const campaign = { status: 'DRAFT', channel: 'whatsapp', templateName: '' };
  applyCampaignPatch(campaign, {
    name: 'Updated',
    channel: 'email',
    emailSubject: 'Hello',
    templateName: 'tpl_1',
  });
  assert.equal(campaign.name, 'Updated');
  assert.equal(campaign.channel, 'email');
  assert.equal(campaign.emailSubject, 'Hello');
  assert.equal(campaign.templateName, 'tpl_1');
});

test('applyCampaignPatch schedules campaign when scheduledAt provided', () => {
  const campaign = { status: 'DRAFT', scheduledAt: null };
  applyCampaignPatch(campaign, { scheduledAt: '2026-07-01T10:00:00.000Z' });
  assert.equal(campaign.status, 'SCHEDULED');
  assert.ok(campaign.scheduledAt instanceof Date);
});

test('CAMPAIGN_DRAFT_STATUSES includes draft paused scheduled', () => {
  assert.ok(CAMPAIGN_DRAFT_STATUSES.has('DRAFT'));
  assert.ok(CAMPAIGN_DRAFT_STATUSES.has('PAUSED'));
  assert.ok(CAMPAIGN_DRAFT_STATUSES.has('SCHEDULED'));
  assert.equal(CAMPAIGN_DRAFT_STATUSES.has('COMPLETED'), false);
});
