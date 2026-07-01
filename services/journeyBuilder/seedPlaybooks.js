'use strict';

const WhatsAppFlow = require('../../models/WhatsAppFlow');
const { JOURNEY_NODE_TYPES } = require('./journeyNodeContract');
const { CART_RECOVERY_DEFAULTS } = require('../../constants/cartRecoveryDefaults');
const { PREBUILT_ORDER_EMAIL_TEMPLATES } = require('../../constants/prebuiltOrderEmailTemplates');

function edge(id, source, target, sourceHandle) {
  const e = { id, source, target, type: 'default' };
  if (sourceHandle) e.sourceHandle = sourceHandle;
  return e;
}

function node(id, type, data, position) {
  return {
    id,
    type,
    position: position || { x: 0, y: 0 },
    data: { nodeType: type, ...data },
  };
}

function emailFromPrebuilt(key, id, label, position) {
  const tpl = PREBUILT_ORDER_EMAIL_TEMPLATES[key];
  if (!tpl) {
    throw new Error(`Missing prebuilt email template: ${key}`);
  }
  return node(id, JOURNEY_NODE_TYPES.SEND_EMAIL, {
    templateId: key,
    templateName: tpl.name,
    subject: tpl.subject,
    content: tpl.bodyHtml,
    label: label || tpl.name,
  }, position);
}

function waSend(id, templateName, label, extra = {}, position) {
  const PREBUILT_VM = {
    order_confirmation_v1: {
      header: 'first_product_image',
      body: { 1: 'first_name', 2: 'order_id', 3: 'order_items', 4: 'order_total', 5: 'shipping_address' },
    },
    order_shipped_v1: {
      body: { 1: 'first_name', 2: 'order_id', 3: 'estimated_delivery' },
      buttons: { 0: 'tracking_url' },
    },
    cart_recovery_1: {
      header: 'first_product_image',
      body: { 1: 'first_name', 2: 'product_name', 3: 'cart_total' },
      buttons: { 0: 'checkout_url' },
    },
    cart_recovery_2: {
      header: 'first_product_image',
      body: { 1: 'first_name', 2: 'product_name' },
      buttons: { 0: 'checkout_url' },
    },
    cart_recovery_3: {
      header: 'first_product_image',
      body: { 1: 'first_name', 2: 'product_name', 3: 'cart_total', 4: 'discount_code' },
      buttons: { 0: 'checkout_url' },
    },
    cod_confirmation_v1: {
      header: 'first_product_image',
      body: { 1: 'first_name', 2: 'order_id', 3: 'order_items', 4: 'order_total', 5: 'shipping_address' },
    },
    order_cancellation_v1: {
      body: { 1: 'first_name', 2: 'order_id', 3: 'order_total', 4: 'brand_name' },
    },
  };
  const preset = templateName ? PREBUILT_VM[templateName] : null;
  return node(id, JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
    templateName,
    label,
    ...(preset ? { variableMappings: preset } : {}),
    ...extra,
  }, position);
}

/** Quick 3-step drip — mirrors FollowUpSequenceModal defaults (15m / 6h between sends). */
function buildQuick3StepGraph() {
  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, { entryType: 'manual', cancelOnReply: true }, { x: 80, y: 40 }),
    node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: '', label: 'First message' }, { x: 80, y: 160 }),
    node('wait_1', JOURNEY_NODE_TYPES.WAIT, { delayValue: 15, delayUnit: 'm', label: 'Wait 15 minutes' }, { x: 80, y: 280 }),
    node('send_2', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: '', label: 'Follow-up' }, { x: 80, y: 400 }),
    node('wait_2', JOURNEY_NODE_TYPES.WAIT, { delayValue: 6, delayUnit: 'h', label: 'Wait 6 hours' }, { x: 80, y: 520 }),
    node('send_3', JOURNEY_NODE_TYPES.SEND_WHATSAPP, { templateName: '', label: 'Final nudge' }, { x: 80, y: 640 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 760 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_1'),
    edge('e2', 'send_1', 'wait_1'),
    edge('e3', 'wait_1', 'send_2'),
    edge('e4', 'send_2', 'wait_2'),
    edge('e5', 'wait_2', 'send_3'),
    edge('e6', 'send_3', 'end_1'),
  ];
  return { nodes, edges };
}

/**
 * Cart recovery 3-step journey.
 * Delays from cartRecoveryDefaults: 25m / 4h / 36h.
 * Templates: cart_recovery_1 / cart_recovery_2 / cart_recovery_3.
 */
function buildCartRecovery3StepGraph() {
  const d1m = CART_RECOVERY_DEFAULTS.step1DelayMinutes;
  const d2m = CART_RECOVERY_DEFAULTS.step2DelayMinutes;
  const d3m = CART_RECOVERY_DEFAULTS.step3DelayMinutes;

  const d2h = Math.round(d2m / 60);
  const d3h = Math.round(d3m / 60);

  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, {
      entryType: 'cart_abandoned',
      journeyTrigger: { type: 'cart_abandoned', filters: { cartDelayMinutes: d1m } },
      cancelOnReply: true,
    }, { x: 80, y: 40 }),
    waSend('send_wa_1', 'cart_recovery_1', 'Cart recovery — nudge 1 (WhatsApp)', {}, { x: 80, y: 160 }),
    emailFromPrebuilt('cart_recovery_email_1', 'send_email_1', 'Cart recovery — nudge 1 (email)', { x: 80, y: 280 }),
    node('wait_1', JOURNEY_NODE_TYPES.WAIT, {
      delayValue: d2h,
      delayUnit: 'h',
      label: `Wait ${d2h} hours`,
    }, { x: 80, y: 400 }),
    waSend('send_wa_2', 'cart_recovery_2', 'Cart recovery — nudge 2 (WhatsApp)', {}, { x: 80, y: 520 }),
    emailFromPrebuilt('cart_recovery_email_2', 'send_email_2', 'Cart recovery — nudge 2 (email)', { x: 80, y: 640 }),
    node('wait_2', JOURNEY_NODE_TYPES.WAIT, {
      delayValue: d3h,
      delayUnit: 'h',
      label: `Wait ${d3h} hours`,
    }, { x: 80, y: 760 }),
    waSend('send_wa_3', 'cart_recovery_3', 'Cart recovery — final nudge (WhatsApp)', {}, { x: 80, y: 880 }),
    emailFromPrebuilt('cart_recovery_email_3', 'send_email_3', 'Cart recovery — final nudge (email)', { x: 80, y: 1000 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 1120 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_wa_1'),
    edge('e2', 'send_wa_1', 'send_email_1'),
    edge('e3', 'send_email_1', 'wait_1'),
    edge('e4', 'wait_1', 'send_wa_2'),
    edge('e5', 'send_wa_2', 'send_email_2'),
    edge('e6', 'send_email_2', 'wait_2'),
    edge('e7', 'wait_2', 'send_wa_3'),
    edge('e8', 'send_wa_3', 'send_email_3'),
    edge('e9', 'send_email_3', 'end_1'),
  ];
  return { nodes, edges };
}

/** Order placed confirmation — WhatsApp + email (mirrors Order messages dual-channel). */
function buildOrderPlacedGraph() {
  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, {
      entryType: 'order_placed',
      journeyTrigger: { type: 'order_placed', filters: {} },
      cancelOnReply: false,
    }, { x: 80, y: 40 }),
    waSend('send_wa_1', 'order_confirmation_v1', 'Order confirmation — WhatsApp', {}, { x: 80, y: 160 }),
    emailFromPrebuilt('order_confirmed', 'send_email_1', 'Order confirmation — email', { x: 80, y: 280 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 400 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_wa_1'),
    edge('e2', 'send_wa_1', 'send_email_1'),
    edge('e3', 'send_email_1', 'end_1'),
  ];
  return { nodes, edges };
}

/**
 * COD confirm + cancel — multi-step per §10/§T.
 * send COD confirm template with buttons → wait 2h → condition (if no confirm → cancel reminder).
 * Uses interactionMode: 'awaiting_button' (set at compile time by compileGraphToSteps).
 */
function buildCodConfirmBasicGraph() {
  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, {
      entryType: 'order_placed',
      journeyTrigger: { type: 'order_placed', filters: { codOnly: true } },
      cancelOnReply: false,
    }, { x: 80, y: 40 }),
    waSend('send_wa_1', 'cod_confirmation_v1', 'COD confirm — initial ask', { codConfirmTemplate: true }, { x: 80, y: 160 }),
    emailFromPrebuilt('order_confirmed', 'send_email_1', 'COD order confirmation — email', { x: 80, y: 280 }),
    node('wait_1', JOURNEY_NODE_TYPES.WAIT, {
      delayValue: 2,
      delayUnit: 'h',
      label: 'Wait 2 hours',
    }, { x: 80, y: 400 }),
    node('cond_1', JOURNEY_NODE_TYPES.CONDITION, {
      condition: 'no_reply',
      label: 'No confirm yet?',
    }, { x: 80, y: 520 }),
    waSend('send_wa_2', 'order_cancellation_v1', 'Cancel reminder', {}, { x: 80, y: 640 }),
    emailFromPrebuilt('order_cancelled', 'send_email_2', 'Cancellation notice — email', { x: 80, y: 760 }),
    waSend('send_wa_3', '', 'Address verification', { addressVerifyTemplate: true }, { x: 80, y: 880 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 1000 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_wa_1'),
    edge('e2', 'send_wa_1', 'send_email_1'),
    edge('e3', 'send_email_1', 'wait_1'),
    edge('e4', 'wait_1', 'cond_1'),
    edge('e5', 'cond_1', 'send_wa_2', 'yes'),
    edge('e6', 'send_wa_2', 'send_email_2'),
    edge('e7', 'send_email_2', 'send_wa_3'),
    edge('e8', 'send_wa_3', 'end_1'),
  ];
  return { nodes, edges };
}

/** Order shipped tracking — WhatsApp + email (mirrors Order messages). */
function buildOrderShippedTrackingGraph() {
  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, {
      entryType: 'order_shipped',
      journeyTrigger: { type: 'order_shipped', filters: {} },
      cancelOnReply: false,
    }, { x: 80, y: 40 }),
    waSend('send_wa_1', 'order_shipped_v1', 'Shipping notification — WhatsApp', {}, { x: 80, y: 160 }),
    emailFromPrebuilt('order_shipped', 'send_email_1', 'Shipping notification — email', { x: 80, y: 280 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 400 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_wa_1'),
    edge('e2', 'send_wa_1', 'send_email_1'),
    edge('e3', 'send_email_1', 'end_1'),
  ];
  return { nodes, edges };
}

/**
 * Master playbook catalog.
 * tier: 1 = core (always seed); 2 = shipping (seed DRAFT only, no auto-enable)
 * status: DRAFT for all (merchant must pick template and publish)
 */
const PLAYBOOK_CATALOG = [
  {
    playbookKey: 'quick-3-step',
    name: 'Quick 3-step follow-up',
    description: 'Three WhatsApp messages with delays — same as the classic sequence wizard.',
    tier: 1,
    buildGraph: buildQuick3StepGraph,
    journeyTrigger: { type: 'manual', filters: {} },
  },
  {
    playbookKey: 'cart-recovery-3step',
    name: 'Cart recovery — 3 messages',
    description: '25 min, 4 h, 36 h cart nudges on WhatsApp + email using prebuilt templates.',
    tier: 1,
    buildGraph: buildCartRecovery3StepGraph,
    journeyTrigger: { type: 'cart_abandoned', filters: {} },
  },
  {
    playbookKey: 'order-placed-confirm',
    name: 'Order placed confirmation',
    description: 'Instant WhatsApp + email confirmation when a Shopify order is created.',
    tier: 1,
    buildGraph: buildOrderPlacedGraph,
    journeyTrigger: { type: 'order_placed', filters: {} },
  },
  {
    playbookKey: 'cod-confirm-basic',
    name: 'COD confirm + cancel flow',
    description: 'COD WhatsApp confirm + paired email, then cancel reminder if no reply.',
    tier: 1,
    buildGraph: buildCodConfirmBasicGraph,
    journeyTrigger: { type: 'order_placed', filters: { codOnly: true } },
  },
  {
    playbookKey: 'order-shipped-tracking',
    name: 'Order shipped — tracking update',
    description: 'WhatsApp + email tracking update when your Shopify order ships.',
    tier: 2,
    buildGraph: buildOrderShippedTrackingGraph,
    journeyTrigger: { type: 'order_shipped', filters: {} },
  },
];

/** Keep backward-compat alias. */
const TIER1_PLAYBOOKS = PLAYBOOK_CATALOG.filter((p) => p.tier === 1);

/**
 * Refresh DRAFT playbook graphs that were seeded before dual-channel + prebuilt templates.
 * Skips published journeys and merchant-edited graphs that already have templates + email.
 */
async function upgradeStaleDraftPlaybooks(clientId) {
  const commerceKeys = [
    'cart-recovery-3step',
    'order-placed-confirm',
    'cod-confirm-basic',
    'order-shipped-tracking',
  ];
  let upgraded = 0;

  for (const playbookKey of commerceKeys) {
    const doc = await WhatsAppFlow.findOne({
      clientId,
      flowType: 'journey',
      playbookKey,
      status: 'DRAFT',
    });
    if (!doc) continue;

    const nodes = doc.nodes || [];
    const hasEmail = nodes.some((n) => String(n.type || n.data?.nodeType) === JOURNEY_NODE_TYPES.SEND_EMAIL);
    const waEmpty = nodes.some(
      (n) => String(n.type || n.data?.nodeType) === JOURNEY_NODE_TYPES.SEND_WHATSAPP
        && !String(n.data?.templateName || '').trim()
    );
    const waMissingMappings = nodes.some(
      (n) => String(n.type || n.data?.nodeType) === JOURNEY_NODE_TYPES.SEND_WHATSAPP
        && String(n.data?.templateName || '').trim()
        && !Object.keys(n.data?.variableMappings?.body || {}).length
    );
    if (hasEmail && !waEmpty && !waMissingMappings) continue;

    const playbook = PLAYBOOK_CATALOG.find((p) => p.playbookKey === playbookKey);
    if (!playbook) continue;

    const { nodes: nextNodes, edges: nextEdges } = playbook.buildGraph();
    await WhatsAppFlow.updateOne(
      { _id: doc._id },
      { $set: { nodes: nextNodes, edges: nextEdges, description: playbook.description } }
    );
    upgraded += 1;
  }

  return upgraded;
}

/**
 * Seeds Tier 1 + Tier 2 playbooks as DRAFT for a client.
 * Idempotent — skips if playbookKey already exists for the client.
 */
async function seedPlaybooksForClient(clientId, { keys = null, maxTier = 2 } = {}) {
  const toSeed = keys
    ? PLAYBOOK_CATALOG.filter((p) => keys.includes(p.playbookKey) && p.tier <= maxTier)
    : PLAYBOOK_CATALOG.filter((p) => p.tier <= maxTier && p.tier <= 2);

  let created = 0;
  for (const playbook of toSeed) {
    const exists = await WhatsAppFlow.findOne({
      clientId,
      flowType: 'journey',
      playbookKey: playbook.playbookKey,
    }).lean();
    if (exists) continue;

    const { nodes, edges } = playbook.buildGraph();
    const flowId = `journey_${playbook.playbookKey}_${Date.now()}`;
    await WhatsAppFlow.create({
      clientId,
      flowId,
      name: playbook.name,
      description: playbook.description,
      flowType: 'journey',
      playbookKey: playbook.playbookKey,
      status: 'DRAFT',
      version: 1,
      nodes,
      edges,
      publishedNodes: [],
      publishedEdges: [],
      journeyTrigger: playbook.journeyTrigger || { type: 'manual', filters: {} },
      journeyPolicies: { cancelOnReply: true },
      isActive: false,
    });
    created += 1;
  }
  await upgradeStaleDraftPlaybooks(clientId);
  return created;
}

module.exports = {
  PLAYBOOK_CATALOG,
  TIER1_PLAYBOOKS,
  buildQuick3StepGraph,
  buildCartRecovery3StepGraph,
  buildOrderPlacedGraph,
  buildCodConfirmBasicGraph,
  buildOrderShippedTrackingGraph,
  seedPlaybooksForClient,
  upgradeStaleDraftPlaybooks,
};
