/**
 * Repairs orphaned users: JWT has clientId but no Client document (404 storms on /admin/my-settings, billing, knowledge).
 * Safe to call on every bootstrap/login — no-op when Client already exists.
 */
const Client = require('../models/Client');

const VALID_BUSINESS_TYPES = [
  'ecommerce',
  'salon',
  'turf',
  'clinic',
  'choice_salon',
  'choice_salon_new',
  'agency',
  'travel',
  'real-estate',
  'healthcare',
  'other'
];

async function ensureClientForUser(user) {
  if (!user || !user.clientId) return null;

  const clientId = String(user.clientId).trim();
  let client = await Client.findOne({ clientId });
  if (client) return client;

  const displayName =
    (user.name && String(user.name).trim()) ||
    (user.email && String(user.email).split('@')[0]) ||
    'Workspace';
  const rawType = user.business_type || 'other';
  const businessType = VALID_BUSINESS_TYPES.includes(rawType) ? rawType : 'other';

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
