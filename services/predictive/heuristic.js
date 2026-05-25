'use strict';

const AdLead = require('../../models/AdLead');

function predictOptimalHour(lead, tenantDefaultHour = 11) {
  const events = lead.engagementHours || lead.metaData?.engagementHours;
  if (Array.isArray(events) && events.length >= 5) {
    const buckets = new Array(24).fill(0);
    events.forEach((h) => {
      const hour = Number(h);
      if (hour >= 0 && hour < 24) buckets[hour] += 1;
    });
    let best = tenantDefaultHour;
    let max = 0;
    buckets.forEach((n, hour) => {
      if (n > max) {
        max = n;
        best = hour;
      }
    });
    return best;
  }
  if (lead.optimalSendHour != null) return lead.optimalSendHour;
  return tenantDefaultHour;
}

function predictConversion(lead) {
  const score = Number(lead.leadScore || 0);
  let p = score * 0.4;
  const sentiment = Number(lead.sentimentScore || lead.recentSentimentTrend || 50);
  if (sentiment > 70) p += 20;
  else if (sentiment < 30) p -= 10;
  const last = lead.lastActivityAt || lead.updatedAt;
  if (last) {
    const days = (Date.now() - new Date(last).getTime()) / 86400000;
    if (days < 3) p += 20;
    else if (days < 14) p += 10;
  }
  if (lead.cartStatus === 'abandoned') p += 20;
  if ((lead.ordersCount || 0) > 0) p += 20;
  return Math.max(0, Math.min(100, Math.round(p)));
}

function predictCartTiming(lead, fallbackMinutes = 15) {
  const hour = predictOptimalHour(lead);
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delayMs = Math.max(fallbackMinutes * 60000, target - now);
  return { sendAt: new Date(now.getTime() + delayMs), optimalHour: hour };
}

async function recomputeLeadPredictions(leadIdOrDoc) {
  const lead =
    typeof leadIdOrDoc === 'object' && leadIdOrDoc?._id
      ? leadIdOrDoc
      : await AdLead.findById(leadIdOrDoc).lean();
  if (!lead) return null;
  const optimalSendHour = predictOptimalHour(lead);
  const conversionProbability = predictConversion(lead);
  await AdLead.updateOne(
    { _id: lead._id },
    { $set: { optimalSendHour, conversionProbability } }
  );
  return { optimalSendHour, conversionProbability };
}

async function recomputeAllLeadPredictions({ limit = 5000 } = {}) {
  const leads = await AdLead.find({})
    .select('_id leadScore sentimentScore recentSentimentTrend lastActivityAt updatedAt cartStatus ordersCount optimalSendHour engagementHours metaData')
    .limit(limit)
    .lean();
  let n = 0;
  for (const lead of leads) {
    const optimalSendHour = predictOptimalHour(lead);
    const conversionProbability = predictConversion(lead);
    await AdLead.updateOne({ _id: lead._id }, { $set: { optimalSendHour, conversionProbability } });
    n += 1;
  }
  return n;
}

module.exports = {
  predictOptimalHour,
  predictConversion,
  predictCartTiming,
  recomputeLeadPredictions,
  recomputeAllLeadPredictions,
};
