#!/usr/bin/env node
"use strict";

/**
 * Optional migration helper — report flows with manual MPM catalog nodes
 * that could be replaced by a Browse products branch.
 *
 * Usage:
 *   node scripts/migrateCatalogToBrowseBranch.js --clientId=tenant_id [--dry-run]
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Client = require("../models/Client");

async function main() {
  const args = process.argv.slice(2);
  const clientArg = args.find((a) => a.startsWith("--clientId="));
  const clientId = clientArg ? clientArg.split("=")[1] : null;
  const dryRun = !args.includes("--apply");

  if (!clientId) {
    console.error("Usage: node scripts/migrateCatalogToBrowseBranch.js --clientId=ID [--apply]");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const client = await Client.findOne({ clientId }).select("visualFlows clientId").lean();
  if (!client) {
    console.error("Client not found:", clientId);
    process.exit(1);
  }

  const flows = Array.isArray(client.visualFlows) ? client.visualFlows : [];
  let reportCount = 0;

  for (const vf of flows) {
    const nodes = vf.nodes || [];
    const mpmNodes = nodes.filter(
      (n) => n.type === "catalog" && n.data?.catalogType === "mpm_template" && !n.data?.browseBranch
    );
    const hasBrowseMenu = nodes.some((n) => n.data?.browseBranchMenu);
    if (mpmNodes.length >= 2 && !hasBrowseMenu) {
      reportCount += 1;
      console.log(`Flow ${vf.id || vf.name}: ${mpmNodes.length} manual MPM nodes, no browse menu`);
      mpmNodes.slice(0, 5).forEach((n) => {
        console.log(`  - ${n.id}: ${n.data?.label || n.data?.sectionTitle || "(unnamed)"}`);
      });
    }
  }

  if (reportCount === 0) {
    console.log("No manual MPM clusters needing migration.");
  } else if (dryRun) {
    console.log(`\n${reportCount} flow(s) flagged. Re-drop Browse products in Flow Builder or run with --apply (future).`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
