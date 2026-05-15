'use strict';

const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
  'Delhi',
  'Jammu and Kashmir',
  'Ladakh',
  'Puducherry',
  'Chandigarh',
];

/** @param {string|object|null|undefined} addressInput */
function addressToSearchString(addressInput) {
  if (!addressInput) return '';
  if (typeof addressInput === 'string') return addressInput;
  if (typeof addressInput === 'object') {
    return [
      addressInput.province,
      addressInput.province_code,
      addressInput.state,
      addressInput.city,
      addressInput.address1,
      addressInput.address2,
      addressInput.zip,
      addressInput.country,
    ]
      .filter(Boolean)
      .join(', ');
  }
  return String(addressInput);
}

/**
 * Extract Indian state name from a shipping address string or Shopify address object.
 * @param {string|object|null|undefined} addressInput
 * @returns {string|null}
 */
function extractStateFromAddress(addressInput) {
  const raw = addressToSearchString(addressInput).trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  for (const state of INDIAN_STATES) {
    if (lower.includes(state.toLowerCase())) return state;
  }
  return null;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build MongoDB $or clauses matching any of the given state names on order documents.
 * @param {string[]} states
 */
function buildStateMatchOr(states = []) {
  const list = (states || []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return null;

  const clauses = [];
  for (const state of list) {
    const re = new RegExp(escapeRegex(state), 'i');
    clauses.push(
      { state: re },
      { 'shippingAddress.province': re },
      { 'shippingAddress.state': re },
      { address: re },
      { 'shippingAddress.address1': re },
      { 'shippingAddress.city': re }
    );
  }
  return { $or: clauses };
}

module.exports = {
  INDIAN_STATES,
  addressToSearchString,
  extractStateFromAddress,
  buildStateMatchOr,
  escapeRegex,
};
