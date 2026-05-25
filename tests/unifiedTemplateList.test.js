'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildUnifiedLibraryResponse,
  buildUnifiedContextResponse,
} = require('../utils/meta/unifiedTemplateList');

const sample = [
  { name: 'hello_world', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] },
  {
    name: 'promo_sale',
    status: 'APPROVED',
    category: 'MARKETING',
    primaryPurpose: 'campaign',
    components: [{ type: 'BODY', text: 'Sale {{1}} ends soon' }],
  },
  {
    name: 'eco_order_confirmed',
    status: 'APPROVED',
    category: 'UTILITY',
    primaryPurpose: 'order_status',
    components: [{ type: 'BODY', text: 'Order {{1}} confirmed' }],
  },
  {
    name: 'draft_tpl',
    status: 'DRAFT',
    category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Draft body text here' }],
  },
];

test('buildUnifiedLibraryResponse — excludes system templates from display', () => {
  const { data, meta } = buildUnifiedLibraryResponse(sample);
  assert.ok(!data.some((t) => t.name === 'hello_world'));
  assert.equal(meta.systemExcluded, 1);
  assert.ok(data.every((t) => t.eligibleFor));
});

test('buildUnifiedContextResponse — campaign MARKETING only', () => {
  const { data, meta } = buildUnifiedContextResponse(sample, 'campaign');
  assert.equal(data.length, 1);
  assert.equal(data[0].name, 'promo_sale');
  assert.equal(meta.eligibleTotal, 1);
  assert.equal(meta.hiddenSystem, 1);
});
