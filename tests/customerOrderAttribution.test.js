'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  namesAreSimilar,
  scoreOrderForCustomer,
  assignOrdersToCustomers,
  SCORE,
  phoneSuffixKey,
} = require('../utils/shopify/customerOrderAttribution');

describe('customerOrderAttribution', () => {
  const sharedPhone = '9879095371';

  const mokshProfile = {
    id: '100',
    first_name: 'Moksh',
    last_name: 'Patel',
    phone: sharedPhone,
    linkedPhones: [sharedPhone],
    linkedEmails: ['moksh2031@gmail.com'],
    mergedCustomerIds: ['100'],
    total_spent: '50000',
  };

  const mamtaProfile = {
    id: '200',
    first_name: 'Mamta',
    last_name: 'Patel',
    phone: sharedPhone,
    linkedPhones: [sharedPhone],
    linkedEmails: [],
    mergedCustomerIds: ['200'],
    total_spent: '10000',
  };

  it('namesAreSimilar — Moksh vs mOx, not Mamta vs Moksh', () => {
    assert.equal(namesAreSimilar('Moksh Patel', 'mOx Patel'), true);
    assert.equal(namesAreSimilar('Mamta Patel', 'Moksh Patel'), false);
  });

  it('scoreOrderForCustomer — Shopify customer id wins over shared phone', () => {
    const order = {
      shopifyCustomerId: '200',
      customerPhone: sharedPhone,
      customerName: 'Mamta Patel',
      customerEmail: '',
    };
    assert.equal(scoreOrderForCustomer(order, mamtaProfile), SCORE.SHOPIFY_CUSTOMER_ID);
    assert.equal(scoreOrderForCustomer(order, mokshProfile), SCORE.PHONE_ONLY);
  });

  it('assignOrdersToCustomers — Mamta order on Mamta profile, not Moksh, when names differ', () => {
    const order = {
      _id: 'o1023',
      orderNumber: '1023',
      shopifyCustomerId: '',
      customerPhone: sharedPhone,
      customerName: 'Mamta Patel',
      totalPrice: 10,
      createdAt: new Date(),
    };
    const { assignment, unassigned } = assignOrdersToCustomers(
      [mokshProfile, mamtaProfile],
      [order]
    );
    assert.equal(assignment.get('100').length, 0);
    assert.equal(assignment.get('200').length, 1);
    assert.equal(unassigned.length, 0);
  });

  it('assignOrdersToCustomers — Mamta order on Mamta when shopifyCustomerId set', () => {
    const order = {
      _id: 'o1023',
      orderNumber: '1023',
      shopifyCustomerId: '200',
      customerPhone: sharedPhone,
      customerName: 'Mamta Patel',
      totalPrice: 10,
      createdAt: new Date(),
    };
    const { assignment } = assignOrdersToCustomers([mokshProfile, mamtaProfile], [order]);
    assert.equal(assignment.get('200').length, 1);
    assert.equal(assignment.get('100').length, 0);
  });

  it('assignOrdersToCustomers — Nakshu orders exclusive, no duplicate across profiles', () => {
    const nakshuPhone = {
      id: '300',
      first_name: 'Nakshu',
      last_name: 'Patel',
      phone: '9104245084',
      linkedPhones: ['9104245084'],
      linkedEmails: [],
      mergedCustomerIds: ['300'],
      total_spent: '20000',
    };
    const nakshuEmail = {
      id: '301',
      first_name: 'Nakshu',
      last_name: 'Patel',
      email: 'nakhujpatel@gmail.com',
      linkedEmails: ['nakhujpatel@gmail.com'],
      linkedPhones: [],
      mergedCustomerIds: ['301'],
      total_spent: '5000',
    };
    const orders = [
      {
        _id: 'o1026',
        orderNumber: '1026',
        shopifyCustomerId: '300',
        customerPhone: '9104245084',
        customerEmail: '',
        customerName: 'Nakshu Patel',
        totalPrice: 10,
        createdAt: new Date('2026-03-09'),
      },
      {
        _id: 'o1019',
        orderNumber: '1019',
        shopifyCustomerId: '301',
        customerPhone: '9104245084',
        customerEmail: 'nakhujpatel@gmail.com',
        customerName: 'Nakshu Patel',
        totalPrice: 6999,
        createdAt: new Date('2026-02-21'),
      },
      {
        _id: 'o1018',
        orderNumber: '1018',
        shopifyCustomerId: '301',
        customerPhone: '9104245084',
        customerEmail: 'nakhujpatel@gmail.com',
        customerName: 'Nakshu Patel',
        totalPrice: 5999,
        createdAt: new Date('2026-02-21'),
      },
      {
        _id: 'o1012',
        orderNumber: '1012',
        shopifyCustomerId: '300',
        customerPhone: '9104245084',
        customerEmail: '',
        customerName: 'Nakshu Patel',
        totalPrice: 6999,
        createdAt: new Date('2026-02-20'),
      },
    ];
    const { assignment } = assignOrdersToCustomers([nakshuPhone, nakshuEmail], orders);
    const allAssigned = [
      ...assignment.get('300'),
      ...assignment.get('301'),
    ];
    assert.equal(allAssigned.length, 4);
    const nums = allAssigned.map((o) => o.orderNumber).sort();
    assert.deepEqual(nums, ['1012', '1018', '1019', '1026']);
    const on300 = assignment.get('300').map((o) => o.orderNumber).sort();
    const on301 = assignment.get('301').map((o) => o.orderNumber).sort();
    assert.ok(!on300.includes('1018') || !on301.includes('1018') || on300.length + on301.length === 4);
    assert.equal(new Set(allAssigned.map((o) => o.orderNumber)).size, 4);
  });

  it('placeholder phone is ignored', () => {
    assert.equal(phoneSuffixKey('0000000000'), '');
    const order = {
      customerPhone: '0000000000',
      customerName: 'Guest',
      customerEmail: '',
    };
    assert.equal(scoreOrderForCustomer(order, mokshProfile), 0);
  });
});
