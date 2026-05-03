/**
 * ─────────────────────────────────────────────────────────────────────────────
 * migrateOnboardingCompleted.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time migration: grandfather all existing clients to
 *   onboardingCompleted = true
 * so they are NOT forced into the new full-screen /onboarding flow when they
 * next log in. Only clients created AFTER this script runs (i.e. truly new
 * signups) will go through the new flow.
 *
 * Usage:
 *   node scripts/migrateOnboardingCompleted.js            # dry-run report
 *   node scripts/migrateOnboardingCompleted.js --apply    # actually write
 *
 * Safe to run multiple times — it only updates clients where the field is
 * undefined/null.
 */

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Client = require('../models/Client');

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  console.log('Connected to MongoDB');

  const query = {
    $or: [
      { onboardingCompleted: { $exists: false } },
      { onboardingCompleted: null }
    ]
  };

  const total = await Client.countDocuments({});
  const needsMigration = await Client.countDocuments(query);

  console.log('─────────────────────────────────────────');
  console.log(`Total clients in DB: ${total}`);
  console.log(`Clients missing onboardingCompleted: ${needsMigration}`);
  console.log('─────────────────────────────────────────');

  if (!APPLY) {
    console.log('\nDRY RUN — no writes performed.');
    console.log('Re-run with --apply to actually update these records.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log('\nApplying migration...');

  const now = new Date();
  const res = await Client.updateMany(query, {
    $set: {
      onboardingCompleted: true,
      onboardingCompletedAt: now,
      onboardingStep: 6 // final step index
    }
  });

  console.log(`✅ Matched: ${res.matchedCount || res.n}  Modified: ${res.modifiedCount || res.nModified}`);
  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
