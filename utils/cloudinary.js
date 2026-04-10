// const cloudinary = require('cloudinary').v2;
// 
// cloudinary.config({
//   cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
//   api_key: process.env.CLOUDINARY_API_KEY,
//   api_secret: process.env.CLOUDINARY_API_SECRET
// });

/**
 * [MOCK] Uploads a file buffer to Cloudinary and returns the secure URL
 * Cloudinary has been removed as per user request. AWS S3 implementation pending.
 */
exports.uploadToCloud = async (fileBuffer, folder = 'chat_media', resourceType = 'auto') => {
  console.log('[Mock Cloudinary] Media upload requested but Cloudinary is disabled.');
  // Return a local public URL if you have a local upload folder, 
  // or just throw an error that the feature is temporarily disabled.
  return "https://via.placeholder.com/500?text=Cloudinary+Disabled";
};

exports.cloudinary = null;

