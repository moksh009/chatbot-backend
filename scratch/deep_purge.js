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

async function deepPurge() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const clients = await Client.find({});
    console.log(`Found ${clients.length} clients. Performing Deep Purge...`);

    const encFields = [
      'ai.geminiKey', 'ai.openaiKey', 'social.instagram.accessToken', 'social.instagram.appSecret', 'social.metaAds.accessToken',
      'social.metaAds.appSecret', 'whatsappToken', 'shopifyAccessToken', 'shopifyClientId', 'shopifyClientSecret',
      'shopifyRefreshToken', 'shopifyWebhookSecret', 'metaAppId', 'metaAppSecret', 'metaAccessToken', 'metaAdsToken',
      'instagramAccessToken', 'instagramAppSecret', 'googleAccessToken', 'googleRefreshToken', 'gmailAddress',
      'geminiApiKey', 'openaiApiKey', 'razorpayKeyId', 'razorpaySecret', 'cashfreeAppId', 'cashfreeSecretKey', 'emailAppPassword'
    ];

    for (const client of clients) {
      let changed = false;
      let unsets = {};

      for (const field of encFields) {
        let val;
        try {
            if (field.includes('.')) {
                val = field.split('.').reduce((o, i) => o?.[i], client);
            } else {
                val = client.get(field);
            }
        } catch (e) { continue; }
        
        if (!val || typeof val !== 'string') continue;

        // Check if it's in encrypted format
        const isEncFormat = val.split(':').length === 2 && val.split(':')[0].length === 32;
        if (!isEncFormat) {
            // It's raw text. Encrypt it with current key.
            console.log(`[DeepPurge] ${client.clientId} -> ${field}: Raw text found. Encrypting...`);
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
            continue;
        }

        // Try decrypt with current key
        let decrypted = decryptWithKey(val, CURRENT_KEY);
        
        if (decrypted === null) {
          // Decryption failed with current key. Try fallback key.
          decrypted = decryptWithKey(val, FALLBACK_KEY);
          
          if (decrypted !== null) {
            console.log(`[DeepPurge] ${client.clientId} -> ${field}: Migrated from fallback key.`);
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
            // PERMANENTLY BROKEN
            console.log(`[DeepPurge] ${client.clientId} -> ${field}: ❌ Permanently broken. Unsetting.`);
            unsets[field] = 1;
            changed = true;
          }
        }
      }

      if (changed) {
        if (Object.keys(unsets).length > 0) {
            await Client.updateOne({ _id: client._id }, { $unset: unsets });
            // Re-fetch to apply remaining changes via .save()
            const updatedClient = await Client.findById(client._id);
            await updatedClient.save();
        } else {
            await client.save();
        }
        console.log(`[DeepPurge] ${client.clientId}: Updated successfully.`);
      }
    }

    console.log('Deep Purge complete.');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

deepPurge();
