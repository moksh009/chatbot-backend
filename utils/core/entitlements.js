'use strict';

/**
 * Legacy entitlements helpers — SaaS billing removed (2026-06).
 * Kept as no-ops for admin scripts that still import these symbols.
 */

const Client = require('../../models/Client');
const log = require('./logger')('Entitlements');

const FAR_FUTURE = new Date('2099-12-31T23:59:59.000Z');

async function grantFullWorkspaceAccess(clientId, opts = {}) {
  const cid = String(clientId || '').trim();
  if (!cid) throw new Error('clientId required');
  const client = await Client.findOneAndUpdate(
    { clientId: cid },
    {
      $set: {
        trialActive: true,
        isPaidAccount: true,
        'billing.trialActive': true,
        'billing.isPaidAccount': true,
        onboardingCompleted: true,
        wizardCompleted: true,
      },
      $unset: { suspendedAt: '' },
    },
    { new: true }
  );
  if (!client) throw new Error(`Client not found: ${cid}`);
  log.info(`grantFullWorkspaceAccess (no-op billing): ${cid}`);
  return client;
}

async function revokeFullWorkspaceAccess(clientId, { suspend = false } = {}) {
  const cid = String(clientId || '').trim();
  const $set = suspend ? { suspendedAt: new Date() } : {};
  const client = await Client.findOneAndUpdate({ clientId: cid }, { $set }, { new: true });
  if (!client) throw new Error(`Client not found: ${cid}`);
  log.info(`revokeFullWorkspaceAccess: ${cid} suspend=${suspend}`);
  return client;
}

module.exports = { grantFullWorkspaceAccess, revokeFullWorkspaceAccess, FAR_FUTURE };
