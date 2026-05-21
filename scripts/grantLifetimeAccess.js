#!/usr/bin/env node
/**
 * Grant full dashboard access (no Razorpay) for VIP / offline-billing tenants.
 *
 * Examples:
 *   node scripts/grantLifetimeAccess.js delitech_smarthomes
 *   node scripts/grantLifetimeAccess.js shubhampatelsbusiness_1cfb2b --note "Apex Light — Paytm monthly"
 *   node scripts/grantLifetimeAccess.js delitech_smarthomes --grant-user
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { grantFullWorkspaceAccess, revokeFullWorkspaceAccess } = require("../utils/entitlements");

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const grantUser = args.includes("--grant-user");
  const noteIdx = args.indexOf("--note");
  const note = noteIdx >= 0 ? args[noteIdx + 1] : undefined;
  const clientId = args.find((a) => !a.startsWith("--"));

  if (!clientId) {
    console.error("Usage: node scripts/grantLifetimeAccess.js <clientId> [--note \"Paytm\"] [--grant-user] [--revoke]");
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI required");
    process.exit(1);
  }

  await mongoose.connect(uri);

  if (revoke) {
    const client = await revokeFullWorkspaceAccess(clientId, { suspend: false });
    console.log("Revoked:", client.clientId, client.name);
  } else {
    const client = await grantFullWorkspaceAccess(clientId, {
      note: note || "Manual / offline billing — full access",
      paymentSource: "paytm_offline",
      grantUserLifetime: grantUser,
    });
    console.log("Granted full access:", {
      clientId: client.clientId,
      name: client.name,
      isLifetimeAdmin: client.isLifetimeAdmin,
      isPaidAccount: client.isPaidAccount,
      plan: client.plan,
      trialEndsAt: client.trialEndsAt,
    });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
