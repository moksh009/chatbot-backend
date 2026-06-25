"use strict";

const WELCOME_A = {
  electronics: (brand, bot) =>
    `Hi {{first_name}} 👋 Welcome to *${brand}*.\nI'm *${bot}* — your tech specialist. Browse products, get install help, or reach our support team.\n\nTap *Menu* to continue.`,
  fashion: (brand, bot) =>
    `Hi {{first_name}} ✨ *${brand}* here — I'm *${bot}*, your style assistant.\nExplore new drops, check sizing, handle returns, or speak to our team.\n\nTap *Menu* below.`,
  beauty: (brand, bot) =>
    `Hi {{first_name}} 💄 Welcome to *${brand}*.\nI'm *${bot}* — ask about products, routines, or get help with your order anytime.\n\nTap *Menu* to get started.`,
  food: (brand, bot) =>
    `Hi {{first_name}} 👋 *${brand}* here — I'm *${bot}*.\nBrowse our menu, get order help, or reach our team in one tap.\n\nTap *Menu* below.`,
  salon: (brand, bot) =>
    `Hi {{first_name}} ✂️ Welcome to *${brand}*.\nI'm *${bot}* — book appointments, view services, or message our front desk.\n\nTap *Menu* to continue.`,
  services: (brand, bot) =>
    `Hi {{first_name}} 👋 *${brand}* here — I'm *${bot}*.\nGet quotes, order help, or connect with our team.\n\nTap *Menu* below.`,
  ecommerce: (brand, bot) =>
    `Hi {{first_name}} 👋 Welcome to *${brand}*.\nI'm *${bot}* — browse products, get order help, or talk to our team.\n\nTap *Menu* to continue.`,
};

const INDUSTRY_MAP = {
  Electronics: "electronics",
  "Fashion & Clothing": "fashion",
  "Shoes & Footwear": "fashion",
  "Beauty & Skincare": "beauty",
  "Health & Supplements": "beauty",
  "Home & Furniture": "ecommerce",
  "Food & Beverages": "food",
  Jewellery: "fashion",
};

function resolveIndustryKey(ctx) {
  const industry = String(ctx?.wizardData?.industry || ctx?.client?.onboardingData?.industry || "").trim();
  if (industry && INDUSTRY_MAP[industry]) return INDUSTRY_MAP[industry];
  const bt = String(ctx?.wizardData?.businessType || ctx?.client?.businessType || "ecommerce").toLowerCase();
  if (bt === "electronics") return "electronics";
  if (bt === "fashion") return "fashion";
  if (bt === "restaurant" || bt === "food") return "food";
  if (bt === "salon/spa" || bt === "salon") return "salon";
  if (["clinic/doctor", "real estate", "education", "other"].includes(bt)) return "services";
  return "ecommerce";
}

function buildBrandProfileWelcome(ctx) {
  const bp =
    ctx?.brandProfile ||
    ctx?.client?.onboardingData?.brandProfile ||
    ctx?.wizardData?.brandProfile ||
    null;
  if (!bp || typeof bp !== "object") return null;

  const brand = ctx?.businessName || ctx?.client?.businessName || "our store";
  const tone = String(bp.brandTone || ctx?.tone || "").toLowerCase();
  const points = Array.isArray(bp.keySellingPoints) ? bp.keySellingPoints : [];
  const point = points[0] ? String(points[0]).trim() : "";

  let greeting;
  if (/friendly|casual|playful/.test(tone)) {
    greeting = "Hi! How can I help you today? 😊";
  } else if (/professional|authoritative/.test(tone)) {
    greeting = "Hello, how may I assist you?";
  } else if (tone) {
    greeting = `Hi {{first_name}} 👋 Welcome to *${brand}*.`;
  } else {
    return null;
  }

  if (point) {
    return `${greeting}\n\nWelcome to *${brand}*! Known for ${point}.\n\nTap *Menu* to continue.`;
  }
  return `${greeting}\n\nWelcome to *${brand}*.\n\nTap *Menu* to continue.`;
}

function buildIndustryWelcomeA(ctx) {
  const branded = buildBrandProfileWelcome(ctx);
  if (branded) return branded;

  const brand = ctx?.businessName || "our store";
  const bot = ctx?.botName || "our assistant";
  const key = resolveIndustryKey(ctx);
  const fn = WELCOME_A[key] || WELCOME_A.ecommerce;
  return fn(brand, bot);
}

module.exports = { buildIndustryWelcomeA, resolveIndustryKey };
