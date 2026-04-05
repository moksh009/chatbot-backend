"use strict";

const crypto = require('crypto');
const Referral = require('../models/Referral');
const AdLead = require('../models/AdLead');
const log = require('./logger')('ReferralEngine');

const ReferralEngine = {
  /**
   * Generates a unique referral code for a lead.
   * @param {Object} lead - AdLead document
   * @returns {String} referral code
   */
  async generateCode(lead) {
    if (lead.referralCode) return lead.referralCode;

    let isUnique = false;
    let code = '';
    
    // Attempt to generate a unique 6-character alphanumeric code
    while (!isUnique) {
      code = crypto.randomBytes(3).toString('hex').toUpperCase();
      const exists = await AdLead.exists({ referralCode: code });
      if (!exists) isUnique = true;
    }

    try {
      // Save code to AdLead
      lead.referralCode = code;
      await lead.save();

      // Ensure Referral tracking document exists
      await Referral.findOneAndUpdate(
        { referrerLeadId: lead._id },
        { 
          $setOnInsert: { 
            clientId: lead.clientId,
            referrerLeadId: lead._id, 
            referralCode: code 
          }
        },
        { upsert: true }
      );

      return code;
    } catch (err) {
      log.error(`generateCode failed for lead ${lead._id}`, { error: err.message });
      return null;
    }
  },

  /**
   * Process a referred sign-up or interaction
   * @param {String} code - The referral code used
   * @param {Object} newLead - The newly created AdLead document
   */
  async processReferral(code, newLead) {
    if (!code) return;
    
    try {
      const referralDoc = await Referral.findOne({ referralCode: code.toUpperCase() });
      if (!referralDoc) return;

      // Ensure we don't process if already processed
      const alreadyReferred = referralDoc.history.find(
        (entry) => entry.referredLeadId?.toString() === newLead._id.toString()
      );
      
      if (alreadyReferred) return;

      // Update lead with referrer info
      newLead.referredBy = code.toUpperCase();
      await newLead.save();

      // Add to referral history
      referralDoc.history.push({
        referredLeadId: newLead._id,
        status: 'joined',
        timestamp: new Date()
      });
      referralDoc.totalReferrals += 1;
      await referralDoc.save();

      log.info(`Referral processed: Code ${code} resulted in new lead ${newLead.phoneNumber}`);

    } catch (err) {
      log.error(`processReferral failed for code ${code}`, { error: err.message });
    }
  },

  /**
   * Mark a referral as converted (e.g. order placed) and issue reward
   * @param {Object} lead - The AdLead that just converted
   */
  async markConverted(lead) {
    if (!lead.referredBy) return;

    try {
      const referralDoc = await Referral.findOne({ referralCode: lead.referredBy });
      if (!referralDoc) return;

      // Find the entry
      const entry = referralDoc.history.find(
        (e) => e.referredLeadId?.toString() === lead._id.toString() && e.status !== 'converted'
      );

      if (entry) {
        entry.status = 'converted';
        entry.rewardIssued = true;
        referralDoc.successfulConversions += 1;
        // Optionally add logic to issue store credit, coupon code, etc.
        // referralDoc.totalRewardsEarned += REWARD_VALUE;
        await referralDoc.save();
        log.info(`Referral converted! Lead ${lead._id} purchased, credited to code ${lead.referredBy}`);
      }
    } catch (err) {
      log.error(`markConverted failed for lead ${lead._id}`, { error: err.message });
    }
  }
};

module.exports = ReferralEngine;
