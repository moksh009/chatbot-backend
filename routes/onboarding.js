const express = require('express');
const router = express.Router({ mergeParams: true });
const OnboardingWizard = require('../models/OnboardingWizard');
const Client = require('../models/Client');
const log = require('../utils/logger')('OnboardingRoutes');
const { protect } = require('../middleware/auth');
const { mapFeatureToggle } = require('../utils/wizardMapper');
const { syncPersonaAcrossSystem } = require('../utils/personaEngine');

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
    const wizardDoc = await OnboardingWizard.findOne({ clientId });
    
    if (!wizardDoc) {
      return res.status(404).json({ success: true, wizard: null });
    }

    repairLegacyWizardBuckets(wizardDoc);
    migrateWizardSchema(wizardDoc);

    if (wizardDoc.isModified && wizardDoc.isModified()) {
      await wizardDoc.save();
    }

    let wizard = wizardDoc.toObject ? wizardDoc.toObject() : wizardDoc;
    if (typeof wizard.currentStep === 'number' && wizard.currentStep > 6) {
      wizard = { ...wizard, currentStep: 6 };
    }
    if (Array.isArray(wizard.completedSteps)) {
      wizard = {
        ...wizard,
        completedSteps: [...new Set(wizard.completedSteps.filter((s) => s >= 0 && s <= 6))],
      };
    }

    res.json({ success: true, wizard });
  } catch (error) {
    log.error(`Error fetching wizard state for ${req.params.clientId}`, error);
    res.status(500).json({ success: false, error: 'Failed to fetch wizard state' });
  }
});

// Save step data
router.patch('/step/:stepNumber', protect, async (req, res) => {
  try {
    const { clientId } = req.body;
    const { stepNumber } = req.params;
    const { stepData } = req.body;
    
    if (!clientId) {
      return res.status(400).json({ success: false, error: 'clientId is required in body' });
    }

    const stepNum = parseInt(stepNumber, 10);
    if (isNaN(stepNum) || stepNum < 0 || stepNum > 6) {
      return res.status(400).json({ success: false, error: 'Invalid step number' });
    }

    const stepId = OnboardingWizard.STEP_IDS[stepNum];

    let wizard = await OnboardingWizard.findOne({ clientId });
    
    if (!wizard) {
      wizard = new OnboardingWizard({ clientId, status: 'in_progress' });
    }

    repairLegacyWizardBuckets(wizard);
    migrateWizardSchema(wizard);

    const prevStepBlob =
      wizard.stepData &&
      wizard.stepData[stepId] &&
      typeof wizard.stepData[stepId] === 'object' &&
      !Array.isArray(wizard.stepData[stepId])
        ? { ...wizard.stepData[stepId].toObject?.() || wizard.stepData[stepId] }
        : {};

    wizard.stepData[stepId] = stepData;
    wizard.currentStep = stepNum;
    
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
    if (stepId === 'business' && stepData) {
      if (stepData.businessName)        { pvUpdate.businessName = stepData.businessName; pvUpdate['platformVars.brandName'] = stepData.businessName; }
      if (stepData.industry)            pvUpdate.industry = stepData.industry;
      if (stepData.supportPhone) {
        pvUpdate['platformVars.supportWhatsapp'] = stepData.supportPhone;
        pvUpdate.supportPhone = stepData.supportPhone;
      }
      if (stepData.googleReviewUrl && String(stepData.googleReviewUrl).trim()) {
        pvUpdate.googleReviewUrl = String(stepData.googleReviewUrl).trim();
        pvUpdate['platformVars.googleReviewUrl'] = String(stepData.googleReviewUrl).trim();
      }
      if (stepData.botName !== undefined && wizardStepFieldChanged(prevStepBlob, stepData, 'botName')) {
        queuePersona({ name: stepData.botName });
      }
      if (wizardStepFieldChanged(prevStepBlob, stepData, 'businessDescription') && stepData.businessDescription) {
        queuePersona({ description: stepData.businessDescription });
      }
      if (stepData.botLanguage && wizardStepFieldChanged(prevStepBlob, stepData, 'botLanguage')) {
        queuePersona({ language: stepData.botLanguage });
      }
      if (stepData.tone && wizardStepFieldChanged(prevStepBlob, stepData, 'tone')) {
        queuePersona({ tone: stepData.tone });
      }
      if (stepData.adminPhone)          { pvUpdate['platformVars.adminWhatsappNumber'] = stepData.adminPhone; pvUpdate.adminPhone = stepData.adminPhone; }
      if (stepData.currency)            pvUpdate['platformVars.baseCurrency'] = stepData.currency;
      if (stepData.shippingTime)        pvUpdate['platformVars.shippingTime'] = stepData.shippingTime;
      if (stepData.websiteUrl)          pvUpdate.websiteUrl = stepData.websiteUrl;
      if (stepData.activePersona && wizardStepFieldChanged(prevStepBlob, stepData, 'activePersona')) {
        queuePersona({ role: stepData.activePersona });
      }
    }

    // intelligence (tone / language / keys / prompt live on shared flat `data`)
    if (stepId === 'ai' && stepData) {
      if (stepData.faqUrl && String(stepData.faqUrl).trim()) {
        pvUpdate.faqUrl = String(stepData.faqUrl).trim();
      }
      if (stepData.aiKnowledgeBase && String(stepData.aiKnowledgeBase).trim()) {
        pvUpdate['ai.persona.knowledgeBase'] = String(stepData.aiKnowledgeBase).trim().slice(0, 5000);
      }
      const nextName = stepData.botName || stepData.activePersona;
      const prevName = prevStepBlob.botName || prevStepBlob.activePersona;
      if (nextName !== undefined && String(nextName ?? '') !== String(prevName ?? '')) {
        queuePersona({ name: nextName });
      }
      if (stepData.tone && wizardStepFieldChanged(prevStepBlob, stepData, 'tone')) {
        queuePersona({ tone: stepData.tone });
      }
      if (stepData.botLanguage && wizardStepFieldChanged(prevStepBlob, stepData, 'botLanguage')) {
        queuePersona({ language: stepData.botLanguage });
      }
      if (stepData.systemPrompt !== undefined) {
        const nextSp = String(stepData.systemPrompt || '').trim();
        const prevSp = String(prevStepBlob.systemPrompt || '').trim();
        if (nextSp !== prevSp && nextSp) {
          personaSystemPrompt = nextSp;
        }
      }
      if (stepData.geminiApiKey) { pvUpdate.geminiApiKey = stepData.geminiApiKey; pvUpdate['ai.geminiKey'] = stepData.geminiApiKey; }
      if (stepData.openaiApiKey) { pvUpdate.openaiApiKey = stepData.openaiApiKey; }
    }

    if (stepData?.faqs && Array.isArray(stepData.faqs)) {
      const faqDocs = stepData.faqs
        .filter(f => f.question?.trim() && f.answer?.trim())
        .map((f, i) => ({ question: f.question.trim(), answer: f.answer.trim(), order: i }));
      if (faqDocs.length > 0) pvUpdate.faq = faqDocs;
    }

    if (stepData?.is247 !== undefined)   pvUpdate['config.businessHours.is247'] = stepData.is247;
    if (stepData?.openTime)              pvUpdate['config.businessHours.openTime'] = stepData.openTime;
    if (stepData?.closeTime)             pvUpdate['config.businessHours.closeTime'] = stepData.closeTime;
    if (stepData?.workingDays?.length)  pvUpdate['config.businessHours.workingDays'] = stepData.workingDays;

    const syncCartTimingToFeatures = (t) => {
      if (!t) return;
      pvUpdate['wizardFeatures.cartNudgeMinutes1'] = Number(t.msg1 ?? 15) || 15;
      pvUpdate['wizardFeatures.cartNudgeHours2'] = Number(t.msg2 ?? 2) || 2;
      pvUpdate['wizardFeatures.cartNudgeHours3'] = Number(t.msg3 ?? 24) || 24;
    };
    if (stepId === 'cart_timing' && stepData?.cartTiming) {
      syncCartTimingToFeatures(stepData.cartTiming);
    }
    if (stepId === 'features' && stepData?.cartTiming) {
      syncCartTimingToFeatures(stepData.cartTiming);
    }

    if (stepId === 'escalation' && stepData) {
      if (stepData.adminPhone) {
        pvUpdate['platformVars.adminWhatsappNumber'] = stepData.adminPhone;
        pvUpdate.adminPhone = stepData.adminPhone;
        pvUpdate.adminAlertWhatsapp = stepData.adminPhone;
      }
      if (stepData.adminEmail && String(stepData.adminEmail).trim()) {
        const em = String(stepData.adminEmail).trim();
        pvUpdate.adminEmail = em;
        pvUpdate.adminAlertEmail = em;
      }
      if (['whatsapp', 'email', 'both'].includes(stepData.adminAlertPreferences)) {
        pvUpdate.adminAlertPreferences = stepData.adminAlertPreferences;
      }
    }

    if (stepData?.features && typeof stepData.features === 'object') {
      Object.assign(pvUpdate, mapFeatureToggle(stepData.features));
    }

    if (stepId === 'architecture' && stepData) {
      if (stepData.activePaymentGateway)  pvUpdate.activePaymentGateway = stepData.activePaymentGateway;
      if (stepData.razorpayKeyId)         pvUpdate.razorpayKeyId = stepData.razorpayKeyId;
      if (stepData.razorpaySecret)        pvUpdate.razorpaySecret = stepData.razorpaySecret;
      if (stepData.cashfreeAppId)         pvUpdate.cashfreeAppId = stepData.cashfreeAppId;
      if (stepData.cashfreeSecretKey)     pvUpdate.cashfreeSecretKey = stepData.cashfreeSecretKey;
    }

    if (Object.keys(pvUpdate).length > 0) {
      await Client.updateOne({ clientId }, { $set: pvUpdate });
    }

    if (personaSync && Object.keys(personaSync).length > 0) {
      await syncPersonaAcrossSystem(clientId, personaSync, {
        systemPrompt: personaSystemPrompt,
      });
    } else if (personaSystemPrompt !== undefined) {
      await syncPersonaAcrossSystem(clientId, {}, { systemPrompt: personaSystemPrompt });
    }

    res.json({ success: true, wizard });
  } catch (error) {
    log.error(`Error saving wizard step ${req.params.stepNumber}`, error);
    res.status(500).json({ success: false, error: 'Failed to save wizard step' });
  }
});

// Reset wizard (admin)
router.delete('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    await OnboardingWizard.deleteOne({ clientId });
    res.json({ success: true, message: 'Wizard state reset successfully' });
  } catch (error) {
    log.error(`Error resetting wizard state for ${req.params.clientId}`, error);
    res.status(500).json({ success: false, error: 'Failed to reset wizard state' });
  }
});

module.exports = router;
