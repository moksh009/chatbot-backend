const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY = crypto.createHash('sha256').update(String(process.env.ENCRYPTION_KEY || 'topedge_ai_secure_v1_2024_03_30_x!')).digest('base64').substring(0, 32);

/**
 * Encrypts a string using AES-256-CBC.
 * Returns a buffer-like string: iv:content
 */
function encrypt(text) {
  if (!text) return "";
  // --- ROBUSTNESS: Avoid double encryption ---
  if (typeof text === 'string' && text.includes(':') && text.length > 32) return text; 
  
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a string. 
 * Detects if the string is already plain text (backward compatibility).
 */
function decrypt(text) {
  if (!text) return "";
  if (!text.includes(':')) return text; // Backward compatibility for unencrypted tokens

  try {
    const [ivHex, encryptedHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error("[Encryption] Decryption failed. Returning raw value.", err.message);
    return text; // Fallback to raw if decryption fails (e.g. key changed)
  }
}

module.exports = { encrypt, decrypt };
