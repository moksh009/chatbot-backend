const express = require('express');
const QRCode = require('qrcode');
const Client = require('../models/Client');
const GrowthQrScan = require('../models/GrowthQrScan');
const { protect } = require('../middleware/auth');

const router = express.Router();

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function resolveClientWhatsappNumber(client) {
  return (
    digitsOnly(client?.phoneNumber) ||
    digitsOnly(client?.platformVars?.adminWhatsappNumber) ||
    digitsOnly(client?.wabaAccounts?.[0]?.phoneNumber) ||
    ''
  );
}

router.get('/qr-code', protect, async (req, res) => {
  try {
    const source = String(req.query.source || 'qr').trim().slice(0, 40);
    const size = Math.max(120, Math.min(800, parseInt(req.query.size || '300', 10)));
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId })
      .select('clientId businessName phoneNumber platformVars.adminWhatsappNumber wabaAccounts.phoneNumber')
      .lean();
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const whatsappNumber = resolveClientWhatsappNumber(client);
    if (!whatsappNumber) {
      return res.status(400).json({ success: false, error: 'WhatsApp number not configured for QR redirect' });
    }

    const appUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const trackingUrl = `${appUrl}/api/public/growth/qr-redirect?clientId=${encodeURIComponent(clientId)}&source=${encodeURIComponent(source)}`;
    const qrDataUrl = await QRCode.toDataURL(trackingUrl, {
      width: size,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const scansThisWeek = await GrowthQrScan.countDocuments({ clientId, source, scannedAt: { $gte: weekAgo } });

    return res.json({
      success: true,
      source,
      trackingUrl,
      qrImageUrl: qrDataUrl,
      scansThisWeek,
      imgTag: `<img src="${trackingUrl}" alt="TopEdge QR (${source})" />`,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/qr-stats', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const source = String(req.query.source || '').trim();
    const match = source ? { clientId, source } : { clientId };
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [weekly, bySource] = await Promise.all([
      GrowthQrScan.countDocuments({ ...match, scannedAt: { $gte: weekAgo } }),
      GrowthQrScan.aggregate([
        { $match: { clientId } },
        { $group: { _id: '$source', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);
    return res.json({
      success: true,
      scansThisWeek: weekly,
      bySource: bySource.map((x) => ({ source: x._id || 'qr', count: x.count })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
