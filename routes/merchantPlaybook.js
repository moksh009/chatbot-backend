'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const { buildMerchantPlaybookStatus } = require('../utils/hub/merchantPlaybookStatus');

function assertClientAccess(req, res) {
  const { clientId } = req.params;
  if (req.user?.clientId && req.user.clientId !== clientId && req.user?.role !== 'super-admin') {
    res.status(403).json({ success: false, message: 'Forbidden' });
    return false;
  }
  return true;
}

router.get('/:clientId/status', protect, async (req, res) => {
  try {
    if (!assertClientAccess(req, res)) return;
    const data = await buildMerchantPlaybookStatus(req.params.clientId);
    if (!data) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[MerchantPlaybook] status:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/:clientId/checklist', protect, async (req, res) => {
  try {
    if (!assertClientAccess(req, res)) return;
    const { clientId } = req.params;
    const { stepId, action } = req.body || {};

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const ob = client.onboarding && typeof client.onboarding === 'object' ? { ...client.onboarding } : {};
    const checklist = ob.checklist && typeof ob.checklist === 'object' ? { ...ob.checklist } : {};
    checklist.manualDone = checklist.manualDone && typeof checklist.manualDone === 'object' ? { ...checklist.manualDone } : {};
    checklist.skipped = Array.isArray(checklist.skipped) ? [...checklist.skipped] : [];

    if (action === 'hide') {
      checklist.hidden = true;
      checklist.hiddenAt = new Date();
    } else if (action === 'unhide') {
      checklist.hidden = false;
      checklist.hiddenAt = null;
    } else if (action === 'mark_done' && stepId) {
      checklist.manualDone[stepId] = true;
      const idx = checklist.skipped.indexOf(stepId);
      if (idx >= 0) checklist.skipped.splice(idx, 1);
    } else if (action === 'skip' && stepId) {
      if (!checklist.skipped.includes(stepId)) checklist.skipped.push(stepId);
      delete checklist.manualDone[stepId];
    } else if (action === 'unskip' && stepId) {
      checklist.skipped = checklist.skipped.filter((id) => id !== stepId);
    } else {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    ob.checklist = checklist;
    client.onboarding = ob;
    client.markModified('onboarding');
    await client.save();

    const data = await buildMerchantPlaybookStatus(clientId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[MerchantPlaybook] patch:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
