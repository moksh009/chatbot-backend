#!/usr/bin/env node
'use strict';

/**
 * Backfill FollowUpSequence.name from linked AdLead when name equals journey blueprint title.
 *
 * Usage:
 *   node scripts/backfill-journey-sequence-names.js [--clientId=xxx] [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const WhatsAppFlow = require('../models/WhatsAppFlow');

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const clientArg = args.find((a) => a.startsWith('--clientId='));
  const clientId = clientArg ? clientArg.split('=')[1] : null;

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[backfill] connected', dryRun ? '(dry run)' : '');

  const match = {
    sourceFlowId: { $ne: '' },
    leadId: { $exists: true, $ne: null },
  };
  if (clientId) match.clientId = clientId;

  const sequences = await FollowUpSequence.find(match)
    .select('_id clientId leadId name sourceFlowId enrollment')
    .lean();

  const flowIds = [...new Set(sequences.map((s) => s.sourceFlowId).filter(Boolean))];
  const flows = await WhatsAppFlow.find({ flowId: { $in: flowIds } })
    .select('flowId name')
    .lean();
  const flowNameById = new Map(flows.map((f) => [f.flowId, f.name]));

  const leadIds = [...new Set(sequences.map((s) => String(s.leadId)).filter(Boolean))];
  const leads = await AdLead.find({ _id: { $in: leadIds } })
    .select('name fullName')
    .lean();
  const leadNameById = new Map(
    leads.map((l) => [String(l._id), l.name || l.fullName || ''])
  );

  let updated = 0;
  let skipped = 0;

  for (const seq of sequences) {
    const blueprintName =
      seq.enrollment?.blueprint?.name
      || flowNameById.get(seq.sourceFlowId)
      || '';
    const leadName = leadNameById.get(String(seq.leadId)) || '';
    const currentName = String(seq.name || '').trim();

    if (!leadName || !blueprintName) {
      skipped += 1;
      continue;
    }
    if (currentName !== blueprintName) {
      skipped += 1;
      continue;
    }

    if (!dryRun) {
      await FollowUpSequence.updateOne({ _id: seq._id }, { $set: { name: leadName } });
    }
    updated += 1;
    console.log(`[backfill] ${seq._id}: "${currentName}" → "${leadName}"`);
  }

  console.log(`[backfill] done — updated ${updated}, skipped ${skipped}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[backfill] failed', err);
  process.exit(1);
});
