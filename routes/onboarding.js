const express = require('express');
const router = express.Router({ mergeParams: true });
const OnboardingWizard = require('../models/OnboardingWizard');
const Client = require('../models/Client');
const log = require('../utils/logger')('OnboardingRoutes');
const { protect } = require('../middleware/auth');
const { mapFeatureToggle } = require('../utils/wizardMapper');
const { syncPersonaAcrossSystem } = require('../utils/personaEngine');

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

// Fetch wizard state
router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const wizardDoc = await OnboardingWizard.findOne({ clientId });
    
    if (!wizardDoc) {
      return res.status(404).json({ success: true, wizard: null });
    }

    repairLegacyWizardBuckets(wizardDoc);

    // One-time migration: v1 had 7 steps; v2 inserts `escalation` at index 2 — shift indices ≥2.
    if (wizardDoc.wizardSchemaVersion == null || wizardDoc.wizardSchemaVersion < 2) {
      if (typeof wizardDoc.currentStep === 'number' && wizardDoc.currentStep >= 2) {
        wizardDoc.currentStep = Math.min(7, wizardDoc.currentStep + 1);
      }
      if (Array.isArray(wizardDoc.completedSteps)) {
        wizardDoc.completedSteps = [...new Set(
          wizardDoc.completedSteps
            .filter((s) => typeof s === 'number' && s >= 0 && s <= 6)
            .map((s) => (s >= 2 ? Math.min(7, s + 1) : s))
        )];
      }
      wizardDoc.wizardSchemaVersion = 2;
      wizardDoc.markModified('currentStep');
      wizardDoc.markModified('completedSteps');
      wizardDoc.markModified('wizardSchemaVersion');
    }

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
    if (isNaN(stepNum) || stepNum < 0 || stepNum > 7) {
      return res.status(400).json({ success: false, error: 'Invalid step number' });
    }

    const stepId = OnboardingWizard.STEP_IDS[stepNum];

    let wizard = await OnboardingWizard.findOne({ clientId });
    
    if (!wizard) {
      wizard = new OnboardingWizard({ clientId, status: 'in_progress' });
    }

    repairLegacyWizardBuckets(wizard);

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

    // business
    if (stepId === 'business' && stepData) {
      if (stepData.businessName)        { pvUpdate.businessName = stepData.businessName; pvUpdate['platformVars.brandName'] = stepData.businessName; }
      if (stepData.botName)             queuePersona({ name: stepData.botName });
      if (stepData.businessDescription) queuePersona({ description: stepData.businessDescription });
      if (stepData.botLanguage)         queuePersona({ language: stepData.botLanguage });
      if (stepData.tone)                queuePersona({ tone: stepData.tone });
      if (stepData.adminPhone)          { pvUpdate['platformVars.adminWhatsappNumber'] = stepData.adminPhone; pvUpdate.adminPhone = stepData.adminPhone; }
      if (stepData.currency)            pvUpdate['platformVars.baseCurrency'] = stepData.currency;
      if (stepData.shippingTime)        pvUpdate['platformVars.shippingTime'] = stepData.shippingTime;
      if (stepData.websiteUrl)          pvUpdate.websiteUrl = stepData.websiteUrl;
      if (stepData.activePersona)       queuePersona({ role: stepData.activePersona });
    }

    // intelligence (tone / language / keys / prompt live on shared flat `data`)
    if (stepId === 'ai' && stepData) {
      if (stepData.botName || stepData.activePersona) {
        queuePersona({ name: stepData.botName || stepData.activePersona });
      }
      if (stepData.tone) queuePersona({ tone: stepData.tone });
      if (stepData.botLanguage) queuePersona({ language: stepData.botLanguage });
      if (stepData.systemPrompt && String(stepData.systemPrompt).trim()) {
        personaSystemPrompt = String(stepData.systemPrompt).trim();
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

    if (stepId === 'cart_timing' && stepData?.cartTiming) {
      const t = stepData.cartTiming;
      pvUpdate['wizardFeatures.cartNudgeMinutes1'] = Number(t.msg1 ?? 15) || 15;
      pvUpdate['wizardFeatures.cartNudgeHours2'] = Number(t.msg2 ?? 2) || 2;
      pvUpdate['wizardFeatures.cartNudgeHours3'] = Number(t.msg3 ?? 24) || 24;
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

    if (stepId === 'features' && stepData?.features && typeof stepData.features === 'object') {
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
