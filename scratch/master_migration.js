const mongoose = require('mongoose');
const crypto = require('crypto');
require('dotenv').config();
const Client = require('../models/Client');

const ALGORITHM = 'aes-256-cbc';
const FALLBACK_KEY = Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex');
const CURRENT_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

function decryptWithKey(encryptedText, key) {
  if (!encryptedText || typeof encryptedText !== 'string') return null;
  const parts = encryptedText.split(':');
  if (parts.length !== 2) return encryptedText; // was plain text
  try {
    const [ivHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

function encryptWithCurrentKey(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, CURRENT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const clients = await Client.find({});
    console.log(`Found ${clients.length} clients. Checking tokens...`);

    for (const client of clients) {
      let changed = false;

      // Fields to check
      const fields = [
        'instagramAccessToken', 'whatsappToken', 'shopifyAccessToken', 
        'social.instagram.accessToken', 'social.metaAds.accessToken',
        'emailAppPassword' // Added this
      ];

      for (const field of fields) {
        let val;
        if (field.includes('.')) {
           val = field.split('.').reduce((o, i) => o?.[i], client);
        } else {
           val = client.get(field); // Use .get() to avoid mongoose magic
        }
        
        if (!val || typeof val !== 'string') continue;

        console.log(`Checking ${client.clientId} -> ${field}...`);

        // Try decrypt with current key
        let decrypted = decryptWithKey(val, CURRENT_KEY);
        
        if (decrypted === null) {
          console.log(`  - Decryption failed with current key for ${field}. Trying fallback...`);
          // Decryption failed with current key. Try fallback key.
          decrypted = decryptWithKey(val, FALLBACK_KEY);
          
          if (decrypted !== null) {
            console.log(`  [Fix] Found valid token with fallback key for ${field}. Migrating...`);
            const newVal = encryptWithCurrentKey(decrypted);
            
            if (field.includes('.')) {
               const parts = field.split('.');
               const last = parts.pop();
               const parent = parts.reduce((o, i) => o[i], client);
               parent[last] = newVal;
            } else {
               client.set(field, newVal);
            }
            changed = true;
          } else {
            console.log(`  - Decryption failed with fallback key too.`);
            // Decryption failed with both. Check if it's raw text.
            if (!val.includes(':')) {
                console.log(`  [Fix] Field ${field} is raw text. Encrypting...`);
                const newVal = encryptWithCurrentKey(val);
                if (field.includes('.')) {
                    const parts = field.split('.');
                    const last = parts.pop();
                    const parent = parts.reduce((o, i) => o[i], client);
                    parent[last] = newVal;
                 } else {
                    client.set(field, newVal);
                 }
                 changed = true;
            }
          }
        } else {
          console.log(`  - Decryption successful with current key.`);
        }
      }

      if (changed) {
        await client.save();
        console.log(`  [Save] Updated client ${client.clientId}`);
      }
    }

    console.log('Migration complete.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

migrate();
