const crypto = require('crypto');
const ALGORITHM = 'aes-256-cbc';

function getKey() {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey) {
    console.warn('⚠️ WARNING: ENCRYPTION_KEY is not set in environment variables. IG Automation encryption will use an unsafe fallback key.');
    // Provide a dummy 32-byte hex key to prevent runtime crashes during boot
    return Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex');
  }
  return Buffer.from(hexKey, 'hex');
}

function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;
  const parts = encryptedText.split(':');
  if (parts.length !== 2) return encryptedText; // fallback if plain text was stored
  
  try {
    const [ivHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('⚠️ [Encryption] Decryption failed:', err.message);
    // Return original string instead of crashing. 
    // If it was an unencrypted token that happened to have a colon, it will still work.
    // If it was encrypted but the key is wrong (e.g. missing ENCRYPTION_KEY env), the API will gracefully reject it instead of crashing Node.
    return encryptedText;
  }
}

module.exports = { encrypt, decrypt };
