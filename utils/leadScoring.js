const calculateLeadScore = (lead) => {
  let score = 0;
  
  // Base activity points
  score += (lead.ordersCount || 0) * 50;
  score += (lead.appointmentsBooked || 0) * 50;
  score += (lead.checkoutInitiatedCount || 0) * 30;
  score += (lead.addToCartCount || 0) * 20;
  score += (lead.linkClicks || 0) * 5;
  
  // Recency bonus (if interaction within last 7 days)
  const daysSinceLastInteraction = (new Date() - new Date(lead.lastInteraction)) / (1000 * 60 * 60 * 24);
  if (daysSinceLastInteraction < 7) {
    score += 10;
  }
  
  return score;
};

const getLeadTags = (lead, score) => {
  const tags = new Set(lead.tags || []);
  
  if (lead.ordersCount > 0) tags.add('customer');
  if (lead.ordersCount > 3) tags.add('loyal');
  if (score > 100) tags.add('high-value');
  if (score > 50 && score <= 100) tags.add('warm');
  if (lead.totalSpent > 0) tags.add('repeat-buyer');
  if (lead.checkoutInitiatedCount >= 2) tags.add('high-intent');

  return Array.from(tags);
};

// Determines the phase 9 exact intent state
const updateLeadIntent = (lead) => {
  if (lead.cartStatus === 'purchased' || lead.ordersCount > 0) return 'converted';
  if (lead.cartStatus === 'recovered') return 'recovered';
  if (lead.cartStatus === 'abandoned') return 'cart_abandoned';
  if (lead.checkoutInitiatedCount > 0 && !lead.isOrderPlaced) return 'high_intent';
  return 'browsing';
};

module.exports = { calculateLeadScore, getLeadTags, updateLeadIntent };
