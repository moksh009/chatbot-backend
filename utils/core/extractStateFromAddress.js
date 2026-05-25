'use strict';

/** Shopify / India province codes → canonical state names */
const PROVINCE_CODE_TO_STATE = {
  AN: 'Andhra Pradesh',
  AP: 'Andhra Pradesh',
  AR: 'Arunachal Pradesh',
  AS: 'Assam',
  BR: 'Bihar',
  CG: 'Chhattisgarh',
  CH: 'Chandigarh',
  CT: 'Chhattisgarh',
  DL: 'Delhi',
  DN: 'Goa',
  GA: 'Goa',
  GJ: 'Gujarat',
  HP: 'Himachal Pradesh',
  HR: 'Haryana',
  JH: 'Jharkhand',
  JK: 'Jammu and Kashmir',
  KA: 'Karnataka',
  KL: 'Kerala',
  LA: 'Ladakh',
  LD: 'Ladakh',
  MH: 'Maharashtra',
  ML: 'Meghalaya',
  MN: 'Manipur',
  MP: 'Madhya Pradesh',
  MZ: 'Mizoram',
  NL: 'Nagaland',
  OR: 'Odisha',
  OD: 'Odisha',
  PB: 'Punjab',
  PY: 'Puducherry',
  RJ: 'Rajasthan',
  SK: 'Sikkim',
  TG: 'Telangana',
  TS: 'Telangana',
  TN: 'Tamil Nadu',
  TR: 'Tripura',
  UK: 'Uttarakhand',
  UT: 'Uttarakhand',
  UP: 'Uttar Pradesh',
  WB: 'West Bengal',
};

const PROVINCE_ALIASES = {
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
  delhi: 'Delhi',
  bombay: 'Maharashtra',
  mumbai: 'Maharashtra',
  bengaluru: 'Karnataka',
  bangalore: 'Karnataka',
  madras: 'Tamil Nadu',
  calcutta: 'West Bengal',
  orissa: 'Odisha',
  uttaranchal: 'Uttarakhand',
  pondicherry: 'Puducherry',
  pondy: 'Puducherry',
};

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
function normalizeProvinceToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  const code = t.toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length >= 2 && code.length <= 3 && PROVINCE_CODE_TO_STATE[code]) {
    return PROVINCE_CODE_TO_STATE[code];
  }
  const alias = PROVINCE_ALIASES[t.toLowerCase()];
  if (alias) return alias;
  for (const state of INDIAN_STATES) {
    if (t.toLowerCase() === state.toLowerCase()) return state;
  }
  return null;
}

function extractStateFromAddress(addressInput) {
  if (addressInput && typeof addressInput === 'object') {
    const fromCode = normalizeProvinceToken(addressInput.province_code);
    if (fromCode) return fromCode;
    const fromProvince = normalizeProvinceToken(addressInput.province);
    if (fromProvince) return fromProvince;
    const fromState = normalizeProvinceToken(addressInput.state);
    if (fromState) return fromState;
  }

  const raw = addressToSearchString(addressInput).trim();
  if (!raw) return null;

  const tokens = raw.split(/[,|/]+/).map((s) => s.trim()).filter(Boolean);
  for (const token of tokens) {
    const hit = normalizeProvinceToken(token);
    if (hit) return hit;
  }

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
