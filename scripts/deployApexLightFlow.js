#!/usr/bin/env node
"use strict";
/**
 * deployApexLightFlow.js — One command to push Apex Light flow + sync catalog for production.
 *
 * Steps:
 *   1) Push repo apexLightOwnerFlow.js → Mongo (setupApexOwnerSupportFlow)
 *   2) Import Meta catalog → Mongo
 *   3) Patch MPM product IDs per explore category
 *   4) Clear trigger + client cache
 *
 * Usage:
 *   node scripts/deployApexLightFlow.js
 *   node scripts/deployApexLightFlow.js --clientId=shubhampatelsbusiness_1cfb2b
 *   node scripts/deployApexLightFlow.js --skip-import   # flow copy only
 *   node scripts/deployApexLightFlow.js --dry-run
 *
 * Requires: MONGODB_URI (or MONGO_URI) in chatbot-backend-main/.env
 */

const path = require("path");
const { execSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { FLOW_ID } = require("../data/apexLightOwnerFlow");
const { runMetaCatalogImport, diagnoseMetaCatalogAccess } = require("../utils/meta/metaCatalogSync");
const { syncApexCatalogFlowFromMeta } = require("../utils/shopify/apexCatalogFlowSync");
const { clearTriggerCache } = require("../utils/flow/triggerEngine");
const { clearClientCache } = require("../middleware/apiCache");

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

  console.log("\n=== Apex Light — full deploy ===\n");
  console.log("Client:", clientId);
  if (dryRun) console.log("(dry-run mode)\n");

  if (!dryRun) {
    console.log("Step 1/4: Push flow graph from repo…\n");
    execSync(`node scripts/setupApexOwnerSupportFlow.js --clientId=${clientId}`, {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
      env: { ...process.env, APEX_SYNC_CLIENT_ID: clientId },
    });
  } else {
    console.log("Step 1/4: (dry-run skipped setupApexOwnerSupportFlow)\n");
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 90000 });

  const diag = await diagnoseMetaCatalogAccess(clientId);
  console.log("\nStep 2/4: Catalog diagnose:");
  console.log(JSON.stringify(diag, null, 2));

  if (!skipImport && !diag.canImport && !dryRun) {
    console.warn(
      "\nWarning: Meta catalog import not available — continuing with flow-only deploy. Fix Commerce token and re-run."
    );
  }

  let importResult = { synced: 0, collections: 0 };
  if (!skipImport && !dryRun && diag.canImport) {
    console.log("\nStep 3/4: Import Meta catalog → Mongo…");
    importResult = await runMetaCatalogImport(clientId);
    console.log(`  Products synced: ${importResult.synced}, collections: ${importResult.collections}`);
  } else if (skipImport) {
    console.log("\nStep 3/4: (--skip-import) skipped catalog import");
  }

  let syncResult = null;
  if (!dryRun) {
    console.log("\nStep 4/4: Patch category menu + MPM product IDs…");
    syncResult = await syncApexCatalogFlowFromMeta(clientId, { flowId: FLOW_ID });
    clearTriggerCache(clientId);
    await clearClientCache(clientId);
  }

  const flow = await WhatsAppFlow.findOne({ clientId, flowId: FLOW_ID })
    .select("publishedNodes publishedEdges version")
    .lean();
  const pubNodes = flow?.publishedNodes || [];
  const pubEdges = flow?.publishedEdges || [];
  const mpmNodes = pubNodes.filter((n) => n.type === "catalog" && n.data?.catalogType === "mpm_template");
  const mpmSummary = mpmNodes.map((n) => ({
    id: n.id,
    header: n.data?.header,
    productCount: String(n.data?.productIds || "").split(",").filter(Boolean).length,
    apexPreferProductList: !!n.data?.apexPreferProductList,
  }));

  const client = await Client.findOne({ clientId })
    .select("facebookCatalogId commerceBotSettings.checkoutMessage")
    .lean();

  console.log("\n=== Deploy summary ===\n");
  console.log(
    JSON.stringify(
      {
        success: true,
        clientId,
        flowId: FLOW_ID,
        flowVersion: flow?.version,
        nodeCount: pubNodes.length,
        edgeCount: pubEdges.length,
        cartEdges: pubEdges.filter((e) => e.sourceHandle === "cart").length,
        hasPostCart: pubNodes.some((n) => n.id === "n_post_cart"),
        catalogImport: importResult,
        mpmPatch: syncResult,
        mpmNodes: mpmSummary,
        facebookCatalogId: client?.facebookCatalogId || null,
        checkoutMessageSet: !!client?.commerceBotSettings?.checkoutMessage,
      },
      null,
      2
    )
  );

  console.log("\nNext steps:");
  console.log("  1. Restart API if backend code changed (dualBrainEngine)");
  console.log("  2. Hard-refresh Flow Builder — do NOT Publish from stale tab");
  console.log("  3. WhatsApp test: hi → Shop & prices → TV Backlights → add to cart → menu\n");
}

run()
  .catch((err) => {
    console.error("\n[deployApexLightFlow] Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });
