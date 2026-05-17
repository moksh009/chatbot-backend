#!/usr/bin/env node
"use strict";

/**
 * One-time migration: AdLead.warrantyRecords -> WarrantyRecord (canonical store).
 * Idempotent: skips records already migrated using deterministic keys.
 *
 * Usage:
 *   node scripts/migrateLegacyWarrantyRecords.js --client delitech_smarthomes --apply
 *   node scripts/migrateLegacyWarrantyRecords.js --client all --apply
 *   node scripts/migrateLegacyWarrantyRecords.js --client all
 */

const path = require("path");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config();

const AdLead = require("../models/AdLead");
const Contact = require("../models/Contact");
const WarrantyBatch = require("../models/WarrantyBatch");
const WarrantyRecord = require("../models/WarrantyRecord");

function argValue(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith("--")) return fallback;
  return val;
}
function hasFlag(flag) {
  return process.argv.includes(flag);
}

function toDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

async function ensureDefaultBatch(clientId) {
  let batch = await WarrantyBatch.findOne({ clientId, status: "active" }).sort({ createdAt: -1 });
  if (!batch) {
    batch = await WarrantyBatch.create({
      clientId,
      batchName: "Legacy Warranty Migration",
      shopifyProductIds: [],
      durationMonths: 12,
      validFrom: new Date(),
      status: "active",
    });
  }
  return batch;
}

async function ensureContact(clientId, lead) {
  let contact = await Contact.findOne({ clientId, phoneNumber: lead.phoneNumber });
  if (!contact) {
    contact = await Contact.create({
      clientId,
      phoneNumber: lead.phoneNumber,
      name: lead.name || "Customer",
      email: lead.email || "",
    });
  }
  return contact;
}

function makeLegacyKey(legacy) {
  const orderId = String(legacy.orderId || "");
  const productName = String(legacy.productName || "").toLowerCase();
  const purchaseDate = toDate(legacy.purchaseDate || legacy.registeredAt || Date.now()).toISOString().slice(0, 10);
  return `${orderId}::${productName}::${purchaseDate}`;
}

async function migrateClient(clientId, apply) {
  const leads = await AdLead.find({
    clientId,
    warrantyRecords: { $exists: true, $ne: [] },
  }).lean();

  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  const batch = await ensureDefaultBatch(clientId);

  for (const lead of leads) {
    try {
      const contact = await ensureContact(clientId, lead);
      const existing = await WarrantyRecord.find({ clientId, customerId: contact._id }).lean();
      const existingKeys = new Set(existing.map((r) => {
        const key = `${String(r.shopifyOrderId || "")}::${String(r.productName || "").toLowerCase()}::${toDate(r.purchaseDate).toISOString().slice(0, 10)}`;
        return key;
      }));

      for (const legacy of lead.warrantyRecords || []) {
        const key = makeLegacyKey(legacy);
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }

        const purchaseDate = toDate(legacy.purchaseDate || legacy.registeredAt || Date.now());
        const expiryDate = toDate(legacy.expiryDate || purchaseDate);
        const shopifyOrderId = String(legacy.orderId || `legacy-${lead._id}-${Date.now()}`);
        const productName = String(legacy.productName || "Registered Product");
        const productId = String(legacy.serialNumber || productName);
        const status = ["active", "expired", "terminated", "void"].includes(String(legacy.status || "").toLowerCase())
          ? String(legacy.status).toLowerCase()
          : "active";

        if (apply) {
          await WarrantyRecord.create({
            clientId,
            customerId: contact._id,
            shopifyOrderId,
            productId,
            productName,
            purchaseDate,
            expiryDate,
            batchId: batch._id,
            status,
          });
        }
        existingKeys.add(key);
        migrated += 1;
      }
    } catch (err) {
      errors += 1;
    }
  }

  return { clientId, leads: leads.length, migrated, skipped, errors, apply };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("Missing MONGODB_URI");
  const selector = argValue("--client", "all");
  const apply = hasFlag("--apply");

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 90000 });

  let clientIds = [];
  if (selector === "all") {
    clientIds = await AdLead.distinct("clientId", { warrantyRecords: { $exists: true, $ne: [] } });
  } else {
    clientIds = [selector];
  }

  if (!clientIds.length) {
    console.log("No clients with legacy warranty records found.");
    return;
  }

  const rows = [];
  for (const clientId of clientIds) {
    rows.push(await migrateClient(clientId, apply));
  }
  console.table(rows);
}

main()
  .catch((err) => {
    console.error("migrateLegacyWarrantyRecords failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) {}
  });

