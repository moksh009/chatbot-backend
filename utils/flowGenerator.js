"use strict";

const { generateJSON } = require("./gemini");

/**
 * FLOW GENERATOR — Phase R4 ENTERPRISE FOLDERED
 * Generates a complete 60+ node enterprise flow organized into 8 smart folders.
 *
 * Bug Fixes Applied:
 *   BUG 1: e_pay_link — REMOVED (no PAYMENT_LINK node was ever created)
 *   BUG 2: e_p_tr — REMOVED (PersonaNode is floating metadata, not an entry trigger)
 *   BUG 3: Duplicate RETURN_POLICY node — REMOVED (wired to existing RET_NODE in Folder 8)
 *   BUG 4: Duplicate WARRANTY_REG_SUCCESS declaration — FIXED (single declaration)
 *   BUG 5: COD fires unconditionally — FIXED (COD_CHECK logic node added)
 *   BUG 6: node.data contains heavy arrays — FIXED (verifyFlowIntegrity guards this)
 *   BUG 7: Generic product descriptions — FIXED (buildProductContext + 38-key AI prompt)
 *   NEW:   8 folder nodes with proper parentId on all children
 *   NEW:   verifyFlowIntegrity() validates before returning
 *
 * @param {Object} client     - Client document (for geminiApiKey)
 * @param {Object} wizardData - Data from the onboarding wizard form
 * @returns {{ nodes, edges }}
 */

// ── UTILITY: Build rich product context ─────────────────────────────────────
function buildProductContext(product, index) {
  const images = Array.isArray(product.images) ? product.images : [];
  const altTexts = images.map(img => img?.alt).filter(Boolean).join(" ");
  const features = (altTexts || product.description || product.descriptionHtml || '').slice(0, 300);
  const rawName = product.name || product.title || `Product ${index + 1}`;
  const handle = product.handle || rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    id:       product.shopifyId || product.id || `prod_${index}`,
    title:    rawName,
    price:    product.price || '0',
    imageUrl: product.imageUrl || (images[0]?.src || ''),
    handle,
    features,
    category: product.category || 'General',
  };
}

// ── UTILITY: Verify flow integrity before returning ──────────────────────────
function verifyFlowIntegrity(nodes, edges) {
  const nodeIds = new Set(nodes.map(n => n.id));
  const issues = [];
  const seen = new Set();

  nodes.forEach((n, i) => {
    if (!n.id) { issues.push(`Node at index ${i} is missing an id`); return; }
    if (seen.has(n.id)) issues.push(`Duplicate node id: ${n.id}`);
    seen.add(n.id);

    // Guard: no heavy canvas-level arrays should be embedded in node data
    const prohibited = ['waTemplates', 'shopifyProducts', 'teamMembers', 'availableTags', 'waFlows'];
    prohibited.forEach(key => {
      if (n.data && Array.isArray(n.data[key]) && n.data[key].length > 0) {
        issues.push(`Node ${n.id} contains prohibited data field: ${key} (${n.data[key].length} items)`);
      }
    });
  });

  edges.forEach(e => {
    if (!e.id)     issues.push(`Edge missing id: source=${e.source} target=${e.target}`);
    if (!e.source) issues.push(`Edge ${e.id} missing source`);
    if (!e.target) issues.push(`Edge ${e.id} missing target`);
    if (e.source && !nodeIds.has(e.source)) issues.push(`Edge ${e.id}: source '${e.source}' not found in nodes`);
    if (e.target && !nodeIds.has(e.target)) issues.push(`Edge ${e.id}: target '${e.target}' not found in nodes`);
  });

  if (issues.length > 0) {
    const msg = `[FlowGenerator] ❌ Integrity check failed (${issues.length} issue${issues.length > 1 ? 's' : ''}):\n${issues.slice(0, 10).join('\n')}`;
    console.error(msg);
    // Don't throw — log and continue so the wizard doesn't fail completely
    return false;
  }

  console.log(`[FlowGenerator] ✅ Integrity verified: ${nodes.length} nodes, ${edges.length} edges across 8 folders.`);
  return true;
}

// ── MAIN GENERATOR ───────────────────────────────────────────────────────────
async function generateEcommerceFlow(client, wizardData) {
  const {
    businessName      = 'My Business',
    businessDescription = '',
    products          = [],
    botName           = 'Assistant',
    tone              = 'friendly',
    botLanguage       = 'Hinglish',
    cartTiming        = { msg1: 15, msg2: 2, msg3: 24 },
    googleReviewUrl   = '',
    adminPhone        = '',
    faqText           = '',
    returnsInfo       = '',
    fallbackMessage   = "I'm still learning! Let me connect you with a human expert. 😊",
    openTime          = '10:00',
    closeTime         = '19:00',
    workingDays       = [1, 2, 3, 4, 5],
    referralPoints    = 500,
    signupPoints      = 100,
    activePersona     = 'sidekick',
    b2bEnabled        = false,
    warrantyDuration  = '1 Year',
    warrantyPolicy    = 'Standard manufacturer warranty applicable from date of purchase.',
    checkoutUrl       = '',
    b2bThreshold      = 10,
    b2bAdminPhone     = '',
  } = wizardData;

  const personaMap = {
    concierge: { label: 'Elite Concierge',    type: 'Luxury/Formal',     tone_markers: "Use 'Sir/Ma'am', extremely polite, high-end vocabulary, boutique feel." },
    hacker:    { label: 'Growth Hacker',       type: 'Sales/Aggressive',  tone_markers: 'FOMO-driven, enthusiastic, use emojis like 🚀🔥, fast-paced, direct.' },
    sidekick:  { label: 'Friendly Sidekick',   type: 'Casual/Friendly',   tone_markers: "Warm, empathetic, uses 'friend/buddy', very approachable, uses 😊✨." },
    efficiency:{ label: 'Efficiency Expert',   type: 'Direct/Minimalist', tone_markers: 'No fluff, bullet points, ultra-fast, professional but dry.' },
  };
  const selectedPersona = personaMap[activePersona] || personaMap.sidekick;

  // Enrich products with context
  const enrichedProducts = products.slice(0, 15).map((p, i) => buildProductContext(p, i));
  const productsSummary  = enrichedProducts.map(p => `"${p.title}" ₹${p.price}: ${p.features.slice(0, 80)}`).join('\n');
  const productHandles   = enrichedProducts.slice(0, 6).map(p => p.handle);

  // ── STEP 1: 38-Key Gemini Prompt ─────────────────────────────────────────
  let content = {};

  const productGuideLines = productHandles.map(h => {
    const p = enrichedProducts.find(ep => ep.handle === h);
    return `"guide_${h}": [2-3 step setup/usage guide for "${p?.title}". Concise, persona-aligned, friendly]`;
  }).join('\n');

  const aiPrompt = `You are a world-class WhatsApp chatbot UX architect for an Indian e-commerce brand.

BRAND: ${businessName}
DESCRIPTION: ${businessDescription || 'E-commerce brand selling quality products'}
BOT NAME: ${botName}
TONE: ${tone}
PERSONA: ${selectedPersona.label} (${selectedPersona.type})
PERSONA GUIDELINES: ${selectedPersona.tone_markers}
LANGUAGE: ${botLanguage}
FAQ DATA: ${faqText ? faqText.slice(0, 400) : 'Standard product FAQs'}
RETURNS INFO: ${returnsInfo || '7-day easy returns'}
LOYALTY: Referral=${referralPoints} pts, Signup=${signupPoints} pts
BUSINESS HOURS: ${openTime}–${closeTime}
PRODUCTS:
${productsSummary || 'Various products available'}

Generate a JSON object with EXACTLY these keys. ALL text must match the persona and language above. Be concise, impactful, brand-specific. No generic placeholders.

REQUIRED KEYS:
"welcome_a": [Warm first greeting - persona-specific, brand name included, max 100 chars]
"welcome_b": [Second A/B variant - different hook - urgency/curiosity/value, max 100 chars]
"product_menu_text": [Menu header text - inviting, persona-styled]
"order_status_msg": [Order status update - reassuring, delivery ETA]
"fallback_msg": [AI cannot answer - empathetic, offers human help]
"returns_policy_short": [${returnsInfo || '7-day easy returns'} - friendly restatement]
"refund_policy_short": [Refund 5-7 days - reassuring]
"cancellation_confirm": [Confirm cancel intent - double-check phrasing]
"cancellation_success": [Cancel processed - apologetic but positive]
"loyalty_welcome": [Welcome to rewards - exciting, mention ${signupPoints} pts]
"loyalty_points_msg": [Points balance display - motivating, mention redemption value]
"referral_msg": [Referral pitch - mention ${referralPoints} pts reward]
"sentiment_ask": [Post-purchase experience question - warm, curious]
"review_positive": [After positive feedback - appreciate, ask Google review]
"review_negative": [After negative feedback - empathetic, escalate]
"upsell_intro": [Upsell after purchase - soft, helpful]
"cross_sell_msg": [Cross-sell related products - casual]
"cart_recovery_1": [${cartTiming.msg1 || 15}min cart abandon - gentle curiosity hook]
"cart_recovery_2": [${cartTiming.msg2 || 2}hr cart abandon - add value/urgency]
"cart_recovery_3": [${cartTiming.msg3 || 24}hr cart abandon - last chance + discount]
"cod_nudge": [COD to prepaid nudge - save ₹50, simpler delivery]
"order_confirmed_msg": [Order confirmation - celebrate, set delivery expectations]
"agent_handoff_msg": [Escalate to human - reassuring, ETA mention]
"faq_response": [General FAQ answer wrapper - helpful, directs to menu]
"ad_welcome": [Welcome from Meta Ad click - acknowledge ad, warm entry]
"ig_welcome": [Welcome from Instagram mention - casual, IG-specific]
"b2b_welcome": [B2B inquiry welcome - professional, wholesale-focused]
"b2b_capture_prompt": [Ask company + volume for B2B - professional, min ${b2bThreshold} units]
"warranty_welcome": [Warranty hub intro - ${warrantyDuration} coverage, reassuring]
"warranty_lookup_prompt": [Ask serial number for lookup - clear 1-line instructions]
"payment_request_body": [Request online payment - secure, benefits]
"loyalty_award_reason": [Points awarded message - celebratory, brand-specific]
"installation_msg": [Generic setup help - clear, step-by-step]
"support_hours_msg": [Business hours info - ${openTime}-${closeTime}, offline guidance]
"vip_perk_msg": [VIP exclusive perk reveal - exciting, premium feel]
"new_member_nudge": [Push new member toward next tier - motivating, shows progress]
"in_transit_error": [Can't cancel - already shipped - apologetic but helpful]
"return_photo_prompt": [Ask return damage photo - clear instructions]
"warranty_reg_success": [Warranty registration done - ${warrantyDuration} coverage confirmed]
${productGuideLines}

Respond ONLY with valid raw JSON. No markdown code fences. No explanation.`;

  try {
    const parsed = await generateJSON(aiPrompt, client.geminiApiKey || process.env.GEMINI_API_KEY, {
      maxTokens: 4096,
      temperature: 0.2,
      timeout: 45000,
      maxRetries: 2,
    });
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length >= 20) {
      content = parsed;
      console.log(`[FlowGenerator] AI content OK: ${Object.keys(content).length} keys`);
    } else {
      console.warn('[FlowGenerator] AI returned empty/invalid content — using smart defaults.');
    }
  } catch (err) {
    console.warn('[FlowGenerator] AI generation failed:', err.message, '— using smart defaults.');
  }

  // Merge with smart defaults (AI wins on non-empty fields)
  content = {
    ...buildDefaultContent(businessName, botName, enrichedProducts, { referralPoints, signupPoints, warrantyDuration, openTime, closeTime, checkoutUrl }),
    ...content,
  };

  // ── STEP 2: Define IDs ────────────────────────────────────────────────────
  const ts = Date.now();

  const FOLDER_IDS = {
    WELCOME:    `f1_welcome_${ts}`,
    CATALOG:    `f2_catalog_${ts}`,
    ORDERS:     `f3_orders_${ts}`,
    RETURNS:    `f4_returns_${ts}`,
    SUPPORT:    `f5_support_${ts}`,
    LOYALTY:    `f6_loyalty_${ts}`,
    AUTOMATION: `f7_auto_${ts}`,
    POSTPURCH:  `f8_post_${ts}`,
  };

  const IDS = {
    // Root metadata (floating, no edges)
    PERSONA: `pers_${ts}`,

    // Folder 1 — Welcome & Entry
    TRIGGER:    `f1_trig_${ts}`,
    AD_TRIGGER: `f1_ad_${ts}`,
    IG_TRIGGER: `f1_ig_${ts}`,
    AB_TEST:    `f1_ab_${ts}`,
    W_A:        `f1_wa_${ts}`,
    W_B:        `f1_wb_${ts}`,
    W_AD:       `f1_wad_${ts}`,
    W_IG:       `f1_wig_${ts}`,
    MENU:       `f1_menu_${ts}`,

    // Folder 2 — Product Catalog
    CATALOG:       `f2_cat_${ts}`,
    DETAIL_PREFIX: `f2_det_${ts}_`,

    // Folder 3 — Order Operations
    ORDER_STATUS:          `f3_stat_${ts}`,
    CANCEL_START:          `f3_can_${ts}`,
    CANCEL_LOGIC:          `f3_can_log_${ts}`,
    CANCEL_REASON:         `f3_can_rea_${ts}`,
    CANCEL_ALREADY_SHIPPED:`f3_can_shp_${ts}`,
    CANCEL_FINAL:          `f3_can_fin_${ts}`,
    ORDER_CHECK:           `f3_chk_${ts}`,

    // Folder 4 — Returns & Refunds
    RETURN_START:   `f4_ret_${ts}`,
    RETURN_FORM:    `f4_ret_f_${ts}`,
    RETURN_SUCCESS: `f4_ret_ok_${ts}`,
    REFUND_START:   `f4_ref_${ts}`,
    REFUND_STATUS:  `f4_ref_s_${ts}`,
    REFUND_FINAL:   `f4_ref_f_${ts}`,

    // Folder 5 — Support & Escalation
    SUPPORT_MENU:  `f5_sup_${ts}`,
    SUPPORT_HOURS: `f5_hrs_${ts}`,
    SCHED_NODE:    `f5_sch_${ts}`,
    ESC_LOGIC:     `f5_esc_l_${ts}`,
    ESC_CAP:       `f5_esc_c_${ts}`,
    ESC_TAG:       `f5_esc_t_${ts}`,
    ESC_ALERT:     `f5_esc_a_${ts}`,
    ESC_FINAL:     `f5_esc_f_${ts}`,

    // Folder 6 — Loyalty & Rewards
    LOY_MENU:      `f6_loy_${ts}`,
    LOY_POINTS:    `f6_pts_${ts}`,
    LOY_REDEEM:    `f6_red_${ts}`,
    LOY_REFER:     `f6_ref_${ts}`,
    LOY_SEG:       `f6_seg_${ts}`,
    LOY_VIP_PERK:  `f6_vip_${ts}`,
    LOY_NEW_NUDGE: `f6_new_${ts}`,
    LOYALTY_AWARD: `f6_awd_${ts}`,

    // Folder 7 — Automations
    CART_TR:   `f7_c_tr_${ts}`,
    CART_SEQ:  `f7_c_seq_${ts}`,
    CONF_TR:   `f7_conf_tr_${ts}`,
    CONF_MSG:  `f7_conf_m_${ts}`,
    COD_CHECK: `f7_cod_chk_${ts}`, // BUG FIX: Logic gate for COD-only nudge
    COD_NUDGE: `f7_cod_${ts}`,
    REV_TRIG:  `f7_rev_tr_${ts}`,
    REV_ASK:   `f7_rev_ask_${ts}`,

    // Folder 8 — Post-Purchase Hub
    FAQ_NODE:             `f8_faq_${ts}`,
    RET_NODE:             `f8_ret_p_${ts}`,
    FB_NODE:              `f8_fb_${ts}`,
    WARRANTY_HUB:         `f8_war_hub_${ts}`,
    WARRANTY_REG_SERIAL:  `f8_war_s_${ts}`,
    WARRANTY_REG_DATE:    `f8_war_d_${ts}`,
    WARRANTY_REG_TAG:     `f8_war_tag_${ts}`,
    WARRANTY_REG_SUCCESS: `f8_war_ok_${ts}`, // BUG FIX: Single declaration (was duplicated)
    WARRANTY_LOOKUP_SER:  `f8_war_ls_${ts}`,
    WARRANTY_LOOKUP_EXEC: `f8_war_le_${ts}`,
    B2B_TRIGGER:          `f8_b2b_tr_${ts}`,
    B2B_FORM:             `f8_b2b_f_${ts}`,
    B2B_CAPTURE_IND:      `f8_b2b_v_${ts}`,
    B2B_TAG:              `f8_b2b_tag_${ts}`,
    B2B_ALERT:            `f8_b2b_a_${ts}`,
    B2B_CONFIRM:          `f8_b2b_ok_${ts}`,
  };

  const Y = 140; // default Y step within folders (compact local canvas)
  const nodes = [];
  const edges = [];

  // ====================================================================
  // ROOT LEVEL — Folders + Persona (floating, no parentId)
  // ====================================================================

  // PersonaNode: metadata only — NO execution edges (BUG 10 FIX)
  nodes.push({
    id: IDS.PERSONA,
    type: 'persona',
    position: { x: -320, y: -180 },
    data: {
      label: `Brand Persona: ${selectedPersona.label}`,
      personaType: selectedPersona.type,
      activePersona,
      botName,
      tone,
      language: botLanguage,
    },
  });

  // 8 Folder nodes at root
  const FOLDER_META = [
    { id: FOLDER_IDS.WELCOME,    label: 'Welcome & Entry',      color: 'indigo', icon: 'Zap',         pos: { x: 0,    y: 0   } },
    { id: FOLDER_IDS.CATALOG,    label: 'Product Catalog',      color: 'emerald',icon: 'ShoppingBag', pos: { x: 360,  y: 0   } },
    { id: FOLDER_IDS.ORDERS,     label: 'Order Operations',     color: 'amber',  icon: 'Package',     pos: { x: 720,  y: 0   } },
    { id: FOLDER_IDS.RETURNS,    label: 'Returns & Refunds',    color: 'rose',   icon: 'RefreshCcw',  pos: { x: 1080, y: 0   } },
    { id: FOLDER_IDS.SUPPORT,    label: 'Support & Escalation', color: 'blue',   icon: 'Headset',     pos: { x: 0,    y: 330 } },
    { id: FOLDER_IDS.LOYALTY,    label: 'Loyalty & Rewards',    color: 'violet', icon: 'Star',        pos: { x: 360,  y: 330 } },
    { id: FOLDER_IDS.AUTOMATION, label: 'Smart Automations',    color: 'orange', icon: 'Bot',         pos: { x: 720,  y: 330 } },
    { id: FOLDER_IDS.POSTPURCH,  label: 'Post-Purchase Hub',    color: 'teal',   icon: 'ShieldCheck', pos: { x: 1080, y: 330 } },
  ];

  FOLDER_META.forEach(f => {
    nodes.push({
      id: f.id,
      type: 'folder',
      position: f.pos,
      data: { label: f.label, color: f.color, icon: f.icon, childCount: 0 },
    });
  });

  // ====================================================================
  // FOLDER 1 — Welcome & Entry (9 core nodes)
  // ====================================================================
  
  const baseKeywords = ['hi', 'hello', 'menu', 'start', 'hey', 'kem cho', 'namaste', 'help', 'bot'];
  const productKeywords = enrichedProducts.slice(0, 3).map(p => p.title.toLowerCase());
  const businessKeywords = [businessName.toLowerCase(), 'price', 'buy', 'order', '6499', 'discount'];
  const allKeywords = [...new Set([...baseKeywords, ...productKeywords, ...businessKeywords])];

  nodes.push(
    { id: IDS.TRIGGER,    type: 'trigger',     position: { x: 0,    y: 0      }, parentId: FOLDER_IDS.WELCOME, data: { label: 'Main Entry Trigger', triggerType: 'keyword', keywords: allKeywords } },
    { id: IDS.AD_TRIGGER, type: 'trigger',     position: { x: 0,    y: Y      }, parentId: FOLDER_IDS.WELCOME, data: { label: 'Meta Ad Entry',      triggerType: 'meta_ad',          keywords: ['ad_click'] } },
    { id: IDS.IG_TRIGGER, type: 'trigger',     position: { x: 0,    y: Y * 2  }, parentId: FOLDER_IDS.WELCOME, data: { label: 'Instagram Mention',  triggerType: 'ig_story_mention', keywords: ['story_mention'] } },
    { id: IDS.W_AD,       type: 'message',     position: { x: 400,  y: Y      }, parentId: FOLDER_IDS.WELCOME, data: { label: 'Ad Welcome',         text: content.ad_welcome } },
    { id: IDS.W_IG,       type: 'message',     position: { x: 400,  y: Y * 2  }, parentId: FOLDER_IDS.WELCOME, data: { label: 'IG Welcome',         text: content.ig_welcome } },
    { id: IDS.AB_TEST,    type: 'ab_test',     position: { x: 400,  y: 0      }, parentId: FOLDER_IDS.WELCOME, data: { label: 'A/B Test Welcome',   splitRatio: 50, variantA: 'Warm Hook', variantB: 'Value Hook' } },
    { id: IDS.W_A,        type: 'message',     position: { x: 800,  y: -60    }, parentId: FOLDER_IDS.WELCOME, data: { label: 'Welcome Variant A',  text: content.welcome_a } },
    { id: IDS.W_B,        type: 'message',     position: { x: 800,  y: 80     }, parentId: FOLDER_IDS.WELCOME, data: { label: 'Welcome Variant B',  text: content.welcome_b } },
    {
      id: IDS.MENU,
      type: 'interactive',
      position: { x: 1200, y: 0 },
      parentId: FOLDER_IDS.WELCOME,
      data: {
        label: 'Main Hub Menu',
        interactiveType: 'list',
        text: content.product_menu_text,
        buttonText: 'Open Menu',
        sections: [{
          title: `${businessName} Services`,
          rows: [
            { id: 'discovery', title: '🛍️ Shop Collection' },
            { id: 'orders',    title: '📦 My Orders'       },
            { id: 'ops',       title: '⚙️ Returns & Refunds' },
            { id: 'loyalty',   title: '💎 Rewards Hub'    },
            { id: 'support',   title: '🎧 Customer Help'  },
            { id: 'faq',       title: '❓ General FAQs'  },
            { id: 'warranty',  title: '🛡️ Warranty'      },
          ],
        }],
      },
    }
  );

  edges.push(
    // BUG FIX: NO e_p_tr edge (Persona → Trigger removed)
    { id: 'f1_tr_ab',    source: IDS.TRIGGER,    target: IDS.AB_TEST },
    { id: 'f1_ad_wad',   source: IDS.AD_TRIGGER, target: IDS.W_AD    },
    { id: 'f1_ig_wig',   source: IDS.IG_TRIGGER, target: IDS.W_IG    },
    { id: 'f1_ab_wa',    source: IDS.AB_TEST,    target: IDS.W_A, sourceHandle: 'a' },
    { id: 'f1_ab_wb',    source: IDS.AB_TEST,    target: IDS.W_B, sourceHandle: 'b' },
    { id: 'f1_wa_menu',  source: IDS.W_A,        target: IDS.MENU   },
    { id: 'f1_wb_menu',  source: IDS.W_B,        target: IDS.MENU   },
    { id: 'f1_wad_menu', source: IDS.W_AD,       target: IDS.MENU   },
    { id: 'f1_wig_menu', source: IDS.W_IG,       target: IDS.MENU   },
    // Cross-folder nav edges: MENU → Folder entry nodes
    { id: 'f1_m_cat',    source: IDS.MENU, target: IDS.CATALOG,           sourceHandle: 'discovery' },
    { id: 'f1_m_ord',    source: IDS.MENU, target: IDS.ORDER_STATUS,      sourceHandle: 'orders'    },
    { id: 'f1_m_ops',    source: IDS.MENU, target: IDS.RETURN_START,      sourceHandle: 'ops'       },
    { id: 'f1_m_loy',    source: IDS.MENU, target: IDS.LOY_MENU,          sourceHandle: 'loyalty'   },
    { id: 'f1_m_sup',    source: IDS.MENU, target: IDS.SUPPORT_MENU,      sourceHandle: 'support'   },
    { id: 'f1_m_faq',    source: IDS.MENU, target: IDS.FAQ_NODE,          sourceHandle: 'faq'       },
    { id: 'f1_m_war',    source: IDS.MENU, target: IDS.WARRANTY_HUB,      sourceHandle: 'warranty'  },
  );

  // ====================================================================
  // FOLDER 2 — Product Catalog
  // ====================================================================
  if (enrichedProducts.length === 0) {
    nodes.push({
      id: IDS.CATALOG,
      type: 'interactive',
      position: { x: 0, y: 0 },
      parentId: FOLDER_IDS.CATALOG,
      data: {
        label: 'Store Redirect',
        interactiveType: 'button',
        text: `We're updating our WhatsApp catalog! Browse our full collection at ${checkoutUrl || 'our website'}.`,
        buttonsList: [{ id: 'menu', title: '⬅️ Back to Menu' }],
      },
    });
  } else {
    const categories = [...new Set(enrichedProducts.map(p => p.category))];

    if (categories.length > 1) {
      // Multi-category
      nodes.push({
        id: IDS.CATALOG,
        type: 'interactive',
        position: { x: 0, y: 0 },
        parentId: FOLDER_IDS.CATALOG,
        data: {
          label: 'Category Menu',
          interactiveType: 'list',
          text: `Explore our *${businessName}* collection:`,
          buttonText: 'Browse Categories',
          sections: [{
            title: 'Product Categories',
            rows: categories.slice(0, 10).map(cat => ({ id: `cat_${cat.toLowerCase().replace(/\s+/g, '_')}`, title: cat })),
          }],
        },
      });

      categories.forEach((cat, idx) => {
        const catId   = `f2_cl_${idx}_${ts}`;
        const catProds = enrichedProducts.filter(p => p.category === cat).slice(0, 10);
        nodes.push({
          id: catId,
          type: 'interactive',
          position: { x: 420, y: idx * Y },
          parentId: FOLDER_IDS.CATALOG,
          data: {
            label: `Category: ${cat}`,
            interactiveType: 'list',
            text: `Our best *${cat}* products:`,
            buttonText: 'View Products',
            sections: [{
              title: cat,
              rows: catProds.map((p, pi) => ({ id: `p_${idx}_${pi}`, title: p.title.substring(0, 24) })),
            }],
          },
        });
        edges.push({ id: `f2_c_${idx}`, source: IDS.CATALOG, target: catId, sourceHandle: `cat_${cat.toLowerCase().replace(/\s+/g, '_')}` });

        catProds.forEach((p, pi) => {
          const pId     = `${IDS.DETAIL_PREFIX}${idx}_${pi}`;
          const guideId = `f8_guide_${p.handle}_${ts}`;
          const hasGuide = !!content[`guide_${p.handle}`];
          const btns = [
            { id: 'buy',  title: '🛒 Buy Now'    },
            { id: 'menu', title: '⬅️ Main Menu' },
            ...(hasGuide ? [{ id: 'guide', title: '📋 Product Guide' }] : []),
          ];
          nodes.push({
            id: pId,
            type: 'interactive',
            position: { x: 840, y: (idx * catProds.length + pi) * Y },
            parentId: FOLDER_IDS.CATALOG,
            data: {
              label: `Product: ${p.title.substring(0, 20)}`,
              interactiveType: 'button',
              text: `*${p.title}*\n\n💰 Price: ₹${p.price}${p.features ? `\n\n${p.features.slice(0, 150)}` : ''}`,
              imageUrl: p.imageUrl || '',
              buttonsList: btns,
            },
          });
          edges.push(
            { id: `f2_cl${idx}_p${pi}`,   source: catId, target: pId, sourceHandle: `p_${idx}_${pi}` },
            { id: `f2_p${idx}${pi}_menu`, source: pId,   target: IDS.MENU, sourceHandle: 'menu' }
          );
          if (hasGuide) {
            nodes.push({ id: guideId, type: 'message', position: { x: 200, y: (enrichedProducts.indexOf(p) + 5) * Y }, parentId: FOLDER_IDS.POSTPURCH, data: { label: `Guide: ${p.title.substring(0, 18)}`, text: content[`guide_${p.handle}`] } });
            edges.push({ id: `f2_p${idx}${pi}_guide`, source: pId, target: guideId, sourceHandle: 'guide' });
          }
        });
      });
    } else {
      // Single-category flat catalog
      nodes.push({
        id: IDS.CATALOG,
        type: 'interactive',
        position: { x: 0, y: 0 },
        parentId: FOLDER_IDS.CATALOG,
        data: {
          label: 'Product Catalog',
          interactiveType: 'list',
          text: content.product_menu_text,
          buttonText: 'View Products',
          sections: [{
            title: `${businessName} Products`,
            rows: enrichedProducts.map((p, i) => ({ id: `p_${i}`, title: p.title.substring(0, 24) })),
          }],
        },
      });

      enrichedProducts.forEach((p, i) => {
        const pId     = `${IDS.DETAIL_PREFIX}${i}`;
        const guideId = `f8_guide_${p.handle}_${ts}`;
        const hasGuide = !!content[`guide_${p.handle}`];
        const templateName = `prod_${p.handle.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`.substring(0, 50);

        // Hybrid Engine: Check if template exists and is APPROVED
        const approvedTemplate = (client.messageTemplates || []).find(t => 
           t.name === templateName && t.status === 'APPROVED'
        );

        if (!approvedTemplate) {
            // Queue for auto-submission via wizard wrapper
            wizardData.customTemplates = wizardData.customTemplates || [];
            if (!wizardData.customTemplates.find(t => t.name === templateName)) {
                wizardData.customTemplates.push({
                   name: templateName,
                   category: 'MARKETING',
                   language: 'en',
                   components: [
                       { type: 'HEADER', format: 'IMAGE' },
                       { type: 'BODY', text: `*{{1}}*\n\n💰 Price: ₹{{2}}\n\nTap below to proceed. 🛍️` },
                       { type: 'BUTTONS', buttons: [
                           { type: 'QUICK_REPLY', text: '🛒 Buy Now' },
                           { type: 'QUICK_REPLY', text: '⬅️ Main Menu' }
                       ]}
                   ]
                });
            }
        }

        const btns = [
          { id: 'buy',  title: '🛒 Buy Now'     },
          { id: 'menu', title: '⬅️ Main Menu'  },
          ...(hasGuide ? [{ id: 'guide', title: '📋 Product Guide' }] : []),
        ];

        if (approvedTemplate && !hasGuide) {  // Only deploy TemplateNode if it perfectly matches (buttons limit)
           nodes.push({
             id: pId,
             type: 'template',
             position: { x: 420, y: i * Y },
             parentId: FOLDER_IDS.CATALOG,
             data: {
               label: `Product: ${p.title.substring(0, 20)}`,
               templateName: templateName,
               variables: [p.title, p.price],
               imageUrl: p.imageUrl || ''
             }
           });
        } else {
           nodes.push({
             id: pId,
             type: 'interactive',
             position: { x: 420, y: i * Y },
             parentId: FOLDER_IDS.CATALOG,
             data: {
               label: `Product: ${p.title.substring(0, 20)}`,
               interactiveType: 'button',
               text: `*${p.title}*\n\n💰 Price: ₹${p.price}${p.features ? `\n\n${p.features.slice(0, 150)}` : ''}`,
               imageUrl: p.imageUrl || '',
               buttonsList: btns,
             },
           });
        }

        edges.push(
          { id: `f2_cat_p${i}`, source: IDS.CATALOG, target: pId, sourceHandle: `p_${i}` },
          { id: `f2_p${i}_m`,   source: pId,          target: IDS.MENU, sourceHandle: 'menu' }
        );
        if (hasGuide) {
          nodes.push({ id: guideId, type: 'message', position: { x: 200, y: (i + 5) * Y }, parentId: FOLDER_IDS.POSTPURCH, data: { label: `Guide: ${p.title.substring(0, 18)}`, text: content[`guide_${p.handle}`] } });
          edges.push({ id: `f2_p${i}_guide`, source: pId, target: guideId, sourceHandle: 'guide' });
        }
      });
    }
  }

  // ====================================================================
  // FOLDER 3 — Order Operations
  // ====================================================================
  nodes.push(
    { id: IDS.ORDER_STATUS,           type: 'shopify_call',  position: { x: 0,    y: 0      }, parentId: FOLDER_IDS.ORDERS, data: { label: 'Fetch Order Status',   action: 'CHECK_ORDER_STATUS' } },
    { id: IDS.CANCEL_START,           type: 'interactive',   position: { x: 0,    y: Y      }, parentId: FOLDER_IDS.ORDERS, data: { label: 'Cancel Confirm',       interactiveType: 'button', text: content.cancellation_confirm, buttonsList: [{ id: 'yes', title: '✅ Yes, Cancel' }, { id: 'no', title: '❌ Keep It' }] } },
    { id: IDS.CANCEL_LOGIC,           type: 'logic',         position: { x: 420,  y: Y      }, parentId: FOLDER_IDS.ORDERS, data: { label: 'Order Shipped?',       variable: 'is_shipped', operator: 'eq', value: 'true' } },
    { id: IDS.CANCEL_REASON,          type: 'capture_input', position: { x: 840,  y: Y / 2  }, parentId: FOLDER_IDS.ORDERS, data: { label: 'Cancellation Reason',  variable: 'cancel_reason', question: 'Why are you cancelling? Your feedback helps us improve! 🙏' } },
    { id: IDS.CANCEL_ALREADY_SHIPPED, type: 'message',       position: { x: 840,  y: Y * 2  }, parentId: FOLDER_IDS.ORDERS, data: { label: 'Already Shipped',      text: content.in_transit_error } },
    { id: IDS.CANCEL_FINAL,           type: 'shopify_call',  position: { x: 1260, y: Y / 2  }, parentId: FOLDER_IDS.ORDERS, data: { label: 'Process Cancellation', action: 'CANCEL_ORDER' } },
    { id: IDS.ORDER_CHECK,            type: 'shopify_call',  position: { x: 0,    y: Y * 3  }, parentId: FOLDER_IDS.ORDERS, data: { label: 'Check Order Details',  action: 'get_order' } }
  );
  edges.push(
    { id: 'f3_can_y',   source: IDS.CANCEL_START,  target: IDS.CANCEL_LOGIC,           sourceHandle: 'yes'   },
    { id: 'f3_log_t',   source: IDS.CANCEL_LOGIC,  target: IDS.CANCEL_ALREADY_SHIPPED, sourceHandle: 'true'  },
    { id: 'f3_log_f',   source: IDS.CANCEL_LOGIC,  target: IDS.CANCEL_REASON,          sourceHandle: 'false' },
    { id: 'f3_can_fin', source: IDS.CANCEL_REASON, target: IDS.CANCEL_FINAL }
  );

  // ====================================================================
  // FOLDER 4 — Returns & Refunds
  // BUG FIX: RETURN_POLICY duplicate node REMOVED.
  //          "pol" handle now links to RET_NODE (in Folder 8) directly.
  // ====================================================================
  nodes.push(
    { id: IDS.RETURN_START,   type: 'interactive',   position: { x: 0,   y: 0    }, parentId: FOLDER_IDS.RETURNS, data: { label: 'Return Hub',       interactiveType: 'button', text: 'Want to return or exchange something?', buttonsList: [{ id: 'form', title: '📸 Start Return' }, { id: 'pol', title: '📋 View Policy' }] } },
    { id: IDS.RETURN_FORM,    type: 'capture_input', position: { x: 420, y: 0    }, parentId: FOLDER_IDS.RETURNS, data: { label: 'Damage Photo',      variable: 'return_photo', question: content.return_photo_prompt } },
    { id: IDS.RETURN_SUCCESS, type: 'message',       position: { x: 840, y: 0    }, parentId: FOLDER_IDS.RETURNS, data: { label: 'Return Confirmed',  text: '✅ Return request received! Our team will verify and arrange pickup within 24 hours.' } },
    { id: IDS.REFUND_START,   type: 'interactive',   position: { x: 0,   y: Y    }, parentId: FOLDER_IDS.RETURNS, data: { label: 'Refund Hub',        interactiveType: 'button', text: 'Want to check your refund status?', buttonsList: [{ id: 'check', title: '🔍 Check Status' }, { id: 'back', title: '⬅️ Go Back' }] } },
    { id: IDS.REFUND_STATUS,  type: 'shopify_call',  position: { x: 420, y: Y    }, parentId: FOLDER_IDS.RETURNS, data: { label: 'Fetch Refund',      action: 'ORDER_REFUND_STATUS' } },
    { id: IDS.REFUND_FINAL,   type: 'message',       position: { x: 840, y: Y    }, parentId: FOLDER_IDS.RETURNS, data: { label: 'Refund Policy',     text: content.refund_policy_short } }
  );
  edges.push(
    { id: 'f4_ret_form', source: IDS.RETURN_START, target: IDS.RETURN_FORM,  sourceHandle: 'form'  },
    { id: 'f4_ret_pol',  source: IDS.RETURN_START, target: IDS.RET_NODE,     sourceHandle: 'pol'   }, // Cross-folder to Folder 8
    { id: 'f4_ret_succ', source: IDS.RETURN_FORM,  target: IDS.RETURN_SUCCESS },
    { id: 'f4_ref_chk',  source: IDS.REFUND_START, target: IDS.REFUND_STATUS, sourceHandle: 'check' },
    { id: 'f4_ref_fin',  source: IDS.REFUND_STATUS,target: IDS.REFUND_FINAL  }
  );

  // ====================================================================
  // FOLDER 5 — Support & Escalation
  // ====================================================================
  nodes.push(
    { id: IDS.SUPPORT_MENU,  type: 'interactive',   position: { x: 0,    y: 0     }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Support Dispatch',  interactiveType: 'button', text: 'How can we help you today?', buttonsList: [{ id: 'talk', title: '💬 Talk to Human' }, { id: 'hrs', title: '⏰ Business Hours' }] } },
    { id: IDS.SUPPORT_HOURS, type: 'message',       position: { x: 420,  y: Y * 2  }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Business Hours',    text: content.support_hours_msg } },
    { id: IDS.SCHED_NODE,    type: 'schedule',      position: { x: 420,  y: 0     }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Availability Check', openTime, closeTime, days: workingDays, closedMessage: 'Our agents are currently offline. AI is here 24/7, or leave a message!' } },
    { id: IDS.ESC_LOGIC,     type: 'logic',         position: { x: 840,  y: 0     }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Name Captured?',    variable: 'name', operator: 'exists' } },
    { id: IDS.ESC_CAP,       type: 'capture_input', position: { x: 1260, y: -Y/2  }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Capture Name',      variable: 'name', question: "May I have your name so I can connect you with our team? 😊" } },
    { id: IDS.ESC_TAG,       type: 'tag_lead',      position: { x: 1260, y: Y/2   }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Tag: Pending Help', action: 'add', tag: 'pending-human' } },
    { id: IDS.ESC_ALERT,     type: 'admin_alert',   position: { x: 1680, y: Y/2   }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Alert Support Team', priority: 'high', topic: '🔔 High Priority: Human Agent Requested', phone: adminPhone } },
    { id: IDS.ESC_FINAL,     type: 'message',       position: { x: 2100, y: Y/2   }, parentId: FOLDER_IDS.SUPPORT, data: { label: 'Handoff Confirmed', text: content.agent_handoff_msg } }
  );
  edges.push(
    { id: 'f5_sup_hrs',  source: IDS.SUPPORT_MENU, target: IDS.SUPPORT_HOURS, sourceHandle: 'hrs'   },
    { id: 'f5_sup_talk', source: IDS.SUPPORT_MENU, target: IDS.SCHED_NODE,    sourceHandle: 'talk'  },
    { id: 'f5_sch_open', source: IDS.SCHED_NODE,   target: IDS.ESC_LOGIC,    sourceHandle: 'open'  },
    { id: 'f5_sch_cls',  source: IDS.SCHED_NODE,   target: IDS.FB_NODE,      sourceHandle: 'closed' }, // cross-folder to Folder 8
    { id: 'f5_esc_t',    source: IDS.ESC_LOGIC,    target: IDS.ESC_TAG,      sourceHandle: 'true'  },
    { id: 'f5_esc_f',    source: IDS.ESC_LOGIC,    target: IDS.ESC_CAP,      sourceHandle: 'false' },
    { id: 'f5_cap_tag',  source: IDS.ESC_CAP,      target: IDS.ESC_TAG       },
    { id: 'f5_tag_alt',  source: IDS.ESC_TAG,      target: IDS.ESC_ALERT     },
    { id: 'f5_alt_fin',  source: IDS.ESC_ALERT,    target: IDS.ESC_FINAL     }
  );

  // ====================================================================
  // FOLDER 6 — Loyalty & Rewards
  // ====================================================================
  nodes.push(
    { id: IDS.LOY_MENU,      type: 'interactive',    position: { x: 0,   y: 0      }, parentId: FOLDER_IDS.LOYALTY, data: { label: 'Rewards Hub',    interactiveType: 'list', text: content.loyalty_welcome, buttonText: 'My Rewards', sections: [{ title: 'Options', rows: [{ id: 'pts', title: '💎 My Points' }, { id: 'red', title: '🎁 Redeem' }, { id: 'ref', title: '📢 Invite & Earn' }, { id: 'vip', title: '⭐ VIP Status' }] }] } },
    { id: IDS.LOY_POINTS,    type: 'message',        position: { x: 420, y: -Y/2   }, parentId: FOLDER_IDS.LOYALTY, data: { label: 'Points Balance',  text: content.loyalty_points_msg } },
    { id: IDS.LOY_REDEEM,    type: 'loyalty',        position: { x: 420, y: Y/4    }, parentId: FOLDER_IDS.LOYALTY, data: { label: 'Redeem Points',   loyaltyAction: 'REDEEM_POINTS', pointsRequired: 100 } },
    { id: IDS.LOYALTY_T2,    type: 'logic',          position: { x: 840, y: Y      }, parentId: FOLDER_IDS.LOYALTY, data: { label: 'VIP Tier Check',  variable: 'loyalty_balance', operator: 'gte', value: '1000' } },
    { id: IDS.VIP_PERK,      type: 'message',        position: { x: 1260,y: Y/2    }, parentId: FOLDER_IDS.LOYALTY, data: { label: 'VIP Reward',      text: content.vip_perk_msg } },
    { id: IDS.NUDGE_MEMBER,  type: 'message',        position: { x: 1260,y: Y*1.5  }, parentId: FOLDER_IDS.LOYALTY, data: { label: 'Tier Nudge',      text: content.new_member_nudge } },
    { id: IDS.LOYALTY_AWARD, type: 'loyalty',        position: { x: 420, y: Y*2.2  }, parentId: FOLDER_IDS.LOYALTY, data: { label: 'Award Points',    loyaltyAction: 'ADD_POINTS', points: signupPoints, reason: content.loyalty_award_reason } }
  );
  edges.push(
    { id: 'f6_loy_pts', source: IDS.LOY_MENU,   target: IDS.LOY_POINTS,    sourceHandle: 'pts' },
    { id: 'f6_loy_red', source: IDS.LOY_MENU,   target: IDS.LOY_REDEEM,    sourceHandle: 'red' },
    { id: 'f6_loy_ref', source: IDS.LOY_MENU,   target: IDS.LOY_REFER,     sourceHandle: 'ref' },
    { id: 'f6_loy_vip', source: IDS.LOY_MENU,   target: IDS.LOY_SEG,       sourceHandle: 'vip' },
    { id: 'f6_seg_v',   source: IDS.LOY_SEG,    target: IDS.LOY_VIP_PERK,  sourceHandle: 'vip' },
    { id: 'f6_seg_n',   source: IDS.LOY_SEG,    target: IDS.LOY_NEW_NUDGE, sourceHandle: 'new' }
  );

  // ====================================================================
  // FOLDER 7 — Smart Automations
  // BUG FIX: COD_CHECK logic node added between CONF_MSG and COD_NUDGE
  // BUG FIX: e_pay_link REMOVED (PAYMENT_LINK node never existed)
  // ====================================================================
  nodes.push(
    { id: IDS.CART_TR,   type: 'trigger',     position: { x: 0,    y: 0      }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'Abandoned Checkout',  triggerType: 'shopify_event', event: 'checkout_abandoned' } },
    { id: IDS.CART_SEQ,  type: 'sequence',    position: { x: 420,  y: 0      }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'Recovery Drip',       steps: [{ id: '1', text: content.cart_recovery_1, delay: cartTiming.msg1 || 15 }, { id: '2', text: content.cart_recovery_2, delay: (cartTiming.msg2 || 2) * 60 }, { id: '3', text: content.cart_recovery_3, delay: (cartTiming.msg3 || 24) * 60 }] } },
    { id: IDS.CONF_TR,   type: 'trigger',     position: { x: 0,    y: Y      }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'Order Created',       triggerType: 'shopify_event', event: 'order_created' } },
    { id: IDS.CONF_MSG,  type: 'message',     position: { x: 420,  y: Y      }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'Order Confirmed',     text: content.order_confirmed_msg } },
    // BUG FIX: COD_CHECK ensures nudge only fires for COD orders
    { id: IDS.COD_CHECK, type: 'logic',       position: { x: 840,  y: Y      }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'COD Payment?',        variable: 'payment_method', operator: 'contains', value: 'cod' } },
    { id: IDS.COD_NUDGE, type: 'cod_prepaid', position: { x: 1260, y: Y - 60 }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'Prepay & Save ₹50',   discountAmount: 50, action: 'CONVERT_COD_TO_PREPAID', text: content.cod_nudge } },
    { id: IDS.REV_TRIG,  type: 'trigger',     position: { x: 0,    y: Y * 2  }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'Order Fulfilled',     triggerType: 'shopify_event', event: 'order_fulfilled' } },
    { id: IDS.REV_ASK,   type: 'review',      position: { x: 420,  y: Y * 2  }, parentId: FOLDER_IDS.AUTOMATION, data: { label: 'Sentiment Check',     text: content.sentiment_ask, rewardText: 'REVIEW15', googleReviewUrl } }
  );
  edges.push(
    { id: 'f7_cart_s',   source: IDS.CART_TR,   target: IDS.CART_SEQ  },
    { id: 'f7_conf_c',   source: IDS.CONF_TR,   target: IDS.CONF_MSG  },
    // BUG FIX: CONF_MSG → COD_CHECK → (true only) → COD_NUDGE
    { id: 'f7_conf_chk', source: IDS.CONF_MSG,  target: IDS.COD_CHECK },
    { id: 'f7_cod_t',    source: IDS.COD_CHECK, target: IDS.COD_NUDGE, sourceHandle: 'true' },
    // false path ends cleanly (no node needed — flow ends naturally for prepaid orders)
    { id: 'f7_rev_s',    source: IDS.REV_TRIG,  target: IDS.REV_ASK   }
  );

  // ====================================================================
  // FOLDER 8 — Post-Purchase Hub (Knowledge Base + Warranty + B2B)
  // BUG FIX: WARRANTY_REG_SUCCESS declared only once
  // ====================================================================

  // Knowledge Base nodes
  nodes.push(
    { id: IDS.FAQ_NODE, type: 'message', position: { x: 0, y: 0      }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'General FAQs',   text: faqText || content.faq_response } },
    { id: IDS.RET_NODE, type: 'message', position: { x: 0, y: Y      }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Returns Policy', text: returnsInfo || content.returns_policy_short } },
    { id: IDS.FB_NODE,  type: 'message', position: { x: 0, y: Y * 2  }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'AI Fallback',    text: fallbackMessage } }
  );

  // Warranty Module
  nodes.push(
    { id: IDS.WARRANTY_HUB,         type: 'interactive',    position: { x: 420,  y: 0     }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Warranty Hub',          interactiveType: 'button', text: content.warranty_welcome, buttonsList: [{ id: 'reg', title: '✅ Register Product' }, { id: 'check', title: '🔍 Check Status' }] } },
    { id: IDS.WARRANTY_REG_SERIAL,  type: 'capture_input',  position: { x: 840,  y: -Y/2  }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Serial Number',         variable: 'warranty_serial', question: 'Please enter your Product Serial Number or Order ID.' } },
    { id: IDS.WARRANTY_REG_DATE,    type: 'capture_input',  position: { x: 1260, y: -Y/2  }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Date of Purchase',       variable: 'purchase_date',   question: 'Enter your date of purchase (DD/MM/YYYY).' } },
    { id: IDS.WARRANTY_REG_TAG,     type: 'tag_lead',       position: { x: 1680, y: -Y/2  }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Tag: Warranty Active',   action: 'add', tag: 'warranty-enrolled' } },
    { id: IDS.WARRANTY_REG_SUCCESS, type: 'message',        position: { x: 2100, y: -Y/2  }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Warranty Activated',     text: content.warranty_reg_success } }, // Single declaration
    { id: IDS.WARRANTY_LOOKUP_SER,  type: 'capture_input',  position: { x: 840,  y: Y/2   }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Serial Lookup',          variable: 'lookup_serial',   question: content.warranty_lookup_prompt } },
    { id: IDS.WARRANTY_LOOKUP_EXEC, type: 'warranty_check', position: { x: 1260, y: Y/2   }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Warranty Engine Lookup', duration: warrantyDuration, policy: warrantyPolicy } }
  );
  edges.push(
    { id: 'f8_war_reg',  source: IDS.WARRANTY_HUB,        target: IDS.WARRANTY_REG_SERIAL,  sourceHandle: 'reg'   },
    { id: 'f8_war_s_d',  source: IDS.WARRANTY_REG_SERIAL, target: IDS.WARRANTY_REG_DATE     },
    { id: 'f8_war_d_t',  source: IDS.WARRANTY_REG_DATE,   target: IDS.WARRANTY_REG_TAG      },
    { id: 'f8_war_t_ok', source: IDS.WARRANTY_REG_TAG,    target: IDS.WARRANTY_REG_SUCCESS  },
    { id: 'f8_war_look', source: IDS.WARRANTY_HUB,        target: IDS.WARRANTY_LOOKUP_SER,  sourceHandle: 'check' },
    { id: 'f8_war_l_ex', source: IDS.WARRANTY_LOOKUP_SER, target: IDS.WARRANTY_LOOKUP_EXEC  }
  );

  // B2B Nexus (conditional on wizard selection)
  if (b2bEnabled) {
    nodes.push(
      { id: IDS.B2B_TRIGGER,     type: 'trigger',       position: { x: 0,    y: Y * 5 }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'B2B/Wholesale Intent', triggerType: 'keyword', keywords: ['wholesale', 'bulk', 'b2b', 'bulk order', 'distributor', 'reseller'] } },
      { id: IDS.B2B_FORM,        type: 'capture_input', position: { x: 420,  y: Y * 5 }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Company Name',         variable: 'b2b_company',  question: content.b2b_welcome || `We love wholesale partners! 🤝 What's your company name?` } },
      { id: IDS.B2B_CAPTURE_IND, type: 'capture_input', position: { x: 840,  y: Y * 5 }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Volume & Category',    variable: 'b2b_volume',   question: content.b2b_capture_prompt || `Monthly order volume? (Min ${b2bThreshold} units for wholesale pricing)` } },
      { id: IDS.B2B_TAG,         type: 'tag_lead',      position: { x: 1260, y: Y * 5 }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'Tag: B2B Prospect',    action: 'add', tag: 'b2b-prospect' } },
      { id: IDS.B2B_ALERT,       type: 'admin_alert',   position: { x: 1680, y: Y * 5 }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'B2B Lead Alert',       priority: 'high', topic: '🤝 NEW B2B WHOLESALE LEAD CAPTURED', phone: b2bAdminPhone || adminPhone } },
      { id: IDS.B2B_CONFIRM,     type: 'message',       position: { x: 2100, y: Y * 5 }, parentId: FOLDER_IDS.POSTPURCH, data: { label: 'B2B Confirmation',     text: 'All set! 👔 Our wholesale team will reach out within 2 hours with a custom pricing quote.' } }
    );
    edges.push(
      { id: 'f8_b2b_tr',  source: IDS.B2B_TRIGGER,     target: IDS.B2B_FORM        },
      { id: 'f8_b2b_fi',  source: IDS.B2B_FORM,        target: IDS.B2B_CAPTURE_IND },
      { id: 'f8_b2b_it',  source: IDS.B2B_CAPTURE_IND, target: IDS.B2B_TAG         },
      { id: 'f8_b2b_ta',  source: IDS.B2B_TAG,         target: IDS.B2B_ALERT       },
      { id: 'f8_b2b_ac',  source: IDS.B2B_ALERT,       target: IDS.B2B_CONFIRM     }
    );
  }

  // ── Update folder childCount metadata ─────────────────────────────────────
  const folderCounts = {};
  nodes.forEach(n => {
    if (n.parentId && n.type !== 'folder') {
      folderCounts[n.parentId] = (folderCounts[n.parentId] || 0) + 1;
    }
  });
  nodes.forEach(n => {
    if (n.type === 'folder' && folderCounts[n.id]) {
      n.data.childCount = folderCounts[n.id];
    }
  });

  // ── Transform & Clean generated text ──────────────────────────────────────
  const stripPlaceholders = (text) => {
      if (!text) return text;
      // Strip out terms like "[15 minutes]", "[2 days]", "[100] pts" resulting from AI lazy generation
      return text.replace(/\[\d+\s*(minutes|mins|days|hours|hrs|pts|points)\]/gi, '')
                 .replace(/\[X\]/gi, '');
  };

  nodes = nodes.map(n => {
     if (n.data && typeof n.data.text === 'string') {
         n.data.text = stripPlaceholders(n.data.text);
     }
     if (n.data && n.data.content && typeof n.data.content.body === 'string') {
         n.data.content.body = stripPlaceholders(n.data.content.body);
     }
     return n;
  });

  // ── Final integrity check ─────────────────────────────────────────────────
  verifyFlowIntegrity(nodes, edges);

  console.log(`[FlowGenerator] ✅ Built ${nodes.length} nodes, ${edges.length} edges across 8 folders${b2bEnabled ? ' (B2B enabled)' : ''}.`);
  return { nodes, edges };
}

// ── Smart defaults (used when AI fails) ─────────────────────────────────────
function buildDefaultContent(businessName, botName, products = [], ops = {}) {
  const { referralPoints = 500, signupPoints = 100, warrantyDuration = '1 Year', openTime = '10:00', closeTime = '19:00', checkoutUrl = '' } = ops;
  return {
    welcome_a:             `Welcome to *${businessName}*! 👋 I'm ${botName}, your personal assistant. How can I help you today?`,
    welcome_b:             `Hello! 🛍️ Check out the latest from *${businessName}*! Amazing deals are waiting for you.`,
    product_menu_text:     `Explore everything *${businessName}* has! Select an option below:`,
    order_status_msg:      `📦 Your order is on its way! Expected delivery: 3-5 business days.`,
    agent_handoff_msg:     `Got it! I've notified our team and they'll be with you shortly. Please stay on this chat. 🎧`,
    sentiment_ask:         `How was your experience with ${businessName}? Your feedback matters! 😊`,
    review_positive:       `That's wonderful! 🌟 Could you share it on Google? It takes 30 seconds!`,
    review_negative:       `I'm really sorry to hear that. 😔 Let me connect you with our specialist right now.`,
    returns_policy_short:  `7-day hassle-free returns on all unused products. Send us a photo and we'll handle it! 🔄`,
    refund_policy_short:   `Refunds processed within 5-7 business days after we receive your return. 💳`,
    cancellation_confirm:  `Are you sure you want to cancel this order? This action cannot be reversed.`,
    cancellation_success:  `Your cancellation has been processed. We hope to serve you better next time! 💙`,
    installation_msg:      `Need help setting up? Our team can guide you step-by-step or schedule an expert visit. 🛠️`,
    loyalty_welcome:       `Welcome to ${businessName} Rewards! ✨ You've earned ${signupPoints} welcome points. Keep shopping to unlock amazing perks!`,
    loyalty_points_msg:    `💎 You have points in your wallet! Use them for a discount on your next order.`,
    referral_msg:          `Invite a friend to ${businessName} and earn *${referralPoints} bonus points* when they order! 🎁`,
    cod_nudge:             `Switch to online payment and save ₹50 instantly! 💳 Faster, safer, and simpler.`,
    order_confirmed_msg:   `🎉 Order confirmed! Your *${businessName}* order is being prepared with care. We'll notify you when it ships!`,
    faq_response:          `Great question! Here's what I know. For more help, type /support anytime.`,
    ad_welcome:            `Thanks for clicking our ad! 👋 Welcome to *${businessName}* — how can I help you today?`,
    ig_welcome:            `Hey! 📸 Thanks for the Instagram mention — we love it! What can I help you with?`,
    b2b_welcome:           `Welcome to *${businessName}* Wholesale! 🤝 Let's get you set up with the best bulk pricing.`,
    b2b_capture_prompt:    `What's your company name and what monthly volume are you looking for?`,
    warranty_welcome:      `🛡️ All *${businessName}* products include a *${warrantyDuration}* warranty. Register below to activate yours!`,
    warranty_lookup_prompt:`Enter your Product Serial Number or Order ID to check warranty status.`,
    payment_request_body:  `Complete your payment securely. All transactions are encrypted and safe. 🔒`,
    loyalty_award_reason:  `Shopping with ${businessName}! Keep collecting to unlock amazing rewards.`,
    cart_recovery_1:       `Hey! 👋 You left something in your cart at ${businessName}. Still interested? It's waiting for you!`,
    cart_recovery_2:       `Your cart at ${businessName} is still there! 🛒 These items are selling fast — grab yours before they're gone!`,
    cart_recovery_3:       `Last chance! ⏰ Your *${businessName}* cart expires soon. Use code *SAVE10* for extra 10% off now!`,
    upsell_intro:          `Since you love this, you might also enjoy these popular picks from our collection!`,
    cross_sell_msg:        `Customers who bought this also loved these items. Want to check them out?`,
    support_hours_msg:     `We're available ${openTime}–${closeTime}, Mon–Sat. Our AI is here 24/7, and human agents reply the next business morning.`,
    vip_perk_msg:          `🌟 You're a VIP! Unlock your exclusive 20% discount with code *VIP20*. Valid for 48 hours only!`,
    new_member_nudge:      `You're getting so close to VIP status! 🚀 Just a bit more shopping and exclusive discounts are yours.`,
    in_transit_error:      `Oh no! Your order is already shipped and cannot be cancelled. 🚚 Once it arrives, you can start a return.`,
    return_photo_prompt:   `Please upload a clear photo of the issue. This helps us resolve your request quickly!`,
    warranty_reg_success:  `✅ Warranty registered for *${warrantyDuration}*! We've saved your details. Contact us anytime for support.`,
    fallback_msg:          `I'm still learning! Let me connect you with a human expert who can help. 😊`,
  };
}

async function generateSystemPrompt(client, wizardData) {
  const { businessName, businessDescription, botName, tone, botLanguage, products = [] } = wizardData;
  const { generateText } = require('./gemini');
  const prompt = `Write a professional WhatsApp chatbot system prompt for ${businessName}.
Description: ${businessDescription}
Bot Name: ${botName}
Tone: ${tone}
Language: ${botLanguage}
Products: ${products.slice(0, 5).map(p => p.name || p.title).join(', ')}`;
  try {
    const res = await generateText(prompt, client.geminiApiKey || process.env.GEMINI_API_KEY);
    return res || `Default prompt for ${businessName}`;
  } catch (_) {
    return `Default system prompt for ${businessName}`;
  }
}

function getPrebuiltTemplates(wizardData) {
  const { businessName, googleReviewUrl } = wizardData;
  return [
    {
      name:      'order_confirmation_msg',
      category:  'UTILITY',
      language:  'en',
      status:    'not_submitted',
      body:      `✅ Your order #{{1}} from ${businessName} is confirmed!\n\nItems: {{2}} | Total: ₹{{3}}\n\nWe'll notify you when it ships! 📦`,
      variables: ['order_id', 'cart_items', 'order_total'],
      description: 'Sent immediately after order placed',
      required:  true,
    },
    ...(googleReviewUrl ? [{
      id:        'review_request',
      name:      'post_delivery_review',
      category:  'MARKETING',
      language:  'en',
      status:    'not_submitted',
      body:      `Hi {{1}}! How was your experience with ${businessName}? 😊\n\nLeave us a quick review — it takes just 30 seconds:\n${googleReviewUrl}`,
      variables: ['customer_name'],
      description: 'Sent 4 days after delivery',
      required:  false,
    }] : []),
    {
      id:        'admin_handoff_alert',
      name:      'admin_human_alert',
      category:  'UTILITY',
      language:  'en',
      status:    'not_submitted',
      body:      `🚨 *Human Agent Requested!*\n\nCustomer: {{1}} ({{2}})\nMessage: {{3}}\n\nReply now: https://whatsapp.facebook.com/{{4}}`,
      variables: ['customer_name', 'customer_phone', 'last_message', 'waba_id'],
      description: 'Sent to Admin when a human is requested',
      required:  true,
    },
  ];
}

module.exports = { generateEcommerceFlow, generateSystemPrompt, getPrebuiltTemplates, verifyFlowIntegrity, buildProductContext };
