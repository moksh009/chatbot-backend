const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolvePublicUrl } = require('./resolvePublicUrl');

const OUTBOUND_MEDIA_DIR = path.join(__dirname, '..', '..', 'uploads', 'outbound-media');

if (!fs.existsSync(OUTBOUND_MEDIA_DIR)) {
  fs.mkdirSync(OUTBOUND_MEDIA_DIR, { recursive: true });
}

function extFromMime(mime = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'bin';
}

/**
 * Store outbound Live Chat media on local disk (S3 optional via env later).
 * Returns a public HTTPS URL suitable for Meta WhatsApp media send.
 */
exports.uploadToCloud = async (fileBuffer, folder = 'chat_media', resourceType = 'auto', mimeType = '') => {
  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new Error('uploadToCloud requires a file buffer');
  }

  const ext = extFromMime(mimeType || resourceType);
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const relPath = `/uploads/outbound-media/${filename}`;
  const absPath = path.join(OUTBOUND_MEDIA_DIR, filename);

  fs.writeFileSync(absPath, fileBuffer);

  const publicUrl = resolvePublicUrl(relPath);
  if (!publicUrl) {
    throw new Error('PUBLIC_BASE_URL is required for WhatsApp media upload in production');
  }
  return publicUrl;
};

exports.cloudinary = null;
