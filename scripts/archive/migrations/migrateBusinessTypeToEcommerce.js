#!/usr/bin/env node
"use strict";

/**
 * One-time migration for e-commerce-only product scope.
 * Updates all User.business_type and Client.businessType to "ecommerce".
 *
 * Usage:
 *   node scripts/migrateBusinessTypeToEcommerce.js --dry-run
 *   node scripts/migrateBusinessTypeToEcommerce.js
 */

const mongoose = require("mongoose");
const User = require("../models/User");
const Client = require("../models/Client");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const isDryRun = process.argv.includes("--dry-run");

async function run() {
  if (!MONGO_URI) {
    throw new Error("Missing MONGO_URI or MONGODB_URI");
  }

  await mongoose.connect(MONGO_URI);
  console.log(`[migrateBusinessTypeToEcommerce] Connected. dryRun=${isDryRun}`);

  const userFilter = { business_type: { $ne: "ecommerce" } };
  const clientFilter = { businessType: { $ne: "ecommerce" } };

  const [usersToUpdate, clientsToUpdate] = await Promise.all([
    User.countDocuments(userFilter),
    Client.countDocuments(clientFilter),
  ]);

  console.log(`[migrateBusinessTypeToEcommerce] Users to update: ${usersToUpdate}`);
  console.log(`[migrateBusinessTypeToEcommerce] Clients to update: ${clientsToUpdate}`);

  if (!isDryRun) {
    const [usersRes, clientsRes] = await Promise.all([
      User.updateMany(userFilter, { $set: { business_type: "ecommerce" } }),
      Client.updateMany(clientFilter, { $set: { businessType: "ecommerce" } }),
    ]);

    console.log(`[migrateBusinessTypeToEcommerce] Users modified: ${usersRes.modifiedCount || 0}`);
    console.log(`[migrateBusinessTypeToEcommerce] Clients modified: ${clientsRes.modifiedCount || 0}`);
  }

  await mongoose.disconnect();
  console.log("[migrateBusinessTypeToEcommerce] Done.");
}

run().catch(async (err) => {
  console.error("[migrateBusinessTypeToEcommerce] Failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

