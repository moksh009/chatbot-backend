const Subscription = require('../models/Subscription');
const { isPaidPlanSlug } = require('../config/planCatalog');

/** Workspace is in the free-trial window (explore full product with soft limits). */
function isTrialWindowActive(client) {
  if (!client) return false;
  if (client.isLifetimeAdmin) return true;
  if (client.trialActive === false) return false;
  const end = client.trialEndsAt ? new Date(client.trialEndsAt) : null;
  return !!(end && end > new Date());
}

/** Active paid workspace (canonical or legacy plan slug on subscription). */
function hasPaidActiveSubscription(sub) {
  if (!sub) return false;
  if (sub.status === 'frozen') return false;
  if (sub.status !== 'active') return false;
  return isPaidPlanSlug(sub.plan);
}

async function resolveSubscriptionForClient(client) {
  if (!client) return null;
  const cid = client.clientId;
  let sub = await Subscription.findOne({ clientId: cid }).lean();
  if (!sub && client._id) {
    sub = await Subscription.findOne({ clientId: String(client._id) }).lean();
  }
  return sub;
}

function computeAccessPayload(client, sub, user) {
  const isAdminBypass = user?.role === 'SUPER_ADMIN' || user?.isLifetimeAdmin;
  if (client?.isLifetimeAdmin) {
    return { trialWindowActive: true, hasPaidAccess: true, dashboardLocked: false };
  }
  const trialWindowActive = isTrialWindowActive(client);
  const paid = hasPaidActiveSubscription(sub);
  const dashboardLocked =
    !isAdminBypass && !trialWindowActive && !paid;
  return { trialWindowActive, hasPaidAccess: paid, dashboardLocked };
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
  isTrialWindowActive,
  hasPaidActiveSubscription,
  resolveSubscriptionForClient,
  computeAccessPayload,
  getAccessForUserClient,
  ensureTrialSubscriptionRecord
};
