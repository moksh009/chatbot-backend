#!/usr/bin/env node
"use strict";

/**
 * Phase 6 (FLOW-WIZARD plan) — Backfill canonical store-category slug for
 * existing tenants. Idempotent: skips clients that already have a slug saved.
 *
 * For each Client with no `onboardingData.storeCategory` we infer one from:
 *   1. `onboardingData.ecommerceCategories` (signup multi-select)
 *   2. `onboardingData.brandProfile.productCategory` (AI analyze)
 *   3. `onboardingData.industry` / `onboardingData.step1.industry` (legacy text)
 *   4. Falls back to `general_d2c` when nothing matches.
 *
 * Usage:
 *   node scripts/backfillStoreCategory.js                       # dry-run, all tenants
 *   node scripts/backfillStoreCategory.js --commit              # actually write
 *   node scripts/backfillStoreCategory.js --clientId=acme_store # one tenant
 *   node scripts/backfillStoreCategory.js --commit --apply-presets  # also re-merge wizardFeatures via slug
 */

require("dotenv").config();
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const applyPresets = args.includes("--apply-presets");
const clientArg = args.find((a) => a.startsWith("--clientId="));
const onlyClientId = clientArg ? clientArg.split("=")[1] : null;

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI or MONGODB_URI is required");
  await mongoose.connect(uri);

  const Client = require("../models/Client");
  const { resolveStoreCategorySlug, getStoreCategoryBySlug } = require("../constants/storeCategories");
  const { mergeWizardFeatures } = require("../utils/flow/wizardFeaturePresets");

  const query = onlyClientId ? { clientId: onlyClientId } : {};
  const cursor = Client.find(query, {
    clientId: 1,
    businessName: 1,
    wizardFeatures: 1,
    onboardingData: 1,
    businessType: 1,
  })
    .lean()
    .cursor();

  let scanned = 0;
  let alreadySet = 0;
  let updated = 0;
  let presetsTouched = 0;
  const summary = {};

  for (let client = await cursor.next(); client; client = await cursor.next()) {
    scanned += 1;
    const onb = client.onboardingData || {};

    if (onb.storeCategory) {
      alreadySet += 1;
      continue;
    }

    const slug = resolveStoreCategorySlug({
      ecommerceCategories: onb.ecommerceCategories,
      aiProductCategory: onb.brandProfile?.productCategory,
      industryLabel: onb.industry || onb.step1?.industry,
    });
    const cat = getStoreCategoryBySlug(slug);
    summary[slug] = (summary[slug] || 0) + 1;

    const update = {
      $set: {
        "onboardingData.storeCategory": slug,
        "onboardingData.storeCategorySource": "preset",
      },
    };

    if (applyPresets) {
      const existing = client.wizardFeatures || {};
      const next = mergeWizardFeatures(existing, client.businessType, onb.industry, {
        storeCategory: slug,
        categoryOverrides: onb.categoryOverrides || {},
      });
      // Only write keys that actually changed to keep the diff small.
      for (const key of Object.keys(next)) {
        if (next[key] !== existing[key]) {
          update.$set[`wizardFeatures.${key}`] = next[key];
        }
      }
      if (Object.keys(update.$set).some((k) => k.startsWith("wizardFeatures."))) {
        presetsTouched += 1;
      }
    }

    if (commit) {
      await Client.updateOne({ clientId: client.clientId }, update);
      updated += 1;
      console.log(`[backfill] ${client.clientId} → ${slug} (${cat?.label || ""})`);
    } else {
      console.log(`[dry-run] ${client.clientId} would become ${slug} (${cat?.label || ""})`);
    }
  }

  console.log("\n========== Backfill summary ==========");
  console.log(`Scanned:       ${scanned}`);
  console.log(`Already set:   ${alreadySet}`);
  console.log(`Updated:       ${updated}${commit ? "" : " (dry-run — no writes)"}`);
  if (applyPresets) {
    console.log(`Preset merges: ${presetsTouched}`);
  }
  console.log("By slug:");
  for (const [slug, count] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${slug.padEnd(28)} ${count}`);
  }

  await mongoose.disconnect();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfillStoreCategory] FAILED", err);
    process.exit(1);
  });
