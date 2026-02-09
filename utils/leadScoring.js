const calculateLeadScore = (lead) => {
  let score = 0;
  
  // Base activity points
  score += (lead.ordersCount || 0) * 50;
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
  const tags = [];
  
  if (lead.ordersCount > 0) tags.push('customer');
  if (lead.ordersCount > 3) tags.push('loyal');
  if (score > 100) tags.push('high-value');
  if (score > 50 && score <= 100) tags.push('warm');
  if (lead.addToCartCount > 0 && !lead.isOrderPlaced) tags.push('abandoned-cart');
  
  return tags;
};

module.exports = { calculateLeadScore, getLeadTags };
