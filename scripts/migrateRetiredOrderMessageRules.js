#!/usr/bin/env node
'use strict';

/**
 * Persist canonical commerce automations for all tenants — strips retired
 * sys_financial_* / sys_fulfillment_fulfilled / sys_order_* rows and merges
 * settings into the seven order + three cart system rules.
 *
 * Usage:
 *   node scripts/migrateRetiredOrderMessageRules.js [--dry-run]
 *   node scripts/migrateRetiredOrderMessageRules.js --clientId=delitech_smarthomes
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const {
  isRetiredOrderStatusRule,
  isLegacyOrderRuleId,
} = require('../utils/commerce/commerceAutomationPresets');
const {
  COMMERCE_AUTOMATION_VERSION,
  pruneDuplicateOrderNotificationRules,
  syncSystemOrderRulesFromNicheMap,
} = require('../utils/commerce/commerceAutomationService');
const { mergeSystemAutomations } = require('../utils/commerce/commerceAutomationPresets');

function parseArgs(argv) {
  const out = { dryRun: false, clientId: null };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--clientId=')) out.clientId = arg.slice('--clientId='.length).trim();
  }
  return out;
}

function isRetiredOrLegacyRule(rule) {
  if (!rule) return false;
  if (isRetiredOrderStatusRule(rule)) return true;
  if (isLegacyOrderRuleId(rule.id)) return true;
  const id = String(rule.id || '');
  return id.startsWith('sys_order_') || id.startsWith('status_');
}

function normalizeCommerceAutomations(client) {
  const base = Array.isArray(client.commerceAutomations) ? client.commerceAutomations : [];
  const withSystem = mergeSystemAutomations(base);
  const synced = syncSystemOrderRulesFromNicheMap(withSystem, client.nicheData || {});
  return pruneDuplicateOrderNotificationRules(synced);
}

function summarizeDiff(before = [], after = []) {
  const beforeIds = new Set(before.map((r) => r.id));
  const afterIds = new Set(after.map((r) => r.id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id));
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  const retiredRemoved = before.filter((r) => isRetiredOrLegacyRule(r)).map((r) => r.id);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return { removed, added, retiredRemoved, changed };
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
    .select('clientId commerceAutomations nicheData commerceAutomationVersion')
    .lean();

  let updated = 0;
  let skipped = 0;
  let retiredStripped = 0;

  console.log(`Clients to scan: ${clients.length}${dryRun ? ' (dry-run)' : ''}`);

  for (const client of clients) {
    const before = Array.isArray(client.commerceAutomations) ? client.commerceAutomations : [];
    if (!before.length) {
      skipped += 1;
      continue;
    }

    const after = normalizeCommerceAutomations(client);
    const diff = summarizeDiff(before, after);
    if (!diff.changed) {
      skipped += 1;
      continue;
    }

    retiredStripped += diff.retiredRemoved.length;
    updated += 1;
    console.log(
      `  ${client.clientId}: rules ${before.length} → ${after.length}` +
        (diff.retiredRemoved.length ? `; retired stripped: ${diff.retiredRemoved.join(', ')}` : '') +
        (diff.removed.length ? `; removed ids: ${diff.removed.join(', ')}` : '')
    );

    if (!dryRun) {
      await Client.updateOne(
        { clientId: client.clientId },
        {
          $set: {
            commerceAutomations: after,
            commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
            commerceAutomationMigratedAt: new Date(),
          },
        }
      );
    }
  }

  console.log('');
  console.log(`Done.${dryRun ? ' (dry-run — no writes)' : ''}`);
  console.log(`  Clients updated: ${updated}`);
  console.log(`  Clients skipped (empty or unchanged): ${skipped}`);
  console.log(`  Retired rule rows stripped: ${retiredStripped}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
