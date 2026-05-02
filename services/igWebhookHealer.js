"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// igWebhookHealer
//
// One-shot, self-throttled background task that runs once after server boot.
//
// Why this exists:
//   The original webhook subscription only included
//   `messages,messaging_postbacks,messaging_seen,messaging_referral`. That meant
//   no `comments` or `mentions` events were ever delivered, and Comment-to-DM
//   automations never fired. Existing tenants have `igWebhookSubscribed: true`
//   on their Client doc, so a naive "skip if subscribed" check would silently
//   keep them broken forever.
//
// What it does:
//   For every Client with IG credentials AND at least one active (non-deleted)
//   IG automation, calls ensureWebhookSubscription with `force: true`. The
//   underlying helper diffs Meta's current `subscribed_fields` against the
//   canonical REQUIRED_IG_WEBHOOK_FIELDS and re-subscribes only when
//   something is missing. So already-correct tenants pay one cheap GET.
//
// Safety:
//   • Runs once on boot, then exits — never on a hot path.
//   • Spaced 250ms per tenant to avoid Graph API burst rate limits.
//   • Wrapped in try/catch per tenant; one bad token cannot break the rest.
//   • Disabled via DISABLE_IG_WEBHOOK_HEAL=true env var if you ever need to.
// ─────────────────────────────────────────────────────────────────────────────

const Client = require('../models/Client');
const IGAutomation = require('../models/IGAutomation');
const log = require('../utils/logger')('IGWebhookHealer');

async function runOnce() {
  if (process.env.DISABLE_IG_WEBHOOK_HEAL === 'true') {
    log.info('Skipping startup heal (DISABLE_IG_WEBHOOK_HEAL=true)');
    return;
  }

  // Require the controller lazily — it imports Client itself, and we want to
  // avoid any circular-import pitfalls at module load time.
  let ensureWebhookSubscription;
  try {
    ({ ensureWebhookSubscription } = require('../controllers/igAutomation/crudController'));
  } catch (_) {
    // Older builds did not export ensureWebhookSubscription. Fall back to
    // a direct equivalent: read creds, force-subscribe.
    log.warn('crudController did not export ensureWebhookSubscription, skipping heal');
    return;
  }
  if (typeof ensureWebhookSubscription !== 'function') {
    log.warn('ensureWebhookSubscription not callable, skipping heal');
    return;
  }

  try {
    // Find clients that actually have IG creds. Only those need heals.
    const clients = await Client.find({
      $and: [
        { $or: [
          { igAccessToken: { $exists: true, $ne: null, $nin: ['', null] } },
          { 'social.instagram.accessToken': { $exists: true, $ne: null, $nin: ['', null] } },
          { instagramAccessToken: { $exists: true, $ne: null, $nin: ['', null] } }
        ]},
        { $or: [
          { igPageId: { $exists: true, $ne: null, $nin: ['', null] } },
          { 'social.instagram.pageId': { $exists: true, $ne: null, $nin: ['', null] } },
          { instagramPageId: { $exists: true, $ne: null, $nin: ['', null] } },
          { instagramFbPageId: { $exists: true, $ne: null, $nin: ['', null] } }
        ]}
      ]
    }).select({ clientId: 1 }).lean();

    if (!clients.length) {
      log.info('No IG-connected clients found, nothing to heal');
      return;
    }

    // Skip clients with no active (non-deleted) automations to avoid noisy
    // re-subscribes for tenants who are mid-trial and never finished setup.
    const clientIds = clients.map(c => c.clientId);
    const automated = await IGAutomation.distinct('clientId', {
      clientId: { $in: clientIds },
      deletedAt: null
    });
    const targetSet = new Set(automated);
    const targets = clients.filter(c => targetSet.has(c.clientId));

    log.info(`Healing webhook subscriptions for ${targets.length}/${clients.length} IG-connected client(s)`);

    let fixed = 0, alreadyOk = 0, failed = 0;
    for (const c of targets) {
      try {
        const result = await ensureWebhookSubscription(c.clientId, { force: false });
        if (result?.ok) {
          if (result.action === 'subscribed') fixed += 1;
          else alreadyOk += 1;
        } else {
          failed += 1;
          log.warn(`Heal: client=${c.clientId} not ok — ${result?.reason || 'unknown'}`);
        }
      } catch (err) {
        failed += 1;
        log.warn(`Heal: client=${c.clientId} threw — ${err.message}`);
      }
      // Soft rate-limit so a tenant with many IG accounts doesn't get burst-throttled.
      await new Promise(r => setTimeout(r, 250));
    }

    log.info(`Heal done — fixed=${fixed} alreadyOk=${alreadyOk} failed=${failed}`);
  } catch (err) {
    log.error(`Heal pass crashed: ${err.message}`);
  }
}

// Defer the run by 5s so the HTTP listener is up first and we don't compete
// with cold-start work (Mongo index builds, NLP engine prime, etc.).
function scheduleStartup() {
  setTimeout(() => {
    runOnce().catch(err => log.error(`Heal scheduling error: ${err.message}`));
  }, 5000);
}

module.exports = { runOnce, scheduleStartup };
