"use strict";

/**
 * Flow Builder `warranty_check` runtime — five automated WhatsApp scenarios.
 * Data: Audience > Warranty CustomerProfile warehouse via warrantyCustomerProfileService.
 */

const Conversation = require("../../models/Conversation");
const WhatsApp = require("../meta/whatsapp");
const log = require("../core/logger")("WarrantyFlowLookup");
const { normalizePhone } = require("../core/helpers");
const { sanitizePhoneForStorage } = require("../core/phoneE164Policy");
const {
  buildWarrantyCustomerProfile,
  classifyWarrantyScenario,
  formatWarrantyStatusDisplay,
  formatWarrantyDuration,
  displayPhone,
} = require("./warrantyCustomerProfileService");

const MENU_BUTTON_ID = "warranty_menu";
const LIST_MORE_ID = "warranty_list_more";
const ORDER_ROW_PREFIX = "wr_ord_";
const WA_INTERACTIVE_BODY_MAX = 1024;
const WA_TEXT_MAX = 4096;
const LIST_PAGE_SIZE = 8;

function resolveInboundPhone(convo, phone) {
  return convo?.phone || convo?.customerPhone || phone || "";
}

/** E.164 for CustomerProfile lookup; digits-only for Meta Graph `to`. */
function resolveWarrantyPhones(convo, phone) {
  const raw = resolveInboundPhone(convo, phone);
  const e164 = sanitizePhoneForStorage(raw);
  const waTo = e164 ? normalizePhone(e164) : "";
  return { e164, waTo };
}

function encodeOrderRowId(orderKey) {
  return `${ORDER_ROW_PREFIX}${Buffer.from(String(orderKey), "utf8")
    .toString("base64url")
    .replace(/=/g, "")}`;
}

function decodeOrderRowId(rowId) {
  const raw = String(rowId || "");
  if (!raw.startsWith(ORDER_ROW_PREFIX)) return "";
  try {
    const b64 = raw.slice(ORDER_ROW_PREFIX.length);
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return Buffer.from(b64 + pad, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function isMenuSelection({ buttonId, buttonTitle, userText }) {
  const id = String(buttonId || "").toLowerCase();
  const title = String(buttonTitle || "").toLowerCase().trim();
  const text = String(userText || "").toLowerCase().trim();
  return id === MENU_BUTTON_ID || title === "menu" || text === "menu";
}

function isListMoreSelection({ buttonId, buttonTitle }) {
  const id = String(buttonId || "").toLowerCase();
  const title = String(buttonTitle || "").toLowerCase().trim();
  return id === LIST_MORE_ID || title.includes("more order");
}

function buildScenarioOneBody(customerPhone) {
  return `👉 Registered Number for Warranty Check: ${customerPhone}

❌ Amongst your all orders, no items are covered under any warranty. If you placed an order with a different contact number, please contact customer support or send a message from that number.

Please click 'Menu' for support or further assistance.`;
}

function buildScenarioFiveBody(customerPhone) {
  return `👉 Phone number checked: ${customerPhone}

❌ We couldn't find any orders or warranty records associated with this number. If you placed an order with a different contact number, please contact customer support or send a message from that number.

Tap 'Menu' for support or further assistance.`;
}

function buildDetailsBody(customerPhone, orderGroup) {
  const lines = [
    `👉 Registered Number for Warranty Check: ${customerPhone}`,
    "",
    `🛒 Warranty Details for Order ${orderGroup.orderDisplay}:`,
  ];

  for (const item of orderGroup.items) {
    lines.push(`• ${item.productName}`);
    lines.push(`🛡️ Status: ${item.status} | Duration: ${item.duration}`);
    lines.push("");
  }

  lines.push("Tap 'Menu' for support or further assistance.");
  return lines.join("\n");
}

function buildOrderMap(ordersWithWarranty) {
  const map = {};
  for (const o of ordersWithWarranty) {
    map[encodeOrderRowId(o.orderKey)] = o.orderKey;
  }
  return map;
}

function buildListRows(ordersWithWarranty, page = 0) {
  const start = page * LIST_PAGE_SIZE;
  const pageOrders = ordersWithWarranty.slice(start, start + LIST_PAGE_SIZE);
  const hasMore = start + LIST_PAGE_SIZE < ordersWithWarranty.length;

  const rows = pageOrders.map((o) => ({
    id: encodeOrderRowId(o.orderKey),
    title: o.orderDisplay.substring(0, 24),
  }));

  if (hasMore) {
    rows.push({ id: LIST_MORE_ID, title: "More orders" });
  }

  rows.push({ id: MENU_BUTTON_ID, title: "Menu" });
  return rows;
}

async function sendTextChunks(client, phone, text) {
  const body = String(text || "");
  if (!body) return;
  if (body.length <= WA_TEXT_MAX) {
    await WhatsApp.sendText(client, phone, body);
    return;
  }
  let offset = 0;
  while (offset < body.length) {
    const chunk = body.slice(offset, offset + WA_TEXT_MAX);
    await WhatsApp.sendText(client, phone, chunk);
    offset += WA_TEXT_MAX;
  }
}

async function sendMenuButtonMessage(client, phone, bodyText) {
  const body = String(bodyText || "");
  const interactive = {
    type: "button",
    action: {
      buttons: [{ type: "reply", reply: { id: MENU_BUTTON_ID, title: "Menu" } }],
    },
  };

  if (body.length <= WA_INTERACTIVE_BODY_MAX) {
    await WhatsApp.sendInteractive(client, phone, interactive, body);
    return;
  }

  await sendTextChunks(client, phone, body);
  await WhatsApp.sendInteractive(
    client,
    phone,
    interactive,
    "Tap 'Menu' for support or further assistance."
  );
}

async function sendOrderPickerList(client, phone, ordersWithWarranty, page = 0) {
  const rows = buildListRows(ordersWithWarranty, page);
  const interactive = {
    type: "list",
    action: {
      button: "Choose",
      sections: [{ title: "Your orders", rows }],
    },
  };
  await WhatsApp.sendInteractive(
    client,
    phone,
    interactive,
    "Select your Order ID to fetch the warranty details."
  );
}

function findWarrantyOutputEdge(flowEdges, nodeId) {
  const out = (flowEdges || []).filter((e) => e.source === nodeId);
  return (
    out.find((e) => {
      const h = String(e.sourceHandle || "").toLowerCase();
      return !h || ["bottom", "output", "default", "a"].includes(h);
    }) || null
  );
}

function normalizeOrderMap(raw) {
  if (!raw) return {};
  if (raw instanceof Map) return Object.fromEntries(raw.entries());
  if (typeof raw === "object") return { ...raw };
  return {};
}

async function setWarrantyConversationState(convoId, nodeId, patch = {}) {
  const setFields = {
    lastStepId: nodeId,
    lastInteraction: new Date(),
    status: "BOT_ACTIVE",
    ...patch,
  };
  await Conversation.findByIdAndUpdate(convoId, { $set: setFields });
  return setFields;
}

async function clearWarrantyConversationState(convoId) {
  await Conversation.findByIdAndUpdate(convoId, {
    $unset: {
      "metadata._warranty_phase": "",
      "metadata._warranty_order_map": "",
      "metadata._warranty_list_page": "",
    },
  });
}

async function runWarrantyLookupEntry({ nodeId, client, phone, convo }) {
  const { e164, waTo } = resolveWarrantyPhones(convo, phone);
  if (!waTo || !e164) {
    log.warn("[WarrantyFlow] Missing phone on conversation");
    return { scenario: "error", phase: null, convoPatch: null };
  }

  const applyState = async (phase, orderMap, listPage = 0) => {
    const patch = await setWarrantyConversationState(convo._id, nodeId, {
      "metadata._warranty_phase": phase,
      "metadata._warranty_order_map": orderMap,
      "metadata._warranty_list_page": listPage,
    });
    return {
      metadata: {
        ...(convo.metadata || {}),
        _warranty_phase: phase,
        _warranty_order_map: orderMap,
        _warranty_list_page: listPage,
      },
      lastStepId: nodeId,
      status: patch.status,
    };
  };

  try {
    const profile = await buildWarrantyCustomerProfile(client.clientId, e164);
    const scenario = classifyWarrantyScenario(profile);
    const display = profile.displayPhone || e164;
    const orderMap = buildOrderMap(profile.ordersWithWarranty);

    if (scenario === "no_customer") {
      await sendMenuButtonMessage(client, waTo, buildScenarioFiveBody(display));
      const convoPatch = await applyState("awaiting_menu", orderMap, 0);
      return { scenario, phase: "awaiting_menu", convoPatch };
    }

    if (scenario === "orders_no_warranty") {
      await sendMenuButtonMessage(client, waTo, buildScenarioOneBody(display));
      const convoPatch = await applyState("awaiting_menu", orderMap, 0);
      return { scenario, phase: "awaiting_menu", convoPatch };
    }

    if (scenario === "multi_order") {
      await sendOrderPickerList(client, waTo, profile.ordersWithWarranty, 0);
      const convoPatch = await applyState("pick_order", orderMap, 0);
      return { scenario, phase: "pick_order", convoPatch };
    }

    const orderGroup = profile.ordersWithWarranty[0];
    await sendMenuButtonMessage(
      client,
      waTo,
      buildDetailsBody(display, orderGroup)
    );
    const convoPatch = await applyState("awaiting_menu", orderMap, 0);
    return { scenario, phase: "awaiting_menu", convoPatch };
  } catch (err) {
    log.error("[WarrantyFlow] Entry failed:", { error: err.message, clientId: client.clientId });
    try {
      await sendMenuButtonMessage(
        client,
        waTo,
        "We could not load your warranty details right now. Please tap Menu to continue or contact support."
      );
      const convoPatch = await applyState("awaiting_menu", {}, 0);
      return { scenario: "error", phase: "awaiting_menu", convoPatch };
    } catch (sendErr) {
      log.error("[WarrantyFlow] Fallback send failed:", { error: sendErr.message });
    }
    return { scenario: "error", phase: "awaiting_menu", convoPatch: null };
  }
}

async function handleWarrantyLookupReply({
  nodeId,
  client,
  phone,
  convo,
  flowEdges,
  buttonId,
  buttonTitle,
  userText,
}) {
  const meta = convo?.metadata || {};
  const phase = String(meta._warranty_phase || "");
  if (!phase) return { handled: false };

  const { e164, waTo } = resolveWarrantyPhones(convo, phone);
  const display = e164 ? (displayPhone(e164) || e164) : "";
  const orderMap = normalizeOrderMap(meta._warranty_order_map);
  let listPage = Number(meta._warranty_list_page) || 0;
  const warrantyNodeId = nodeId || convo?.lastStepId;

  if (isMenuSelection({ buttonId, buttonTitle, userText })) {
    await clearWarrantyConversationState(convo._id);
    return { handled: true, advanceToNext: true };
  }

  if (phase === "pick_order") {
    if (buttonId && isListMoreSelection({ buttonId, buttonTitle })) {
      try {
        const profile = await buildWarrantyCustomerProfile(client.clientId, e164);
        listPage += 1;
        await sendOrderPickerList(client, waTo, profile.ordersWithWarranty, listPage);
        await setWarrantyConversationState(convo._id, warrantyNodeId, {
          "metadata._warranty_phase": "pick_order",
          "metadata._warranty_order_map": buildOrderMap(profile.ordersWithWarranty),
          "metadata._warranty_list_page": listPage,
        });
        return { handled: true, advanceToNext: false };
      } catch (err) {
        log.error("[WarrantyFlow] List pagination failed:", { error: err.message });
        return { handled: true, advanceToNext: false };
      }
    }

    if (buttonId) {
      const orderKey = orderMap[buttonId] || decodeOrderRowId(buttonId);
      if (!orderKey) {
        try {
          const profile = await buildWarrantyCustomerProfile(client.clientId, e164);
          await sendOrderPickerList(client, waTo, profile.ordersWithWarranty, listPage);
        } catch (err) {
          log.error("[WarrantyFlow] Unknown order re-prompt failed:", { error: err.message });
        }
        return { handled: true, advanceToNext: false };
      }

      try {
        const profile = await buildWarrantyCustomerProfile(client.clientId, e164);
        const orderGroup = profile.ordersWithWarranty.find((o) => o.orderKey === orderKey);
        if (!orderGroup) {
          await sendMenuButtonMessage(client, waTo, buildScenarioFiveBody(display));
          await setWarrantyConversationState(convo._id, warrantyNodeId, {
            "metadata._warranty_phase": "awaiting_menu",
            "metadata._warranty_list_page": 0,
          });
          return { handled: true, advanceToNext: false };
        }

        await sendMenuButtonMessage(
          client,
          waTo,
          buildDetailsBody(profile.displayPhone, orderGroup)
        );
        await setWarrantyConversationState(convo._id, warrantyNodeId, {
          "metadata._warranty_phase": "awaiting_menu",
          "metadata._warranty_list_page": 0,
        });
        return { handled: true, advanceToNext: false };
      } catch (err) {
        log.error("[WarrantyFlow] Order pick failed:", { error: err.message, orderKey });
        await sendMenuButtonMessage(
          client,
          waTo,
          "We could not load warranty details for that order. Tap Menu to continue."
        );
        await setWarrantyConversationState(convo._id, warrantyNodeId, {
          "metadata._warranty_phase": "awaiting_menu",
        });
        return { handled: true, advanceToNext: false };
      }
    }

    try {
      const profile = await buildWarrantyCustomerProfile(client.clientId, e164);
      await sendOrderPickerList(client, waTo, profile.ordersWithWarranty, listPage);
    } catch (err) {
      log.error("[WarrantyFlow] Pick-order re-prompt failed:", { error: err.message });
    }
    return { handled: true, advanceToNext: false };
  }

  if (phase === "awaiting_menu") {
    if (buttonId || userText) {
      await sendMenuButtonMessage(
        client,
        waTo,
        "Tap 'Menu' for support or further assistance."
      );
    }
    return { handled: true, advanceToNext: false };
  }

  void flowEdges;
  return { handled: true, advanceToNext: false };
}

function isWarrantyInteractionActive(convo) {
  const phase = String(convo?.metadata?._warranty_phase || "");
  return phase === "awaiting_menu" || phase === "pick_order";
}

/** @deprecated use buildWarrantyCustomerProfile */
async function fetchWarrantyProfileForFlow(clientId, phone) {
  return buildWarrantyCustomerProfile(clientId, phone);
}

/** Plain-text preview for Flow Builder simulator (matches runtime outbound copy). */
function buildSimulatorWarrantyPreview(profile, scenario) {
  const display = profile?.displayPhone || profile?.customerPhone || '';
  if (scenario === 'no_customer') {
    return buildScenarioFiveBody(display);
  }
  if (scenario === 'orders_no_warranty') {
    return buildScenarioOneBody(display);
  }
  if (scenario === 'multi_order') {
    const orders = profile?.ordersWithWarranty || [];
    const lines = orders.map((o, i) => `${i + 1}. ${o.orderDisplay}`).join('\n');
    return [
      `👉 Registered Number for Warranty Check: ${display}`,
      '',
      '📋 Multiple orders with warranty coverage:',
      lines,
      '',
      '_In live WhatsApp, customers pick an order from an interactive list._',
      '',
      "Tap 'Menu' for support or further assistance.",
    ].join('\n');
  }
  const orderGroup = profile?.ordersWithWarranty?.[0];
  if (orderGroup) return buildDetailsBody(display, orderGroup);
  return buildScenarioFiveBody(display);
}

module.exports = {
  buildWarrantyCustomerProfile,
  fetchWarrantyProfileForFlow,
  classifyWarrantyScenario,
  formatWarrantyStatusDisplay,
  formatWarrantyDuration,
  findWarrantyOutputEdge,
  runWarrantyLookupEntry,
  handleWarrantyLookupReply,
  isWarrantyInteractionActive,
  isMenuSelection,
  isListMoreSelection,
  MENU_BUTTON_ID,
  LIST_MORE_ID,
  buildDetailsBody,
  buildScenarioOneBody,
  buildScenarioFiveBody,
  buildListRows,
  buildSimulatorWarrantyPreview,
};
