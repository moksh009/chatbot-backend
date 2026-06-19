/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ONBOARDING V2 — Full-Screen New-User Onboarding Backend
 * ─────────────────────────────────────────────────────────────────────────────
 * Mounted at /api/onboarding (alongside legacy endpoints — distinct paths).
 *
 * Endpoints:
 *   POST  /analyze              — scrape website + AI-infer brand profile
 *   PATCH /progress             — persist current step + merge data
 *   POST  /flow/generate        — generate first flow from collected wizard data
 *   PATCH /complete             — mark linear onboarding done; leave wizardCompleted false for AI wizard in Flow Builder
 *   POST  /track                — append analytics event (server-side log)
 *
 * Contract:
 *   - All routes require auth (protect middleware).
 *   - req.user.clientId is the canonical tenant — never trust clientId from body.
 *   - Hard timeouts: scrape = 8s, flow gen = 15s. Always return a success-path
 *     payload even on failure so the frontend can proceed gracefully.
 */

"use strict";

const express = require("express");
const router = express.Router();
const axios = require("axios");
const cheerio = require("cheerio");
const Client = require("../models/Client");
const User = require("../models/User");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { protect } = require("../middleware/auth");
const { platformGenerateJSON } = require('../utils/core/gemini');
const { generateEcommerceFlow, generateSystemPrompt } =
  require('../utils/flow/flowGenerator');
const { mapWizardToClient, pullPersonaBundleFromSet } = require('../utils/flow/wizardMapper');
const { emitToClient } = require('../utils/core/socket');
const { syncPersonaAcrossSystem } = require('../utils/core/personaEngine');
const { clearTriggerCache } = require('../utils/flow/triggerEngine');
const log = require('../utils/core/logger')("OnboardingV2");
const {
  activationPackFromGoals,
  filterActivationPackForPlan,
  wizardFeatureUpdatesToMongoSet,
} = require('../utils/onboarding/activationPackFromGoals');
const {
  resolveSubscriptionForClient,
  hasPaidEntitlements,
  isTrialWindowActive,
} = require('../utils/core/accessFlags');
const { resolveStoreCategorySlug } = require('../constants/storeCategories');

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function normalizeUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch (_) {
    return "";
  }
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function resolveAbsoluteUrl(href, base) {
  if (!href || typeof href !== "string") return "";
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("data:")) return "";
  try {
    return new URL(trimmed, base).toString();
  } catch (_) {
    return "";
  }
}

function isHexColor(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || "").trim());
}

function normalizeBrandColor(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (isHexColor(s)) return s;
  const rgb = s.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]]
      .map((n) => Number(n).toString(16).padStart(2, "0"))
      .join("");
    return `#${hex}`;
  }
  return "";
}

function pickBestLogo($, origin) {
  const iconLinks = [];
  $("link[rel]").each((_, el) => {
    const rel = String($(el).attr("rel") || "").toLowerCase();
    if (
      !rel.includes("icon") &&
      !rel.includes("apple-touch-icon") &&
      !rel.includes("mask-icon")
    ) {
      return;
    }
    const href = $(el).attr("href");
    if (!href) return;
    const sizes = String($(el).attr("sizes") || "");
    const type = String($(el).attr("type") || "").toLowerCase();
    let score = 10;
    if (rel.includes("apple-touch-icon")) score += 40;
    if (sizes.includes("192") || sizes.includes("180")) score += 25;
    if (type.includes("png") || type.includes("svg")) score += 10;
    if (/logo/i.test(href)) score += 15;
    iconLinks.push({ href, score });
  });
  iconLinks.sort((a, b) => b.score - a.score);

  const candidates = [
    $('meta[property="og:image:secure_url"]').attr("content"),
    $('meta[property="og:image"]').attr("content"),
    $('meta[name="twitter:image"]').attr("content"),
    ...iconLinks.map((x) => x.href),
    "/favicon.ico",
  ].filter(Boolean);

  for (const raw of candidates) {
    const abs = resolveAbsoluteUrl(raw, origin);
    if (abs) return abs;
  }

  try {
    const host = new URL(origin).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  } catch (_) {
    return "";
  }
}

function cleanSiteTitle(title) {
  if (!title) return "";
  return String(title)
    .replace(/\s*[|\-–—]\s*.+$/, "")
    .trim()
    .slice(0, 80);
}

async function scrapeWebsite(url) {
  const origin = normalizeUrl(url);
  if (!origin) return null;

  try {
    const resp = await axios.get(origin, {
      timeout: 6000,
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (TopEdgeAI Onboarding Bot) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const $ = cheerio.load(resp.data || "");
    const title = $("title").first().text().trim() || "";
    const ogTitle =
      $('meta[property="og:title"]').attr("content") ||
      $('meta[name="twitter:title"]').attr("content") ||
      "";
    const siteName =
      $('meta[property="og:site_name"]').attr("content") ||
      cleanSiteTitle(ogTitle || title) ||
      "";
    const metaDesc =
      $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") ||
      "";
    const themeColor =
      normalizeBrandColor($('meta[name="theme-color"]').attr("content")) ||
      normalizeBrandColor(
        $('meta[name="msapplication-TileColor"]').attr("content")
      ) ||
      "";
    const htmlLang = $("html").attr("lang") || "";
    const logoUrl = pickBestLogo($, origin);

    // Body text — strip scripts/styles, take first ~800 chars
    $("script, style, noscript").remove();
    const bodyText = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800);

    return {
      title,
      siteName,
      metaDesc,
      logoUrl,
      themeColor,
      language: htmlLang,
      bodyText,
      origin,
    };
  } catch (err) {
    log.warn(`Scrape failed for ${origin}: ${err.message}`);
    return null;
  }
}

async function inferBrandProfileWithAI(scraped, fallbackIndustry) {
  if (!scraped || !scraped.bodyText) return null;

  const prompt = `You are a brand analyst. Based on the following website content, extract:
1. primary product category (short phrase)
2. brand tone — one of: friendly, professional, playful, authoritative, casual
3. up to 3 key selling points (short phrases)
4. detected language (ISO code or plain name, e.g. "en", "English")

Website title: ${scraped.title}
Meta description: ${scraped.metaDesc}
Body text (truncated): ${scraped.bodyText}

Respond strictly as JSON matching this schema:
{ "productCategory": "...", "brandTone": "...", "keySellingPoints": ["..."], "detectedLanguage": "..." }`;

  try {
    const result = await platformGenerateJSON(prompt, { maxTokens: 400 });
    if (!result) return null;
    return {
      productCategory: String(result.productCategory || "").slice(0, 80),
      brandTone: String(result.brandTone || "").toLowerCase().slice(0, 30),
      keySellingPoints: Array.isArray(result.keySellingPoints)
        ? result.keySellingPoints.slice(0, 3).map((s) => String(s).slice(0, 120))
        : [],
      detectedLanguage:
        String(result.detectedLanguage || scraped.language || "").slice(0, 30),
    };
  } catch (err) {
    log.warn(`AI brand-infer failed: ${err.message}`);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/analyze
// ───────────────────────────────────────────────────────────────────────────
router.post("/analyze", protect, async (req, res) => {
  const { websiteUrl, brandName, industry, ecommerceCategories } = req.body || {};
  const clientId = req.user.clientId;
  const categories = Array.isArray(ecommerceCategories)
    ? ecommerceCategories.filter((x) => typeof x === "string" && x.trim())
    : [];
  const industryHint =
    categories.length > 0 ? categories.join(", ") : String(industry || "").trim();

  const defaultsPayload = {
    success: true,
    scraped: false,
    brandColor: "#7c3aed",
    logoUrl: "",
    siteName: String(brandName || "").trim(),
    tagline: "",
    brandTone: "professional",
    productCategory: industryHint || "general",
    keySellingPoints: [],
    detectedLanguage: "English",
  };

  if (!websiteUrl) {
    // Persist the brand name + industry even if we can't scrape
    if (clientId && brandName) {
      await Client.updateOne(
        { clientId },
        {
          $set: {
            "onboardingData.brandName": String(brandName).trim(),
            "onboardingData.industry": industryHint || "",
            "onboardingData.ecommerceCategories": categories,
          },
        }
      ).catch(() => {});
    }
    return res.json({ ...defaultsPayload, message: "No website URL provided" });
  }

  try {
    // HARD TIMEOUT: 8 seconds for the entire scrape+AI pipeline
    const scraped = await withTimeout(scrapeWebsite(websiteUrl), 6500, null);

    let aiResult = null;
    if (scraped) {
      aiResult = await withTimeout(
        inferBrandProfileWithAI(scraped, industryHint),
        7500,
        null
      );
    }

    const resolvedBrandName =
      String(brandName || "").trim() ||
      String(scraped?.siteName || "").trim() ||
      cleanSiteTitle(scraped?.title || "") ||
      "";
    const brandColor =
      normalizeBrandColor(scraped?.themeColor) || "#7c3aed";
    const logoUrl = scraped?.logoUrl || "";
    const tagline = String(scraped?.metaDesc || "").trim().slice(0, 240);

    const brandProfile = {
      brandColor,
      logoUrl,
      siteName: String(scraped?.siteName || resolvedBrandName || "").trim(),
      tagline,
      brandTone: aiResult?.brandTone || "professional",
      productCategory:
        aiResult?.productCategory || industryHint || "general",
      keySellingPoints: aiResult?.keySellingPoints || [],
      detectedLanguage:
        aiResult?.detectedLanguage || scraped?.language || "English",
      scraped: !!scraped,
    };

    // Phase 1.2 — Resolve canonical store-category slug from signup + AI inputs.
    // Priority: user-selected (n/a here) > signup multiselect > AI brandProfile > industry text.
    const resolvedStoreCategory = resolveStoreCategorySlug({
      ecommerceCategories: categories,
      aiProductCategory: brandProfile.productCategory,
      industryLabel: industryHint,
    });

    // Persist into client.onboardingData.brandProfile + workspace brand fields
    await Client.updateOne(
      { clientId },
      {
        $set: {
          "onboardingData.brandName": resolvedBrandName,
          "onboardingData.websiteUrl": String(websiteUrl || "").trim(),
          "onboardingData.industry": industryHint || "",
          "onboardingData.ecommerceCategories": categories,
          "onboardingData.brandProfile": brandProfile,
          "onboardingData.storeCategory": resolvedStoreCategory,
          "onboardingData.storeCategorySource": "ai",
          // Mirror to canonical paths so Settings, theme, and generators see them immediately
          ...(resolvedBrandName
            ? {
                "platformVars.brandName": resolvedBrandName,
                businessName: resolvedBrandName,
              }
            : {}),
          ...(logoUrl ? { businessLogo: logoUrl } : {}),
          ...(tagline ? { businessDescription: tagline } : {}),
          // Industry display string stays on onboardingData ONLY (root `industry` is an orphan write).
          ...(brandColor ? { "brand.primaryColor": brandColor } : {}),
          ...(brandProfile.brandTone
            ? { "platformVars.defaultTone": brandProfile.brandTone }
            : {}),
        },
      }
    );

    return res.json({
      success: true,
      scraped: !!scraped,
      ...brandProfile,
      storeCategory: resolvedStoreCategory,
    });
  } catch (err) {
    log.error(`analyze error: ${err.message}`);
    return res.json({ ...defaultsPayload, message: "Analysis unavailable" });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /api/onboarding/progress
// Body: { step: Number (0..6), data: Object }
// Merges data into client.onboardingData and updates onboardingStep
// ───────────────────────────────────────────────────────────────────────────
router.patch("/progress", protect, async (req, res) => {
  const clientId = req.user.clientId;
  const { step, data } = req.body || {};

  const stepNum = Number(step);
  if (!Number.isFinite(stepNum) || stepNum < 0 || stepNum > 7) {
    return res.status(400).json({ success: false, error: "Invalid step" });
  }

  try {
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ success: false, error: "Client not found" });
    }

    // Never reduce step unless this is an explicit reset from the frontend
    const newStep = Math.max(client.onboardingStep || 0, stepNum);

    const $set = { onboardingStep: newStep };

    if (!client.onboardingStartedAt) {
      $set.onboardingStartedAt = new Date();
    }

    // Whitelist what we merge into onboardingData (prevent clients writing arbitrary keys)
    if (data && typeof data === "object") {
      const allowed = [
        "goals",
        "brandName",
        "websiteUrl",
        "industry",
        "ecommerceCategories",
        "storeCategory",
        "storeCategorySource",
        "conversationVolume",
        "brandProfile",
        "whatsappSkipped",
        "brandVoice",
        "primaryGoal",
        "fallbackBehavior",
        "generatedFlowId",
        "generatedFlowName",
        "stepTimings",
      ];
      for (const key of allowed) {
        if (data[key] !== undefined) {
          $set[`onboardingData.${key}`] = data[key];
        }
      }
      // Mirror common brand fields to canonical paths for downstream systems
      if (data.brandName) {
        $set.businessName = String(data.brandName).trim();
        $set["platformVars.brandName"] = String(data.brandName).trim();
      }
      if (data.websiteUrl) {
        $set["onboardingData.websiteUrl"] = String(data.websiteUrl).trim();
      }
      if (data.brandProfile && typeof data.brandProfile === "object") {
        $set["onboardingData.brandProfile"] = data.brandProfile;
        const bp = data.brandProfile;
        if (bp.logoUrl) $set.businessLogo = String(bp.logoUrl).trim();
        if (bp.tagline) $set.businessDescription = String(bp.tagline).trim().slice(0, 500);
        if (bp.brandColor && normalizeBrandColor(bp.brandColor)) {
          $set["brand.primaryColor"] = normalizeBrandColor(bp.brandColor);
        }
        // Industry display string stays on onboardingData ONLY (root `industry` is an orphan write).
        if (bp.productCategory) $set["onboardingData.industry"] = String(bp.productCategory).trim();
      }
    }

    await Client.updateOne({ clientId }, { $set });

    res.json({ success: true, step: newStep });
  } catch (err) {
    log.error(`progress error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/flow/generate
// Body: all collected wizardData (goals, brandName, persona, etc.)
// Generates a flow + WhatsAppFlow doc, returns a simplified preview payload.
//
// **Deprecated 2026-06-18 (Phase 4.3 of FLOW-WIZARD plan)** — no UI calls this
// route. Production traffic should go through `POST /api/wizard/:clientId/complete`
// instead, which uses the Commerce wizard pack and the canonical mapper.
//
// Returns 410 Gone by default to surface accidental callers; set
// `ENABLE_LEGACY_ONBOARDING_FLOW_GENERATE=true` to re-enable.
// ───────────────────────────────────────────────────────────────────────────
router.post("/flow/generate", protect, async (req, res) => {
  if (process.env.ENABLE_LEGACY_ONBOARDING_FLOW_GENERATE !== "true") {
    return res.status(410).json({
      success: false,
      deprecated: true,
      error: "deprecated_route",
      message:
        "POST /api/onboarding/flow/generate is deprecated. Use POST /api/wizard/:clientId/complete from the Commerce Flow Wizard.",
      replacement: "/api/wizard/:clientId/complete",
    });
  }

  const clientId = req.user.clientId;
  const wizardData = req.body || {};

  try {
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ success: false, error: "Client not found" });
    }

    // ── Map persona / features from wizard inputs into the flow generator inputs ──
    // Map our simple 3-question persona into the mapper-friendly shape
    const voiceToToneMap = {
      friendly_warm: "friendly",
      professional_direct: "professional",
      playful_fun: "fun",
      expert_authoritative: "direct",
    };
    const primaryGoalToFeaturesMap = {
      recover_carts: { enableAbandonedCart: true, enableCatalog: true },
      answer_questions: { enableFAQ: true, enableAIFallback: true },
      qualify_leads: { enableCatalog: true, enableFAQ: true },
      process_orders: { enableOrderTracking: true, enableOrderConfirmTpl: true },
    };

    const tone = voiceToToneMap[wizardData.brandVoice] || "friendly";
    const extraFeatures = primaryGoalToFeaturesMap[wizardData.primaryGoal] || {};

    const goalsToFeatures = (wizardData.goals || []).reduce((acc, g) => {
      if (g === "abandoned_cart") acc.enableAbandonedCart = true;
      if (g === "order_status") acc.enableOrderTracking = true;
      if (g === "support_bot") acc.enableSupportEscalation = true;
      if (g === "lead_qualify") acc.enableCatalog = true;
      if (g === "campaign_broadcasts") acc.enableMetaAdsTrigger = false; // broadcast outside flow
      if (g === "post_purchase") acc.enableOrderConfirmTpl = true;
      if (g === "coupons") acc.enableCodToPrepaid = true;
      return acc;
    }, {});

    const brandName =
      wizardData.brandName || client.businessName || client.name || "Your Brand";

    const generatorInput = {
      businessName: brandName,
      botName:
        String(
         wizardData.agentName ||
          wizardData.brandName ||
          client.ai?.persona?.name ||
          client.platformVars?.agentName ||
          ""
        ).trim() || brandName,
      tone,
      botLanguage:
        wizardData.botLanguage ||
        client.ai?.persona?.language ||
        client.platformVars?.defaultLanguage ||
        "English",
      replaceExisting: true,
      features: {
        ...(client.wizardFeatures || {}),
        ...extraFeatures,
        ...goalsToFeatures,
      },
      templates: [],
    };

    // HARD TIMEOUT: 15s
    const genPromise = generateEcommerceFlow(client, generatorInput);
    const { nodes, edges, automationFlows = [] } = await withTimeout(
      genPromise,
      15000,
      { nodes: [], edges: [], automationFlows: [], _timedOut: true }
    );

    if (!nodes || nodes.length === 0) {
      // Graceful fallback — frontend will still proceed, user lands in FlowBuilder empty
      log.warn(`Flow gen produced 0 nodes for ${clientId}`);
      return res.json({
        success: false,
        error: "flow_generation_empty",
        message:
          "We couldn't auto-build your flow. We'll take you to the Flow Builder.",
      });
    }

    const systemPrompt = await generateSystemPrompt(client, generatorInput).catch(
      () => ""
    );

    const flowId = `flow_onboard_${Date.now()}`;
    const flowName = `${generatorInput.businessName} — First Automation`;

    // Persist WhatsAppFlow doc (DRAFT status — user publishes from Screen 5)
    await WhatsAppFlow.create({
      clientId,
      flowId,
      name: flowName,
      platform: "whatsapp",
      status: "DRAFT",
      nodes,
      edges,
      description: "Auto-generated by new-user onboarding wizard",
    });

    // Commerce triggers are merged into the single flow graph (automationFlows is empty).
    clearTriggerCache(clientId);

    // Also push into visualFlows so FlowBuilder picks it up
    const newVisualFlow = {
      id: flowId,
      name: flowName,
      platform: "whatsapp",
      isActive: true,
      folderId: "",
      nodes: nodes.length > 20 ? [] : nodes,
      edges: nodes.length > 20 ? [] : edges,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      flowModelId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      generatedBy: "onboarding_v2",
    };

    // Sync persona + wizard data via the canonical mapper
    const mapped = mapWizardToClient(generatorInput, client, { systemPrompt });
    const $set = mapped.$set || {};
    const { persona: personaPatch, systemPrompt: personaSystemPrompt } =
      pullPersonaBundleFromSet($set);
    $set.flowNodes = nodes;
    $set.flowEdges = edges;
    $set["onboardingData.generatedFlowId"] = flowId;
    $set["onboardingData.generatedFlowName"] = flowName;

    // Replace any existing active visualFlow OR push new one
    const existingFlows = client.visualFlows || [];
    const activeIdx = existingFlows.findIndex(
      (f) => f.isActive && f.platform === "whatsapp"
    );
    let updateQuery;
    if (activeIdx !== -1) {
      existingFlows[activeIdx] = { ...existingFlows[activeIdx], ...newVisualFlow };
      updateQuery = { $set: { ...$set, visualFlows: existingFlows } };
    } else {
      updateQuery = { $set, $push: { visualFlows: newVisualFlow } };
    }

    await Client.findByIdAndUpdate(client._id, updateQuery, { new: true });

    await syncPersonaAcrossSystem(clientId, personaPatch, {
      systemPrompt: personaSystemPrompt,
    });

    // Emit socket so any open dashboard refreshes — but during onboarding
    // the frontend suppresses toast for this event.
    try {
      emitToClient(clientId, "wizard:flow-regenerated", {
        clientId,
        flowId,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        source: "onboarding_v2",
        generatedAt: new Date(),
      });
    } catch (_) {
      /* socket optional */
    }

    // Build a simplified preview for the UI (first 5 nodes, visible labels)
    const previewNodes = nodes.slice(0, 5).map((n) => ({
      id: n.id,
      type: n.type,
      label:
        (n.data &&
          (n.data.text ||
            n.data.body ||
            n.data.question ||
            n.data.content?.body ||
            n.data.label)) ||
        n.type,
    }));

    res.json({
      success: true,
      flowId,
      flowName,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      previewNodes,
    });
  } catch (err) {
    log.error(`flow/generate error: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message || "flow_generation_failed",
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /api/onboarding/complete
// Marks client onboarding shell complete so the user can enter the main app.
// wizardCompleted stays false so Flow Builder shows the full AI setup wizard next.
// and hasCompletedTour = true on the user (retires legacy tour).
// ───────────────────────────────────────────────────────────────────────────
router.patch("/complete", protect, async (req, res) => {
  const clientId = req.user.clientId;
  const userId = req.user.id || req.user._id;

  try {
    const now = new Date();
    const client = await Client.findOne({ clientId }).lean();
    if (!client) {
      return res.status(404).json({ success: false, error: "Client not found" });
    }

    const goals = Array.isArray(client.onboardingData?.goals)
      ? client.onboardingData.goals
      : [];
    let updatedWizardFeatures = null;
    let activationPlaybookSteps = [];
    let trialActivationScoped = false;
    let trialGoalActivation = false;

    try {
      const sub = await resolveSubscriptionForClient(client);
      const paid = hasPaidEntitlements(client, sub);
      trialGoalActivation = isTrialWindowActive(client, sub) && !paid;

      const rawPack = activationPackFromGoals(goals);
      const pack = filterActivationPackForPlan(rawPack, { client, subscription: sub });
      activationPlaybookSteps = pack.playbookSteps || [];
      const featureSet = wizardFeatureUpdatesToMongoSet(pack.wizardFeatureUpdates);
      trialActivationScoped = trialGoalActivation && Object.keys(pack.wizardFeatureUpdates || {}).length > 0;

      if (Object.keys(featureSet).length > 0) {
        await Client.updateOne({ clientId }, { $set: featureSet });
      }

      if (goals.includes('abandoned_cart')) {
        const { createCartRecoveryTemplateDrafts } = require('../utils/onboarding/createCartRecoveryTemplateDrafts');
        await createCartRecoveryTemplateDrafts(
          clientId,
          client.onboardingData?.brandProfile?.name || client.businessName
        ).catch((err) => log.warn(`Cart recovery drafts failed: ${err.message}`));
      }

      const refreshed = await Client.findOne({ clientId })
        .select("wizardFeatures")
        .lean();
      updatedWizardFeatures = refreshed?.wizardFeatures || null;
    } catch (packErr) {
      log.error(`activation pack failed for ${clientId}: ${packErr.message}`);
    }

    const completionSet = {
      onboardingCompleted: true,
      onboardingCompletedAt: now,
      onboardingStep: 5,
      onboardingSkipped: false,
      onboardingSkippedAt: null,
      wizardCompleted: false,
      wizardCompletedAt: null,
    };
    if (activationPlaybookSteps.length) {
      completionSet["onboardingData.activationPlaybookSteps"] = activationPlaybookSteps;
      completionSet["onboardingData.activationAppliedAt"] = now;
    }
    if (trialGoalActivation) {
      completionSet["onboardingData.trialGoalActivation"] = true;
    }

    await Promise.all([
      Client.updateOne({ clientId }, { $set: completionSet }),
      User.updateOne(
        { _id: userId },
        { $set: { hasCompletedTour: true, tourCompletedAt: now } }
      ),
    ]);

    res.json({
      success: true,
      onboardingCompleted: true,
      updatedWizardFeatures,
      activationPlaybookSteps,
      trialActivationScoped,
      trialGoalActivation,
    });
  } catch (err) {
    log.error(`complete error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /api/onboarding/defer — Setup Later / Skip (tracks intent, stays incomplete)
// ───────────────────────────────────────────────────────────────────────────
router.patch("/defer", protect, async (req, res) => {
  const clientId = req.user.clientId;
  try {
    const now = new Date();
    await Client.updateOne(
      { clientId },
      {
        $set: {
          onboardingSkipped: true,
          onboardingSkippedAt: now,
          onboardingCompleted: false,
        },
      }
    );
    res.json({ success: true, onboardingSkipped: true, onboardingSkippedAt: now });
  } catch (err) {
    log.error(`defer error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/track
// Body: { event: String, properties: Object }
// Lightweight server-side analytics sink. Writes to stdout log; wire to real
// analytics in your observability layer as needed.
// ───────────────────────────────────────────────────────────────────────────
router.post("/track", protect, async (req, res) => {
  const { event, properties } = req.body || {};
  if (!event) return res.status(400).json({ success: false });

  log.info(`[analytics] ${event}`, {
    clientId: req.user.clientId,
    userId: req.user.id || req.user._id,
    properties,
  });
  res.json({ success: true });
});

module.exports = router;
