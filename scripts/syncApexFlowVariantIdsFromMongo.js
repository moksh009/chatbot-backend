/**
 * Resolve WhatsApp catalog variant IDs from synced Shopify products in MongoDB
 * (same source as GET /api/shopify-catalog/:clientId/products).
 *
 * Usage (from chatbot-backend-main):
 *   node scripts/syncApexFlowVariantIdsFromMongo.js <clientId>
 *   APEX_CLIENT_ID=... node scripts/syncApexFlowVariantIdsFromMongo.js
 *
 * With --write: patches scripts/genApexLightOwnerFlow.js productIds, then you run:
 *   node scripts/genApexLightOwnerFlow.js
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const fs = require("fs");
const mongoose = require("mongoose");
const ShopifyProduct = require("../models/ShopifyProduct");

const GEN_PATH = path.join(__dirname, "genApexLightOwnerFlow.js");

/** Handles from apexlight.in URLs in genApexLightOwnerFlow COPY — order = product_list order */
const CATALOG_HANDLES = {
  tv: [
    "apex-hdmi-2-1-version-tv-backlight",
    "apex-hdmi-sync-tv-backlight-for-all-tv-sizes-upto-90-inches",
    "apex-hdmi-sync-tv-backlight-hdmi-sync-bar-light",
    "govee-tv-backlight-3-lite-with-fish-eye-correction-function-sync-to-55-65-inch-tvs-11-8ft-rgbicw-wi-fi-tv-led-backlight-strip-with-camera-voice-and-app-control-adapterwork-with-all-smart-tv-and-everything",
  ],
  monitor: [
    "apex-monitor-backlight-upto-40-inches-monitor-size-color-changing-with-screen-sync-box-pc-backlight-rgb5050-smart-led-strip-with-1-year-warranty",
    "apex-monitor-sync-bar-light",
    "apex-monitor-sync-floor-lamp",
    "apex-monitor-sync-triangle-light",
    "apex-monitor-sync-hexagon-light",
  ],
  govee: [
    "govee-tv-backlight-3-lite-with-fish-eye-correction-function-sync-to-55-65-inch-tvs-11-8ft-rgbicw-wi-fi-tv-led-backlight-strip-with-camera-voice-and-app-control-adapterwork-with-all-smart-tv-and-everything",
    "govee-rgbic-tv-light-bars",
    "govee-rgbicw-smart-floor-lamp-basic",
    "govee-rgbicw-led-strip-lights",
  ],
  floor: [
    "apex-monitor-sync-floor-lamp",
    "apex-rgbic-floor-lamp",
    "apex-uplighter-floor-lamp",
    "apex-rgbicw-floor-lamp-with-speaker",
    "apex-rgbcw-smart-table-lamp",
  ],
  gaming: [
    "apex-hdmi-2-1-version-tv-backlight",
    "apex-smart-rgbic-gaming-light-bars",
    "apex-monitor-sync-bar-light",
    "apex-triangle-light",
    "apex-hexagon-light-6-pack-6",
    "apex-hexagon-light-panels-small-10-piece",
    "apex-smart-wall-light-line6-line",
    "apex-smart-wall-light-line9-line",
  ],
  strip: [
    "apex-rgbic-cob-led-strip-light",
    "apex-edge-none-light",
    "apex-neon-rope-light-rgbic",
    "apex-rgbic-led-neon-rope-lights-for-desks",
    "apex-rgb-ic-led-strip-light-5m-16-4ft",
  ],
};

const PLACEHOLDER_SUFFIX = {
  tv: "SHOPIFY_VARIANT_ID_FOR_HDMI21,SHOPIFY_VARIANT_ID_FOR_HDMI20,SHOPIFY_VARIANT_ID_FOR_GOVEE_3_LITE,SHOPIFY_VARIANT_ID_FOR_HDMI20_BAR",
  monitor:
    "SHOPIFY_VARIANT_ID_MONITOR_BACKLIGHT,SHOPIFY_VARIANT_ID_MONITOR_BAR,SHOPIFY_VARIANT_ID_MONITOR_LAMP,SHOPIFY_VARIANT_ID_TRIANGLE,SHOPIFY_VARIANT_ID_HEX",
  govee: "SHOPIFY_VARIANT_ID_GOVEE_3_LITE,SHOPIFY_VARIANT_ID_GOVEE_BARS,SHOPIFY_VARIANT_ID_GOVEE_FLOOR,SHOPIFY_VARIANT_ID_GOVEE_STRIP",
  floor: "SHOPIFY_VARIANT_ID_FLOOR_MON,SHOPIFY_VARIANT_ID_FLOOR_RGBIC,SHOPIFY_VARIANT_ID_FLOOR_UPLIGHT,SHOPIFY_VARIANT_ID_FLOOR_SPEAKER,SHOPIFY_VARIANT_ID_TABLE_RGBCW",
  gaming:
    "SHOPIFY_VARIANT_ID_GAMING_HDMI21,SHOPIFY_VARIANT_ID_GAMING_BARS,SHOPIFY_VARIANT_ID_GAMING_MON_BAR,SHOPIFY_VARIANT_ID_GAMING_TRI,SHOPIFY_VARIANT_ID_GAMING_HEX_L,SHOPIFY_VARIANT_ID_GAMING_HEX_S,SHOPIFY_VARIANT_ID_GAMING_WALL6,SHOPIFY_VARIANT_ID_GAMING_WALL9",
  strip: "SHOPIFY_VARIANT_ID_STRIP_COB,SHOPIFY_VARIANT_ID_STRIP_EDGE,SHOPIFY_VARIANT_ID_STRIP_NEON,SHOPIFY_VARIANT_ID_STRIP_DESK,SHOPIFY_VARIANT_ID_STRIP_RGBIC",
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function handleFromProductUrl(url) {
  const m = String(url || "").match(/\/products\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function resolveClient(clientId) {
  const rows = await ShopifyProduct.find({ clientId }).select("shopifyVariantId productUrl title variantTitle").lean();

  /** @type {Map<string, string[]>} */
  const byHandle = new Map();
  for (const r of rows) {
    const h = handleFromProductUrl(r.productUrl);
    if (!h) continue;
    const id = String(r.shopifyVariantId || "").trim();
    if (!id) continue;
    if (!byHandle.has(h)) byHandle.set(h, []);
    byHandle.get(h).push(id);
  }

  const result = {};
  const missing = [];

  for (const [key, handles] of Object.entries(CATALOG_HANDLES)) {
    const ids = [];
    for (const handle of handles) {
      const norm = handle.toLowerCase();
      let pool = byHandle.get(norm);
      if (!pool || !pool.length) {
        missing.push({ catalog: key, handle, reason: "no productUrl match for this handle" });
        ids.push(null);
        continue;
      }
      if (pool.length > 1) {
        const uniq = [...new Set(pool)];
        if (uniq.length > 1) {
          console.warn(`[warn] ${key} / ${handle}: multiple variant IDs (${uniq.join(", ")}), using first`);
        }
      }
      ids.push(pool[0]);
    }
    result[key] = ids;
  }

  return { result, missing, byHandleCount: byHandle.size };
}

function patchGenerator(replacements) {
  let src = fs.readFileSync(GEN_PATH, "utf8");
  for (const [placeholderLine, newIds] of Object.entries(replacements)) {
    if (!src.includes(placeholderLine)) {
      throw new Error(`Generator no longer contains expected placeholder string (update script): ${placeholderLine.slice(0, 80)}...`);
    }
    src = src.split(placeholderLine).join(newIds);
  }
  fs.writeFileSync(GEN_PATH, src, "utf8");
}

async function main() {
  const write = process.argv.includes("--write");
  const args = process.argv.slice(2).filter((a) => a !== "--write");
  const clientId = args[0] || process.env.APEX_CLIENT_ID;

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Missing MONGODB_URI or MONGO_URI in .env");
    process.exit(1);
  }
  if (!clientId) {
    console.error("Usage: node scripts/syncApexFlowVariantIdsFromMongo.js <clientId> [--write]");
    console.error("   or: APEX_CLIENT_ID=... node scripts/syncApexFlowVariantIdsFromMongo.js [--write]");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const { result, missing, byHandleCount } = await resolveClient(clientId);
  console.log(`Client: ${clientId}`);
  console.log(`Distinct product handles in DB (from productUrl): ${byHandleCount}`);

  const replacements = {};
  for (const key of Object.keys(CATALOG_HANDLES)) {
    const ids = result[key];
    const line = PLACEHOLDER_SUFFIX[key];
    const joined = ids.map((x) => (x == null ? "MISSING" : x)).join(",");
    console.log(`\n[${key}] -> ${joined}`);
    if (ids.every((x) => x != null)) {
      replacements[line] = ids.join(",");
    }
  }

  if (missing.length) {
    console.error("\n--- Missing matches (run Shopify sync first, or fix handle typos vs Shopify) ---");
    for (const m of missing) {
      console.error(`  [${m.catalog}] ${m.handle}\n       ${m.reason}`);
    }
    console.error("\nTip: strip URL handle from Shopify Admin product URL and ensure it appears in productUrl after sync.");
    process.exit(1);
  }

  if (!write) {
    console.log("\nDry run OK. Re-run with --write to patch scripts/genApexLightOwnerFlow.js");
    process.exit(0);
  }

  patchGenerator(replacements);
  console.log("\nPatched", GEN_PATH, "- run: node scripts/genApexLightOwnerFlow.js");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
