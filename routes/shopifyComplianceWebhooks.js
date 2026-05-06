"use strict";

/**
 * Mandatory compliance webhooks (App Store): customers/data_request, customers/redact, shop/redact.
 * HMAC is verified with the app API client secret (SHOPIFY_CLIENT_SECRET), not per-shop webhook secrets.
 * @see https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks
 * @see https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const Client = require("../models/Client");
const Order = require("../models/Order");
const AdLead = require("../models/AdLead");
const log = require("../utils/logger")("ShopifyCompliance");
const { normalizePhone } = require("../utils/helpers");

function normalizeShopDomain(domain) {
  if (!domain || typeof domain !== "string") return "";
  return domain.trim().toLowerCase();
}

function verifyComplianceHmac(req, res, next) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const secret = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    log.error("[Compliance] SHOPIFY_CLIENT_SECRET/SHOPIFY_API_SECRET is not set");
    return res.status(500).send("Server misconfigured");
  }
  if (!hmac) {
    return res.status(401).send("Missing HMAC");
  }

  const rawBuf = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}), "utf8");

  const digest = crypto.createHmac("sha256", secret).update(rawBuf).digest("base64");

  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(digest, "base64"), Buffer.from(hmac, "base64"));
  } catch (_) {
    ok = false;
  }

  if (!ok) {
    return res.status(401).send("Invalid signature");
  }
  next();
}

function requireJsonBody(req, res, next) {
  const contentType = String(req.get("Content-Type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return res.status(415).send("Unsupported Media Type");
  }
  next();
}

async function handleCustomerRedact(payload) {
  const domain = normalizeShopDomain(payload.shop_domain);
  const client = await Client.findOne({ shopDomain: domain });
  if (!client) {
    log.info(`[Compliance] customers/redact — no client for shop ${domain}`);
    return;
  }

  const ids = (payload.orders_to_redact || []).map((id) => String(id));
  const idVariants = new Set();
  for (const id of ids) {
    idVariants.add(id);
    idVariants.add(`#${id}`);
    idVariants.add(`#${id.replace(/^#/, "")}`);
  }

  const email = (payload.customer?.email || "").trim().toLowerCase();
  const phoneRaw = payload.customer?.phone;
  const cleanPhone = phoneRaw ? normalizePhone(phoneRaw) : null;

  const or = [];
  if (idVariants.size) or.push({ orderId: { $in: [...idVariants] } });
  if (email) {
    or.push({ customerEmail: email }, { email: email });
  }
  if (cleanPhone) {
    or.push({ customerPhone: cleanPhone }, { phone: cleanPhone });
  }

  if (!or.length) {
    log.info(`[Compliance] customers/redact — no identifiers for ${domain}`);
    return;
  }

  const filter = { clientId: client.clientId, $or: or };

  const redacted = {
    customerName: "[Redacted]",
    name: "[Redacted]",
    customerPhone: "",
    phone: "",
    customerEmail: "",
    email: "",
    address: "",
    shippingAddress: {},
    billingAddress: {},
    items: [],
  };

  const orderRes = await Order.updateMany(filter, { $set: redacted });
  log.info(
    `[Compliance] customers/redact — orders updated: ${orderRes.modifiedCount} (shop ${domain})`
  );

  const leadOr = [];
  if (cleanPhone) leadOr.push({ phoneNumber: cleanPhone });
  if (email) leadOr.push({ email: email });
  if (leadOr.length) {
    const del = await AdLead.deleteMany({ clientId: client.clientId, $or: leadOr });
    log.info(`[Compliance] customers/redact — AdLead removed: ${del.deletedCount} (shop ${domain})`);
  }
}

async function handleShopRedact(payload) {
  const domain = normalizeShopDomain(payload.shop_domain);
  const clients = await Client.find({
    shopDomain: new RegExp(`^${domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  });

  if (!clients.length) {
    log.info(`[Compliance] shop/redact — no client for shop ${domain}`);
    return;
  }

  for (const client of clients) {
    const cid = client.clientId;
    await Order.deleteMany({ clientId: cid });
    await AdLead.updateMany({ clientId: cid }, {
      $unset: { commerceEvents: "" },
      $set: { chatSummary: "" },
    }).catch((e) => log.warn(`[Compliance] AdLead shop redact: ${e.message}`));

    await Client.updateOne(
      { _id: client._id },
      {
        $set: {
          shopDomain: "",
          shopifyAccessToken: "",
          shopifyRefreshToken: "",
          shopifyScopes: "",
          shopifyWebhookSecret: "",
          shopifyClientSecret: "",
          shopifyTokenExpiresAt: null,
          shopifyConnectionStatus: "disconnected",
          lastShopifyError: "",
          storeType: "manual",
          shopifyWebhooks: {},
          "commerce.storeType": "manual",
          "commerce.shopify.domain": "",
          "commerce.shopify.accessToken": "",
          "commerce.shopify.refreshToken": "",
          "commerce.shopify.clientSecret": "",
          "commerce.shopify.webhookSecret": "",
        },
      }
    );
    log.info(`[Compliance] shop/redact — cleared Shopify data for clientId=${cid} (${domain})`);
  }
}

async function processComplianceTopic(req, res, forcedTopic = "") {
  const topic = forcedTopic || req.get("X-Shopify-Topic") || "";
  const payload = req.body || {};

  res.status(200).send("OK");

  try {
    switch (topic) {
      case "customers/data_request":
        log.info(
          `[Compliance] data_request shop=${payload.shop_domain} customer_id=${payload.customer?.id} orders=${(payload.orders_requested || []).length}`
        );
        break;
      case "customers/redact":
        await handleCustomerRedact(payload);
        break;
      case "shop/redact":
        await handleShopRedact(payload);
        break;
      default:
        log.warn(`[Compliance] unexpected topic: ${topic}`);
    }
  } catch (err) {
    log.error(`[Compliance] handler error (${topic}): ${err.message}`);
  }
}

// Generic endpoint (single URI subscription).
router.post("/", requireJsonBody, verifyComplianceHmac, async (req, res) => {
  return processComplianceTopic(req, res, "");
});

// Explicit endpoints (helps App Review checks and dashboard clarity).
router.post("/customers/data_request", requireJsonBody, verifyComplianceHmac, async (req, res) => {
  return processComplianceTopic(req, res, "customers/data_request");
});

router.post("/customers/redact", requireJsonBody, verifyComplianceHmac, async (req, res) => {
  return processComplianceTopic(req, res, "customers/redact");
});

router.post("/shop/redact", requireJsonBody, verifyComplianceHmac, async (req, res) => {
  return processComplianceTopic(req, res, "shop/redact");
});

module.exports = router;
