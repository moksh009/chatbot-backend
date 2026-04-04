"use strict";

const WhitelabelConfig = require("../models/WhitelabelConfig");

const MAIN_DOMAIN = process.env.MAIN_DOMAIN || "chatbot-backend-lg5y.onrender.com";

/**
 * Detect and attach white-label config based on request hostname.
 * Runs on every request — lightweight DB lookup with lean().
 */
async function whitelabelMiddleware(req, res, next) {
  const hostname = req.hostname || "";

  // Skip for main domain and localhost
  if (!hostname || hostname === MAIN_DOMAIN || hostname === "localhost" || hostname.includes("127.0.0.1")) {
    res.locals.whitelabel = null;
    return next();
  }

  try {
    // Check for white-label config matching this domain
    // Note: We allow non-verified domains (decision from plan review)
    // They just won't show "DNS Verified" badge in the UI
    const wlConfig = await WhitelabelConfig.findOne({
      customDomain: hostname,
      isActive:     true
    }).lean();

    if (wlConfig) {
      res.locals.whitelabel = wlConfig;
      req.resellerId = wlConfig.resellerId;
    } else {
      res.locals.whitelabel = null;
    }
  } catch (err) {
    // Middleware failures must NEVER block requests
    console.error("[Whitelabel] Middleware error:", err.message);
    res.locals.whitelabel = null;
  }

  next();
}

module.exports = whitelabelMiddleware;
