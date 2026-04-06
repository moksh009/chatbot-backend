"use strict";

/**
 * rtoMLPredictor.js — Phase 26 Track 2
 * ML-Enhanced RTO Risk Predictor using Gemini + historical RTOFeedback data.
 * Falls back to rule-based scorer when < 50 training records.
 */

const RTOPredictor     = require('./rtoPredictor');
const RTOFeedback      = require('../models/RTOFeedback');
const AdLead           = require('../models/AdLead');
const Message          = require('../models/Message');
const CampaignMessage  = require('../models/CampaignMessage');
const log              = require('./logger')('RTOMLPredictor');

/**
 * Main entry. Replaces RTOPredictor.calculateRisk in Shopify/WC webhook handlers.
 * @param {Object} client  - Client document
 * @param {string} phone   - Customer phone
 * @param {Object} order   - Shopify/WC order payload
 * @returns {Promise<Object>} { riskScore, riskLevel, factors, method, confidence, reasoning, modelAccuracy, trainingCount }
 */
async function calculateRTORiskML(client, phone, order) {
  // ── Step 1: Rule-based baseline (always computed) ────────────────────────
  let baseline;
  try {
    const lead = await AdLead.findOne({ phoneNumber: phone?.replace(/\D/g, ''), clientId: client._id || client.clientId }).lean();
    const customer = order.customer || {};
    baseline = await RTOPredictor.calculateRisk(order, customer, lead);
  } catch (err) {
    log.error('Baseline scorer failed', { error: err.message });
    baseline = { score: 50, riskLevel: 'Medium', indicators: [] };
  }

  // Old field name → normalize
  const baselineResult = {
    riskScore:  baseline.score || baseline.riskScore || 50,
    riskLevel:  baseline.riskLevel || 'Medium',
    factors:    baseline.indicators || baseline.factors || [],
    method:     'rules',
  };

  // ── Step 2: Check if we have enough training data ────────────────────────
  const clientId = client._id || client.clientId;
  const feedbackCount = await RTOFeedback.countDocuments({ clientId }).catch(() => 0);

  if (feedbackCount < 50) {
    // Not enough data — use rule-based only
    return {
      ...baselineResult,
      method:        'rules',
      trainingCount: feedbackCount,
      modelAccuracy: null
    };
  }

  // ── Step 3: Compute model accuracy from historical data ──────────────────
  let modelAccuracy = null;
  try {
    const highRiskTotal   = await RTOFeedback.countDocuments({ clientId, riskScoreAtTime: { $gte: 65 } });
    const highRiskReturned= await RTOFeedback.countDocuments({ clientId, riskScoreAtTime: { $gte: 65 }, actuallyReturned: true });
    modelAccuracy = highRiskTotal > 0
      ? parseFloat(((highRiskReturned / highRiskTotal) * 100).toFixed(1))
      : null;
  } catch { /* non-critical */ }

  // ── Step 4: Build feature vector ─────────────────────────────────────────
  const lead = await AdLead.findOne({ phoneNumber: phone?.replace(/\D/g, ''), clientId }).lean().catch(() => null);

  const isCOD = ['manual','cod','cash'].some(k => (order.gateway || '').toLowerCase().includes(k));
  let msgCount = 0, campaignIgnored = 0;
  try {
    msgCount        = await Message.countDocuments({ clientId, phone, direction: 'incoming' });
    campaignIgnored = await CampaignMessage.countDocuments({
      clientId, phone, readAt: null,
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) }
    });
  } catch { /* non-critical */ }

  const features = {
    isCOD,
    isFirstOrder:       (lead?.ordersCount || 0) === 0,
    prevRTOCount:       lead?.rtoCount       || 0,
    leadScore:          lead?.leadScore       || 0,
    msgCountBefore:     msgCount,
    orderValue:         parseFloat(order.total_price || order.totalPrice || 0),
    prevOrders:         lead?.ordersCount     || 0,
    campaignIgnored,
    hourOfOrder:        new Date().getHours()
  };

  // ── Step 5: Get recent RTO patterns ──────────────────────────────────────
  const recentRTOs = await RTOFeedback.find({ clientId, actuallyReturned: true })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean()
    .catch(() => []);

  const patternSummary = recentRTOs.length > 0
    ? recentRTOs.slice(0, 10).map(r =>
        `RTO: COD=${r.features.isCOD}, FirstOrder=${r.features.isFirstOrder}, PrevRTOs=${r.features.prevRTOCount}, Score=${r.features.leadScore}, Messages=${r.features.msgCountBefore}`
      ).join('\n')
    : 'No confirmed RTO patterns yet.';

  // ── Step 6: Ask Gemini ────────────────────────────────────────────────────
  const prompt = `You are an RTO (Return to Origin) risk classifier for an Indian e-commerce business.

Recent confirmed RTO cases for this business (patterns to learn from):
${patternSummary}

New order to classify:
- COD: ${features.isCOD}
- First order: ${features.isFirstOrder}
- Previous RTOs: ${features.prevRTOCount}
- Lead score: ${features.leadScore}/100
- Messages before order: ${features.msgCountBefore}
- Order value: ₹${features.orderValue}
- Previous orders: ${features.prevOrders}
- Campaigns ignored: ${features.campaignIgnored}
- Hour of order: ${features.hourOfOrder}:00 IST
- Baseline rule score: ${baselineResult.riskScore}/100

Based on the historical patterns, estimate the RTO probability (0-100).
Be calibrated — not every COD order is returned.
Return ONLY valid JSON with no markdown: {"riskScore":<number>,"confidence":"high|medium|low","reasoning":"<one sentence>"}`;

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const apiKey  = client.geminiApiKey || client.ai?.geminiKey || process.env.GEMINI_API_KEY;
    const genAI   = new GoogleGenerativeAI(apiKey);
    const model   = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    const result  = await model.generateContent(prompt);
    const raw     = result.response.text().replace(/```json|```/g, '').trim();
    const parsed  = JSON.parse(raw);

    // Blend: 30% rules + 70% ML
    const finalScore = Math.min(100, Math.max(0, Math.round(
      (baselineResult.riskScore * 0.3) + ((parsed.riskScore || 50) * 0.7)
    )));
    const riskLevel = finalScore >= 65 ? 'HIGH' : finalScore >= 40 ? 'MEDIUM' : 'LOW';

    // ── Save feedback record for future training ──────────────────────────
    await RTOFeedback.findOneAndUpdate(
      { clientId, orderId: String(order.id || order.orderNumber || order.order_id || Date.now()) },
      {
        clientId, phone,
        orderId:         String(order.id || order.orderNumber || order.order_id || Date.now()),
        features,
        riskScoreAtTime: finalScore,
        method:          'ml_enhanced',
        actuallyReturned:false,
        createdAt:       new Date()
      },
      { upsert: true, setDefaultsOnInsert: true }
    ).catch(() => {});

    return {
      riskScore:    finalScore,
      riskLevel,
      factors:      baselineResult.factors,
      method:       'ml_enhanced',
      confidence:   parsed.confidence || 'medium',
      reasoning:    parsed.reasoning  || '',
      modelAccuracy,
      trainingCount:feedbackCount
    };
  } catch (err) {
    log.warn('Gemini ML scorer failed, using rules fallback', { error: err.message });
    return { ...baselineResult, method: 'rules_fallback', trainingCount: feedbackCount, modelAccuracy };
  }
}

/**
 * Called when a Shopify order is marked "returned" or "refunded".
 * Updates RTOFeedback ground truth and increments lead.rtoCount.
 */
async function markOrderReturned(clientId, orderId, phone) {
  try {
    await RTOFeedback.findOneAndUpdate(
      { clientId, orderId: String(orderId) },
      { actuallyReturned: true }
    );
    if (phone) {
      await AdLead.findOneAndUpdate(
        { phoneNumber: phone.replace(/\D/g, ''), clientId },
        { $inc: { rtoCount: 1 } }
      );
    }
    log.info('RTOFeedback ground truth updated', { orderId, clientId });
  } catch (err) {
    log.error('markOrderReturned failed', { error: err.message });
  }
}

module.exports = { calculateRTORiskML, markOrderReturned };
