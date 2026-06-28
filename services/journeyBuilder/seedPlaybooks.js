'use strict';

const WhatsAppFlow = require('../../models/WhatsAppFlow');
const { JOURNEY_NODE_TYPES } = require('./journeyNodeContract');
const { CART_RECOVERY_DEFAULTS } = require('../../constants/cartRecoveryDefaults');

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
    node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: 'cart_recovery_1',
      label: 'Cart recovery — nudge 1',
    }, { x: 80, y: 160 }),
    node('wait_1', JOURNEY_NODE_TYPES.WAIT, {
      delayValue: d2h,
      delayUnit: 'h',
      label: `Wait ${d2h} hours`,
    }, { x: 80, y: 280 }),
    node('send_2', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: 'cart_recovery_2',
      label: 'Cart recovery — nudge 2',
    }, { x: 80, y: 400 }),
    node('wait_2', JOURNEY_NODE_TYPES.WAIT, {
      delayValue: d3h,
      delayUnit: 'h',
      label: `Wait ${d3h} hours`,
    }, { x: 80, y: 520 }),
    node('send_3', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: 'cart_recovery_3',
      label: 'Cart recovery — final nudge',
    }, { x: 80, y: 640 }),
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

/** Order placed confirmation — single send, Tier 1. */
function buildOrderPlacedGraph() {
  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, {
      entryType: 'order_placed',
      journeyTrigger: { type: 'order_placed', filters: {} },
      cancelOnReply: false,
    }, { x: 80, y: 40 }),
    node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: '',
      label: 'Order confirmation',
    }, { x: 80, y: 160 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 280 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_1'),
    edge('e2', 'send_1', 'end_1'),
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
    node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: '',
      label: 'COD confirm — initial ask',
      codConfirmTemplate: true,
    }, { x: 80, y: 160 }),
    node('wait_1', JOURNEY_NODE_TYPES.WAIT, {
      delayValue: 2,
      delayUnit: 'h',
      label: 'Wait 2 hours',
    }, { x: 80, y: 280 }),
    node('cond_1', JOURNEY_NODE_TYPES.CONDITION, {
      condition: 'no_reply',
      label: 'No confirm yet?',
    }, { x: 80, y: 400 }),
    node('send_2', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: '',
      label: 'Cancel reminder',
    }, { x: 80, y: 520 }),
    node('send_3', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: '',
      label: 'Address verification',
      addressVerifyTemplate: true,
    }, { x: 80, y: 640 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 760 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_1'),
    edge('e2', 'send_1', 'wait_1'),
    edge('e3', 'wait_1', 'cond_1'),
    edge('e4', 'cond_1', 'send_2', 'default'),
    edge('e5', 'send_2', 'send_3'),
    edge('e6', 'send_3', 'end_1'),
  ];
  return { nodes, edges };
}

/** Order shipped tracking — single send, Tier 2. */
function buildOrderShippedTrackingGraph() {
  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, {
      entryType: 'order_shipped',
      journeyTrigger: { type: 'order_shipped', filters: {} },
      cancelOnReply: false,
    }, { x: 80, y: 40 }),
    node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: '',
      label: 'Shipping notification',
    }, { x: 80, y: 160 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 280 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_1'),
    edge('e2', 'send_1', 'end_1'),
  ];
  return { nodes, edges };
}

/** Tier 3 logistics shipment update — single send. */
function buildLogisticsShipmentGraph({ shipmentStatus, label, templateSlot }) {
  const nodes = [
    node('trigger_1', JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, {
      entryType: 'order_shipped',
      journeyTrigger: {
        type: 'order_shipped',
        filters: { shipmentStatus },
      },
      cancelOnReply: false,
    }, { x: 80, y: 40 }),
    node('send_1', JOURNEY_NODE_TYPES.SEND_WHATSAPP, {
      templateName: templateSlot || '',
      label: label || 'Shipment update',
    }, { x: 80, y: 160 }),
    node('end_1', JOURNEY_NODE_TYPES.END, { label: 'End' }, { x: 80, y: 280 }),
  ];
  const edges = [
    edge('e1', 'trigger_1', 'send_1'),
    edge('e2', 'send_1', 'end_1'),
  ];
  return { nodes, edges };
}

function buildOrderInTransitGraph() {
  return buildLogisticsShipmentGraph({
    shipmentStatus: 'in_transit',
    label: 'In transit update',
    templateSlot: 'om_in_transit',
  });
}

function buildOrderOutForDeliveryGraph() {
  return buildLogisticsShipmentGraph({
    shipmentStatus: 'out_for_delivery',
    label: 'Out for delivery',
    templateSlot: 'om_out_for_delivery',
  });
}

function buildOrderAttemptedDeliveryGraph() {
  return buildLogisticsShipmentGraph({
    shipmentStatus: 'attempted_delivery',
    label: 'Delivery attempt',
    templateSlot: 'om_delivery_failed',
  });
}

function buildOrderRtoRescueGraph() {
  return buildLogisticsShipmentGraph({
    shipmentStatus: 'failure',
    label: 'RTO rescue',
    templateSlot: 'om_ndr_rescue',
  });
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
    description: '25 min, 4 h, 36 h cart nudges using your approved cart recovery templates.',
    tier: 1,
    buildGraph: buildCartRecovery3StepGraph,
    journeyTrigger: { type: 'cart_abandoned', filters: {} },
  },
  {
    playbookKey: 'order-placed-confirm',
    name: 'Order placed confirmation',
    description: 'Instant WhatsApp confirmation when a Shopify order is created.',
    tier: 1,
    buildGraph: buildOrderPlacedGraph,
    journeyTrigger: { type: 'order_placed', filters: {} },
  },
  {
    playbookKey: 'cod-confirm-basic',
    name: 'COD confirm + cancel flow',
    description: 'Ask for COD confirmation → wait 2h → send cancel reminder if no reply.',
    tier: 1,
    buildGraph: buildCodConfirmBasicGraph,
    journeyTrigger: { type: 'order_placed', filters: { codOnly: true } },
  },
  {
    playbookKey: 'order-shipped-tracking',
    name: 'Order shipped — tracking update',
    description: 'Send a tracking link when your Shopify order ships.',
    tier: 2,
    buildGraph: buildOrderShippedTrackingGraph,
    journeyTrigger: { type: 'order_shipped', filters: {} },
  },
  {
    playbookKey: 'order-in-transit',
    name: 'Shipment update — in transit',
    description: 'Notify customers when their parcel is in transit (requires logistics integration).',
    tier: 3,
    requiresLogistics: true,
    buildGraph: buildOrderInTransitGraph,
    journeyTrigger: { type: 'order_shipped', filters: { shipmentStatus: 'in_transit' } },
  },
  {
    playbookKey: 'order-out-for-delivery',
    name: 'Out for delivery update',
    description: 'Alert when the courier is out for delivery (requires logistics integration).',
    tier: 3,
    requiresLogistics: true,
    buildGraph: buildOrderOutForDeliveryGraph,
    journeyTrigger: { type: 'order_shipped', filters: { shipmentStatus: 'out_for_delivery' } },
  },
  {
    playbookKey: 'order-attempted-delivery',
    name: 'Delivery attempt update',
    description: 'Follow up after a failed delivery attempt (requires logistics integration).',
    tier: 3,
    requiresLogistics: true,
    buildGraph: buildOrderAttemptedDeliveryGraph,
    journeyTrigger: { type: 'order_shipped', filters: { shipmentStatus: 'attempted_delivery' } },
  },
  {
    playbookKey: 'order-rto-rescue',
    name: 'Failed delivery (RTO) rescue',
    description: 'Rescue message when delivery fails or RTO risk is high (requires logistics).',
    tier: 3,
    requiresLogistics: true,
    buildGraph: buildOrderRtoRescueGraph,
    journeyTrigger: { type: 'order_shipped', filters: { shipmentStatus: 'failure' } },
  },
];

/** Keep backward-compat alias. */
const TIER1_PLAYBOOKS = PLAYBOOK_CATALOG.filter((p) => p.tier === 1);

/**
 * Seeds Tier 1 + Tier 2 playbooks as DRAFT for a client.
 * Never seeds Tier 3 (Tier 3 = future phase).
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
      isActive: true,
    });
    created += 1;
  }
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
  buildOrderInTransitGraph,
  buildOrderOutForDeliveryGraph,
  buildOrderAttemptedDeliveryGraph,
  buildOrderRtoRescueGraph,
  seedPlaybooksForClient,
};
