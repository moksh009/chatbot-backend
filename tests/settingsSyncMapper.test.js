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

  console.log("settingsSyncMapper tests passed");
}

run();
