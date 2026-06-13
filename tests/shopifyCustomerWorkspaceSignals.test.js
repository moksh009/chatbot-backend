'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  appendWorkspaceCustomers,
  resolveWarrantyForCustomer,
  collectCustomerIdentityKeys,
} = require('../utils/shopify/shopifyCustomerWorkspaceSignals');
const { mergeWarrantyCounts } = require('../utils/shopify/shopifyCustomerEnrichment');
const { filterCustomers } = require('../utils/shopify/shopifyCustomersHub');

describe('shopifyCustomerWorkspaceSignals', () => {
  const warrantyMaps = {
    byContactId: new Map([
      [
        'c1',
        {
          contactId: 'c1',
          name: 'Rajender Shukla',
          phone: '919930992355',
          email: '',
          total: 3,
          active: 3,
        },
      ],
      [
        'c2',
        {
          contactId: 'c2',
          name: 'Tilva Smit',
          phone: '919484607042',
          email: '',
          total: 6,
          active: 0,
        },
      ],
    ]),
    byPhone: new Map([
      ['9930992355', { contactId: 'c1', total: 3, active: 3 }],
      ['9484607042', { contactId: 'c2', total: 6, active: 0 }],
    ]),
    byEmail: new Map(),
  };

  it('resolveWarrantyForCustomer matches Shopify row by phone suffix', () => {
    const hit = resolveWarrantyForCustomer(
      { phone: '9930992355', linkedPhones: ['9930992355'] },
      warrantyMaps
    );
    assert.equal(hit.contactId, 'c1');
    assert.equal(hit.total, 3);
  });

  it('appendWorkspaceCustomers adds warranty contacts missing from Shopify cache', () => {
    const out = appendWorkspaceCustomers([], warrantyMaps);
    assert.equal(out.length, 2);
    assert.ok(out.some((c) => c.id === 'contact:c1' && c.warrantyTotal === 3));
    assert.ok(out.some((c) => c.id === 'contact:c2' && c.warrantyTotal === 6));
  });

  it('appendWorkspaceCustomers does not duplicate matched Shopify customer', () => {
    const shopify = [
      {
        id: '100',
        first_name: 'Rajender',
        last_name: 'Shukla',
        phone: '919930992355',
        linkedPhones: ['919930992355'],
        warrantyTotal: 3,
      },
    ];
    const out = appendWorkspaceCustomers(shopify, warrantyMaps);
    assert.equal(out.length, 2);
    assert.equal(out.filter((c) => String(c.id).startsWith('contact:')).length, 1);
    assert.ok(out.some((c) => c.id === 'contact:c2'));
  });

  it('mergeWarrantyCounts prefers canonical WarrantyRecord over legacy lead array', () => {
    const merged = mergeWarrantyCounts(
      true,
      { total: 6, active: 0 },
      [{ status: 'active' }]
    );
    assert.equal(merged.warrantyTotal, 6);
    assert.equal(merged.warrantyActive, 1);
  });

  it('filterCustomers has_warranty includes terminated-only profiles', () => {
    const list = [
      { id: 1, total_spent: '0', warrantyTotal: 0 },
      { id: 2, total_spent: '0', warrantyTotal: 6, warrantyActive: 0 },
      { id: 3, total_spent: '100', warrantyTotal: 3, warrantyActive: 3 },
    ];
    const filtered = filterCustomers(list, { topedge: 'has_warranty' });
    assert.equal(filtered.length, 2);
    assert.deepEqual(
      filtered.map((c) => c.id).sort(),
      [2, 3]
    );
  });

  it('collectCustomerIdentityKeys gathers linked phones and emails', () => {
    const keys = collectCustomerIdentityKeys({
      phone: '919930992355',
      linkedPhones: ['9876543210'],
      email: 'a@test.com',
      linkedEmails: ['b@test.com'],
      contactId: 'c1',
    });
    assert.ok(keys.phones.has('9930992355'));
    assert.ok(keys.phones.has('9876543210'));
    assert.ok(keys.emails.has('a@test.com'));
    assert.ok(keys.emails.has('b@test.com'));
    assert.ok(keys.contactIds.has('c1'));
  });
});
