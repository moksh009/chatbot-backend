"use strict";

const { buildEcommerceDefaults } = require("./ecommerce");

function getCopyPack(ctx) {
  // For now, all deterministic generation is ecommerce-first.
  // Future: split by ctx.flowType, ctx.channelMix, etc.
  return buildEcommerceDefaults(ctx);
}

module.exports = { getCopyPack };

