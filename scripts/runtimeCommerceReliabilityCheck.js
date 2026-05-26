#!/usr/bin/env node
"use strict";

const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const Client = require("../models/Client");
const Contact = require("../models/Contact");
const WarrantyRecord = require("../models/WarrantyRecord");
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

async function main() {
  const clientId = process.argv[2];
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

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Runtime reliability check failed:", err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});

