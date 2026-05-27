"use strict";

const moment = require("moment");
const Client = require("../../models/Client");
const PixelEvent = require("../../models/PixelEvent");
const AdLead = require("../../models/AdLead");

/**
 * Compare storefront vs checkout-extensibility capture for merchant dashboard.
 */
async function buildTrackingHealth(clientId, periodDays = 30) {
  const since = moment().subtract(periodDays, "days").toDate();

  const [
    contactPixelEvents,
    checkoutWebhookLeads,
    webPixelEvents,
    storefrontEvents,
    lastWebPixel,
    lastStorefront,
  ] = await Promise.all([
    PixelEvent.countDocuments({
      clientId,
      eventName: {
        $in: [
          "checkout_contact_identified",
          "checkout_contact_info_submitted",
          "contact_identified",
        ],
      },
      timestamp: { $gte: since },
    }),
    AdLead.countDocuments({
      clientId,
      checkoutInitiatedCount: { $gt: 0 },
      updatedAt: { $gte: since },
    }),
    PixelEvent.countDocuments({
      clientId,
      eventName: {
        $in: [
          "checkout_contact_identified",
          "checkout_contact_info_submitted",
        ],
      },
      "metadata.source": "shopify_web_pixel",
      timestamp: { $gte: since },
    }),
    PixelEvent.countDocuments({
      clientId,
      eventName: { $in: ["page_view", "product_added_to_cart", "contact_identified"] },
      timestamp: { $gte: since },
    }),
    PixelEvent.findOne({
      clientId,
      eventName: {
        $in: [
          "checkout_contact_identified",
          "checkout_contact_info_submitted",
        ],
      },
      "metadata.source": "shopify_web_pixel",
    })
      .sort({ timestamp: -1 })
      .select("timestamp")
      .lean(),
    PixelEvent.findOne({ clientId })
      .sort({ timestamp: -1 })
      .select("timestamp eventName")
      .lean(),
  ]);

  const clientDoc = await Client.findOne({ clientId })
    .select("shopifyThemePixelInstalledAt shopifyWebPixelId")
    .lean();
  const themeScriptMarked = Boolean(clientDoc?.shopifyThemePixelInstalledAt);
  const webPixelApiRegistered = Boolean(clientDoc?.shopifyWebPixelId);

  const checkoutSignals = Math.max(contactPixelEvents, checkoutWebhookLeads);
  const webPixelInstalled =
    webPixelEvents > 0 || !!lastWebPixel || themeScriptMarked || webPixelApiRegistered;
  const storefrontActive = storefrontEvents > 0 || !!lastStorefront || themeScriptMarked;

  let checkoutCaptureRate = 100;
  let missedPercent = 0;
  if (checkoutSignals > 0) {
    checkoutCaptureRate = Math.min(
      100,
      Math.round((contactPixelEvents / checkoutSignals) * 100)
    );
    if (!webPixelInstalled && checkoutWebhookLeads > contactPixelEvents) {
      missedPercent = Math.min(
        99,
        Math.max(
          0,
          Math.round(
            ((checkoutWebhookLeads - contactPixelEvents) / checkoutWebhookLeads) * 100
          )
        )
      );
    }
  }

  return {
    periodDays,
    storefrontActive,
    webPixelInstalled,
    themeScriptInstalled: themeScriptMarked,
    webPixelApiRegistered,
    checkoutCaptureRate,
    missedCheckoutPercent: missedPercent,
    counts: {
      checkoutContactEvents: contactPixelEvents,
      checkoutWebhookSignals: checkoutWebhookLeads,
      webPixelContactEvents: webPixelEvents,
      storefrontEvents,
    },
    lastWebPixelEventAt: lastWebPixel?.timestamp || null,
    lastAnyPixelEventAt: lastStorefront?.timestamp || null,
    recommendation: webPixelInstalled
      ? "Web pixel is receiving checkout contact events."
      : missedPercent > 10
        ? "Install the Shopify Custom Web Pixel to capture phone/email on Checkout Extensibility stores."
        : "Theme pixel is active. Add the Web Pixel for full checkout coverage.",
  };
}

module.exports = { buildTrackingHealth };
