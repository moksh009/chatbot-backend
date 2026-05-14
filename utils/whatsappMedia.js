const axios = require('axios');
const fs = require('fs');
const path = require('path');
const log = require('./logger')('WhatsAppMedia');
const { getEffectiveWhatsAppAccessToken } = require('./clientWhatsAppCreds');

/**
 * Utility to handle WhatsApp Media resolution and local storage.
 * Ensures media is stored permanently on our server for fast delivery.
 */

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'media');

// Ensure directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Resolves a WhatsApp Media ID to a local URL.
 * 1. Fetches download URL from Meta
 * 2. Downloads binary data
 * 3. Saves to local uploads directory
 */
async function resolveAndSaveMedia(mediaId, client, extension = 'bin') {
  const token = getEffectiveWhatsAppAccessToken(client) || process.env.WHATSAPP_TOKEN;
  if (!token) {
    log.error('WhatsApp Token missing for media resolution');
    return null;
  }

  try {
    log.info(`Resolving media ID: ${mediaId}`);
    
    // 1. Fetch media metadata from Meta
    const metadataRes = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const downloadUrl = metadataRes.data.url;
    const mimeType = metadataRes.data.mime_type;
    
    // Determine extension from mime-type if not provided
    if (mimeType.includes('image/jpeg')) extension = 'jpg';
    else if (mimeType.includes('image/png')) extension = 'png';
    else if (mimeType.includes('video/mp4')) extension = 'mp4';
    else if (mimeType.includes('audio/ogg')) extension = 'ogg';
    else if (mimeType.includes('audio/mpeg')) extension = 'mp3';
    else if (mimeType.includes('application/pdf')) extension = 'pdf';

    const filename = `${mediaId}.${extension}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    // If file already exists locally, just return the URL
    if (fs.existsSync(filePath)) {
      return `/uploads/media/${filename}`;
    }

    // 2. Download binary data
    const mediaRes = await axios.get(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    });

    // 3. Save to disk
    fs.writeFileSync(filePath, mediaRes.data);
    log.success(`Media saved locally: ${filename}`);

    return `/uploads/media/${filename}`;
  } catch (err) {
    log.error(`Failed to resolve media ${mediaId}:`, err.response?.data || err.message);
    return null;
  }
}

/**
 * Uploads a local file to Meta's Media API to get a media_id for sending.
 */
async function uploadToWhatsApp(filePath, phoneNumberId, token) {
  try {
    const formData = new (require('form-data'))();
    formData.append('file', fs.createReadStream(filePath));
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', 'image'); // Default to image, though WhatsApp is strict

    const res = await axios.post(`https://graph.facebook.com/v21.0/${phoneNumberId}/media`, formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${token}`
      }
    });

    return res.data.id;
  } catch (err) {
    log.error('Failed to upload to WhatsApp:', err.response?.data || err.message);
    return null;
  }
}

module.exports = {
  resolveAndSaveMedia,
  uploadToWhatsApp
};
