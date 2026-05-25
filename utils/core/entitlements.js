"use strict";

/**
 * Grant full dashboard access without Razorpay — for DFY clients, Paytm/offline billing, VIP tenants.
 * Does NOT weaken tenant isolation (security); only unlocks billing/trial gates.
 */

const Client = require("../../models/Client");
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const { ensureTrialSubscriptionRecord } = require('./accessFlags');
const log = require('./logger')("Entitlements");

const FAR_FUTURE = new Date("2099-12-31T23:59:59.000Z");

/**
 * @param {string} clientId - tenant slug e.g. delitech_smarthomes
 * @param {object} [opts]
 * @param {boolean} [opts.lifetimeAdmin=true] - Client.isLifetimeAdmin (best for VIP / offline pay)
 * @param {boolean} [opts.markPaid=true] - billing.isPaidAccount without subscription row
 * @param {string} [opts.plan] - e.g. 'CX Agent (V2)'
 * @param {string} [opts.tier] - v1 | v2
 * @param {string} [opts.note] - stored in billing.offlinePaymentNote
 * @param {boolean} [opts.grantUserLifetime=false] - also set User.isLifetimeAdmin for owner
 */
async function grantFullWorkspaceAccess(clientId, opts = {}) {
  const cid = String(clientId || "").trim();
  if (!cid) throw new Error("clientId required");

  const lifetimeAdmin = opts.lifetimeAdmin !== false;
  const markPaid = opts.markPaid !== false;
  const plan = opts.plan || "CX Agent (V2)";
  const tier = opts.tier || "v2";

  const $set = {
    trialActive: true,
    trialEndsAt: FAR_FUTURE,
    "billing.trialActive": true,
    "billing.trialEndsAt": FAR_FUTURE,
    plan,
    tier,
    onboardingCompleted: true,
    wizardCompleted: true,
  };

  if (lifetimeAdmin) {
    $set.isLifetimeAdmin = true;
  }
  if (markPaid) {
    $set.isPaidAccount = true;
    $set["billing.isPaidAccount"] = true;
    $set["billing.paymentSource"] = opts.paymentSource || "offline";
    if (opts.note) $set["billing.offlinePaymentNote"] = String(opts.note);
  }

  const client = await Client.findOneAndUpdate(
    { clientId: cid },
    { $set, $unset: { suspendedAt: "" } },
    { new: true }
  );
  if (!client) throw new Error(`Client not found: ${cid}`);

  await Subscription.findOneAndUpdate(
    { clientId: cid },
    {
      $set: {
        plan: "enterprise",
        status: "active",
        billingCycle: "offline",
        amount: 0,
        currentPeriodEnd: FAR_FUTURE,
        trialEndsAt: FAR_FUTURE,
      },
    },
    { upsert: true }
  );
  await ensureTrialSubscriptionRecord(cid, FAR_FUTURE);

  if (opts.grantUserLifetime) {
    await User.updateMany({ clientId: cid }, { $set: { isLifetimeAdmin: true } });
  }

  log.info(`Granted full access: ${cid} lifetimeAdmin=${lifetimeAdmin} markPaid=${markPaid}`);
  return client;
}

/** Revoke VIP access (e.g. churned offline client). */
async function revokeFullWorkspaceAccess(clientId, { suspend = false } = {}) {
  const cid = String(clientId || "").trim();
  const $set = {
    isLifetimeAdmin: false,
    isPaidAccount: false,
    "billing.isPaidAccount": false,
    trialActive: false,
    "billing.trialActive": false,
  };
  if (suspend) $set.suspendedAt = new Date();
  const client = await Client.findOneAndUpdate({ clientId: cid }, { $set }, { new: true });
  if (!client) throw new Error(`Client not found: ${cid}`);
  await Subscription.updateOne({ clientId: cid }, { $set: { status: "frozen" } });
  log.info(`Revoked access: ${cid} suspend=${suspend}`);
  return client;
}

module.exports = { grantFullWorkspaceAccess, revokeFullWorkspaceAccess, FAR_FUTURE };
