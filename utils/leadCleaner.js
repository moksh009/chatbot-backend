/**
 * LeadCleaner Utility
 * Handles normalization, fuzzy mapping, and data cleaning for lead imports.
 */

const normalizePhone = (phone, defaultCountryCode = '91') => {
    if (!phone) return null;
    let cleaned = String(phone).replace(/\D/g, '');
    
    // Auto-fix 10-digit numbers for common regions (default India)
    if (cleaned.length === 10) {
        cleaned = defaultCountryCode + cleaned;
    }
    
    return cleaned;
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

module.exports = {
    normalizePhone,
    findBestMatch,
    FUZZY_KEYS
};
