const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Middleware to verify that requests are actually from Meta/WhatsApp.
 */
exports.verifyMetaSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET;

  if (!signature) {
    console.warn('[Security] Missing x-hub-signature-256 header');
    return res.status(403).json({ success: false, message: 'Missing signature' });
  }

  if (!appSecret) {
    console.error('[Security] META_APP_SECRET is not defined in env');
    return next(); // Fallback for dev, but in prod this should fail
  }

  const elements = signature.split('=');
  const signatureHash = elements[1];
  
  // Use rawBody buffer captured in express.json verify hook
  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex');

  if (crypto.timingSafeEqual(Buffer.from(signatureHash), Buffer.from(expectedHash))) {
    next();
  } else {
    console.error('[Security] Signature mismatch');
    res.status(401).json({ success: false, message: 'Invalid signature' });
  }
};

/**
 * Middleware to verify Dashboard user tokens.
 */
exports.verifyDashboardToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Token invalid' });
    
    // Attach user/client context to request
    req.user = {
      userId: decoded.id,
      clientId: decoded.clientId,
      role: decoded.role
    };
    next();
  });
};
