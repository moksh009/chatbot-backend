const crypto = require('crypto');
const { auditLog } = require('../services/audit/auditWriter');

/**
 * Meta webhook signature verification — no environment bypass in production.
 */
exports.verifyMetaSignature = (req, res, next) => {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET;

  if (!signature) {
    auditLog({
      category: 'security',
      action: 'webhook_signature_failed',
      severity: 'high',
      clientId: 'system',
      actor: { type: 'system', source: 'meta_webhook' },
      details: { reason: 'missing_signature' },
      blocking: true,
    });
    return res.status(401).end();
  }

  if (!appSecret) {
    console.error('[Security] META_APP_SECRET is not defined');
    return res.status(500).json({ success: false, message: 'Security misconfiguration' });
  }

  try {
    const elements = signature.split('=');
    const signatureHash = elements[1];
    const expectedHash = crypto
      .createHmac('sha256', appSecret)
      .update(req.rawBody)
      .digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(signatureHash), Buffer.from(expectedHash))) {
      return next();
    }
    auditLog({
      category: 'security',
      action: 'webhook_signature_failed',
      severity: 'high',
      clientId: 'system',
      actor: { type: 'system', source: 'meta_webhook' },
      details: { reason: 'signature_mismatch' },
      blocking: true,
    });
    return res.status(401).end();
  } catch (error) {
    console.error('[Security] Verification error:', error.message);
    return res.status(401).end();
  }
};
