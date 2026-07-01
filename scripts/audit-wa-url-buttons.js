/**
 * audit-wa-url-buttons.js
 *
 * Lists all journey FollowUpSequence steps that have a WhatsApp template with a
 * URL button, and reports whether they are static (permanent blind spot — can
 * never be tracked without Meta re-approval) or dynamic (trackable with
 * waClickTrackingService).
 *
 * Usage:
 *   node scripts/audit-wa-url-buttons.js [clientId]
 *   node scripts/audit-wa-url-buttons.js delitech_smarthomes
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

async function main() {
  const args = process.argv.slice(2);
  const clientId = args.find((a) => !a.startsWith('--')) || null;

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('Connected to MongoDB\n');

  const MetaTemplate = require('../models/MetaTemplate');
  const clientFilter = clientId ? { clientId } : {};

  const templates = await MetaTemplate.find(clientFilter)
    .select('name components clientId status')
    .lean();

  let staticCount = 0;
  let dynamicCount = 0;
  const staticTemplates = [];
  const dynamicTemplates = [];

  for (const tpl of templates) {
    const components = tpl.components || [];
    const buttons = components.find((c) => String(c.type || '').toUpperCase() === 'BUTTONS');
    if (!buttons?.buttons?.length) continue;

    const urlButtons = buttons.buttons.filter(
      (b) => String(b.type || '').toUpperCase() === 'URL'
    );
    if (!urlButtons.length) continue;

    for (const btn of urlButtons) {
      const url = String(btn.url || '');
      const isDynamic = url.includes('{{') || url.includes('}}');
      const entry = {
        clientId: tpl.clientId,
        name: tpl.name,
        status: tpl.status,
        buttonText: btn.text,
        url,
        trackable: isDynamic,
      };
      if (isDynamic) {
        dynamicCount += 1;
        dynamicTemplates.push(entry);
      } else {
        staticCount += 1;
        staticTemplates.push(entry);
      }
    }
  }

  console.log(`=== Static URL buttons (PERMANENT BLIND SPOT — re-approval required) ===`);
  if (staticTemplates.length) {
    staticTemplates.forEach((t) => {
      console.log(`  [${t.clientId}] ${t.name} (${t.status}) — "${t.buttonText}" → ${t.url}`);
    });
  } else {
    console.log('  None found.');
  }

  console.log(`\n=== Dynamic URL buttons (trackable with waClickTrackingService) ===`);
  if (dynamicTemplates.length) {
    dynamicTemplates.forEach((t) => {
      console.log(`  [${t.clientId}] ${t.name} (${t.status}) — "${t.buttonText}" → ${t.url}`);
    });
  } else {
    console.log('  None found.');
  }

  console.log(`\nSummary: ${staticCount} static (blind spot), ${dynamicCount} dynamic (trackable)`);
  if (staticCount > 0) {
    console.log('\n⚠  Static URL button templates cannot be retrofitted — they must be');
    console.log('   re-created as dynamic URL button templates and re-submitted to Meta.');
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
