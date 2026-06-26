/**
 * LeadCleaner Utility
 * Handles normalization, fuzzy mapping, and data cleaning for lead imports.
 */

const { phoneForAdLeadStorage } = require('../core/phoneSanitizer');

const normalizePhone = (phone, defaultCountryCode = '91') => {
  if (!phone) return null;
  const country = String(defaultCountryCode) === '91' ? 'IN' : 'IN';
  return phoneForAdLeadStorage(phone, country);
};

const FUZZY_KEYS = {
    phone: ['ph', 'mob', 'contact', 'whatsapp', 'number', 'tel', 'cell'],
    name: ['first', 'full', 'customer', 'lead', 'client', 'person'],
    email: ['e-mail', 'mail', 'address']
};

const findBestMatch = (headers, target) => {
    const targetKeywords = FUZZY_KEYS[target] || [];
    return headers.find(h => {
        const lowerH = h.toLowerCase();
        return lowerH === target || targetKeywords.some(kw => lowerH.includes(kw));
    });
};

/** CSV wizard sends mapping as { "CSV Header": "phone" | "name" | ... } — resolve header name for a role. */
const resolveMappedHeader = (mapping, role) => {
    if (!mapping || typeof mapping !== 'object') return null;
    const hit = Object.entries(mapping).find(([, v]) => String(v || '').trim() === role);
    return hit ? hit[0] : null;
};

module.exports = {
    normalizePhone,
    findBestMatch,
    resolveMappedHeader,
    FUZZY_KEYS
};
