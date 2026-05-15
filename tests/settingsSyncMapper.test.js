"use strict";

const assert = require("assert");
const {
  applySettingsSyncMirrors,
  flattenClientForSettingsUI,
} = require("../utils/settingsSyncMapper");

function run() {
  const fields = {};
  applySettingsSyncMirrors(fields, {
    facebookCatalogId: "999888777",
    googleReviewUrl: "https://g.page/test",
    adminPhone: "919876543210",
    businessName: "Apex Light",
    botName: "Siya",
    isAIFallbackEnabled: true,
  });

  assert.equal(fields.waCatalogId, "999888777");
  assert.equal(fields.catalogEnabled, true);
  assert.equal(fields["platformVars.googleReviewUrl"], "https://g.page/test");
  assert.equal(fields["platformVars.adminWhatsappNumber"], "919876543210");
  assert.equal(fields["platformVars.brandName"], "Apex Light");
  assert.equal(fields["platformVars.agentName"], "Siya");
  assert.equal(fields["wizardFeatures.enableAIFallback"], true);

  const flat = flattenClientForSettingsUI({
    businessName: "Legacy Name",
    platformVars: { brandName: "Canonical", agentName: "Bot" },
    facebookCatalogId: "111",
    waCatalogId: "222",
  });
  assert.equal(flat.businessName, "Canonical");
  assert.equal(flat.botName, "Bot");
  assert.equal(flat.facebookCatalogId, "111");

  const cartFields = {};
  applySettingsSyncMirrors(cartFields, {
    cartTiming: { msg1: 20, msg2: 3, msg3: 48, msg1_template: "cart_nudge_1" },
  });
  assert.equal(cartFields["wizardFeatures.cartNudgeMinutes1"], 20);
  assert.equal(cartFields["wizardFeatures.cartNudgeTemplate1"], "cart_nudge_1");

  const policyFields = {};
  applySettingsSyncMirrors(policyFields, {
    policies: { returnPolicy: "7-day returns", shippingPolicy: "3-5 days" },
    shippingTime: "3-5 days",
  });
  assert.equal(policyFields["policies.returnPolicy"], "7-day returns");
  assert.equal(policyFields["knowledgeBase.returnPolicy"], "7-day returns");

  console.log("settingsSyncMapper tests passed");
}

run();
