"use strict";

const WELCOME_A = {
  electronics: (brand, bot) =>
    `Hi {{first_name}} 👋 Welcome to *${brand}*.\nI'm *${bot}* — your tech specialist. Browse smart home & electronics, track orders, or get install help.\n\nTap *Menu* to continue.`,
  fashion: (brand, bot) =>
    `Hi {{first_name}} ✨ *${brand}* here — I'm *${bot}*, your style assistant.\nExplore new drops, check sizing & returns, or track your order.\n\nTap *Menu* below.`,
  beauty: (brand, bot) =>
    `Hi {{first_name}} 💄 Welcome to *${brand}*.\nI'm *${bot}* — ask about products, routines, or your order anytime.\n\nTap *Menu* to get started.`,
  food: (brand, bot) =>
    `Hi {{first_name}} 👋 *${brand}* here — I'm *${bot}*.\nReorder favourites, check delivery, or reach our team in one tap.\n\nTap *Menu* below.`,
  salon: (brand, bot) =>
    `Hi {{first_name}} ✂️ Welcome to *${brand}*.\nI'm *${bot}* — book appointments, view services, or message our front desk.\n\nTap *Menu* to continue.`,
  services: (brand, bot) =>
    `Hi {{first_name}} 👋 *${brand}* here — I'm *${bot}*.\nGet quotes, check status, or connect with our team.\n\nTap *Menu* below.`,
  ecommerce: (brand, bot) =>
    `Hi {{first_name}} 👋 Welcome to *${brand}*.\nI'm *${bot}* — browse products, track orders, or talk to support.\n\nTap *Menu* to continue.`,
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

function buildIndustryWelcomeA(ctx) {
  const brand = ctx?.businessName || "our store";
  const bot = ctx?.botName || "our assistant";
  const key = resolveIndustryKey(ctx);
  const fn = WELCOME_A[key] || WELCOME_A.ecommerce;
  return fn(brand, bot);
}

module.exports = { buildIndustryWelcomeA, resolveIndustryKey };
