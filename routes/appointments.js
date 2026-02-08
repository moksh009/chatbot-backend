const express = require('express');
const router = express.Router();
const Appointment = require('../models/Appointment');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { listEvents, createEvent, updateEvent, deleteEvent } = require('../utils/googleCalendar');

// Helper to format date/time for legacy schema
const formatDateTime = (isoDateString) => {
  const dateObj = new Date(isoDateString);
  const date = dateObj.toLocaleDateString('en-GB', { 
    weekday: 'long', 
    day: '2-digit', 
    month: 'short',
    timeZone: 'Africa/Nairobi'
  }); // "Tuesday, 23 Jul"
  const time = dateObj.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit', 
    hour12: true,
    timeZone: 'Africa/Nairobi'
  }); // "11:00 AM"
  return { date, time };
};

// @route   GET /api/appointments
// @desc    Get all appointments (DB only)
// @access  Private
router.get('/', protect, async (req, res) => {
  const { startDate, endDate, phone } = req.query;
  const query = { clientId: req.user.clientId };

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

// @route   GET /api/appointments/calendar
// @desc    Get merged calendar events (Google + DB)
// @access  Private
router.get('/calendar', protect, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ message: 'Start and end dates required' });
    }

    const client = await Client.findOne({ clientId: req.user.clientId });
    const calendarId = client.googleCalendarId || 'primary';

    // 1. Fetch Google Calendar Events
    let googleEvents = [];
    try {
      googleEvents = await listEvents(start, end, calendarId);
    } catch (err) {
      console.error('Google Calendar listEvents failed:', err.message);
      // Fallback: return empty list, or handle gracefully
    }

    // 2. Fetch DB Appointments for this client (to enrich)
    const dbAppointments = await Appointment.find({ clientId: req.user.clientId });
    const dbMap = new Map();
    dbAppointments.forEach(appt => {
      if (appt.eventId) dbMap.set(appt.eventId, appt);
    });

    // 3. Merge
    const mergedEvents = googleEvents.map(event => {
      const dbAppt = dbMap.get(event.id);
      
      let source = 'external';
      if (dbAppt) {
        source = dbAppt.bookingSource || 'chatbot'; // Default to chatbot if field missing
      }

      // Safe access to date/time
      const startDateTime = event.start.dateTime || event.start.date;
      const endDateTime = event.end.dateTime || event.end.date;

      return {
        id: event.id,
        title: event.summary || 'No Title',
        start: startDateTime, 
        end: endDateTime,
        allDay: !event.start.dateTime,
        source: source,
        extendedProps: {
          description: event.description,
          service: dbAppt?.service,
          clientName: dbAppt?.name,
          phone: dbAppt?.phone,
          dbId: dbAppt?._id,
          doctor: dbAppt?.doctor
        }
      };
    });

    res.json(mergedEvents);

  } catch (error) {
    console.error('Calendar sync error:', error);
    res.status(500).json({ message: 'Failed to sync calendar', error: error.message });
  }
});

// @route   POST /api/appointments
// @desc    Create manual appointment
// @access  Private
router.post('/', protect, async (req, res) => {
  try {
    const { name, phone, email, service, doctor, start, end, notes } = req.body;
    
    const client = await Client.findOne({ clientId: req.user.clientId });
    const calendarId = client.googleCalendarId || 'primary';

    // 1. Create in Google Calendar
    const gCalEvent = await createEvent({
      summary: `${name} - ${service}`,
      description: `${notes || ''}\nPhone: ${phone}\nSource: Manual Dashboard Booking`,
      start,
      end,
      attendees: email ? [email] : [],
      calendarId
    });

    // 2. Create in DB
    const { date, time } = formatDateTime(start);
    
    const appointment = new Appointment({
      clientId: req.user.clientId,
      name,
      phone,
      email,
      service,
      doctor: doctor || 'Unassigned',
      date,
      time,
      eventId: gCalEvent.eventId,
      bookingSource: 'manual',
      logs: [{
        action: 'create',
        changedBy: req.user._id || 'dashboard_user',
        source: 'dashboard',
        details: 'Created via manual booking'
      }]
    });

    await appointment.save();

    // Emit socket event for real-time update
    const io = req.app.get('socketio');
    if (io) {
        io.to(`client_${req.user.clientId}`).emit('appointments_update');
    }

    res.status(201).json(appointment);

  } catch (error) {
    console.error('Create appointment error:', error);
    res.status(500).json({ message: 'Failed to create appointment', error: error.message });
  }
});

// @route   PUT /api/appointments/:id
// @desc    Update appointment
// @access  Private
router.put('/:id', protect, async (req, res) => {
  try {
    const { start, end, name, service, notes } = req.body;
    const appointment = await Appointment.findOne({ _id: req.params.id, clientId: req.user.clientId });
    
    if (!appointment) return res.status(404).json({ message: 'Not found' });

    const client = await Client.findOne({ clientId: req.user.clientId });
    const calendarId = client.googleCalendarId || 'primary';

    // 1. Update Google Calendar
    if (appointment.eventId) {
      await updateEvent({
        eventId: appointment.eventId,
        calendarId,
        summary: `${name || appointment.name} - ${service || appointment.service}`,
        description: notes,
        start,
        end
      });
    }

    // 2. Update DB
    if (name) appointment.name = name;
    if (service) appointment.service = service;
    if (start) {
      const { date, time } = formatDateTime(start);
      appointment.date = date;
      appointment.time = time;
    }
    
    appointment.logs.push({
      action: 'update',
      changedBy: req.user._id || 'dashboard_user',
      source: 'dashboard',
      details: 'Updated via dashboard'
    });

    await appointment.save();

    // Emit socket event for real-time update
    const io = req.app.get('socketio');
    if (io) {
        io.to(`client_${req.user.clientId}`).emit('appointments_update');
    }

    res.json(appointment);

  } catch (error) {
    console.error('Update appointment error:', error);
    res.status(500).json({ message: 'Failed to update appointment' });
  }
});

// @route   DELETE /api/appointments/:id
// @desc    Cancel appointment
// @access  Private
router.delete('/:id', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    
    // Subscription Check
    if (!client || client.subscriptionPlan === 'v1') {
      return res.status(403).json({ message: 'Cancellation is locked for CX Agent (v1). Please upgrade to v2.' });
    }

    const appointment = await Appointment.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!appointment) return res.status(404).json({ message: 'Not found' });

    const calendarId = client.googleCalendarId || 'primary';

    // 1. Delete from Google Calendar (Free up the slot)
    if (appointment.eventId) {
      try {
        await deleteEvent(appointment.eventId, calendarId);
      } catch (gError) {
        console.warn('Google Calendar delete failed (might be already deleted):', gError.message);
      }
    }
    
    // 2. Soft Delete in DB
    appointment.status = 'cancelled';
    appointment.cancelledAt = new Date();
    appointment.cancelledBy = req.user._id || 'dashboard_user';
    appointment.eventId = null; // Remove link to GCal event since it's deleted there
    
    appointment.logs.push({
      action: 'cancel',
      changedBy: req.user._id || 'dashboard_user',
      source: 'dashboard',
      details: 'Cancelled via dashboard'
    });

    await appointment.save();
    
    // Emit socket event for real-time update
    const io = req.app.get('socketio');
    if (io) {
        io.to(`client_${req.user.clientId}`).emit('appointments_update');
    }

    res.json({ message: 'Appointment cancelled' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
