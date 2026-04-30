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
    
    // Also update Client platformVars on first save (step 0 - business setup)
    if (stepNum === 0 && stepData) {
      const pvUpdate = {};
      if (stepData.businessName)        pvUpdate['platformVars.brandName'] = stepData.businessName;
      if (stepData.botName)             pvUpdate['platformVars.agentName'] = stepData.botName;
      if (stepData.businessDescription) pvUpdate['platformVars.businessDescription'] = stepData.businessDescription;
      if (stepData.botLanguage)         pvUpdate['platformVars.defaultLanguage'] = stepData.botLanguage;
      if (stepData.tone)                pvUpdate['platformVars.defaultTone'] = stepData.tone;
      if (stepData.adminPhone)          pvUpdate['platformVars.adminWhatsappNumber'] = stepData.adminPhone;
      if (stepData.currency)            pvUpdate['platformVars.baseCurrency'] = stepData.currency;
      if (stepData.shippingTime)        pvUpdate['platformVars.shippingTime'] = stepData.shippingTime;
      // Also sync to legacy flat fields for backward compat
      if (stepData.businessName)        pvUpdate['businessName'] = stepData.businessName;
      if (stepData.adminPhone)          pvUpdate['adminPhone'] = stepData.adminPhone;

      if (Object.keys(pvUpdate).length > 0) {
        await Client.updateOne({ clientId }, { $set: pvUpdate });
      }
    }

    // Persist FAQ data when Step 4 (operations) is saved
    if (stepNum === 4 && stepData?.faqs && Array.isArray(stepData.faqs)) {
      const faqDocs = stepData.faqs
        .filter(f => f.question?.trim() && f.answer?.trim())
        .map((f, i) => ({ question: f.question.trim(), answer: f.answer.trim(), order: i }));
      await Client.updateOne({ clientId }, { $set: { faq: faqDocs } });
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
