const express = require('express');
const router = express.Router({ mergeParams: true });
const OnboardingWizard = require('../models/OnboardingWizard');
const Client = require('../models/Client');
const log = require('../utils/logger')('OnboardingRoutes');
const { protect } = require('../middleware/auth');

// Fetch wizard state
router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    let wizard = await OnboardingWizard.findOne({ clientId }).lean();
    
    if (!wizard) {
      return res.status(404).json({ success: true, wizard: null });
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

    const stepNum = parseInt(stepNumber);
    if (isNaN(stepNum) || stepNum < 0 || stepNum > 11) {
      return res.status(400).json({ success: false, error: 'Invalid step number' });
    }

    const stepId = OnboardingWizard.STEP_IDS[stepNum];

    let wizard = await OnboardingWizard.findOne({ clientId });
    
    if (!wizard) {
      wizard = new OnboardingWizard({ clientId, status: 'in_progress' });
    }

    wizard.stepData[stepId] = stepData;
    wizard.currentStep = stepNum;
    
    if (!wizard.completedSteps.includes(stepNum)) {
      wizard.completedSteps.push(stepNum);
    }
    
    wizard.markModified('stepData');
    await wizard.save();
    
    // ─── Canonical Sync: Wizard → Client Document ───────────────────────
    // Ensures wizard data is ALWAYS written through to the canonical paths
    // that the AI engine, bot, and dashboard pages actually read from.
    const pvUpdate = {};

    // Step 0 — Business Setup: sync to platformVars + ai.persona
    if (stepNum === 0 && stepData) {
      if (stepData.businessName)        { pvUpdate['platformVars.brandName'] = stepData.businessName; pvUpdate['businessName'] = stepData.businessName; }
      if (stepData.botName)             { pvUpdate['platformVars.agentName'] = stepData.botName; pvUpdate['ai.persona.name'] = stepData.botName; }
      if (stepData.businessDescription) { pvUpdate['platformVars.businessDescription'] = stepData.businessDescription; pvUpdate['ai.persona.description'] = stepData.businessDescription; }
      if (stepData.botLanguage)         { pvUpdate['platformVars.defaultLanguage'] = stepData.botLanguage; pvUpdate['ai.persona.language'] = stepData.botLanguage; }
      if (stepData.tone)                { pvUpdate['platformVars.defaultTone'] = stepData.tone; pvUpdate['ai.persona.tone'] = stepData.tone; }
      if (stepData.adminPhone)          { pvUpdate['platformVars.adminWhatsappNumber'] = stepData.adminPhone; pvUpdate['adminPhone'] = stepData.adminPhone; }
      if (stepData.currency)            pvUpdate['platformVars.baseCurrency'] = stepData.currency;
      if (stepData.shippingTime)        pvUpdate['platformVars.shippingTime'] = stepData.shippingTime;
      if (stepData.websiteUrl)          pvUpdate['websiteUrl'] = stepData.websiteUrl;
    }

    // Step 7 — AI Persona: sync persona fields to canonical ai.persona path
    if (stepNum === 7 && stepData) {
      if (stepData.botName || stepData.activePersona) pvUpdate['ai.persona.name'] = stepData.botName || stepData.activePersona;
      if (stepData.tone)          pvUpdate['ai.persona.tone'] = stepData.tone;
      if (stepData.botLanguage)   pvUpdate['ai.persona.language'] = stepData.botLanguage;
      if (stepData.systemPrompt)  pvUpdate['ai.systemPrompt'] = stepData.systemPrompt;
      if (stepData.geminiApiKey)  pvUpdate['geminiApiKey'] = stepData.geminiApiKey;
      if (stepData.openaiApiKey)  pvUpdate['openaiApiKey'] = stepData.openaiApiKey;
    }

    // Step 4 — Operations: persist FAQ to canonical faq path
    if (stepNum === 4 && stepData?.faqs && Array.isArray(stepData.faqs)) {
      const faqDocs = stepData.faqs
        .filter(f => f.question?.trim() && f.answer?.trim())
        .map((f, i) => ({ question: f.question.trim(), answer: f.answer.trim(), order: i }));
      pvUpdate['faq'] = faqDocs;
    }

    // Step 5 — Business Hours: sync to canonical config path
    if (stepData?.is247 !== undefined)   pvUpdate['config.businessHours.is247'] = stepData.is247;
    if (stepData?.openTime)              pvUpdate['config.businessHours.openTime'] = stepData.openTime;
    if (stepData?.closeTime)             pvUpdate['config.businessHours.closeTime'] = stepData.closeTime;
    if (stepData?.workingDays?.length)    pvUpdate['config.businessHours.workingDays'] = stepData.workingDays;

    // Step 6 — Payment: sync gateway config
    if (stepData?.activePaymentGateway)  pvUpdate['activePaymentGateway'] = stepData.activePaymentGateway;
    if (stepData?.razorpayKeyId)         pvUpdate['razorpayKeyId'] = stepData.razorpayKeyId;
    if (stepData?.razorpaySecret)        pvUpdate['razorpaySecret'] = stepData.razorpaySecret;
    if (stepData?.cashfreeAppId)         pvUpdate['cashfreeAppId'] = stepData.cashfreeAppId;
    if (stepData?.cashfreeSecretKey)     pvUpdate['cashfreeSecretKey'] = stepData.cashfreeSecretKey;

    // Flush all accumulated updates in a single DB write
    if (Object.keys(pvUpdate).length > 0) {
      await Client.updateOne({ clientId }, { $set: pvUpdate });
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
