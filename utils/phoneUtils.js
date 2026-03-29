"use strict";

/**
 * Robust Phone Number Normalizer
 * Standardizes numbers into a consistent digits-only format with country code.
 * 
 * Logic for India (Priority):
 * 1. Strip all non-digits.
 * 2. If it starts with '0', remove it and prepend '91'.
 * 3. If it's 10 digits, prepend '91'.
 * 4. Ensure no leading '+'.
 * 
 * @param {string|number} phoneRaw 
 * @returns {string} Normalized phone number
 */
function normalizePhone(phoneRaw) {
    if (!phoneRaw) return "";
    
    // Strip everything except digits
    let digits = String(phoneRaw).replace(/\D/g, "");
    
    // Handle India-specific cases
    if (digits.startsWith("0") && digits.length === 11) {
        // e.g. 09313045439 -> 919313045439
        digits = "91" + digits.slice(1);
    } else if (digits.length === 10) {
        // e.g. 9313045439 -> 919313045439
        digits = "91" + digits;
    }
    
    return digits;
}

module.exports = { normalizePhone };
