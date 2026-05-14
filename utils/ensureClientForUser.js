/**
 * Repairs orphaned users: JWT has clientId but no Client document (404 storms on /admin/my-settings, billing, knowledge).
 * Safe to call on every bootstrap/login — no-op when Client already exists.
 */
const Client = require('../models/Client');
const crypto = require('crypto');

async function ensureClientForUser(user) {
  if (!user || !user.clientId) return null;

  const clientId = String(user.clientId).trim();
  let client = await Client.findOne({ clientId });
  if (client) return client;

  const displayName =
    (user.name && String(user.name).trim()) ||
    (user.email && String(user.email).split('@')[0]) ||
    'Workspace';
  const businessType = 'ecommerce';
  const vt = `te_wa_${crypto.randomBytes(18).toString('hex')}`;

  try {
    client = await Client.create({
      clientId,
      businessName: displayName,
      name: displayName,
      isActive: true,
      trialActive: true,
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      plan: 'CX Agent (V1)',
      businessType,
      verifyToken: vt,
      whatsapp: {
        phoneNumberId: '',
        wabaId: '',
        accessToken: '',
        verifyToken: vt,
      },
      flowNodes: [],
      flowEdges: [],
      onboardingCompleted: false,
      onboardingStep: 0,
      onboardingData: { brandName: displayName }
    });
    console.warn('[ensureClientForUser] Created missing Client for user', user.email, clientId);
    return client;
  } catch (e) {
    console.error('[ensureClientForUser] Failed to create Client:', e.message);
    return null;
  }
}

module.exports = { ensureClientForUser };
