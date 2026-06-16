"use strict";

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../db');
const Client = require('../models/Client');
const Subscription = require('../models/Subscription');

async function run() {
  const clientId = String(process.env.TOPEDGE_SYSTEM_CLIENT_ID || 'topedge_platform_support').trim();
  if (!clientId) throw new Error('TOPEDGE_SYSTEM_CLIENT_ID missing');

  const existing = await Client.findOne({ clientId });
  if (existing) {
    await Client.updateOne(
      { clientId },
      { $set: { isPlatformInternal: true, isActive: true } }
    );
    console.log(`[seedPlatformClient] exists: ${clientId} (updated isPlatformInternal=true)`);
    return;
  }

  await Client.create({
    clientId,
    businessName: 'TopEdge Platform',
    name: 'TopEdge Platform',
    isPlatformInternal: true,
    isActive: true,
    trialActive: false,
    isPaidAccount: false,
    storeType: 'manual',
    plan: 'platform_internal',
  });

  await Subscription.updateOne(
    { clientId },
    {
      $setOnInsert: {
        clientId,
        plan: 'platform_internal',
        status: 'active',
        billingCycle: 'none',
        amount: 0,
        currency: 'INR',
      },
    },
    { upsert: true }
  );

  console.log(`[seedPlatformClient] created: ${clientId}`);
}

connectDB()
  .then(run)
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('[seedPlatformClient] failed:', e.message);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
  });
