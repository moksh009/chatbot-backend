#!/usr/bin/env node
'use strict';

/**
 * Optional fixture helper for Playwright API specs.
 * Requires MONGO_URI (or local Mongo). Does not start the API server.
 *
 * Usage:
 *   node scripts/testFixtures/seedTestTenant.js
 *   export PLAYWRIGHT_CLIENT_ID=... PLAYWRIGHT_AUTH_TOKEN=... (login separately)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Set MONGO_URI to seed a test tenant.');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const clientId = process.env.E2E_CLIENT_ID || `e2e_clean_house_${Date.now()}`;
  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        clientId,
        businessName: 'Clean House E2E Tenant',
        flags: { useSendEnvelope: true },
        complianceConfig: {
          channels: { whatsapp: { enabled: true }, email: { enabled: true } },
        },
        wizardFeatures: { cartNudgeMinutes1: 15 },
      },
    },
    { upsert: true, new: true }
  );

  await AdLead.findOneAndUpdate(
    { clientId, phoneNumber: '9199000000001' },
    {
      $set: {
        clientId,
        phoneNumber: '9199000000001',
        email: 'e2e-lead@example.com',
        name: 'E2E Lead',
        optStatus: 'opted_in',
        channelConsent: {
          whatsapp: { status: 'opted_in' },
          email: { status: 'opted_in' },
        },
      },
    },
    { upsert: true }
  );

  console.log(JSON.stringify({ clientId, note: 'Obtain JWT via dashboard login for PLAYWRIGHT_AUTH_TOKEN' }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
