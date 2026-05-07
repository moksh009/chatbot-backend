"use strict";

const { normalizeNodeType } = require("./flowNodeContract");

function pos(i, yOffset = 0) {
  return { x: 300, y: 50 + yOffset + i * 220 };
}

function inferActionFromStep(step) {
  const s = String(step || "").toLowerCase();
  if (s.includes("track") || s.includes("status")) return "CHECK_ORDER_STATUS";
  if (s.includes("cancel")) return "CANCEL_ORDER";
  if (s.includes("return") || s.includes("refund")) return "INITIATE_RETURN";
  if (s.includes("product") || s.includes("catalog")) return "product_search";
  return null;
}

function compilePlanToGraph(plan, { yOffset = 0 } = {}) {
  const outline = Array.isArray(plan?.outline) ? plan.outline : [];
  if (!outline.length) return { nodes: [], edges: [] };

  const nodes = [];
  const edges = [];

  const stepId = (s, idx) =>
    String(s?.step || `step_${idx}`)
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 40) || `step_${idx}`;
  const nodeIdForStep = (s, idx) => `p_${idx}_${stepId(s, idx)}`;

  outline.forEach((s, idx) => {
    const type = normalizeNodeType(s?.node || (idx === 0 ? "trigger" : "message"));
    const id = nodeIdForStep(s, idx);
    const brief = String(s?.copyBrief || "").trim();

    if (type === "trigger") {
      const trig = plan?.lanes?.[0]?.entryTriggers?.[0] || {};
      nodes.push({
        id,
        type: "trigger",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Entry",
          triggerType: trig.type || "first_message",
          keywords: trig.keywords || [],
          matchMode: trig.matchMode || "contains",
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "delay") {
      nodes.push({
        id,
        type: "delay",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Wait",
          waitValue: 5,
          waitUnit: "minutes",
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "logic") {
      nodes.push({
        id,
        type: "logic",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Logic split",
          variable: "captured_input",
          operator: "contains",
          value: "yes",
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "shopify_call") {
      const inferred = inferActionFromStep(s.step) || inferActionFromStep(brief);
      nodes.push({
        id,
        type: "shopify_call",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Shopify action",
          action: inferred || "CHECK_ORDER_STATUS",
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "order_action") {
      const inferred = inferActionFromStep(s.step) || inferActionFromStep(brief);
      nodes.push({
        id,
        type: "order_action",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Order action",
          action: inferred || "CHECK_ORDER_STATUS",
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "loyalty_action") {
      nodes.push({
        id,
        type: "loyalty_action",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Loyalty action",
          actionType: "REDEEM_POINTS",
          pointsRequired: 100,
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "warranty_check") {
      nodes.push({
        id,
        type: "warranty_check",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Warranty check",
          action: "WARRANTY_CHECK",
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "review") {
      nodes.push({
        id,
        type: "review",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Review request",
          text: brief ? brief.slice(0, 1024) : "How was your experience?",
          action: "SEND_REVIEW_REQUEST",
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "interactive") {
      const buttonsList =
        Array.isArray(s?.buttons) && s.buttons.length
          ? s.buttons
              .slice(0, 3)
              .map((b, bi) => ({
                id: String(b?.id || `btn_${bi + 1}`),
                title: String(b?.title || `Option ${bi + 1}`).slice(0, 20),
              }))
          : [{ id: "menu", title: "Main Menu" }];

      nodes.push({
        id,
        type: "interactive",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Options",
          interactiveType: "button",
          text: (brief || "Choose an option below.").slice(0, 1024),
          buttonsList,
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "capture_input") {
      nodes.push({
        id,
        type: "capture_input",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Capture",
          variable: "captured_input",
          question: (brief || "Please share the details.").slice(0, 512),
          text: (brief || "Please share the details.").slice(0, 512),
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "template") {
      nodes.push({
        id,
        type: "template",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Template",
          templateName: "",
          variables: [],
          heatmapCount: 0,
        },
      });
      return;
    }

    if (type === "livechat") {
      nodes.push({
        id,
        type: "livechat",
        position: pos(idx, yOffset),
        data: {
          label: s.step || "Human Handoff",
          text: (brief || "Connecting you to a human…").slice(0, 512),
          heatmapCount: 0,
        },
      });
      return;
    }

    nodes.push({
      id,
      type: "message",
      position: pos(idx, yOffset),
      data: {
        label: s.step || "Message",
        text: (brief || "").slice(0, 4096),
        heatmapCount: 0,
      },
    });
  });

  // Default linear wiring + interactive button wiring by targetStep (best-effort)
  for (let i = 0; i < outline.length - 1; i++) {
    const src = nodeIdForStep(outline[i], i);
    const dst = nodeIdForStep(outline[i + 1], i + 1);
    const srcType = nodes.find((n) => n.id === src)?.type;

    if (srcType === "logic") {
      const trueTarget = dst;
      const falseTarget = (outline[i + 2] ? nodeIdForStep(outline[i + 2], i + 2) : dst);
      edges.push({ id: `e_${src}_t`, source: src, target: trueTarget, sourceHandle: "true" });
      edges.push({ id: `e_${src}_f`, source: src, target: falseTarget, sourceHandle: "false" });
      continue;
    }

    if (srcType === "review") {
      const posIdx = outline.findIndex((s, si) => si > i && /positive|great|good/i.test(String(s.step || "")));
      const negIdx = outline.findIndex((s, si) => si > i && /negative|help|bad/i.test(String(s.step || "")));
      if (posIdx >= 0) edges.push({ id: `e_${src}_p`, source: src, target: nodeIdForStep(outline[posIdx], posIdx), sourceHandle: "positive" });
      if (negIdx >= 0) edges.push({ id: `e_${src}_n`, source: src, target: nodeIdForStep(outline[negIdx], negIdx), sourceHandle: "negative" });
      if (posIdx < 0 && negIdx < 0) edges.push({ id: `e_${src}_${dst}`, source: src, target: dst });
      continue;
    }

    if (srcType === "interactive") {
      const btns = outline[i]?.buttons || [];
      if (Array.isArray(btns) && btns.length) {
        btns.slice(0, 3).forEach((b, bi) => {
          const targetIdx = outline.findIndex((s) => String(s.step) === String(b?.targetStep));
          const targetId = targetIdx >= 0 ? nodeIdForStep(outline[targetIdx], targetIdx) : dst;
          edges.push({
            id: `e_${src}_${bi}`,
            source: src,
            target: targetId,
            sourceHandle: String(b?.id || `btn_${bi + 1}`),
          });
        });
        continue;
      }
    }

    edges.push({ id: `e_${src}_${dst}`, source: src, target: dst });
  }

  return { nodes, edges };
}

module.exports = { compilePlanToGraph };

