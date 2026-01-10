const express = require('express');
const router = express.Router();
const Appointment = require('../models/Appointment');
const { protect } = require('../middleware/auth');

// @route   GET /api/appointments
// @desc    Get all appointments (with optional filtering)
// @access  Private
router.get('/', protect, async (req, res) => {
  const { startDate, endDate, phone } = req.query;
  const query = { clientId: req.user.clientId };

  if (startDate && endDate) {
    // This assumes date stored as ISO or comparable string, but current model uses "Tuesday, 23 Jul" string format
    // which is hard to query by range directly in Mongo without parsing.
    // Ideally, we should store a proper Date object in the model.
    // For now, we'll return all and let frontend filter if format is strictly string.
    // However, AppointmentSchema has createdAt. We can filter by createdAt or try to parse 'date' field if needed.
    // Let's assume for this iteration we filter by createdAt or just return list.
  }
  
  if (phone) {
      query.phone = { $regex: phone, $options: 'i' };
  }

  try {
    const appointments = await Appointment.find(query).sort({ createdAt: -1 });
    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// @route   DELETE /api/appointments/:id
// @desc    Cancel appointment (Logic to delete from Google Calendar should be here too ideally)
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!appointment) return res.status(404).json({ message: 'Not found' });

    // TODO: Add Google Calendar deletion logic here using existing utils
    
    await appointment.deleteOne();
    res.json({ message: 'Appointment removed' });
  } catch (error) {
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
