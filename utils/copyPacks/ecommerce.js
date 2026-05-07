"use strict";

function buildEcommerceDefaults(ctx) {
  const { F, riskPosture = "balanced" } = ctx || {};

  const cart2 =
    riskPosture === "conservative"
      ? `{{first_name}} — quick reminder from *{{brand_name}}*.\n\nYour cart is still open:\n{{line_items_list}}\n\n💰 *{{cart_total}}*\n🔗 {{checkout_url}}\n\nIf you have a question before you buy, reply *help* and we’ll guide you.`
      : riskPosture === "aggressive"
        ? `{{first_name}} — *scarcity check* from *{{brand_name}}*: your SKU mix (incl. *{{first_product_title}}*) is selling through faster than average this week.\n\n💰 *{{cart_total}}*\n🔗 {{checkout_url}}\n\nCarts aren’t reserved — if you still want it, this is the nudge.`
        : `{{first_name}} — *scarcity check* from *{{brand_name}}*: your SKU mix (incl. *{{first_product_title}}*) is moving faster than usual.\n\n💰 *{{cart_total}}*\n🔗 {{checkout_url}}\n\nIf you still want it, this is the nudge.`;

  const cart3 =
    riskPosture === "conservative"
      ? `Quick check-in — your *{{brand_name}}* cart is still available.\n\n👉 {{checkout_url}}\n\nIf you’d like a recommendation or have a question, reply *help* or tap *menu*.`
      : `*Final nudge* — *{{brand_name}}* cart: {{cart_total}}.\n\n*FOMO + speed:* prepaid orders get *priority dispatch*; COD adds verification delays.\n\n👉 {{checkout_url}}\n\nAfter this, we’ll assume you passed — tap *menu* if you want a human.`;

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
      "Humans are offline until *{{open_hours}}*. Leave your note here (with order # if any); {{bot_name}} can still handle FAQs and tracking meanwhile.",
    livechat_queue_body:
      "You’re queued for a live agent at *{{brand_name}}*. When you’re finished with them, send *menu* and I’ll take the wheel again.",

    welcome_a:
      `Hi {{first_name}} 👋 *{{brand_name}}* here — I’m *{{bot_name}}*, your WhatsApp concierge.\n\n⚡ *Attention:* everything you need is one tap away.\n\n*Interest:* browse, track, or talk to a human — no forms, no hold music.\n\nPick below and I’ll route you instantly.`,
    welcome_b: `🛍️ *{{brand_name}}* — curated picks, fast support, zero fluff. Tap *menu* when you’re ready to shop.`,
    product_menu_text: `*{{brand_name}}* hub — what should we tackle first?`,
    order_status_msg:
      `📦 *{{order_number}}*\n\n*Status:* {{order_status}}\n\n🧾 {{line_items_list}}\n\n🔗 Track: {{tracking_url}}\n\n*Desire → Action:* need changes, returns, or a human? Use the buttons below — I’ll stay on this thread.`,
    fallback_msg:
      `That’s outside my auto-flows for *{{brand_name}}* — I’m flagging *{{bot_name}}* so a teammate can take over. Tap *menu* anytime to reset.`,
    returns_policy_short: `*{{brand_name}}* keeps returns painless: unused items, clear photos, fast decisions. Tap *Start Return* and we’ll guide you.`,
    cancellation_confirm: `⚠️ *Decision point:* cancel *{{order_number}}* with *{{brand_name}}*? Once submitted, reversal may not be possible.`,
    cancellation_success: `✅ *{{order_number}}* is cancelled. We’re sorry it didn’t work out — when you’re ready again, *{{brand_name}}* will be one tap away (*menu*).`,
    loyalty_welcome:
      `💎 *{{brand_name}}* Rewards — you’re *in*. Welcome bonus: *${F?.loyaltySignupBonus ?? 0} pts* locked to this WhatsApp number.\n\nEarn on every order, redeem at checkout, and skip the generic support queue.`,
    loyalty_points_msg:
      `💎 *Live balance* for this WhatsApp:\n\n• Points: *{{loyalty_points}}*\n• Tier: *{{loyalty_tier}}*\n• Approx. value: *{{loyalty_cash_value}}*\n\n*Action:* tap *Redeem* when you’re ready — discounts apply instantly at checkout for *{{brand_name}}*.`,
    referral_msg:
      `📣 Love *{{brand_name}}*? Refer a friend from this chat — you both win *{{referral_points}} bonus points* when they first order. Limited slots each month.`,
    sentiment_ask: `Quick pulse check for *{{brand_name}}* — how are we doing today? (Your reply trains us to serve you better.)`,
    review_positive: `🔥 Amazing — thank you. If you have 20 seconds, *{{brand_name}}* grows on honest Google reviews:\n{{review_url}}`,
    review_negative:
      `We hear you — that’s not the *{{brand_name}}* standard. A senior teammate is reading this now; give us one message with details and we’ll fix it.`,

    cart_recovery_1:
      `{{first_name}}, *Attention:* your cart at *{{brand_name}}* is still live.\n\n*Interest:* {{line_items_list}}\n\n*Desire:* Total *{{cart_total}}* — inventory moves daily.\n\n*Action (no pressure):* secure checkout in one tap 👇\n{{checkout_url}}\n\nStuck? Reply *help* — {{bot_name}} is here.`,
    cart_recovery_2: cart2,
    cart_recovery_3: cart3,

    cod_nudge:
      `{{first_name}}, *{{order_number}}* is *COD* today.\n\n*Pain:* slower courier pickup + higher failed-delivery risk.\n\n*Gain:* pay online now → *{{currency}}{{discount_amount}}* cashback-style credit on your next prepaid order + *priority packing* at *{{brand_name}}*.\n\n💳 Pay in seconds: {{payment_link}}`,
    order_confirmed_msg:
      `🎉 *{{first_name}}, you’re in.*\n\n📦 *{{order_number}}* · 💰 *{{order_total}}* · 💳 *{{payment_method}}*\n\n📍 *Ship to:*\n{{shipping_address}}\n\n🧾 *Items:*\n{{line_items_list}}\n\n*Anticipation:* tracking pings the second it leaves our hub. Questions? Stay in this chat.`,

    agent_handoff_msg:
      `✅ Noted — *{{brand_name}}* humans have this thread. Average reply during business hours is fast; off-hours we still read everything.`,
    faq_response: `Here’s the *{{brand_name}}* FAQ pack. Need something deeper? Tap *menu* → *Talk to Human*.`,
    ad_welcome: `You came from an ad — smart move. Tell *{{bot_name}}* what caught your eye at *{{brand_name}}* and I’ll shortlist the best match.`,
    ig_welcome: `IG → WhatsApp upgrade 📸 Tell me what you’re hunting at *{{brand_name}}* and I’ll pull stock + pricing.`,

    warranty_welcome:
      `🛡️ *{{brand_name}}* warranty desk — *{{warranty_duration}}* coverage from invoice date on eligible orders.\n\n*Register* (serial + purchase date) for VIP service, or *Check status* with order ID / serial.`,
    warranty_lookup_prompt:
      `Paste your *order #* (e.g. #1042) *or* serial from the product/invoice — I’ll cross-check live purchase date vs *{{warranty_duration}}*.`,
    warranty_reg_success:
      `✅ *Registered.* *{{brand_name}}* has your serial + purchase date on file for *{{warranty_duration}}*.\n\nKeep this chat — fastest path if you ever need service.`,
    warranty_active_msg:
      `✅ *Active coverage* — this order sits *inside* the *{{warranty_duration}}* window at *{{brand_name}}*.\n\nNext: reply with the issue (photo/video helps) or tap *menu* → human for RMA.`,
    warranty_expired_msg:
      `⏳ *Coverage window closed* for this purchase under *{{warranty_duration}}*.\n\n*{{brand_name}}* can still help with paid repair, upgrade pricing, or loyalty routes — tap *menu* for a specialist.`,
    warranty_none_msg:
      `🔍 *No match yet.* Double-check the order # / serial, or register via *Warranty → Register*.\n\nIf you paid under a different phone number, tell us the *order #* only — tap *menu* for a human lookup.`,

    support_hours_msg: `Agents are active *{{open_hours}}*. I'm here 24/7! 📞`,
    return_photo_prompt: `Please upload a clear photo of the item. 📸`,
    in_transit_error: `This *{{order_number}}* order from *{{brand_name}}* has already shipped 🚚 — contact returns once it arrives, or tap *menu* for help.`,

    // Template bodies (used by getPrebuiltTemplates)
    template_welcome_with_logo_body:
      `👋 Welcome to *{{1}}*\n\nClear communication and visible trust signals help customers feel confident before they buy. We're here to guide you — quick answers, honest recommendations, and a smooth path to checkout.\n\nWhat would you like to do next?`,
    template_cart_recovery_1_body:
      `Hi — your picks from {{brand_name}} are still reserved.\n\nCheckout is just one step away.\n\nReturn now to avoid missing stock and keep your preferred delivery slot.\n\nNeed help before you buy? Reply here and we’ll guide you instantly.`,
    template_cart_recovery_2_body:
      `Quick reminder from {{brand_name}}:\n\nYour cart is still open, but high-demand items may sell out soon.\n\nComplete checkout now to lock your order and delivery priority.`,
  };
}

module.exports = { buildEcommerceDefaults };

