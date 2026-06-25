"use strict";

const { buildIndustryWelcomeA } = require('./industryWelcome');

function buildEcommerceDefaults(ctx) {
  const { F, riskPosture = "balanced" } = ctx || {};
  const industryWelcome = buildIndustryWelcomeA(ctx);

  const cart2 =
    riskPosture === "conservative"
      ? `{{first_name}} — quick reminder from *{{brand_name}}*.\n\nYour cart is still open:\n{{line_items_list}}\n\n💰 *{{cart_total}}*\n🔗 {{checkout_url}}\n\nIf you have a question before you buy, reply *help* and we’ll guide you.`
      : riskPosture === "aggressive"
        ? `{{first_name}} — *scarcity check* from *{{brand_name}}*: your SKU mix (incl. *{{first_product_title}}*) is selling through faster than average this week.\n\n💰 *{{cart_total}}*\n🔗 {{checkout_url}}\n\nCarts aren’t reserved — if you still want it, this is the nudge.`
        : `{{first_name}} — *scarcity check* from *{{brand_name}}*: your SKU mix (incl. *{{first_product_title}}*) is moving faster than usual.\n\n💰 *{{cart_total}}*\n🔗 {{checkout_url}}\n\nIf you still want it, this is the nudge.`;

  const cart3 =
    riskPosture === "conservative"
      ? `Quick check-in — your *{{brand_name}}* cart is still available.\n\n👉 {{checkout_url}}\n\nIf you’d like a recommendation or have a question, reply *help* or tap *menu*.`
      : `*Final nudge* — your *{{brand_name}}* cart ({{cart_total}}) is still waiting.\n\n👉 {{checkout_url}}\n\nComplete checkout now to lock your items — tap *menu* if you want a human.`;

  return {
    // “packs” also include what used to be TONE_COPY
    order_not_found_prompt:
      "I want to get this right for you. Reply with your *order number* exactly as on your invoice (e.g. *#1042*) — I'll pull live status from *{{brand_name}}*.",
    order_hub_prompt: "Here’s what I can do for *{{order_number}}* right now — pick one:",
    cancel_reason_prompt: "One line is enough: what made you cancel? (It helps *{{brand_name}}* fix the experience.)",
    cancel_failed_user:
      "I tried to cancel *{{order_number}}* but the warehouse/courier already has it — cancellations can’t go through at this stage. Tap *menu* and a human will sort exceptions.",
    support_capture_prompt:
      "Tell me what’s going wrong — *order number* if you have it. A *{{brand_name}}* teammate reads this thread and will jump in.",
    support_schedule_closed_nudge:
      "Humans are offline until *{{open_hours}}*. Leave your note here (with order # if any); {{bot_name}} can still handle FAQs meanwhile.",
    livechat_queue_body:
      "You’re queued for a live agent at *{{brand_name}}*. When you’re finished with them, send *menu* and I’ll take the wheel again.",

    welcome_a: industryWelcome,
    welcome_b: `🛍️ *{{brand_name}}* — curated picks, fast support, zero fluff. Tap *menu* when you’re ready to shop.`,
    product_menu_text: `*{{brand_name}}* hub — what should we tackle first?`,
    order_status_msg:
      `📦 *{{order_number}}*\n\n*Status:* {{order_status}}\n\n🧾 {{line_items_list}}\n\nNeed to modify, return, or have a question? Tap *menu* anytime — we'll help right away.`,
    fallback_msg:
      `That’s outside my auto-flows for *{{brand_name}}* — I’m flagging *{{bot_name}}* so a teammate can take over. Tap *menu* anytime to reset.`,
    returns_policy_short: `*{{brand_name}}* keeps returns painless: unused items, clear photos, fast decisions. Tap *Start Return* and we’ll guide you.`,
    cancellation_confirm: `⚠️ *Decision point:* cancel *{{order_number}}* with *{{brand_name}}*? Once submitted, reversal may not be possible.`,
    cancellation_success: `✅ *{{order_number}}* is cancelled. We’re sorry it didn’t work out — when you’re ready again, *{{brand_name}}* will be one tap away (*menu*).`,
    referral_msg:
      `📣 Love *{{brand_name}}*? Refer a friend from this chat — you both win *{{referral_points}} bonus points* when they first order. Limited slots each month.`,
    cart_recovery_1:
      `{{first_name}}, *Attention:* your cart at *{{brand_name}}* is still live.\n\n*Interest:* {{line_items_list}}\n\n*Desire:* Total *{{cart_total}}* — inventory moves daily.\n\n*Action (no pressure):* secure checkout in one tap 👇\n{{checkout_url}}\n\nStuck? Reply *help* — {{bot_name}} is here.`,
    cart_recovery_2: cart2,
    cart_recovery_3: cart3,

