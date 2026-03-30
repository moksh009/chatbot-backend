"use strict";

/**
 * Robust Phone Number Normalizer
 * Standardizes numbers into a consistent digits-only format with country code.
 * 
 * Logic for India (Priority):
 * 1. Strip all non-digits.
 * 2. If it starts with '0' and 11 digits, remove it and prepend '91'.
 * 3. If it's 10 digits, prepend '91'.
 * 
 * @param {string|number} phoneRaw 
 * @returns {string} Normalized phone number
 */
function normalizePhone(phoneRaw) {
    if (!phoneRaw) return "";
    let digits = String(phoneRaw).replace(/\D/g, "");
    if (digits.startsWith("0") && digits.length === 11) {
        digits = "91" + digits.slice(1);
    } else if (digits.length === 10) {
        digits = "91" + digits;
    }
    return digits;
}

function parseDateFromId(id, prefix) {
    const datePart = id.replace(prefix, ''); // "13072025"
    const day = datePart.slice(0, 2);
    const month = datePart.slice(2, 4);
    const year = datePart.slice(4);
    return `${year}-${month}-${day}`; // "2025-07-13"
}

module.exports = {
  normalizePhone,
  parseDateFromId
};