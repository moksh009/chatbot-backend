#!/usr/bin/env node
"use strict";

/**
 * Upgrade existing clients to the latest deterministic ecommerce flow graph
 * without requiring manual "AI form to flow" regeneration in the UI.
 *
 * Usage:
 *   node scripts/upgradeLegacyEcommerceFlows.js --client delitech --apply --publish
 *   node scripts/upgradeLegacyEcommerceFlows.js --client apex --apply --publish
 *   node scripts/upgradeLegacyEcommerceFlows.js --client all --apply --publish
 */

const mongoose = require("mongoose");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config();

const Client = require("../models/Client");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const FlowHistory = require("../models/FlowHistory");
const { generateEcommerceFlow } = require("../utils/flowGenerator");

function argValue(flag, fallback = "") {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function toStoreHost(raw = "") {
  return String(raw || "").replace(/^https?:\/\//, "").trim();
}

function buildWizardData(client) {
  return {
    businessName: client.businessName || client.name || undefined,
    shopDomain: client.platformVars?.shopDomain || client.platformVars?.shopifyDomain || client.shopDomain || undefined,
    checkoutUrl: client.platformVars?.checkoutUrl || undefined,
    googleReviewUrl: client.platformVars?.googleReviewUrl || client.googleReviewUrl || undefined,
    currency: client.platformVars?.baseCurrency || "₹",
    tone: client.ai?.persona?.tone || client.platformVars?.defaultTone || "friendly",
    botLanguage: client.ai?.persona?.language || client.platformVars?.defaultLanguage || "Hinglish",
    flowType: "ecommerce",
    riskPosture: "balanced",
    productMode: "catalog",
    features: {
      enableCatalog: true,
      enableCatalogCheckoutRecovery: client.wizardFeatures?.enableCatalogCheckoutRecovery !== false,
      catalogCheckoutDelayMin: Number(client.wizardFeatures?.catalogCheckoutDelayMin || 20),
      enableOrderTracking: true,
      enableReturnsRefunds: true,
      enableCancelOrder: true,
      enableSupportEscalation: true,
      enableAIFallback: true,
      enableFAQ: true,
      enableInstallSupport: client.wizardFeatures?.enableInstallSupport !== false,
      enableWarranty: client.wizardFeatures?.enableWarranty !== false,
      enableLoyalty: !!client.wizardFeatures?.enableLoyalty
    },
    useAiCopy: false,
    preserveNodeIds: true
  };
}

async function pickClients(selector) {
  if (selector === "all") {
    return Client.find({}).lean();
  }
  const regex = new RegExp(selector, "i");
  return Client.find({
    $or: [
      { clientId: regex },
      { name: regex },
      { businessName: regex },
      { shopDomain: regex }
    ]
  }).lean();
}

async function upgradeOne(client, { apply, publish }) {
  const clientId = client.clientId;
  const wizardData = buildWizardData(client);
  const generated = await generateEcommerceFlow(client, wizardData);

  let flow = await WhatsAppFlow.findOne({
    clientId,
    platform: "whatsapp",
    isAutomation: { $ne: true }
  }).sort({ status: -1, updatedAt: -1 });

  const created = !flow;
  if (!flow) {
    flow = new WhatsAppFlow({
      clientId,
      flowId: `flow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: `${client.businessName || client.name || "Business"} - Ecommerce Flow`,
      platform: "whatsapp",
      status: publish ? "PUBLISHED" : "DRAFT",
      version: 1,
      nodes: generated.nodes,
      edges: generated.edges,
      publishedNodes: publish ? generated.nodes : [],
      publishedEdges: publish ? generated.edges : [],
      generatedBy: "legacy-upgrade-script",
      isAutomation: false
    });
  } else {
    if (publish && Array.isArray(flow.publishedNodes) && flow.publishedNodes.length) {
      await FlowHistory.create({
        clientId,
        flowId: flow.flowId,
        version: flow.version || 1,
        nodes: flow.publishedNodes,
        edges: flow.publishedEdges,
        publishedBy: "legacy-upgrade-script"
      });
    }
    flow.nodes = generated.nodes;
    flow.edges = generated.edges;
    if (publish) {
      flow.publishedNodes = generated.nodes;
      flow.publishedEdges = generated.edges;
      flow.status = "PUBLISHED";
      flow.version = Number(flow.version || 1) + 1;
      flow.lastSyncedAt = new Date();
    }
    flow.generatedBy = "legacy-upgrade-script";
  }

  if (apply) {
    await flow.save();

    const host = toStoreHost(
      client.platformVars?.shopDomain || client.platformVars?.shopifyDomain || client.shopDomain || ""
    );

    // Keep legacy mirrors synced for compatibility.
    await Client.updateOne(
      { clientId },
      {
        $set: {
          flowNodes: generated.nodes,
          flowEdges: generated.edges,
          "platformVars.shopDomain": host || client.platformVars?.shopDomain || "",
          "platformVars.checkoutUrl":
            client.platformVars?.checkoutUrl || (host ? `https://${host}/cart` : ""),
          "wizardFeatures.enableCatalogCheckoutRecovery": wizardData.features.enableCatalogCheckoutRecovery,
          "wizardFeatures.catalogCheckoutDelayMin": wizardData.features.catalogCheckoutDelayMin,
          "wizardFeatures.enableInstallSupport": wizardData.features.enableInstallSupport
        }
      }
    );
  }

  return {
    clientId,
    flowId: flow.flowId,
    created,
    publish,
    apply,
    nodeCount: generated.nodes.length,
    edgeCount: generated.edges.length
  };
}

async function main() {
  const selector = argValue("--client", "all");
  const apply = hasFlag("--apply");
  const publish = hasFlag("--publish");

  if (!process.env.MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in environment");
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 90000 });
  const clients = await pickClients(selector);
  if (!clients.length) {
    console.log(`No clients matched selector "${selector}"`);
    return;
  }

  console.log(`Matched ${clients.length} client(s) for selector "${selector}"`);
  if (!apply) {
    console.log("Dry run mode: pass --apply to persist changes");
  }

  const rows = [];
  for (const c of clients) {
    try {
      const row = await upgradeOne(c, { apply, publish });
      rows.push({ ...row, status: "ok" });
    } catch (err) {
      rows.push({ clientId: c.clientId, status: "failed", error: err.message });
    }
  }
  console.table(rows);
}

main()
  .catch((err) => {
    console.error("upgradeLegacyEcommerceFlows failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (_) {}
  });

