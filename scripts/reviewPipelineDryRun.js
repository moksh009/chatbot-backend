#!/usr/bin/env node
/**
 * Controlled dry-run of the post-fulfillment review pipeline:
 * 1) Prefer Shopify Admin REST order JSON (needs shop domain + token)
 * 2) Else build order-shaped payload from internal Order (still exercises scheduling + dispatch stubs)
 * 3) Stub WhatsApp + email (no customer messages)
 * 4) processPendingReviewRequests → scheduled → sent
 * 5) Delete the test ReviewRequest row
 *
 * Usage:
 *   node scripts/reviewPipelineDryRun.js <clientId> [--shopify-order-id=123] [--shop-domain=store.myshopify.com]
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const axios = require("axios");

const Client = require("../models/Client");
const Order = require("../models/Order");
const ReviewRequest = require("../models/ReviewRequest");
const { decrypt } = require("../utils/encryption");
const shopifyAdminApiVersion = require("../utils/shopifyAdminApiVersion");

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const clientId = positional[0];
  let shopifyOrderId = null;
  let shopDomainOverride = null;
  for (const a of argv) {
    if (a.startsWith("--shopify-order-id=")) {
      shopifyOrderId = String(a.split("=")[1] || "").trim();
    }
    if (a.startsWith("--shop-domain=")) {
      shopDomainOverride = String(a.split("=")[1] || "").trim();
    }
  }
  return { clientId, shopifyOrderId, shopDomainOverride };
}

function normalizeShopHost(domain) {
  return String(domain || "")
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .trim();
}

function resolveShopifyCredentials(clientLean, domainOverride) {
  const host = normalizeShopHost(
    domainOverride ||
      clientLean.shopDomain ||
      clientLean.commerce?.shopify?.domain ||
      ""
  );
  const rawToken =
    clientLean.shopifyAccessToken ||
    clientLean.commerce?.shopify?.accessToken ||
    "";
  const token = decrypt(rawToken);
  return { host, token };
}

async function fetchShopifyOrder(clientLean, orderIdNumeric, domainOverride) {
  const { host, token } = resolveShopifyCredentials(clientLean, domainOverride);
  if (!host || !token) {
    throw new Error(
      "Missing shop domain or access token (use --shop-domain= when DB has no domain)"
    );
  }
  const url = `https://${host}/admin/api/${shopifyAdminApiVersion}/orders/${orderIdNumeric}.json`;
  const res = await axios.get(url, {
    headers: { "X-Shopify-Access-Token": token },
    timeout: 45000,
  });
  return res.data.order;
}

/** Shopify webhook-shaped payload from persisted Order (partial; enough for schedule + stubs). */
function buildOrderPayloadFromInternal(orderLean) {
  const sid = orderLean.shopifyOrderId || String(orderLean.orderId || "").replace(/\D/g, "");
  const first = Array.isArray(orderLean.items) ? orderLean.items[0] : null;
  const phone = orderLean.customerPhone || orderLean.phone || "";
  return {
    id: sid || orderLean._id,
    name: orderLean.orderNumber || orderLean.orderId || `#${orderLean.orderId}`,
    phone,
    customer: phone ? { phone } : undefined,
    line_items: [
      {
        title: first?.name || "Product",
        product_id: first?.product_id || "",
        variant_id: first?.variant_id || "",
        sku: first?.sku || "",
        image_url: first?.image || "",
        price: String(first?.price ?? ""),
      },
    ],
  };
}

function installDryRunStubs() {
  const WhatsApp = require("../utils/whatsapp");
  const EmailService = require("../utils/emailService");

  const captured = { wa: [], email: [] };

  const origST = WhatsApp.sendSmartTemplate;
  const origTxt = WhatsApp.sendText;
  WhatsApp.sendSmartTemplate = async (...args) => {
    captured.wa.push({ kind: "sendSmartTemplate", args });
    return { dryRun: true };
  };
  WhatsApp.sendText = async (...args) => {
    captured.wa.push({ kind: "sendText", args });
    return { dryRun: true };
  };

  const origMail = EmailService.sendReviewRequestEmail;
  EmailService.sendReviewRequestEmail = async (...args) => {
    captured.email.push(args);
    return true;
  };

  return {
    captured,
    restore() {
      WhatsApp.sendSmartTemplate = origST;
      WhatsApp.sendText = origTxt;
      EmailService.sendReviewRequestEmail = origMail;
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { clientId, shopifyOrderId: cliOrderId, shopDomainOverride } =
    parseArgs(argv);

  if (!clientId) {
    console.error(
      "Usage: node scripts/reviewPipelineDryRun.js <clientId> [--shopify-order-id=NUM] [--shop-domain=host]"
    );
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI missing");
    process.exit(1);
  }

  const { captured, restore } = installDryRunStubs();
  const {
    scheduleReviewRequest,
    dispatchReviewRequest,
  } = require("../utils/reputationService");

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 90000,
  });

  const client = await Client.findOne({ clientId }).lean();
  if (!client) {
    restore();
    console.error(`Client not found: ${clientId}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const internalOrder =
    (cliOrderId &&
      (await Order.findOne({
        clientId,
        shopifyOrderId: String(cliOrderId),
      }).lean())) ||
    (await Order.findOne({
      clientId,
      shopifyOrderId: { $exists: true, $nin: [null, ""] },
    })
      .sort({ createdAt: -1 })
      .lean()) ||
    (await Order.findOne({ clientId }).sort({ createdAt: -1 }).lean());

  if (!internalOrder) {
    restore();
    console.error("No Order documents for client.");
    await mongoose.disconnect();
    process.exit(1);
  }

  let orderNumeric =
    cliOrderId ||
    internalOrder.shopifyOrderId ||
    String(internalOrder.orderId || "").replace(/\D/g, "");

  const numericStr = String(orderNumeric).replace(/\D/g, "") || String(orderNumeric);

  let shopifyOrder = null;
  let orderSource = "internal_order";

  try {
    shopifyOrder = await fetchShopifyOrder(client, numericStr, shopDomainOverride);
    orderSource = "shopify_rest_api";
  } catch (e) {
    shopifyOrder = buildOrderPayloadFromInternal(internalOrder);
    orderSource = `internal_order_fallback (${e.message})`;
  }

  const oid = String(shopifyOrder.id);
  await ReviewRequest.deleteMany({ clientId, orderId: oid });

  const scheduled = await scheduleReviewRequest(client, shopifyOrder);
  if (!scheduled) {
    restore();
    console.error(
      "scheduleReviewRequest returned nothing (missing phone on order payload?)."
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const rrId = scheduled._id;
  await ReviewRequest.updateOne(
    { _id: rrId },
    { $set: { scheduledFor: new Date(Date.now() - 120000) } }
  );

  const rrDoc = await ReviewRequest.findById(rrId);
  await dispatchReviewRequest(rrDoc);

  const after = await ReviewRequest.findById(rrId).lean();

  const waTemplate = captured.wa.find((x) => x.kind === "sendSmartTemplate");
  const waText = captured.wa.find((x) => x.kind === "sendText");
  const templateArgs = waTemplate?.args || [];
  const headerImage =
    templateArgs.length >= 5 ? templateArgs[4] : null;
  const bodyVars = templateArgs[3];
  const emailCall = captured.email[0];
  const emailPayload =
    Array.isArray(emailCall) && emailCall.length >= 2 ? emailCall[1] : null;

  const report = {
    clientId,
    orderSource,
    shopifyOrderId: oid,
    reviewRequestId: String(rrId),
    scheduleFields: {
      productId: scheduled.productId || "",
      productName: scheduled.productName || "",
      productImageOnSchedule: scheduled.productImage || "",
    },
    afterDispatch: {
      status: after?.status,
      sentAt: after?.sentAt || null,
    },
    dryRunCaptures: {
      whatsAppTemplateName: templateArgs[2] || "review_request",
      templateBodyVariables: Array.isArray(bodyVars) ? bodyVars : [],
      headerImageUrl: headerImage || null,
      fellBackToText: !!waText && !waTemplate,
      emailHadProductImage: !!(emailPayload && emailPayload.productImage),
      emailProductImageUrl: emailPayload?.productImage || null,
    },
    assertions: {
      statusSent: after?.status === "sent",
      outboundAttempted: captured.wa.length > 0 || captured.email.length > 0,
      productIdentity:
        !!(scheduled.productId && String(scheduled.productId).trim().length) ||
        !!(scheduled.productImage && String(scheduled.productImage).trim().length) ||
        (!!scheduled.productName &&
          scheduled.productName !== "Your Purchase"),
      channelStubbedOk:
        (!!waTemplate || !!waText) &&
        (!emailPayload || typeof emailPayload.customerEmail === "string"),
    },
  };

  await ReviewRequest.deleteOne({ _id: rrId });
  restore();

  console.log(JSON.stringify(report, null, 2));

  const ok =
    report.assertions.statusSent &&
    report.assertions.outboundAttempted &&
    report.assertions.productIdentity;

  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error("reviewPipelineDryRun failed:", err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
