const express = require('express');
const router = express.Router({ mergeParams: true });
const { STEP_IDS } = require('../constants/onboardingWizardSteps');
const {
  findWizard,
  findOrCreateWizard,
  deleteWizard,
  createMutableWizard,
} = require('../utils/onboarding/wizardState');
const Client = require('../models/Client');
const log = require('../utils/core/logger')('OnboardingRoutes');
const { protect } = require('../middleware/auth');
const { denyUnlessTenant } = require('../utils/core/queryHelpers');
const { mapFeatureToggle } = require('../utils/flow/wizardMapper');
const { syncPersonaAcrossSystem } = require('../utils/core/personaEngine');
const { sanitizeWizardStepData } = require('../utils/flow/wizardStepSanitize');

/** v2 (8 steps) → v3 (7 steps): features before products; cart_timing merged into features. */
const V2_TO_V3_INDEX = { 0: 0, 1: 1, 2: 4, 3: 3, 4: 5, 5: 2, 6: 2, 7: 6 };

function remapStepIndexToV3(idx) {
  if (typeof idx !== 'number' || idx < 0) return 0;
  if (idx > 7) return 6;
  return V2_TO_V3_INDEX[idx] ?? Math.min(6, idx);
}

function mergeCartTimingIntoFeatures(sd) {
  if (!sd?.cart_timing || typeof sd.cart_timing !== 'object') return false;
  if (!sd.features || typeof sd.features !== 'object') sd.features = {};
  const legacy = sd.cart_timing;
  if (legacy.cartTiming) {
    sd.features.cartTiming = { ...(sd.features.cartTiming || {}), ...legacy.cartTiming };
  }
  if (legacy.features && typeof legacy.features === 'object') {
    sd.features.features = { ...(sd.features.features || {}), ...legacy.features };
  }
  return true;
}

function migrateWizardSchema(wizard) {
  const sd = wizard.stepData || {};
  let touched = false;

  if (wizard.wizardSchemaVersion == null || wizard.wizardSchemaVersion < 2) {
    if (typeof wizard.currentStep === 'number' && wizard.currentStep >= 2) {
      wizard.currentStep = Math.min(7, wizard.currentStep + 1);
    }
    if (Array.isArray(wizard.completedSteps)) {
      wizard.completedSteps = [...new Set(
        wizard.completedSteps
          .filter((s) => typeof s === 'number' && s >= 0 && s <= 6)
          .map((s) => (s >= 2 ? Math.min(7, s + 1) : s))
      )];
    }
    wizard.wizardSchemaVersion = 2;
    touched = true;
  }

  if (wizard.wizardSchemaVersion < 3) {
    if (mergeCartTimingIntoFeatures(sd)) touched = true;
    if (typeof wizard.currentStep === 'number') {
      wizard.currentStep = remapStepIndexToV3(wizard.currentStep);
    }
    if (Array.isArray(wizard.completedSteps)) {
      wizard.completedSteps = [...new Set(
        wizard.completedSteps
          .filter((s) => typeof s === 'number' && s >= 0)
          .map((s) => remapStepIndexToV3(s))
          .filter((s) => s >= 0 && s <= 6)
      )];
    }
    wizard.wizardSchemaVersion = 3;
    touched = true;
  }

  if (wizard.wizardSchemaVersion < 4) {
    const bump = (n) => (typeof n === 'number' && n >= 5 ? Math.min(7, n + 1) : n);
    if (typeof wizard.currentStep === 'number') {
      wizard.currentStep = bump(wizard.currentStep);
    }
    if (Array.isArray(wizard.completedSteps)) {
      wizard.completedSteps = [...new Set(
        wizard.completedSteps
          .filter((s) => typeof s === 'number' && s >= 0)
          .map((s) => bump(s))
          .filter((s) => s >= 0 && s <= 7)
      )];
    }
    const idx = typeof wizard.currentStep === 'number' ? wizard.currentStep : 0;
    wizard.currentStepId = STEP_IDS[Math.min(7, Math.max(0, idx))] || 'business';
    wizard.wizardSchemaVersion = 4;
    touched = true;
  }

  if (!wizard.currentStepId || !STEP_IDS.includes(wizard.currentStepId)) {
    const idx = typeof wizard.currentStep === 'number' ? wizard.currentStep : 0;
    wizard.currentStepId = STEP_IDS[Math.min(7, Math.max(0, idx))] || 'business';
    touched = true;
  }

  if (touched) {
    wizard.stepData = sd;
    wizard.markModified('stepData');
    wizard.markModified('currentStep');
    wizard.markModified('completedSteps');
    wizard.markModified('wizardSchemaVersion');
  }
}

/** One-time shape repair for wizard docs saved before step-order fix. */
function repairLegacyWizardBuckets(wizard) {
  const sd = wizard.stepData || {};
  let touched = false;
  if (!sd.ai && sd.store) {
    sd.ai = sd.store;
    touched = true;
  }
  if (!sd.connections && sd.whatsapp) {
    sd.connections = sd.whatsapp;
    touched = true;
  }
  if (!sd.features && sd.operations) {
    sd.features = sd.operations;
    touched = true;
  }
  if (touched) {
    wizard.stepData = sd;
    wizard.markModified('stepData');
  }
}

/** True when a wizard field value changed vs last saved bucket (stops persona socket → dashboard full sync on every debounced PATCH). */
function wizardStepFieldChanged(prev, next, key) {
  const a = prev && typeof prev === 'object' ? prev[key] : undefined;
  const b = next && typeof next === 'object' ? next[key] : undefined;
  return String(a ?? '') !== String(b ?? '');
}

// Fetch wizard state
router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!denyUnlessTenant(req, res, clientId)) return;
    const existing = await findWizard(clientId);
    if (!existing) {
      return res.status(404).json({ success: true, wizard: null });
    }
    const wizardDoc = createMutableWizard(clientId, existing);

    repairLegacyWizardBuckets(wizardDoc);
    migrateWizardSchema(wizardDoc);

    if (wizardDoc.isModified && wizardDoc.isModified()) {
      await wizardDoc.save();
    }

    let wizard = wizardDoc.toObject ? wizardDoc.toObject() : wizardDoc;
    if (typeof wizard.currentStep === 'number' && wizard.currentStep > 7) {
      wizard = { ...wizard, currentStep: 7 };
    }
    if (Array.isArray(wizard.completedSteps)) {
      wizard = {
        ...wizard,
        completedSteps: [...new Set(wizard.completedSteps.filter((s) => s >= 0 && s <= 7))],
      };
    }
    if (!wizard.currentStepId) {
      const idx = typeof wizard.currentStep === 'number' ? wizard.currentStep : 0;
      wizard = {
        ...wizard,
        currentStepId: STEP_IDS[Math.min(7, Math.max(0, idx))] || 'business',
      };
    }

    res.json({ success: true, wizard });
  } catch (error) {
    log.error(`Error fetching wizard state for ${req.params.clientId}`, error);
    res.status(500).json({ success: false, error: 'Failed to fetch wizard state' });
  }
});

function resolveWizardStepKey(stepKey) {
  const ids = STEP_IDS;
  if (stepKey == null || stepKey === '') return null;

  const raw = String(stepKey).trim().toLowerCase();
  if (ids.includes(raw)) {
    return { stepId: raw, stepNum: ids.indexOf(raw) };
  }

  const stepNum = parseInt(raw, 10);
  if (!Number.isNaN(stepNum) && stepNum >= 0 && stepNum < ids.length) {
    return { stepId: ids[stepNum], stepNum };
  }
  return null;
}

// Save step data — :stepKey is step id (e.g. "templates") or legacy numeric index
router.patch('/step/:stepKey', protect, async (req, res) => {
  try {
    const { clientId } = req.body;
    const { stepKey } = req.params;
    const { stepData, stepId: bodyStepId } = req.body;
    
    if (!clientId) {
      return res.status(400).json({ success: false, error: 'clientId is required in body' });
    }
    if (!denyUnlessTenant(req, res, clientId)) return;

    const resolved = resolveWizardStepKey(bodyStepId || stepKey);
    if (!resolved) {
      return res.status(400).json({
        success: false,
        error: 'Invalid step id or number',
        message: 'Invalid step id or number',
        allowedStepIds: STEP_IDS,
      });
    }
    const { stepId, stepNum } = resolved;

    let wizard = await findOrCreateWizard(clientId);

    repairLegacyWizardBuckets(wizard);
    migrateWizardSchema(wizard);

    const safeStepData = sanitizeWizardStepData(stepId, stepData);

    const prevStepBlob =
      wizard.stepData &&
      wizard.stepData[stepId] &&
      typeof wizard.stepData[stepId] === 'object' &&
      !Array.isArray(wizard.stepData[stepId])
        ? { ...wizard.stepData[stepId].toObject?.() || wizard.stepData[stepId] }
        : {};

    wizard.stepData[stepId] = safeStepData;
    wizard.currentStep = stepNum;
    wizard.currentStepId = stepId;
    
    if (!wizard.completedSteps.includes(stepNum)) {
      wizard.completedSteps.push(stepNum);
    }
    
    wizard.markModified('stepData');
    await wizard.save();
    
    // ─── Canonical Sync: Wizard → Client (Mongo paths the dashboard + engine read) ─
    const pvUpdate = {};
    let personaSync = null;
    let personaSystemPrompt = undefined;

    const queuePersona = (partial) => {
      if (!partial || typeof partial !== 'object') return;
      personaSync = { ...(personaSync || {}), ...partial };
    };

    // business — persona socket only when persona-facing fields actually change
    if (stepId === 'business' && safeStepData) {
      if (safeStepData.businessName)        { pvUpdate.businessName = safeStepData.businessName; pvUpdate['platformVars.brandName'] = safeStepData.businessName; }
      if (safeStepData.industry)            pvUpdate.industry = safeStepData.industry;
      if (safeStepData.supportPhone) {
        pvUpdate['platformVars.supportWhatsapp'] = safeStepData.supportPhone;
        pvUpdate.supportPhone = safeStepData.supportPhone;
      }
      if (safeStepData.googleReviewUrl && String(safeStepData.googleReviewUrl).trim()) {
        pvUpdate.googleReviewUrl = String(safeStepData.googleReviewUrl).trim();
        pvUpdate['platformVars.googleReviewUrl'] = String(safeStepData.googleReviewUrl).trim();
      }
      if (safeStepData.botName !== undefined && wizardStepFieldChanged(prevStepBlob, safeStepData, 'botName')) {
        queuePersona({ name: safeStepData.botName });
      }
      if (wizardStepFieldChanged(prevStepBlob, safeStepData, 'businessDescription') && safeStepData.businessDescription) {
        queuePersona({ description: safeStepData.businessDescription });
      }
      if (safeStepData.botLanguage && wizardStepFieldChanged(prevStepBlob, safeStepData, 'botLanguage')) {
        queuePersona({ language: safeStepData.botLanguage });
      }
      if (safeStepData.tone && wizardStepFieldChanged(prevStepBlob, safeStepData, 'tone')) {
        queuePersona({ tone: safeStepData.tone });
      }
      if (safeStepData.adminPhone)          { pvUpdate['platformVars.adminWhatsappNumber'] = safeStepData.adminPhone; pvUpdate.adminPhone = safeStepData.adminPhone; }
      if (safeStepData.currency)            pvUpdate['platformVars.baseCurrency'] = safeStepData.currency;
      if (safeStepData.shippingTime)        pvUpdate['platformVars.shippingTime'] = safeStepData.shippingTime;
      if (safeStepData.websiteUrl)          pvUpdate.websiteUrl = safeStepData.websiteUrl;
      if (safeStepData.activePersona && wizardStepFieldChanged(prevStepBlob, safeStepData, 'activePersona')) {
        queuePersona({ role: safeStepData.activePersona });
      }
    }

    // intelligence (tone / language / keys / prompt live on shared flat `data`)
    if (stepId === 'ai' && safeStepData) {
      if (safeStepData.faqUrl && String(safeStepData.faqUrl).trim()) {
        pvUpdate.faqUrl = String(safeStepData.faqUrl).trim();
      }
      const kbRaw =
        safeStepData.aiKnowledgeBase || safeStepData.faqText || safeStepData.knowledgeBase;
      if (kbRaw && String(kbRaw).trim()) {
        const kb = String(kbRaw).trim().slice(0, 5000);
        pvUpdate['ai.persona.knowledgeBase'] = kb;
      }
      if (safeStepData.activePersona && wizardStepFieldChanged(prevStepBlob, safeStepData, 'activePersona')) {
        queuePersona({ role: safeStepData.activePersona });
      }
      if (safeStepData.formality && wizardStepFieldChanged(prevStepBlob, safeStepData, 'formality')) {
        queuePersona({ formality: safeStepData.formality });
      }
      if (safeStepData.emojiLevel && wizardStepFieldChanged(prevStepBlob, safeStepData, 'emojiLevel')) {
        queuePersona({ emojiLevel: safeStepData.emojiLevel });
      }
      if (safeStepData.botName && wizardStepFieldChanged(prevStepBlob, safeStepData, 'botName')) {
        queuePersona({ name: safeStepData.botName });
      }
      if (safeStepData.tone && wizardStepFieldChanged(prevStepBlob, safeStepData, 'tone')) {
        queuePersona({ tone: safeStepData.tone });
      }
      if (safeStepData.botLanguage && wizardStepFieldChanged(prevStepBlob, safeStepData, 'botLanguage')) {
        queuePersona({ language: safeStepData.botLanguage });
      }
      if (safeStepData.systemPrompt !== undefined) {
        const nextSp = String(safeStepData.systemPrompt || '').trim();
        const prevSp = String(prevStepBlob.systemPrompt || '').trim();
        if (nextSp !== prevSp && nextSp) {
          personaSystemPrompt = nextSp;
        }
      }
      if (safeStepData.geminiApiKey) {
        pvUpdate.geminiApiKey = safeStepData.geminiApiKey;
        pvUpdate['ai.geminiKey'] = safeStepData.geminiApiKey;
      }
      if (safeStepData.openaiApiKey) {
        pvUpdate.openaiApiKey = safeStepData.openaiApiKey;
        pvUpdate['ai.openaiKey'] = safeStepData.openaiApiKey;
      }
    }

    if (safeStepData?.faqs && Array.isArray(safeStepData.faqs)) {
      const faqDocs = safeStepData.faqs
        .filter(f => f.question?.trim() && f.answer?.trim())
        .map((f, i) => ({ question: f.question.trim(), answer: f.answer.trim(), order: i }));
      if (faqDocs.length > 0) pvUpdate.faq = faqDocs;
    }

    if (safeStepData?.is247 !== undefined)   pvUpdate['config.businessHours.is247'] = safeStepData.is247;
    if (safeStepData?.openTime)              pvUpdate['config.businessHours.openTime'] = safeStepData.openTime;
    if (safeStepData?.closeTime)             pvUpdate['config.businessHours.closeTime'] = safeStepData.closeTime;
    if (safeStepData?.workingDays?.length)  pvUpdate['config.businessHours.workingDays'] = safeStepData.workingDays;

    const syncCartTimingToFeatures = (t) => {
      if (!t) return;
      pvUpdate['wizardFeatures.cartNudgeMinutes1'] = Number(t.msg1 ?? 15) || 15;
      pvUpdate['wizardFeatures.cartNudgeHours2'] = Number(t.msg2 ?? 2) || 2;
      pvUpdate['wizardFeatures.cartNudgeHours3'] = Number(t.msg3 ?? 24) || 24;
    };
    if (stepId === 'cart_timing' && safeStepData?.cartTiming) {
      syncCartTimingToFeatures(safeStepData.cartTiming);
    }
    if (stepId === 'features' && safeStepData?.cartTiming) {
      syncCartTimingToFeatures(safeStepData.cartTiming);
    }

    if (stepId === 'escalation' && safeStepData) {
      if (safeStepData.adminPhone) {
        pvUpdate['platformVars.adminWhatsappNumber'] = safeStepData.adminPhone;
        pvUpdate.adminPhone = safeStepData.adminPhone;
        pvUpdate.adminAlertWhatsapp = safeStepData.adminPhone;
      }
      if (safeStepData.adminEmail && String(safeStepData.adminEmail).trim()) {
        const em = String(safeStepData.adminEmail).trim();
        pvUpdate.adminEmail = em;
        pvUpdate.adminAlertEmail = em;
      }
      if (['whatsapp', 'email', 'both'].includes(safeStepData.adminAlertPreferences)) {
        pvUpdate.adminAlertPreferences = safeStepData.adminAlertPreferences;
      }
    }

    if (stepId === 'features' && safeStepData?.features && typeof safeStepData.features === 'object') {
      Object.assign(pvUpdate, mapFeatureToggle(safeStepData.features));
    }

    if (stepId === 'architecture' && safeStepData) {
      if (safeStepData.activePaymentGateway)  pvUpdate.activePaymentGateway = safeStepData.activePaymentGateway;
      if (safeStepData.razorpayKeyId)         pvUpdate.razorpayKeyId = safeStepData.razorpayKeyId;
      if (safeStepData.razorpaySecret)        pvUpdate.razorpaySecret = safeStepData.razorpaySecret;
      if (safeStepData.cashfreeAppId)         pvUpdate.cashfreeAppId = safeStepData.cashfreeAppId;
      if (safeStepData.cashfreeSecretKey)     pvUpdate.cashfreeSecretKey = safeStepData.cashfreeSecretKey;
    }

    if (Object.keys(pvUpdate).length > 0) {
      try {
        await Client.updateOne({ clientId }, { $set: pvUpdate });
      } catch (syncErr) {
        log.error(`Client sync failed for wizard step ${stepId} (${clientId})`, syncErr);
      }
    }

    try {
      if (personaSync && Object.keys(personaSync).length > 0) {
        await syncPersonaAcrossSystem(clientId, personaSync, {
          systemPrompt: personaSystemPrompt,
        });
      } else if (personaSystemPrompt !== undefined) {
        await syncPersonaAcrossSystem(clientId, {}, { systemPrompt: personaSystemPrompt });
      }
    } catch (personaErr) {
      log.error(`Persona sync failed for wizard step ${stepId} (${clientId})`, personaErr);
    }

    res.json({ success: true, wizard });
  } catch (error) {
    log.error(`Error saving wizard step ${req.params.stepKey}`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to save wizard step',
      message: error.message || 'Failed to save wizard step',
    });
  }
});

// Reset wizard (admin)
router.delete('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (!denyUnlessTenant(req, res, clientId)) return;
    await deleteWizard(clientId);
    res.json({ success: true, message: 'Wizard state reset successfully' });
  } catch (error) {
    log.error(`Error resetting wizard state for ${req.params.clientId}`, error);
    res.status(500).json({ success: false, error: 'Failed to reset wizard state' });
  }
});

module.exports = router;
