/**
 * Single source of truth: 6 paid plans (3 DIY self-serve + 3 Done-for-you managed tiers),
 * 14-day trial limits, legacy slug aliases, Razorpay env keys, and hub / intelligence gates.
 *
 * Pricing is value-oriented for India (INR); tune amounts via Razorpay plan IDs or order checkout.
 */

/** Paid subscription slugs (Subscription.plan when status === 'active'). */
const PAID_SLUGS = ['diy_lite', 'diy_pro', 'diy_scale', 'dfy_launch', 'dfy_growth', 'dfy_enterprise'];

/** Map legacy Razorpay / DB values to new slugs. */
const LEGACY_PLAN_MAP = {
  starter: 'diy_lite',
  growth: 'diy_pro',
  enterprise: 'diy_scale',
  v1: 'diy_lite',
  v2: 'diy_scale'
};

/** Resolve request body `plan` to a canonical paid slug, or null if invalid. */
function resolveRequestedPlan(input) {
  const raw = String(input || '').toLowerCase().trim();
  if (LEGACY_PLAN_MAP[raw]) return LEGACY_PLAN_MAP[raw];
  if (PAID_SLUGS.includes(raw)) return raw;
  return null;
}

function normalizePlanSlug(raw) {
  if (!raw || raw === 'trial') return 'trial';
  const p = String(raw).toLowerCase().trim();
  if (LEGACY_PLAN_MAP[p]) return LEGACY_PLAN_MAP[p];
  if (PAID_SLUGS.includes(p)) return p;
  return 'diy_lite';
}

/**
 * Numeric / boolean limits for planLimits.checkLimit(limitType).
 * booleans: feature disabled for this tier.
 */
const PLAN_LIMITS = {
  trial: {
    contacts: 250,
    messages: 6000,
    agents: 2,
    campaigns: 12,
    flows: 8,
    sequences: true,
    instagram: true,
    analyticsdays: 14,
    waflows: true,
    aiSegments: true,
    aiCalls: 400
  },
  diy_lite: {
    contacts: 2500,
    messages: 10000,
    agents: 1,
    campaigns: 8,
    flows: 4,
    sequences: false,
    instagram: false,
    analyticsdays: 7,
    waflows: false,
    aiSegments: false,
    aiCalls: 200
  },
  diy_pro: {
    contacts: 12000,
    messages: 50000,
    agents: 3,
    campaigns: 40,
    flows: 20,
    sequences: true,
    instagram: true,
    analyticsdays: 30,
    waflows: true,
    aiSegments: false,
    aiCalls: 800
  },
  diy_scale: {
    contacts: 60000,
    messages: 200000,
    agents: 12,
    campaigns: -1,
    flows: -1,
    sequences: true,
    instagram: true,
    analyticsdays: 90,
    waflows: true,
    aiSegments: true,
    aiCalls: 3500
  },
  dfy_launch: {
    contacts: 15000,
    messages: 80000,
    agents: 3,
    campaigns: 60,
    flows: 25,
    sequences: true,
    instagram: true,
    analyticsdays: 30,
    waflows: true,
    aiSegments: false,
    aiCalls: 1200
  },
  dfy_growth: {
    contacts: 100000,
    messages: 400000,
    agents: 20,
    campaigns: -1,
    flows: -1,
    sequences: true,
    instagram: true,
    analyticsdays: 180,
    waflows: true,
    aiSegments: true,
    aiCalls: 8000
  },
  dfy_enterprise: {
    contacts: -1,
    messages: -1,
    agents: -1,
    campaigns: -1,
    flows: -1,
    sequences: true,
    instagram: true,
    analyticsdays: 365,
    waflows: true,
    aiSegments: true,
    aiCalls: -1
  },
  'cx agent (v1)': {
    contacts: 2500,
    messages: 10000,
    agents: 1,
    campaigns: 8,
    flows: 4,
    sequences: false,
    instagram: false,
    analyticsdays: 7,
    waflows: false,
    aiSegments: false,
    aiCalls: 200
  },
  'cx agent (v2)': {
    contacts: -1,
    messages: -1,
    agents: -1,
    campaigns: -1,
    flows: -1,
    sequences: true,
    instagram: true,
    analyticsdays: 90,
    waflows: true,
    aiSegments: true,
    aiCalls: -1
  }
};

/** Hub + intelligence flags when subscription is active (not trial window). */
const PLAN_ACCESS = {
  trial: {
    hubs: { marketing: true, automation: true, commerce: true },
    intelligenceV2: true
  },
  diy_lite: {
    hubs: { marketing: true, automation: false, commerce: false },
    intelligenceV2: false
  },
  diy_pro: {
    hubs: { marketing: true, automation: true, commerce: true },
    intelligenceV2: true
  },
  diy_scale: {
    hubs: { marketing: true, automation: true, commerce: true },
    intelligenceV2: true
  },
  dfy_launch: {
    hubs: { marketing: true, automation: true, commerce: true },
    intelligenceV2: true
  },
  dfy_growth: {
    hubs: { marketing: true, automation: true, commerce: true },
    intelligenceV2: true
  },
  dfy_enterprise: {
    hubs: { marketing: true, automation: true, commerce: true },
    intelligenceV2: true
  },
  'cx agent (v1)': {
    hubs: { marketing: true, automation: false, commerce: false },
    intelligenceV2: false
  },
  'cx agent (v2)': {
    hubs: { marketing: true, automation: true, commerce: true },
    intelligenceV2: true
  }
};

/** Razorpay subscription plan_id env var suffix (RAZORPAY_PLAN_ID_DIY_LITE etc.). */
const PLAN_CHECKOUT = [
  {
    id: 'diy_lite',
    line: 'diy',
    publicName: 'DIY · Lite',
    blurb: 'Self-serve essentials: inbox, CRM, and light campaigns.',
    amountPaise: 79900,
    envKey: 'RAZORPAY_PLAN_ID_DIY_LITE',
    highlight: false,
    features: [
      'Up to 2.5k contacts',
      '10k AI messages / mo',
      'Campaigns & templates (caps apply)',
      'No Flow Builder / Automation hub (upgrade to unlock)'
    ]
  },
  {
    id: 'diy_pro',
    line: 'diy',
    publicName: 'DIY · Pro',
    blurb: 'Full self-serve stack: automation, Meta channels, and commerce hooks.',
    amountPaise: 199900,
    envKey: 'RAZORPAY_PLAN_ID_DIY_PRO',
    highlight: true,
    features: [
      '12k contacts · 50k messages / mo',
      'Sequences, IG automation, WhatsApp flows',
      'Shopify hub',
      'Advanced analytics (30-day window)'
    ]
  },
  {
    id: 'diy_scale',
    line: 'diy',
    publicName: 'DIY · Scale',
    blurb: 'High-volume DIY with AI segments and unlimited campaigns.',
    amountPaise: 449900,
    envKey: 'RAZORPAY_PLAN_ID_DIY_SCALE',
    highlight: false,
    features: [
      '60k contacts · 200k messages / mo',
      'Unlimited campaigns & flows',
      'AI segments & 90-day analytics',
      'Priority email support'
    ]
  },
  {
    id: 'dfy_launch',
    line: 'dfy',
    publicName: 'Done-for-you · Launch',
    blurb: 'We implement Pro-tier capabilities for you: onboarding, flows, and integrations.',
    amountPaise: 1299900,
    envKey: 'RAZORPAY_PLAN_ID_DFY_LAUNCH',
    highlight: false,
    features: [
      '15k contacts · 80k messages / mo',
      'White-glove setup (channels, templates, CRM)',
      'Same module access as DIY Pro+',
      'Dedicated onboarding manager'
    ]
  },
  {
    id: 'dfy_growth',
    line: 'dfy',
    publicName: 'Done-for-you · Growth',
    blurb: 'Managed operations at scale with quarterly strategy reviews.',
    amountPaise: 2499900,
    envKey: 'RAZORPAY_PLAN_ID_DFY_GROWTH',
    highlight: true,
    features: [
      '100k contacts · 400k messages / mo',
      'Unlimited campaigns / flows',
      'AI segments & 180-day analytics',
      'Named success lead + monthly review'
    ]
  },
  {
    id: 'dfy_enterprise',
    line: 'dfy',
    publicName: 'Done-for-you · Enterprise',
    blurb: 'Unlimited platform usage plus enterprise SLA and custom integrations.',
    amountPaise: 4999900,
    envKey: 'RAZORPAY_PLAN_ID_DFY_ENTERPRISE',
    highlight: false,
    features: [
      'Unlimited contacts, messages & AI',
      'Custom integrations & security review',
      '24×7 priority line & SLA',
      'Quarterly business reviews'
    ]
  }
];

function getCheckoutMeta(slug) {
  return PLAN_CHECKOUT.find((p) => p.id === slug) || PLAN_CHECKOUT[0];
}

function getRazorpayPlanIdFromEnv(slug) {
  const meta = getCheckoutMeta(slug);
  const v = process.env[meta.envKey];
  return v && String(v).trim() && !String(v).startsWith('PH_') ? String(v).trim() : null;
}

function getPlanAccessSnapshot(effectiveSlug) {
  const key = PLAN_ACCESS[effectiveSlug] ? effectiveSlug : 'diy_lite';
  const row = PLAN_ACCESS[key];
  return {
    slug: effectiveSlug,
    hubs: { ...row.hubs },
    intelligenceV2: row.intelligenceV2
  };
}

function isPaidPlanSlug(slug) {
  if (!slug || String(slug).toLowerCase() === 'trial') return false;
  const n = normalizePlanSlug(slug);
  return n !== 'trial' && PAID_SLUGS.includes(n);
}

/**
 * UI + sidebar gates: trial = full exploration; paid = catalog gates; otherwise all false.
 */
function buildPlanAccessBundle(client, sub) {
  if (!client) {
    return {
      billingPlanSlug: 'trial',
      hubs: { marketing: true, automation: true, commerce: true },
      intelligenceV2: true
    };
  }

  const trialLive =
    client &&
    client.trialActive !== false &&
    client.trialEndsAt &&
    new Date(client.trialEndsAt) > new Date();
  const paid = sub && sub.status === 'active' && isPaidPlanSlug(sub.plan);

  if (trialLive && !paid) {
    return { billingPlanSlug: 'trial', ...getPlanAccessSnapshot('trial') };
  }
  if (paid) {
    const slug = normalizePlanSlug(sub.plan);
    return { billingPlanSlug: slug, ...getPlanAccessSnapshot(slug) };
  }
  return {
    billingPlanSlug: 'none',
    hubs: { marketing: false, automation: false, commerce: false },
    intelligenceV2: false
  };
}

module.exports = {
  PAID_SLUGS,
  LEGACY_PLAN_MAP,
  PLAN_LIMITS,
  PLAN_CHECKOUT,
  PLAN_ACCESS,
  normalizePlanSlug,
  resolveRequestedPlan,
  getCheckoutMeta,
  getRazorpayPlanIdFromEnv,
  getPlanAccessSnapshot,
  isPaidPlanSlug,
  buildPlanAccessBundle
};
