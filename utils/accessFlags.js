const Subscription = require('../models/Subscription');
const { isPaidPlanSlug } = require('../config/planCatalog');

/** Super Admin toggled OFF "Has access (trial/premium)" — dashboard should show Account Suspended. */
function isManuallySuspended(client) {
  if (!client || client.isLifetimeAdmin) return false;
  return client.trialActive === false;
}

/** Client calendar trial (end date still in the future). Independent of Subscription row. */
function isCalendarTrialLive(client) {
  if (!client) return false;
  const end = client.trialEndsAt ? new Date(client.trialEndsAt) : null;
  return !!(end && end > new Date());
}

/** Subscription row is still in billing `trial` with a future end (or inherits client calendar). */
function isSubscriptionTrialLive(sub, client) {
  if (!sub || sub.status !== 'trial') return false;
  const endRaw = sub.trialEndsAt || sub.currentPeriodEnd;
  if (endRaw) return new Date(endRaw) > new Date();
  return isCalendarTrialLive(client);
}

/**
 * User may use the product during trial: calendar on Client and/or active trial on Subscription.
 * Manual suspend (trialActive === false) overrides everything.
 */
function isTrialWindowActive(client, sub) {
  if (isManuallySuspended(client)) return false;
  if (isCalendarTrialLive(client)) return true;
  if (isSubscriptionTrialLive(sub, client)) return true;
  return false;
}

/** Razorpay-paid subscription (active status + paid slug). */
function hasPaidActiveSubscription(sub) {
  if (!sub) return false;
  if (sub.status === 'frozen') return false;
  if (sub.status !== 'active') return false;
  return isPaidPlanSlug(sub.plan);
}

/**
 * Includes legacy / DFY flags on Client when subscription has not flipped to `active` yet
 * (common for done-for-you workspaces configured in admin).
 */
function hasPaidEntitlements(client, sub) {
  if (hasPaidActiveSubscription(sub)) return true;
  if (!client) return false;
  if (client.billing?.isPaidAccount === true) return true;
  if (client.isPaidAccount === true) return true;
  return false;
}

async function resolveSubscriptionForClient(client) {
  if (!client) return null;
  const cid = client.clientId;
  if (cid) {
    const byString = await Subscription.findOne({ clientId: cid }).lean();
    if (byString) return byString;
  }
  if (client._id) {
    return Subscription.findOne({ clientId: String(client._id) }).lean();
  }
  return null;
}

/**
 * Single source of truth for dashboard / API gates.
 * frontend should prefer these booleans over recomputing trial from raw fields.
 */
function computeAccessPayload(client, sub, user) {
  const isAdminBypass = user?.role === 'SUPER_ADMIN' || user?.isLifetimeAdmin;
  if (client?.isLifetimeAdmin) {
    return {
      manuallySuspended: false,
      trialWindowActive: true,
      hasPaidAccess: true,
      dashboardLocked: false
    };
  }
  if (isAdminBypass) {
    return {
      manuallySuspended: false,
      trialWindowActive: true,
      hasPaidAccess: true,
      dashboardLocked: false
    };
  }

  const manuallySuspended = isManuallySuspended(client);
  const trialWindowActive = isTrialWindowActive(client, sub);
  const paid = hasPaidEntitlements(client, sub);

  const dashboardLocked =
    manuallySuspended === true ? true : !trialWindowActive && !paid;

  return {
    manuallySuspended,
    trialWindowActive,
    hasPaidAccess: paid,
    dashboardLocked
  };
}

async function getAccessForUserClient(user, client) {
  const sub = await resolveSubscriptionForClient(client);
  return computeAccessPayload(client, sub, user);
}

/** Ensures a Subscription row exists (string clientId) so usage counters and plan checks work. */
async function ensureTrialSubscriptionRecord(clientIdString) {
  if (!clientIdString) return;
  await Subscription.findOneAndUpdate(
    { clientId: clientIdString },
    {
      $setOnInsert: {
        clientId: clientIdString,
        plan: 'trial',
        status: 'trial',
        billingCycle: 'none',
        amount: 0,
        usageThisPeriod: { contacts: 0, messages: 0, campaigns: 0, aiCallsMade: 0 }
      }
    },
    { upsert: true }
  );
}

module.exports = {
  isManuallySuspended,
  isCalendarTrialLive,
  isSubscriptionTrialLive,
  isTrialWindowActive,
  hasPaidActiveSubscription,
  hasPaidEntitlements,
  resolveSubscriptionForClient,
  computeAccessPayload,
  getAccessForUserClient,
  ensureTrialSubscriptionRecord
};
