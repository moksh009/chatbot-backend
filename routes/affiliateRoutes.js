"use strict";

/**
 * affiliateRoutes.js — Phase 26 Track 8: Affiliate Program
 * Routes:
 *   POST   /api/affiliates/apply           → apply to become affiliate
 *   GET    /api/affiliates/:id/dashboard   → affiliate portal data
 *   PATCH  /api/affiliates/:id/bank        → update bank details
 *
 *   Admin:
 *   GET    /api/admin/affiliates           → list all affiliates
 *   PATCH  /api/admin/affiliates/:id/approve → set status = "active"
 *   GET    /api/admin/affiliates/payouts   → pending payouts
 *   POST   /api/admin/affiliates/:id/payout → process payout
 */

const express             = require('express');
const router              = express.Router();
const Affiliate           = require('../models/Affiliate');
const AffiliateConversion = require('../models/AffiliateConversion');
const Client              = require('../models/Client');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');

/* ══════════════════════════════════════════════
   PUBLIC: Apply to become an affiliate
   ══════════════════════════════════════════════ */
router.post('/apply', async (req, res) => {
  try {
    const { name, email, phone, bankDetails, commissionType } = req.body;
    if (!name || !email) {
      return res.status(400).json({ success: false, error: 'name and email are required' });
    }

    // Check for existing application
    const existing = await Affiliate.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'An application with this email already exists',
        status: existing.status
      });
    }

    const affiliate = await Affiliate.create({
      name:           name.trim(),
      email:          email.toLowerCase().trim(),
      phone:          phone || '',
      commissionType: commissionType || 'recurring',
      bankDetails:    bankDetails || {},
      status:         'pending'
    });

    res.status(201).json({
      success: true,
      message: 'Application submitted. You will be notified once approved.',
      affiliateCode: affiliate.affiliateCode
    });
  } catch (err) {
    console.error('[Affiliates] Apply error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══════════════════════════════════════════════
   AFFILIATE PORTAL DASHBOARD
   ══════════════════════════════════════════════ */
router.get('/:affiliateId/dashboard', authenticate, async (req, res) => {
  try {
    const affiliate = await Affiliate.findById(req.params.affiliateId).lean();
    if (!affiliate) {
      return res.status(404).json({ success: false, error: 'Affiliate not found' });
    }

    // Recent conversions (last 50)
    const conversions = await AffiliateConversion.find({ affiliateId: affiliate._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // Enrich with client business names
    const enriched = await Promise.all(conversions.map(async (conv) => {
      const client = await Client.findById(conv.clientId).select('businessName clientId').lean().catch(() => null);
      return {
        ...conv,
        clientName: client?.businessName || client?.clientId || conv.clientId
      };
    }));

    res.json({
      success:     true,
      affiliate,
      conversions: enriched
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Update bank details ────────────────────── */
router.patch('/:affiliateId/bank', authenticate, async (req, res) => {
  try {
    const { accountName, accountNumber, ifsc, upiId } = req.body;
    const affiliate = await Affiliate.findByIdAndUpdate(
      req.params.affiliateId,
      { bankDetails: { accountName, accountNumber, ifsc, upiId } },
      { new: true }
    );
    if (!affiliate) return res.status(404).json({ success: false });
    res.json({ success: true, bankDetails: affiliate.bankDetails });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ══════════════════════════════════════════════
   SUPER ADMIN: Affiliate management
   ══════════════════════════════════════════════ */

// List all affiliates
router.get('/', requireSuperAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const filter = status ? { status } : {};
    const total  = await Affiliate.countDocuments(filter);
    const items  = await Affiliate.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean();
    res.json({ success: true, affiliates: items, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Approve affiliate
router.patch('/:affiliateId/approve', requireSuperAdmin, async (req, res) => {
  try {
    const affiliate = await Affiliate.findByIdAndUpdate(
      req.params.affiliateId,
      { status: 'active' },
      { new: true }
    );
    if (!affiliate) return res.status(404).json({ success: false });
    res.json({ success: true, affiliate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update affiliate status
router.patch('/:affiliateId/status', requireSuperAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const affiliate = await Affiliate.findByIdAndUpdate(
      req.params.affiliateId,
      { status },
      { new: true }
    );
    if (!affiliate) return res.status(404).json({ success: false });
    res.json({ success: true, affiliate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get all pending payouts
router.get('/admin/payouts', requireSuperAdmin, async (req, res) => {
  try {
    const pending = await AffiliateConversion.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .lean();

    // Group by affiliate
    const byAffiliate = {};
    for (const conv of pending) {
      const affId = String(conv.affiliateId);
      if (!byAffiliate[affId]) byAffiliate[affId] = { total: 0, conversions: [] };
      byAffiliate[affId].total += conv.amount || 0;
      byAffiliate[affId].conversions.push(conv);
    }

    // Enrich with affiliate info
    const affiliateIds = Object.keys(byAffiliate);
    const affiliates   = await Affiliate.find({ _id: { $in: affiliateIds } }).lean();

    const result = affiliates.map(aff => ({
      affiliate:   aff,
      totalPending:byAffiliate[String(aff._id)]?.total || 0,
      conversions: byAffiliate[String(aff._id)]?.conversions || []
    }));

    res.json({ success: true, payouts: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Process payout (mark conversions as paid)
router.post('/:affiliateId/payout', requireSuperAdmin, async (req, res) => {
  try {
    const { amount, method, reference, conversionIds } = req.body;
    const now = new Date();

    // Mark specified conversions (or all pending) as paid
    const filter = {
      affiliateId: req.params.affiliateId,
      status: 'pending',
      ...(conversionIds?.length && { _id: { $in: conversionIds } })
    };

    const result = await AffiliateConversion.updateMany(
      filter,
      {
        status:          'paid',
        paidAt:          now,
        payoutReference: reference || '',
        notes:           `Paid via ${method || 'bank'}`
      }
    );

    // Update affiliate stats
    const paidAmount = amount || 0;
    await Affiliate.findByIdAndUpdate(
      req.params.affiliateId,
      {
        $inc: {
          'stats.pendingPayout': -paidAmount,
          'stats.paidOut':        paidAmount
        }
      }
    );

    res.json({
      success:          true,
      conversionsMarked:result.modifiedCount,
      amount:           paidAmount
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Track affiliate commission when a payment is made.
 * Called from Razorpay webhook handler.
 */
async function processAffiliateCommission(clientId, paymentAmount, razorpayPaymentId) {
  try {
    const client = await Client.findById(clientId).lean();
    if (!client?.affiliateRef) return;

    const affiliate = await Affiliate.findOne({ affiliateCode: client.affiliateRef });
    if (!affiliate || affiliate.status !== 'active') return;

    // 12-month cap on recurring commissions
    const previousPaymentCommissions = await AffiliateConversion.countDocuments({
      affiliateId:    affiliate._id,
      clientId,
      conversionType: 'payment'
    });

    if (affiliate.commissionType === 'recurring' && previousPaymentCommissions >= 12) {
      return; // Cap reached
    }

    // First payment = flat rate, recurring = percentage
    const isFirstPayment = previousPaymentCommissions === 0;
    const commissionAmount = (affiliate.commissionType === 'flat' && isFirstPayment)
      ? affiliate.flatAmount
      : Math.round(paymentAmount * (affiliate.recurringPercent || 15) / 100);

    if (commissionAmount <= 0) return;

    await AffiliateConversion.create({
      affiliateId:       affiliate._id,
      clientId,
      conversionType:    'payment',
      amount:            commissionAmount,
      status:            'pending',
      razorpayPaymentId: razorpayPaymentId || '',
      createdAt:         new Date()
    });

    await Affiliate.findByIdAndUpdate(affiliate._id, {
      $inc: {
        'stats.paidConversions': 1,
        'stats.totalEarned':     commissionAmount,
        'stats.pendingPayout':   commissionAmount
      }
    });

    console.log(`[Affiliates] Commission ₹${commissionAmount} created for ${affiliate.affiliateCode}`);
  } catch (err) {
    console.error('[Affiliates] processAffiliateCommission error:', err.message);
  }
}

/**
 * Track affiliate click/signup when a new client registers with a ref code.
 */
async function trackAffiliateSignup(clientId, affiliateCode) {
  try {
    if (!affiliateCode) return;
    const affiliate = await Affiliate.findOne({ affiliateCode });
    if (!affiliate || affiliate.status !== 'active') return;

    // Save ref on client
    await Client.findByIdAndUpdate(clientId, { affiliateRef: affiliateCode });

    // Create signup conversion record
    await AffiliateConversion.create({
      affiliateId:    affiliate._id,
      clientId,
      conversionType: 'signup',
      amount:         0, // no monetary value at signup
      status:         'approved',
      createdAt:      new Date()
    });

    await Affiliate.findByIdAndUpdate(affiliate._id, {
      $inc: { 'stats.signups': 1 }
    });

    console.log(`[Affiliates] Signup tracked for ${affiliateCode}`);
  } catch (err) {
    console.error('[Affiliates] trackAffiliateSignup error:', err.message);
  }
}

module.exports = router;
module.exports.processAffiliateCommission = processAffiliateCommission;
module.exports.trackAffiliateSignup       = trackAffiliateSignup;
