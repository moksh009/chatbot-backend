"use strict";

const CustomerIntelligence = require('../models/CustomerIntelligence');

/**
 * Predictive Send Engine — Phase 28 Track 8
 *
 * Given a list of phone numbers, returns each one enriched with the
 * recommended send timestamp: either the customer's peak hour OR right now
 * if no historical data exists.
 *
 * @param {string}   clientId
 * @param {string[]} phones   — Array of phone numbers
 * @returns {Array<{ phone: string, sendAt: Date, reason: string }>}
 */
async function getOptimalSendTimes(clientId, phones) {
  if (!phones || phones.length === 0) return [];

  // Batch-fetch all DNA records for this client's phones in one query
  const dnaRecords = await CustomerIntelligence.find({
    clientId,
    phone: { $in: phones }
  }).lean();

  const dnaMap = {};
  dnaRecords.forEach(d => { dnaMap[d.phone] = d; });

  const now = new Date();
  const results = [];

  for (const phone of phones) {
    const dna = dnaMap[phone];

    if (!dna || !dna.peakInteractionHours || dna.peakInteractionHours.length === 0) {
      // No data — send immediately
      results.push({ phone, sendAt: now, reason: 'No behavioral data; sending immediately.' });
      continue;
    }

    // Find the hour with the highest interaction count
    const sorted = [...dna.peakInteractionHours].sort((a, b) => b.interactionCount - a.interactionCount);
    const peakHour = sorted[0].hour;

    // Build a send time at the next occurrence of peakHour
    const candidateSend = new Date();
    candidateSend.setHours(peakHour, 0, 0, 0);

    // If this hour has already passed today, schedule for tomorrow
    if (candidateSend <= now) {
      candidateSend.setDate(candidateSend.getDate() + 1);
    }

    results.push({
      phone,
      sendAt: candidateSend,
      peakHour,
      reason: `Optimal window ${peakHour}:00 (${sorted[0].interactionCount} past interactions)`
    });
  }

  return results;
}

/**
 * Given a single phone number, returns the predicted optimal send window
 * as { startHour, endHour } from the persisted CustomerIntelligence record.
 */
async function getPersonalizedWindow(clientId, phone) {
  const dna = await CustomerIntelligence.findOne({ clientId, phone }).lean();
  if (!dna) return { startHour: 9, endHour: 20, confident: false };
  return {
    startHour: dna.optimalSendWindow?.startHour ?? 9,
    endHour:   dna.optimalSendWindow?.endHour   ?? 20,
    peakHour:  dna.peakInteractionHours?.sort((a, b) => b.interactionCount - a.interactionCount)[0]?.hour,
    confident: (dna.peakInteractionHours?.reduce((s, h) => s + h.interactionCount, 0) || 0) >= 5
  };
}

module.exports = { getOptimalSendTimes, getPersonalizedWindow };
