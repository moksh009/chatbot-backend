'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isCampaignEligible,
  isSystemExcluded,
  filterTemplatesForContext,
} = require('../utils/meta/templatePolicy');

test('hello_world excluded from campaign picker', () => {
  const templates = [
    {
      name: 'hello_world',
      status: 'APPROVED',
      category: 'MARKETING',
      primaryPurpose: 'campaign',
    },
    {
      name: 'summer_sale',
      status: 'APPROVED',
      category: 'MARKETING',
      primaryPurpose: 'campaign',
    },
  ];
  const { eligible } = filterTemplatesForContext(templates, 'campaign');
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].name, 'summer_sale');
});

test('utility templates not campaign eligible', () => {
  const t = {
    name: 'eco_order_confirmed',
    status: 'APPROVED',
    category: 'UTILITY',
    primaryPurpose: 'order_status',
  };
  assert.equal(isCampaignEligible(t), false);
  assert.equal(isSystemExcluded(t), false);
});
