#!/usr/bin/env node
/**
 * One-time DB cleanup after Reputation / review collection removal.
 *
 * Usage:
 *   node scripts/cleanupReviewReputationData.js            # apply changes
 *   node scripts/cleanupReviewReputationData.js --dry-run  # preview counts only
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const FollowUpSequence = require('../models/FollowUpSequence');
const ScheduledMessage = require('../models/ScheduledMessage');
const MetaTemplate = require('../models/MetaTemplate');

const DRY_RUN = process.argv.includes('--dry-run');

const stats = {
  clientsUpdated: 0,
  sequencesCancelled: 0,
  scheduledCancelled: 0,
  metaTemplatesRemoved: 0,
  reviewRequestDocsDeleted: 0,
};

function isReviewAutomationFlow(flow) {
  const id = String(flow?.id || '').toLowerCase();
  const type = String(flow?.type || '').toLowerCase();
  return id === 'review_collection' || type === 'review_collection';
}

function isReviewMessageTemplate(t) {
  const id = String((t && t.id) || (t && t.key) || '').toLowerCase();
  return id === 'review_request';
}

async function cleanupClients() {
  const cursor = Client.find({})
    .select(
      'clientId automationFlows messageTemplates wizardFeatures onboardingData enableReviewCollection googleReviewUrl reviewDelayDays brand platformVars'
    )
    .lean()
    .cursor();

  for await (const client of cursor) {
    const $set = {};
    const $unset = {};
    let needsUpdate = false;

    if (Array.isArray(client.automationFlows) && client.automationFlows.length) {
      const next = client.automationFlows.filter((f) => !isReviewAutomationFlow(f));
      if (next.length !== client.automationFlows.length) {
        $set.automationFlows = next;
        needsUpdate = true;
      }
    }

    const templates = client.messageTemplates;
    if (templates) {
      const arr = Array.isArray(templates) ? templates : [];
      const next = arr.filter((t) => !isReviewMessageTemplate(t));
      if (next.length !== arr.length) {
        $set.messageTemplates = next;
        needsUpdate = true;
      }
    }

    if (client.enableReviewCollection === true) {
      $set.enableReviewCollection = false;
      needsUpdate = true;
    }

    if (client.reviewDelayDays != null && client.reviewDelayDays !== '') {
      $unset.reviewDelayDays = '';
      needsUpdate = true;
    }

    if (client.wizardFeatures?.enableReviewCollection === true) {
      $set['wizardFeatures.enableReviewCollection'] = false;
      needsUpdate = true;
    }

    if (client.onboardingData?.features?.enableReviewCollection === true) {
      $set['onboardingData.features.enableReviewCollection'] = false;
      needsUpdate = true;
    }

    const goals = client.onboardingData?.goals;
    if (Array.isArray(goals) && goals.includes('review_collection')) {
      $set['onboardingData.goals'] = goals.filter((g) => g !== 'review_collection');
      needsUpdate = true;
    }

    if (client.googleReviewUrl) {
      $unset.googleReviewUrl = '';
      needsUpdate = true;
    }
    if (client.brand?.googleReviewUrl) {
      $unset['brand.googleReviewUrl'] = '';
      needsUpdate = true;
    }
    if (client.platformVars?.googleReviewUrl) {
      $unset['platformVars.googleReviewUrl'] = '';
      needsUpdate = true;
    }

    if (!needsUpdate) continue;

    stats.clientsUpdated += 1;
    console.log(`  • client ${client.clientId || client._id}`);

    if (DRY_RUN) continue;

    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    await Client.updateOne({ _id: client._id }, update);
  }
}

async function cleanupFollowUpSequences() {
  const filter = {
    status: { $in: ['active', 'paused'] },
    $or: [{ type: 'review_request' }, { 'steps.type': 'review_request' }],
  };
  stats.sequencesCancelled = await FollowUpSequence.countDocuments(filter);
  if (stats.sequencesCancelled && !DRY_RUN) {
    await FollowUpSequence.updateMany(filter, {
      $set: { status: 'cancelled' },
    });
  }
}

async function cleanupScheduledMessages() {
  const filter = { sourceType: 'review', status: 'pending' };
  stats.scheduledCancelled = await ScheduledMessage.countDocuments(filter);
  if (stats.scheduledCancelled && !DRY_RUN) {
    await ScheduledMessage.updateMany(filter, { $set: { status: 'cancelled' } });
  }
}

async function cleanupMetaTemplates() {
  const filter = {
    $or: [
      { catalogSlotId: 'wizard_review' },
      { templateKey: 'review_request' },
      { name: /^review_request/i },
      { internalName: /^review request/i },
    ],
  };
  stats.metaTemplatesRemoved = await MetaTemplate.countDocuments(filter);
  if (stats.metaTemplatesRemoved && !DRY_RUN) {
    await MetaTemplate.deleteMany(filter);
  }
}

async function cleanupReviewRequestCollection() {
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  for (const { name } of collections) {
    if (!/reviewrequest/i.test(name)) continue;
    const col = db.collection(name);
    const count = await col.countDocuments();
    stats.reviewRequestDocsDeleted += count;
    if (count && !DRY_RUN) {
      await col.deleteMany({});
    }
    console.log(`  • collection ${name}: ${count} document(s)`);
  }
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('Set MONGO_URI or MONGODB_URI in .env');
    process.exit(1);
  }

  console.log(DRY_RUN ? '🔍 DRY RUN — no writes\n' : '🧹 Applying review/reputation DB cleanup\n');

  await mongoose.connect(uri);
  console.log('Connected to MongoDB\n');

  console.log('Clients…');
  await cleanupClients();

  console.log('\nFollow-up sequences…');
  await cleanupFollowUpSequences();

  console.log('\nScheduled messages…');
  await cleanupScheduledMessages();

  console.log('\nMeta templates…');
  await cleanupMetaTemplates();

  console.log('\nLegacy ReviewRequest collection(s)…');
  await cleanupReviewRequestCollection();

  console.log('\n--- Summary ---');
  console.log(`Clients updated:              ${stats.clientsUpdated}`);
  console.log(`Sequences cancelled:          ${stats.sequencesCancelled}`);
  console.log(`Scheduled messages cancelled: ${stats.scheduledCancelled}`);
  console.log(`Meta templates removed:       ${stats.metaTemplatesRemoved}`);
  console.log(`ReviewRequest docs deleted:   ${stats.reviewRequestDocsDeleted}`);
  if (DRY_RUN) {
    console.log('\nRe-run without --dry-run to apply.');
  } else {
    console.log('\nDone.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
