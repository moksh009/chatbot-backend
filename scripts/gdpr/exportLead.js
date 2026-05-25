#!/usr/bin/env node
'use strict';

const mongoose = require('mongoose');
const { exportLeadBundle } = require('../../services/gdpr/leadGdprService');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const leadId = arg('leadId');
  const phone = arg('phone');
  const dryRun = process.argv.includes('--dry-run');
  if (!leadId && !phone) {
    console.error('Usage: node scripts/gdpr/exportLead.js --leadId <id> | --phone <phone> [--dry-run]');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, leadId, phone }, null, 2));
    process.exit(0);
  }
  const bundle = await exportLeadBundle({
    leadId,
    phone,
    actor: { type: 'system', source: 'gdpr_script' },
  });
  console.log(JSON.stringify(bundle, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
