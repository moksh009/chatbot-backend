"use strict";

const ShopifyProduct = require("../../models/ShopifyProduct");
const { platformGenerateJSON } = require("../core/gemini");
const { buildKnowledgeFromWebsite } = require("../core/websiteKnowledgeBuilder");
const log = require("../core/logger")("ProductGuideGenerator");

const RAW_DRAFT_MAX = 12000;
const SCRAPE_EXCERPT_MAX = 6000;

function slugify(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48) || "general";
}

function emptyLibrary() {
  return {
    version: 1,
    sourceUrl: "",
    rawDraft: "",
    lastGeneratedAt: null,
    categories: [],
  };
}

function normalizeGuide(g = {}) {
  const faqs = Array.isArray(g.faqs)
    ? g.faqs
        .map((f) => ({
          question: String(f?.question || f?.q || "").trim(),
          answer: String(f?.answer || f?.a || "").trim(),
        }))
        .filter((f) => f.question && f.answer)
        .slice(0, 8)
    : [];
  return {
    summary: String(g.summary || "").trim().slice(0, 500),
    steps: (Array.isArray(g.steps) ? g.steps : [])
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 12),
    videoUrl: String(g.videoUrl || g.video_url || "").trim().slice(0, 500),
    manualUrl: String(g.manualUrl || g.manual_url || "").trim().slice(0, 500),
    faqs,
    estimatedMinutes:
      Number.isFinite(Number(g.estimatedMinutes)) && Number(g.estimatedMinutes) > 0
        ? Math.min(180, Math.round(Number(g.estimatedMinutes)))
        : undefined,
  };
}

function normalizeProduct(p = {}) {
  const guide = normalizeGuide(p.installGuide || p.guide || {});
  return {
    productId: String(p.productId || p.shopifyProductId || p.id || "").trim(),
    title: String(p.title || p.name || "Product").trim().slice(0, 200),
    sku: String(p.sku || "").trim().slice(0, 80),
    imageUrl: String(p.imageUrl || p.image || "").trim().slice(0, 500),
    installGuide: guide,
  };
}

function normalizeCategory(c = {}) {
  const id = String(c.id || slugify(c.label || "general")).trim();
  return {
    id,
    label: String(c.label || id).trim().slice(0, 80),
    source: String(c.source || "manual").trim(),
    products: (Array.isArray(c.products) ? c.products : [])
      .map(normalizeProduct)
      .filter((p) => p.title),
  };
}

function normalizeLibrary(lib = {}) {
  const base = emptyLibrary();
  if (!lib || typeof lib !== "object") return base;
  return {
    version: 1,
    sourceUrl: String(lib.sourceUrl || "").trim(),
    rawDraft: String(lib.rawDraft || "").slice(0, RAW_DRAFT_MAX),
    lastGeneratedAt: lib.lastGeneratedAt || null,
    categories: (Array.isArray(lib.categories) ? lib.categories : [])
      .map(normalizeCategory)
      .filter((c) => c.products.length),
  };
}

/**
 * Group Shopify products into categories for guide generation.
 */
function groupShopifyProducts(products = []) {
  const byKey = new Map();

  for (const row of products) {
    const collection = Array.isArray(row.collectionTitles) && row.collectionTitles[0]
      ? String(row.collectionTitles[0]).trim()
      : "";
    const pType = String(row.productType || "").trim();
    const label = collection || pType || "General";
    const source = collection ? "shopify_collection" : pType ? "product_type" : "manual";
    const key = slugify(label);

    if (!byKey.has(key)) {
      byKey.set(key, { id: key, label, source, products: [] });
    }
    const cat = byKey.get(key);
    const pid = String(row.shopifyProductId || row._id || "").trim();
    if (!pid) continue;
    if (cat.products.some((p) => p.productId === pid)) continue;
    cat.products.push({
      productId: pid,
      title: String(row.title || "Product").trim(),
      sku: String(row.sku || "").trim(),
      imageUrl: String(row.imageUrl || "").trim(),
      installGuide: normalizeGuide({}),
    });
  }

  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function loadShopifyProducts(clientId) {
  const rows = await ShopifyProduct.find({ clientId })
    .select("shopifyProductId title sku imageUrl productType collectionTitles tags")
    .sort({ title: 1 })
    .limit(200)
    .lean();
  return rows || [];
}

function extractYoutubeUrls(text = "") {
  const urls = [];
  const re = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=[\w-]+|youtu\.be\/[\w-]+)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    urls.push(m[0]);
  }
  return [...new Set(urls)];
}

function attachYoutubeHints(categories, urls = []) {
  if (!urls.length) return categories;
  return categories.map((cat) => ({
    ...cat,
    products: cat.products.map((p, idx) => {
      if (p.installGuide?.videoUrl) return p;
      const hint = urls[idx % urls.length];
      if (!hint) return p;
      return {
        ...p,
        installGuide: { ...p.installGuide, videoUrl: hint },
      };
    }),
  }));
}

function mergeAiIntoCategories(baseCategories, aiCategories = []) {
  const byProductId = new Map();
  for (const cat of aiCategories) {
    for (const p of cat.products || []) {
      if (p.productId) byProductId.set(p.productId, p);
    }
  }

  return baseCategories.map((cat) => ({
    ...cat,
    products: cat.products.map((p) => {
      const ai = byProductId.get(p.productId);
      if (!ai?.installGuide) return p;
      const merged = normalizeGuide({
        ...p.installGuide,
        ...ai.installGuide,
        steps: ai.installGuide.steps?.length ? ai.installGuide.steps : p.installGuide.steps,
        faqs: ai.installGuide.faqs?.length ? ai.installGuide.faqs : p.installGuide.faqs,
      });
      return { ...p, installGuide: merged, title: ai.title || p.title };
    }),
  }));
}

function mergeLibraries(existing, generated, { replace = false } = {}) {
  if (replace || !existing?.categories?.length) {
    return normalizeLibrary(generated);
  }
  const ex = normalizeLibrary(existing);
  const gen = normalizeLibrary(generated);
  const genById = new Map(gen.categories.map((c) => [c.id, c]));

  const mergedCats = ex.categories.map((cat) => {
    const hit = genById.get(cat.id);
    if (!hit) return cat;
    genById.delete(cat.id);
    const byPid = new Map(hit.products.map((p) => [p.productId, p]));
    return {
      ...cat,
      products: cat.products.map((p) => {
        const g = byPid.get(p.productId);
        if (!g) return p;
        return {
          ...p,
          installGuide: normalizeGuide({ ...p.installGuide, ...g.installGuide }),
        };
      }),
    };
  });

  for (const extra of genById.values()) {
    mergedCats.push(extra);
  }

  return normalizeLibrary({
    ...ex,
    sourceUrl: gen.sourceUrl || ex.sourceUrl,
    rawDraft: gen.rawDraft || ex.rawDraft,
    lastGeneratedAt: gen.lastGeneratedAt || ex.lastGeneratedAt,
    categories: mergedCats,
  });
}

function buildAiPrompt({ categories, rawDraft, scrapeExcerpt, storeCategory, brandName }) {
  const productLines = categories
    .flatMap((c) =>
      c.products.map(
        (p) =>
          `- [${c.label}] ${p.title} (id: ${p.productId})${p.sku ? ` sku:${p.sku}` : ""}`
      )
    )
    .slice(0, 80)
    .join("\n");

  return `You are a product documentation expert for Indian D2C e-commerce brands.
Brand: ${brandName || "Store"}
Store category: ${storeCategory || "general_d2c"}

Products to document (grouped by category):
${productLines || "(no products — infer from text only)"}

Merchant raw notes (may include install steps, FAQ, YouTube links):
${String(rawDraft || "").slice(0, RAW_DRAFT_MAX)}

Website excerpt (if any):
${String(scrapeExcerpt || "").slice(0, SCRAPE_EXCERPT_MAX)}

Return ONLY valid JSON with this exact shape:
{
  "categories": [
    {
      "id": "category_slug",
      "label": "Category name",
      "source": "shopify_collection|product_type|manual",
      "products": [
        {
          "productId": "same id from list above",
          "title": "Product title",
          "installGuide": {
            "summary": "1-2 sentence overview",
            "steps": ["Step 1...", "Step 2..."],
            "videoUrl": "https://... or empty string",
            "manualUrl": "https://... or empty string",
            "faqs": [{ "question": "...", "answer": "..." }],
            "estimatedMinutes": 15
          }
        }
      ]
    }
  ]
}

Rules:
- Use the exact productId values from the product list when provided.
- Write clear numbered install steps suitable for WhatsApp (short sentences).
- If no install info exists for a product, still give 2-3 sensible generic setup steps for that product type.
- videoUrl must be a full https URL or empty string.
- Keep steps practical for ${storeCategory || "electronics/home"} products.`;
}

async function generateProductGuideLibrary({
  clientId,
  client = {},
  websiteUrl = "",
  rawDraft = "",
  products: inputProducts = null,
  storeCategory = "general_d2c",
  replace = false,
  existingLibrary = null,
}) {
  const raw = String(rawDraft || "").slice(0, RAW_DRAFT_MAX);
  let scrapeExcerpt = "";
  const url = String(websiteUrl || client.websiteUrl || "").trim();

  if (url) {
    try {
      const built = await buildKnowledgeFromWebsite(url, { clientId, useAiEnhance: false, timeout: 10000 });
      scrapeExcerpt = String(built.content || "").slice(0, SCRAPE_EXCERPT_MAX);
    } catch (e) {
      log.warn(`[generate] scrape skipped: ${e.message}`);
    }
  }

  let shopRows = inputProducts;
  if (!Array.isArray(shopRows) || !shopRows.length) {
    shopRows = await loadShopifyProducts(clientId);
  }

  let baseCategories = groupShopifyProducts(shopRows);
  if (!baseCategories.length && Array.isArray(inputProducts) && inputProducts.length) {
    baseCategories = groupShopifyProducts(
      inputProducts.map((p) => ({
        shopifyProductId: p.id || p.shopifyId || p.shopifyProductId,
        title: p.title || p.name,
        sku: p.sku,
        imageUrl: p.imageUrl,
        productType: p.productType || p.category,
        collectionTitles: p.collectionTitles || (p.category ? [p.category] : []),
      }))
    );
  }

  if (!baseCategories.length) {
    baseCategories = [
      {
        id: "general",
        label: "Products",
        source: "manual",
        products: [
          {
            productId: "manual_1",
            title: "Your product",
            sku: "",
            imageUrl: "",
            installGuide: normalizeGuide({}),
          },
        ],
      },
    ];
  }

  const youtubeUrls = extractYoutubeUrls(`${raw}\n${scrapeExcerpt}`);
  let aiCategories = [];

  try {
    const prompt = buildAiPrompt({
      categories: baseCategories,
      rawDraft: raw,
      scrapeExcerpt,
      storeCategory,
      brandName: client.businessName || client.name,
    });
    const parsed = await platformGenerateJSON(prompt, {
      maxTokens: 8000,
      temperature: 0.2,
      timeout: 25000,
    });
    if (parsed?.categories && Array.isArray(parsed.categories)) {
      aiCategories = parsed.categories.map(normalizeCategory);
    }
  } catch (e) {
    log.error(`[generate] platform AI failed: ${e.message}`);
    throw new Error("Could not structure guides with TopEdge AI. Try again in a moment.");
  }

  let enriched = mergeAiIntoCategories(baseCategories, aiCategories);
  enriched = attachYoutubeHints(enriched, youtubeUrls);

  const generated = normalizeLibrary({
    version: 1,
    sourceUrl: url,
    rawDraft: raw,
    lastGeneratedAt: new Date(),
    categories: enriched,
  });

  const merged = mergeLibraries(existingLibrary, generated, { replace });
  const productsEnriched = merged.categories.reduce((n, c) => n + c.products.length, 0);

  return {
    library: merged,
    stats: {
      categoriesCreated: merged.categories.length,
      productsEnriched,
    },
  };
}

function countGuideReadyProducts(library) {
  const lib = normalizeLibrary(library);
  let n = 0;
  for (const cat of lib.categories) {
    for (const p of cat.products) {
      const g = p.installGuide || {};
      if (g.summary || (g.steps && g.steps.length) || g.videoUrl) n += 1;
    }
  }
  return n;
}

module.exports = {
  emptyLibrary,
  normalizeLibrary,
  normalizeGuide,
  normalizeProduct,
  normalizeCategory,
  groupShopifyProducts,
  loadShopifyProducts,
  generateProductGuideLibrary,
  mergeLibraries,
  countGuideReadyProducts,
  slugify,
};
