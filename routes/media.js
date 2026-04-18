const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { protect } = require('../middleware/auth');
const log = require('../utils/logger')('MediaRoute');

// Configure storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB limit for videos
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/quicktime', 'audio/mpeg', 'audio/ogg', 'application/pdf', 'audio/wav', 'audio/webm'];
    const isVideo = file.mimetype.startsWith('video/');
    const isLarge = file.size > 5 * 1024 * 1024;

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error('Invalid file type'), false);
    }
    
    // Multer size limit is global, but we can check here if it's too large for non-video
    // Note: file.size might not be available in fileFilter depending on the storage engine, 
    // but with diskStorage it usually is. 
    cb(null, true);
  }
});


/**
 * @route   POST /api/media/upload
 * @desc    Upload a file locally and return the public URL
 */
router.post('/upload', protect, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const protocol = req.secure ? 'https' : 'http';
  const host = req.get('host');
  const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

  log.info(`File uploaded: ${req.file.filename} by ${req.user.clientId}`);

  res.json({
    success: true,
    url: fileUrl,
    filename: req.file.filename,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

module.exports = router;
