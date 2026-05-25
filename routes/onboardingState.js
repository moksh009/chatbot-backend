'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');

const STEPS = ['welcome', 'profile', 'integrations', 'flow', 'launch', 'done'];

function defaultOnboarding(client) {
  return {
    completedAt: client.onboardingCompletedAt || null,
    currentStep: client.onboardingCompleted ? 'done' : 'welcome',
    completedSteps: client.onboardingCompleted ? STEPS : [],
    metadata: {
      brandName: client.businessName || '',
      industry: client.industry || '',
      primaryGoal: client.primaryGoal || '',
      languages: client.languages || ['en'],
      channelsConnected: {
        whatsapp: false,
        instagram: false,
        shopify: false,
      },
      flowGenerated: !!client.wizardCompleted,
      firstCampaignSent: false,
    },
  };
}

router.get('/state', protect, async (req, res) => {
  const client = await Client.findOne({ clientId: req.user.clientId }).lean();
  if (!client) return res.status(404).json({ success: false });
  const onboarding = client.onboarding || defaultOnboarding(client);
  return res.json({
    success: true,
    onboarding,
    onboardingCompleted: !!client.onboardingCompleted,
  });
});

router.post('/advance', protect, async (req, res) => {
  const { step, data = {} } = req.body;
  if (!STEPS.includes(step)) {
    return res.status(400).json({ success: false, message: 'invalid_step' });
  }
  const client = await Client.findOne({ clientId: req.user.clientId });
  if (!client) return res.status(404).json({ success: false });
  const ob = client.onboarding || defaultOnboarding(client);
  ob.currentStep = step;
  if (!ob.completedSteps.includes(step)) ob.completedSteps.push(step);
  ob.metadata = { ...ob.metadata, ...data };
  client.onboarding = ob;
  client.markModified('onboarding');
  await client.save();
  return res.json({ success: true, onboarding: ob });
});

router.post('/complete', protect, async (req, res) => {
  const client = await Client.findOne({ clientId: req.user.clientId });
  if (!client) return res.status(404).json({ success: false });
  const ob = client.onboarding || defaultOnboarding(client);
  ob.currentStep = 'done';
  ob.completedAt = new Date();
  if (!ob.completedSteps.includes('done')) ob.completedSteps.push('done');
  client.onboarding = ob;
  client.onboardingCompleted = true;
  client.onboardingCompletedAt = ob.completedAt;
  client.markModified('onboarding');
  await client.save();
  return res.json({ success: true, onboardingCompleted: true });
});

module.exports = router;
