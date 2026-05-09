#!/usr/bin/env node
"use strict";

const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const Client = require("../models/Client");
const Contact = require("../models/Contact");
const WarrantyRecord = require("../models/WarrantyRecord");
const CustomerWallet = require("../models/CustomerWallet");
const LoyaltyTransaction = require("../models/LoyaltyTransaction");
const ReviewRequest = require("../models/ReviewRequest");
const { processPendingReviewRequests } = require("../utils/reputationService");

function resultLine(status, label, details = "") {
  const icon = status === "PASS" ? "PASS" : status === "WARN" ? "WARN" : "FAIL";
  console.log(`${icon} | ${label}${details ? ` | ${details}` : ""}`);
}

async function checkWarranty(clientId) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const records = await WarrantyRecord.find({ clientId, createdAt: { $gte: since } })
    .select("customerId productName shopifyOrderId status")
    .limit(100)
    .lean();

  if (!records.length) {
    resultLine("WARN", "Warranty activity", "No recent records in last 30 days");
    return;
  }

  const customerIds = [...new Set(records.map((r) => String(r.customerId || "")).filter(Boolean))];
  const contacts = await Contact.find({ _id: { $in: customerIds } }).select("_id").lean();
  const contactSet = new Set(contacts.map((c) => String(c._id)));
  const dangling = records.filter((r) => !contactSet.has(String(r.customerId || "")));

  if (dangling.length) {
    resultLine("FAIL", "Warranty contact linkage", `${dangling.length}/${records.length} records missing contact`);
  } else {
    resultLine("PASS", "Warranty contact linkage", `${records.length} recent records linked`);
  }
}

async function checkLoyalty(clientId) {
  const wallets = await CustomerWallet.find({ clientId })
    .select("phone balance lifetimePoints tier updatedAt")
    .sort({ updatedAt: -1 })
    .limit(50)
    .lean();
  if (!wallets.length) {
    resultLine("WARN", "Loyalty activity", "No wallets found");
    return;
  }

  let drift = 0;
  for (const w of wallets) {
    const lastTx = await LoyaltyTransaction.findOne({ clientId, phone: w.phone })
      .sort({ timestamp: -1 })
      .select("balanceAfter")
      .lean();
    if (lastTx && typeof lastTx.balanceAfter === "number" && lastTx.balanceAfter !== w.balance) drift += 1;
  }

  if (drift) {
    resultLine("WARN", "Loyalty balance parity", `${drift}/${wallets.length} sampled wallets differ from latest ledger`);
  } else {
    resultLine("PASS", "Loyalty balance parity", `${wallets.length} sampled wallets aligned`);
  }
}

async function checkReview(clientId, runDryDispatch = false) {
  const requests = await ReviewRequest.find({ clientId })
    .sort({ createdAt: -1 })
    .limit(80)
    .select("orderId productId productName productImage status scheduledFor sentAt")
    .lean();

  if (!requests.length) {
    resultLine("WARN", "Review activity", "No review requests found");
    return;
  }

  const missingProductIdentity = requests.filter((r) => !r.productId && !r.productImage).length;
  const missingProductName = requests.filter((r) => !r.productName).length;
  if (missingProductIdentity > 0 || missingProductName > 0) {
    resultLine(
      "WARN",
      "Review product mapping",
      `missing identity: ${missingProductIdentity}, missing name: ${missingProductName} (sample=${requests.length})`
    );
  } else {
    resultLine("PASS", "Review product mapping", `${requests.length} recent requests have product mapping`);
  }

  if (!runDryDispatch) return;
  const beforeSent = await ReviewRequest.countDocuments({ clientId, status: "sent" });
  await processPendingReviewRequests();
  const afterSent = await ReviewRequest.countDocuments({ clientId, status: "sent" });
  const delta = afterSent - beforeSent;
  resultLine("PASS", "Review dispatch dry-run", `processed sent delta=${delta} (safe no-op if none scheduled)`);
}

async function main() {
  const clientId = process.argv[2];
  const runDryDispatch = process.argv.includes("--dispatch");
  if (!clientId) {
    console.error("Usage: node scripts/runtimeCommerceReliabilityCheck.js <clientId> [--dispatch]");
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI missing in environment/.env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 90000 });
  const client = await Client.findOne({ clientId }).select("clientId").lean();
  if (!client) {
    console.error(`Client not found: ${clientId}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Running reliability checks for client=${clientId}`);
  await checkWarranty(clientId);
  await checkLoyalty(clientId);
  await checkReview(clientId, runDryDispatch);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Runtime reliability check failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

