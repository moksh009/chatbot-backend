"use strict";

const { VARIABLE_REGISTRY, resolveSourcePath } = require('../utils/core/variableRegistry');
const { buildVariableContext, injectVariables } = require('../utils/core/variableInjector');
const { formatLineItemsSummary } = require('../utils/commerce/orderLineItemEnrichment');
const { applySequenceContextToSendContext } = require('../services/journeyBuilder/sequenceContextService');

/**
 * Resolve {{variable_name}} placeholders using the master registry + live context.
 */
async function resolveTemplateVariables(templateText, context) {
  if (!templateText || typeof templateText !== "string") return "";
  const flat = context && typeof context === "object" ? context : {};
  return injectVariables(templateText, flat);
}

/**
 * Build a flat context for a recipient (client + phone + optional order/cart hints).
 */
async function buildSendContext({
  client,
  phone,
  convo = null,
  lead = null,
  order = null,
  cart = null,
  extra = {},
  sequenceContext = null,
}) {
  const base = await buildVariableContext(client, phone, convo, lead);
  let merged = { ...base, ...(extra || {}) };

  if (order) {
    const lineItems = order.line_items || order.lineItems || [];
    const line0 = lineItems[0];
    if (lineItems.length) {
      merged.product_name = line0?.title || line0?.name || merged.product_name || "";
      merged.first_product_title = merged.product_name;
      merged.order_items =
        order.itemsSummary ||
        formatLineItemsSummary(
          lineItems.map((i) => ({
            title: i.title || i.name,
            quantity: i.quantity || 1,
            variant_title: i.variant_title || '',
          }))
        ) ||
        merged.product_name;
      const img =
        line0?.image?.src ||
        line0?.image_url ||
        line0?.imageUrl ||
        order.first_product_image ||
        null;
      if (img) merged.first_product_image = img;
    }
    merged.order = order;
    const cust = order.customer || {};
    merged.first_name = cust.first_name || (order.customerName || "").split(" ")[0] || merged.first_name;
    merged.customer_name = order.customerName || cust.name || merged.customer_name;
    if (order.name || order.orderNumber || order.orderId) {
      merged.order_id = order.name || order.orderNumber || `#${order.orderId}`;
      merged.order_number = merged.order_id;
    }
    if (order.total_price != null) {
      merged.order_total = `₹${Number(order.total_price).toLocaleString("en-IN")}`;
    }
    if (order.payment_method) merged.payment_method = order.payment_method;
    if (order.shipping_address) {
      const a = order.shipping_address;
      merged.shipping_address = [a.address1, a.address2, a.city, a.province, a.zip].filter(Boolean).join(", ");
    }
    if (order.fulfillments?.[0]?.tracking_url) merged.tracking_url = order.fulfillments[0].tracking_url;
  }

  if (cart?.checkout_url) merged.checkout_url = cart.checkout_url;
  if (cart?.total_price != null) merged.cart_total = `₹${Number(cart.total_price).toLocaleString("en-IN")}`;

  if (!merged.checkout_url && !merged.store_url) {
    const storeUrl =
      client?.shopifyStoreUrl ||
      client?.website ||
      client?.platformVars?.storeUrl ||
      client?.growthWidgetConfig?.storeUrl ||
      '';
    if (storeUrl) {
      merged.checkout_url = String(storeUrl).replace(/\/$/, '');
      merged.store_url = merged.checkout_url;
    }
  }

  // Per-enrollment session memory overrides DB-normalized values for this journey run.
  merged = applySequenceContextToSendContext(merged, sequenceContext);

  return merged;
}

/**
 * Map registry variable names → ordered Meta body parameters {{1}}…{{n}}.
 */
function buildPositionalBodyParams(variableMappings = {}, context = {}) {
  const bodyMap = variableMappings.body || variableMappings;
  const keys = Object.keys(bodyMap)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);

  return keys.map((pos) => {
    const regName = bodyMap[String(pos)] || bodyMap[pos];
    if (regName === "customText") {
      const custom =
        context.extra?.customVariableValues ||
        context._customVariableValues ||
        context.customVariableValues ||
        {};
      const text = custom[String(pos)] ?? custom[pos] ?? "";
      return { type: "text", text: String(text || "-").slice(0, 1024) };
    }
    const def = VARIABLE_REGISTRY.find((v) => v.name === regName);
    let val = context[regName];
    if ((val == null || val === "") && def) {
      if (def.source?.startsWith("computed.")) {
        val = context[regName] ?? def.fallback;
      } else {
        val = resolveSourcePath(def.source, {
          client: context._clientDoc || {},
          convo: { metadata: context },
          lead: context._leadDoc || {},
          computed: {},
        });
      }
    }
    return { type: "text", text: String(val ?? def?.fallback ?? "-").slice(0, 1024) };
  });
}

/**
 * Build Meta Cloud API `components` for an approved/synced template.
 */
async function buildMetaTemplateComponents(metaTemplate, context, options = {}) {
  const components = [];
  const synced = metaTemplate?.components || metaTemplate?.metaComponents || [];
  const mappings = metaTemplate?.variableMappings || metaTemplate?.variableMapping || {};
  const headerImage =
    options.headerImageUrl ||
    context.first_product_image ||
    context.brand_logo_url ||
    "";

  for (const comp of synced) {
    const type = String(comp.type || "").toUpperCase();
    if (type === "HEADER") {
      const blueprintImage =
        comp._imageUrl ||
        (Array.isArray(comp.example?.header_handle) ? comp.example.header_handle[0] : null) ||
        "";
      const resolvedHeaderImage = headerImage || blueprintImage;
      if (comp.format === "IMAGE" && resolvedHeaderImage && /^https?:\/\//i.test(resolvedHeaderImage)) {
        components.push({
          type: "header",
          parameters: [{ type: "image", image: { link: String(resolvedHeaderImage).slice(0, 2048) } }],
        });
      } else if (comp.format === "TEXT" && /\{\{1\}\}/.test(comp.text || "")) {
        const params = buildPositionalBodyParams({ body: mappings.header || { 1: mappings.header?.[1] || "brand_name" } }, context);
        if (params[0]) {
          components.push({ type: "header", parameters: [params[0]] });
        }
      }
    }

    if (type === "BODY") {
      const paramMatches = (comp.text || "").match(/\{\{(\d+)\}\}/g) || [];
      const count =
        paramMatches.length > 0
          ? Math.max(...paramMatches.map((m) => parseInt(m.match(/\d+/)[0], 10)))
          : 0;
      let parameters = buildPositionalBodyParams(mappings, context);
      if (parameters.length < count) {
        const legacy = [];
        for (let i = 1; i <= count; i++) {
          legacy.push({ type: "text", text: String(context[`param_${i}`] ?? context[`var_${i}`] ?? "-").slice(0, 1024) });
        }
        parameters = legacy;
      }
      parameters = parameters.slice(0, count);
      if (parameters.length) components.push({ type: "body", parameters });
    }

    if (type === "BUTTONS" && Array.isArray(comp.buttons)) {
      const missingUrlButtons = [];
      comp.buttons.forEach((btn, idx) => {
        if (btn.type === "URL" && (btn.url || "").includes("{{1}}")) {
          const urlKey = mappings.buttons?.[String(idx)] || mappings.buttons?.[idx] || "checkout_url";
          const urlVal = String(
            context[urlKey] ||
              context.checkout_url ||
              context.store_url ||
              context.website ||
              context.shop_url ||
              ""
          ).slice(0, 2000);
          if (urlVal) {
            components.push({
              type: "button",
              sub_type: "url",
              index: String(idx),
              parameters: [{ type: "text", text: urlVal }],
            });
          } else {
            missingUrlButtons.push(idx);
          }
        }
      });
      if (missingUrlButtons.length > 0) {
        const err = new Error(
          `Template requires URL button parameter(s) at index ${missingUrlButtons.join(", ")}. Map checkout_url or store_url before sending.`
        );
        err.code = "TEMPLATE_URL_BUTTON_MISSING";
        throw err;
      }
    }
  }

  return components;
}

async function resolveAllVariables(context) {
  return context && typeof context === "object" ? { ...context } : {};
}

module.exports = {
  resolveTemplateVariables,
  buildSendContext,
  buildPositionalBodyParams,
  buildMetaTemplateComponents,
  resolveAllVariables,
};
