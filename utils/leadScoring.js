"use strict";

const calculateLeadScore = (lead) => {
  let score = 0;
  
  // Base activity points
  score += (lead.ordersCount || 0) * 50;
  score += (lead.appointmentsBooked || 0) * 50;
  score += (lead.checkoutInitiatedCount || 0) * 30;
  score += (lead.addToCartCount || 0) * 20;
  score += (lead.linkClicks || 0) * 5;
  score += (lead.interactionCount || 0) * 2;
  
  // Recency bonus (if interaction within last 24 hours)
  const msSinceLast = (new Date() - new Date(lead.lastInteraction));
  const daysSinceLast = msSinceLast / (1000 * 60 * 60 * 24);
  
  if (daysSinceLast < 1) score += 25;
  else if (daysSinceLast < 3) score += 10;
  
  return Math.max(0, Math.round(score));
};

const getLeadTags = (lead, score) => {
  const tags = new Set(lead.tags || []);
  
  if (lead.ordersCount > 0) tags.add('customer');
  if (lead.ordersCount >= 3) tags.add('VIP');
  if (score > 150) tags.add('high-value');
  if (score > 50 && score <= 150) tags.add('warm');
  if (lead.checkoutInitiatedCount >= 1 && !lead.isOrderPlaced) tags.add('high-intent');
  if (lead.isRTO) tags.add('RTO-Risk');

  return Array.from(tags).slice(0, 8); // Cap at 8 tags
};

const updateLeadIntent = (lead) => {
  if (lead.cartStatus === 'purchased' || lead.ordersCount > 0) return 'converted';
  if (lead.cartStatus === 'recovered') return 'recovered';
  if (lead.cartStatus === 'abandoned') return 'cart_abandoned';
  if (lead.checkoutInitiatedCount > 0 && !lead.isOrderPlaced) return 'paying';
  if (lead.interactionCount > 5) return 'interested';
  return 'browsing';
};

/**
 * Phase 17: Record a real-time event and update scoring
 */
const recordLeadEvent = async (lead, eventName, points = 0) => {
  const AdLead = require("../models/AdLead");
  
  const update = {
    $set: { lastInteraction: new Date() },
    $inc: { interactionCount: 1, score: points }
  };
  
  // Custom increment based on event
  if (eventName === 'checkout') update.$inc.checkoutInitiatedCount = 1;
  if (eventName === 'purchase') {
    update.$inc.ordersCount = 1;
    update.$set.isOrderPlaced = true;
  }

  const updatedLead = await AdLead.findByIdAndUpdate(lead._id, update, { new: true });
  
  // Re-calculate derived fields
  const newScore = calculateLeadScore(updatedLead);
  const newTags = getLeadTags(updatedLead, newScore);
  const newIntent = updateLeadIntent(updatedLead);

  return await AdLead.findByIdAndUpdate(lead._id, {
    $set: { 
      score: newScore, 
      tags: newTags, 
      intentState: newIntent 
    }
  }, { new: true });
};

/**
 * Phase 17: Daily Score Decay (scheduled via Cron)
 */
const applyDecay = async (clientId) => {
  const AdLead = require("../models/AdLead");
  // Reduce score by 5% daily for inactivity
  await AdLead.updateMany(
    { clientId, score: { $gt: 0 } },
    { $mul: { score: 0.95 } }
  );
};

module.exports = { 
  calculateLeadScore, 
  getLeadTags, 
  updateLeadIntent, 
  recordLeadEvent, 
  applyDecay 
};
