const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Uploads a file buffer to Cloudinary and returns the secure URL
 * @param {Buffer} fileBuffer - The file buffer from multer
 * @param {String} folder - Optional folder name
 * @param {String} resourceType - 'image', 'video', or 'raw'
 */
exports.uploadToCloud = async (fileBuffer, folder = 'chat_media', resourceType = 'auto') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
      },
      (error, result) => {
        if (error) {
          console.error('[Cloudinary] Upload error:', error);
          return reject(error);
        }
        resolve(result.secure_url);
      }
    );

    uploadStream.end(fileBuffer);
  });
};

exports.cloudinary = cloudinary;
