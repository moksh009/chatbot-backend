#!/usr/bin/env node
"use strict";
/**
 * refreshApexCatalogFlow.js — One command for Apex Light catalog + flow alignment
 *
 * 1) Import products + collections from Meta Commerce catalog → Mongo
 * 2) Patch explore category list (titles from Meta product sets)
 * 3) Patch MPM nodes with correct Content IDs per category
 * 4) Clear trigger/cache so WhatsApp uses fresh graph
 *
 * Prerequisites:
 *   • Meta template "carosuel" APPROVED + synced in dashboard (Settings → Templates)
 *   • Catalog ID on client (25779917041614766 for Apex)
 *   • Meta catalog access token saved OR working token in .env for diagnose
 *
 * Usage:
 *   node scripts/refreshApexCatalogFlow.js
 *   node scripts/refreshApexCatalogFlow.js --push-flow   # also push repo apexLightOwnerFlow.js to Mongo
 *   node scripts/refreshApexCatalogFlow.js --dry-run
 *   APEX_SYNC_CLIENT_ID=other_client node scripts/refreshApexCatalogFlow.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Client = require("../models/Client");
const { runMetaCatalogImport, diagnoseMetaCatalogAccess } = require("../utils/metaCatalogSync");
const { syncApexCatalogFlowFromMeta } = require("../utils/apexCatalogFlowSync");
const { clearTriggerCache } = require("../utils/triggerEngine");
const { clearClientCache } = require("../middleware/apiCache");

const pushFlow = process.argv.includes("--push-flow");
const dryRun = process.argv.includes("--dry-run");
const skipImport = process.argv.includes("--skip-import");

function resolveClientId() {
  const fromEnv = process.env.APEX_SYNC_CLIENT_ID || process.env.SYNC_CLIENT_ID;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  const arg = process.argv.find((a) => a.startsWith("--clientId="));
  if (arg) return arg.split("=").slice(1).join("=").trim();
  return "shubhampatelsbusiness_1cfb2b";
}

async function run() {
  const clientId = resolveClientId();
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGODB_URI or MONGO_URI required");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });

  console.log("\n=== Apex catalog + flow refresh ===\n");
  console.log("Client:", clientId);

  const diag = await diagnoseMetaCatalogAccess(clientId);
  console.log("\nCatalog diagnose:");
  console.log(JSON.stringify(diag, null, 2));

  if (!diag.canImport && !skipImport) {
    throw new Error(
      "Meta catalog import not available. Save Meta catalog access token in Settings → Commerce, then retry."
    );
  }

  if (pushFlow) {
    console.log("\nPushing apexLightOwnerFlow.js from repo to Mongo…");
    if (dryRun) {
      console.log("(dry-run: skipped setupApexOwnerSupportFlow)");
    } else {
      const { execSync } = require("child_process");
      execSync(`node scripts/setupApexOwnerSupportFlow.js --clientId=${clientId}`, {
        cwd: path.join(__dirname, ".."),
        stdio: "inherit",
        env: { ...process.env, APEX_SYNC_CLIENT_ID: clientId },
      });
    }
  }

  let importResult = { synced: 0, collections: 0 };
  if (!skipImport) {
    console.log("\nImporting Meta catalog → Mongo…");
    if (dryRun) {
      console.log("(dry-run: skipped import)");
    } else {
      importResult = await runMetaCatalogImport(clientId);
      console.log(`  Products: ${importResult.synced}, collections/sets: ${importResult.collections}`);
    }
  }

  console.log("\nSyncing category menu + MPM product IDs from collections…");
  let syncResult = { ok: false };
  if (dryRun) {
    console.log("(dry-run: skipped flow patch)");
  } else {
    syncResult = await syncApexCatalogFlowFromMeta(clientId);
    console.log(JSON.stringify(syncResult, null, 2));
  }

  if (!dryRun) {
    clearTriggerCache(clientId);
    await clearClientCache(clientId);
  }

  const client = await Client.findOne({ clientId })
    .select("facebookCatalogId syncedMetaTemplates")
    .lean();
  const hasCarouselTpl = (client?.syncedMetaTemplates || []).some(
    (t) => t.name === "carosuel" && String(t.status || "").toUpperCase() === "APPROVED"
  );

  console.log("\n=== Done ===\n");
  console.log("WhatsApp MPM carousel UX:");
  console.log("  • The chat shows a template preview + “View items” button (Meta requirement).");
  console.log("  • Customer taps View items → horizontal product carousel opens inside WhatsApp.");
  console.log("  • Header text “Best Seller” is fixed in Meta template “carosuel” — change it in Meta Manager");
  console.log("    (e.g. “{{1}} products”) if you want category names instead of Best Seller.");
  console.log(`  • Template "carosuel" approved in dashboard: ${hasCarouselTpl ? "yes" : "NO — sync templates"}`);
  console.log("\nIf Flow Builder still looks old: hard-refresh, do NOT Publish unless you edited the graph.");
  console.log("Restart API after backend deploy.\n");
}

run()
  .catch((err) => {
    console.error("\n[refreshApexCatalogFlow] Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
