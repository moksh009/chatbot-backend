#!/usr/bin/env node
'use strict';

/**
 * Remove wizard-generated product templates (prod_*) from tenant stores.
 * Meta Manager custom templates are untouched; only product-marketing noise is removed.
 *
 * Usage:
 *   node scripts/cleanupWizardProductTemplates.js [--dry-run]
 *   node scripts/cleanupWizardProductTemplates.js --clientId=delitech_smarthomes
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const MetaTemplate = require('../models/MetaTemplate');
const { isWizardProductTemplate } = require('../utils/meta/orderMessageTemplatePolicy');

function parseArgs(argv) {
  const out = { dryRun: false, clientId: null };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--clientId=')) out.clientId = arg.slice('--clientId='.length).trim();
  }
  return out;
}

function stripProductTemplatesFromArray(list) {
  if (!Array.isArray(list)) return { next: list, removed: 0 };
  const next = list.filter((tpl) => !isWizardProductTemplate(tpl));
  return { next, removed: list.length - next.length };
}

async function main() {
  const { dryRun, clientId } = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 120000 });

  const clientFilter = clientId ? { clientId } : {};
  const clients = await Client.find(clientFilter)
    .select('clientId messageTemplates syncedMetaTemplates pendingTemplates')
    .lean();

  let metaDeleted = 0;
  let clientArraysCleaned = 0;

  const metaFilter = {
    ...(clientId ? { clientId } : {}),
    $or: [
      { name: { $regex: /^prod_/i } },
      { templateKind: 'product' },
      { source: 'wizard_product' },
    ],
  };

  const metaMatches = await MetaTemplate.find(metaFilter).select('clientId name').lean();
  console.log(`MetaTemplate product rows: ${metaMatches.length}${dryRun ? ' (dry-run)' : ''}`);
  if (!dryRun && metaMatches.length) {
    const res = await MetaTemplate.deleteMany(metaFilter);
    metaDeleted = res.deletedCount || 0;
  } else {
    metaDeleted = metaMatches.length;
  }

  for (const client of clients) {
    const updates = {};
    let removed = 0;

    for (const field of ['messageTemplates', 'syncedMetaTemplates', 'pendingTemplates']) {
      const { next, removed: n } = stripProductTemplatesFromArray(client[field]);
      if (n > 0) {
        updates[field] = next;
        removed += n;
      }
    }

    if (!removed) continue;
    clientArraysCleaned += 1;
    console.log(`  ${client.clientId}: strip ${removed} product template row(s)`);
    if (!dryRun) {
      await Client.updateOne({ clientId: client.clientId }, { $set: updates });
    }
  }

  console.log('');
  console.log(`Done.${dryRun ? ' (dry-run — no writes)' : ''}`);
  console.log(`  MetaTemplate deleted: ${metaDeleted}`);
  console.log(`  Clients updated: ${clientArraysCleaned}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
