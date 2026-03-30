const express = require('express');
const router = express.Router();
const Segment = require('../models/Segment');
const AdLead = require('../models/AdLead');
const { protect } = require('../middleware/auth');

router.post('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { name, conditions, logic } = req.body;
    
    const segment = new Segment({
      clientId,
      name,
      conditions,
      logic: logic || 'AND'
    });

    await segment.save();
    res.json({ success: true, segment });
  } catch (error) {
    console.error('Segment creation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const segments = await Segment.find({ clientId: (clientId === 'delitech_smarthomes' || clientId === 'code_clinic_v1') ? { $in: ['delitech_smarthomes', 'code_clinic_v1'] } : clientId }).sort({ createdAt: -1 });
    res.json({ success: true, segments });
  } catch (error) {
    console.error('Segment fetch error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:clientId/:segmentId/leads', protect, async (req, res) => {
  try {
    const { clientId, segmentId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const segment = await Segment.findOne({ _id: segmentId, clientId });
    if (!segment) return res.status(404).json({ success: false, message: 'Segment not found' });

    // --- PHASE 10 FIX: Shared Query for Delitech/CodeClinic ---
    const sharedPool = ['delitech_smarthomes', 'code_clinic_v1'];
    const effectiveClientId = sharedPool.includes(clientId) ? { $in: sharedPool } : clientId;
    
    // Build Mongo Query
    const orCondition = [];
    const andCondition = [{ clientId: effectiveClientId }]; // Base requirement

    segment.conditions.forEach(cond => {
        let q = {};
        if (cond.operator === 'gte') q[cond.field] = { $gte: cond.value };
        else if (cond.operator === 'lte') q[cond.field] = { $lte: cond.value };
        else if (cond.operator === 'eq') q[cond.field] = cond.value;
        else if (cond.operator === 'in') q[cond.field] = { $in: Array.isArray(cond.value) ? cond.value : [cond.value] };
        else if (cond.operator === 'exists') q[cond.field] = { $exists: cond.value };

        if (segment.logic === 'OR') orCondition.push(q);
        else andCondition.push(q);
    });

    let finalQuery = {};
    if (segment.logic === 'AND') finalQuery = { $and: andCondition };
    else finalQuery = { $and: [{ clientId: effectiveClientId }], $or: orCondition.length > 0 ? orCondition : [{}] };

    const leads = await AdLead.find(finalQuery).sort({ createdAt: -1 });
    res.json({ success: true, count: leads.length, leads });
  } catch (error) {
    console.error('Segment leads execution error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});


router.delete('/:clientId/:segmentId', protect, async (req, res) => {
  try {
    const { clientId, segmentId } = req.params;
    const sharedPool = ['delitech_smarthomes', 'code_clinic_v1'];
    const isAuthorized = req.user.role === 'SUPER_ADMIN' || 
                        req.user.clientId === clientId || 
                        (sharedPool.includes(req.user.clientId) && sharedPool.includes(clientId));

    if (!isAuthorized) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const segment = await Segment.findOneAndDelete({ 
      _id: segmentId, 
      clientId: sharedPool.includes(clientId) ? { $in: sharedPool } : clientId 
    });
    if (!segment) {
      return res.status(404).json({ success: false, message: 'Segment not found' });
    }

    res.json({ success: true, message: 'Segment deleted successfully' });
  } catch (error) {
    console.error('Segment deletion error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;

