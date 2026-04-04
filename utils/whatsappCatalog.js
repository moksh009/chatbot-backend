"use strict";

const axios = require("axios");

/**
 * Get the Commerce catalog ID linked to this WABA phone number.
 */
async function getCatalogId(client) {
  const phoneId = client.phoneNumberId;
  const token   = client.whatsappToken;
  if (!phoneId || !token) throw new Error("Missing phoneNumberId or token");

  const resp = await axios.get(
    `https://graph.facebook.com/v18.0/${phoneId}`,
    { params: { fields: "commerce_settings", access_token: token } }
  );
  return resp.data.commerce_settings?.catalog_id || null;
}

/**
 * Sync products to Meta Commerce catalog using batch API.
 * Accepts array of product objects from Shopify/WC/manual.
 */
async function syncProductsToCatalog(client, products) {
  const catalogId = client.waCatalogId;
  if (!catalogId) throw new Error("No catalog linked. Please set waCatalogId for this client.");

  const token = client.whatsappToken;
  const storeUrl = client.nicheData?.storeUrl || (client.shopDomain ? `https://${client.shopDomain}` : "");

  const requests = products.map((p) => ({
    method:       "POST",
    relative_url: `${catalogId}/products`,
    body: [
      `retailer_id=${encodeURIComponent(String(p.id || p.sku || p._id))}`,
      `name=${encodeURIComponent(p.title || p.name)}`,
      `description=${encodeURIComponent((p.description || p.body_html || p.title || "").replace(/<[^>]*>/g, "").substring(0, 200))}`,
      `price=${Math.round(parseFloat(p.price || 0) * 100)}`,
      `currency=INR`,
      `availability=${p.available !== false && p.in_stock !== false ? "in stock" : "out of stock"}`,
      `image_url=${encodeURIComponent(p.image || p.imageUrl || "")}`,
      `url=${encodeURIComponent(p.url || storeUrl)}`,
      `brand=${encodeURIComponent(client.businessName || "")}`
    ].join("&")
  }));

  // Meta batch API — max 50 per request
  const batchSize = 50;
  for (let i = 0; i < requests.length; i += batchSize) {
    const batch = requests.slice(i, i + batchSize);
    await axios.post(
      "https://graph.facebook.com/v18.0/",
      new URLSearchParams({ batch: JSON.stringify(batch), access_token: token }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
  }

  return requests.length;
}

/**
 * Send a catalog message (shows "View Catalog" button in WhatsApp).
 */
async function sendCatalogMessage(client, phone, bodyText, thumbnailProductId) {
  const payload = {
    messaging_product: "whatsapp",
    to:   phone,
    type: "interactive",
    interactive: {
      type: "catalog_message",
      body: { text: bodyText },
      action: {
        name:       "catalog_message",
        parameters: thumbnailProductId
          ? { thumbnail_product_retailer_id: thumbnailProductId }
          : {}
      }
    }
  };

  await axios.post(
    `https://graph.facebook.com/v18.0/${client.phoneNumberId}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${client.whatsappToken}`, "Content-Type": "application/json" } }
  );
}

/**
 * Send a single-product card message.
 */
async function sendSingleProduct(client, phone, bodyText, productRetailerId) {
  const catalogId = client.waCatalogId;
  if (!catalogId) throw new Error("No catalog linked");

  await axios.post(
    `https://graph.facebook.com/v18.0/${client.phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to:   phone,
      type: "interactive",
      interactive: {
        type: "product",
        body: { text: bodyText },
        action: { catalog_id: catalogId, product_retailer_id: productRetailerId }
      }
    },
    { headers: { Authorization: `Bearer ${client.whatsappToken}`, "Content-Type": "application/json" } }
  );
}

/**
 * Send a multi-product message (product grid with sections).
 * sections: [{ title: "Smart Doorbells", product_items: [{ product_retailer_id: "SKU001" }] }]
 */
async function sendMultiProduct(client, phone, headerText, bodyText, sections) {
  const catalogId = client.waCatalogId;
  if (!catalogId) throw new Error("No catalog linked");

  await axios.post(
    `https://graph.facebook.com/v18.0/${client.phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      to:   phone,
      type: "interactive",
      interactive: {
        type:   "product_list",
        header: { type: "text", text: headerText },
        body:   { text: bodyText },
        action: { catalog_id: catalogId, sections }
      }
    },
    { headers: { Authorization: `Bearer ${client.whatsappToken}`, "Content-Type": "application/json" } }
  );
}

module.exports = { getCatalogId, syncProductsToCatalog, sendCatalogMessage, sendSingleProduct, sendMultiProduct };
