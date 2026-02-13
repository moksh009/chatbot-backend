const express = require('express');
const router = express.Router();
const Appointment = require('../models/Appointment');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { listEvents, createEvent, updateEvent, deleteEvent } = require('../utils/googleCalendar');
const { DateTime } = require('luxon');

// Helper to check for overlapping appointments
const checkOverlap = async (clientId, doctor, start, end, excludeId = null) => {
  const newStart = new Date(start);
  const newEnd = new Date(end);

  // 1. Check DB for conflicts
  const query = {
    clientId,
    doctor,
    status: { $ne: 'cancelled' }
  };
  
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const dbAppointments = await Appointment.find(query);
  
  const hasDbConflict = dbAppointments.some(appt => {
    // Reconstruct start/end from DB date/time if possible, 
    // but Appointment model should ideally store ISO strings.
    // For now, let's check based on the 'date' and 'time' fields if they match exactly
    // as a fallback, but we should really use Google Calendar as the source of truth for availability.
    return false; // DB check is tricky with the current string-based date/time schema
  });

  // 2. Check Google Calendar (The source of truth)
  const client = await Client.findOne({ clientId });
  if (!client) return false;

  // Find the correct calendar ID for the doctor
  let calendarId = client.googleCalendarId || 'primary';
  if (client.config?.calendars && doctor) {
    const doctorKey = doctor.toLowerCase().replace(/\s+/g, '');
    if (client.config.calendars[doctorKey]) {
      calendarId = client.config.calendars[doctorKey];
    }
  }

  // Fetch events for that day
  const dayStart = DateTime.fromJSDate(newStart).startOf('day').toISO();
  const dayEnd = DateTime.fromJSDate(newStart).endOf('day').toISO();
  const events = await listEvents(dayStart, dayEnd, calendarId);

  const conflict = events.find(event => {
    if (excludeId && event.id === excludeId) return false;
    
    const eventStart = new Date(event.start.dateTime || event.start.date);
    const eventEnd = new Date(event.end.dateTime || event.end.date);
    
    // Overlap logic: (StartA < EndB) and (EndA > StartB)
    return (newStart < eventEnd && newEnd > eventStart);
  });

  return conflict ? {
    name: conflict.summary,
    start: conflict.start.dateTime || conflict.start.date,
    end: conflict.end.dateTime || conflict.end.date
  } : null;
};

// @route   POST /api/appointments/check-conflict
// @desc    Check if a time slot is available
// @access  Private
router.post('/check-conflict', protect, async (req, res) => {
  try {
    const { doctor, start, end, excludeId } = req.body;
    if (!start || !end) {
      return res.status(400).json({ message: 'Start and end times are required' });
    }

    const conflict = await checkOverlap(req.user.clientId, doctor, start, end, excludeId);
    res.json({ hasConflict: !!conflict, conflict });
  } catch (error) {
    res.status(500).json({ message: 'Error checking availability', error: error.message });
  }
});

// Helper to format date/time for legacy schema
const formatDateTime = (isoDateString) => {
  try {
    const dateObj = new Date(isoDateString);
    if (isNaN(dateObj.getTime())) {
        throw new Error('Invalid date string: ' + isoDateString);
    }
    const date = dateObj.toLocaleDateString('en-GB', { 
      weekday: 'long', 
      day: '2-digit', 
      month: 'short',
      timeZone: 'Asia/Kolkata'
    }); // "Tuesday, 23 Jul"
    const time = dateObj.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit', 
      hour12: true,
      timeZone: 'Asia/Kolkata'
    }); // "11:00 AM"
    return { date, time };
  } catch (e) {
      console.error('Date formatting error:', e.message);
      return { date: 'Invalid Date', time: 'Invalid Time' };
  }
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
    if (!client) {
        return res.status(404).json({ message: 'Client not found' });
    }
    
    // Collect all calendar IDs
    const calendarIds = new Set();
    if (client.googleCalendarId) calendarIds.add(client.googleCalendarId);
    
    // Add stylist calendars from config
    if (client.config?.calendars) {
        Object.values(client.config.calendars).forEach(id => calendarIds.add(id));
    }
    
    // Default to 'primary' if no calendars found
    if (calendarIds.size === 0) calendarIds.add('primary');

    // 1. Fetch Google Calendar Events from ALL calendars
    let googleEvents = [];
    try {
      const calendarPromises = Array.from(calendarIds).map(calId => 
         listEvents(start, end, calId)
             .catch(err => {
                 console.error(`GCal fetch error for ${calId}:`, err.message);
                 return [];
             })
      );
      
      const results = await Promise.all(calendarPromises);
      googleEvents = results.flat();
      
      // Remove duplicates based on event ID
      const uniqueEvents = new Map();
      googleEvents.forEach(e => uniqueEvents.set(e.id, e));
      googleEvents = Array.from(uniqueEvents.values());

    } catch (err) {
      console.error('Google Calendar listEvents failed:', err.message);
      // Fallback: return empty list
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
      
      let source = 'chatbot';
      if (dbAppt) {
        source = dbAppt.bookingSource || 'chatbot'; // Default to chatbot if field missing
        dbMap.delete(event.id); // Remove from map to track processed ones
      }

      // Safe access to date/time
      const startDateTime = event.start.dateTime || event.start.date;
      const endDateTime = event.end.dateTime || event.end.date;

      // Determine color based on doctor/stylist
      let color = dbAppt?.doctor?.toLowerCase() === 'shubhashbhai' ? '#ff9f89' : (dbAppt?.doctor?.toLowerCase() === 'moksh' ? '#89c4ff' : undefined);
      
      // Fallback: check summary if no DB appointment link found
      if (!color && event.summary) {
        const summary = event.summary.toLowerCase();
        if (summary.includes('shubhashbhai')) color = '#ff9f89';
        else if (summary.includes('moksh')) color = '#89c4ff';
      }

      return {
        id: event.id,
        title: event.summary || 'No Title',
        start: startDateTime, 
        end: endDateTime,
        allDay: !event.start.dateTime,
        source: source,
        color: color,
        extendedProps: {
          description: event.description,
          service: dbAppt?.service,
          clientName: dbAppt?.name,
          phone: dbAppt?.phone,
          email: dbAppt?.email,
          dbId: dbAppt?._id,
          doctor: dbAppt?.doctor,
          status: dbAppt?.status || 'confirmed'
        }
      };
    });

    // 4. Add remaining DB appointments (not in Google Calendar)
    dbMap.forEach(appt => {
      // Reconstruct ISO date from DB string (Asia/Kolkata)
      // Note: This is a best-effort conversion.
      // Ideally DB should store ISO start/end.
      let startISO = new Date().toISOString(); 
      let endISO = new Date().toISOString();

      try {
         const todayYear = new Date().getFullYear();
         // Parse "Monday, 09 Feb" -> "09 Feb"
         const datePart = appt.date.split(',')[1]?.trim(); 
         if (datePart && appt.time) {
             const timeParts = appt.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
             if (timeParts) {
                 let hours = parseInt(timeParts[1]);
                 const minutes = parseInt(timeParts[2]);
                 const ampm = timeParts[3].toUpperCase();
                 if (ampm === 'PM' && hours < 12) hours += 12;
                 if (ampm === 'AM' && hours === 12) hours = 0;
                 
                 const d = new Date(`${datePart} ${todayYear} ${hours}:${minutes}:00`);
                 // Basic validation
                 if (!isNaN(d.getTime())) {
                     startISO = d.toISOString();
                     d.setHours(d.getHours() + 1); // Default 1 hour duration
                     endISO = d.toISOString();
                 }
             }
         }
      } catch (e) {
          console.error('Date parsing error for DB appointment:', e);
      }

      mergedEvents.push({
        id: appt.eventId || `db_${appt._id}`,
        title: `${appt.name} - ${appt.service}`,
        start: startISO,
        end: endISO,
        allDay: false,
        source: appt.bookingSource || 'chatbot',
        color: appt.doctor?.toLowerCase() === 'shubhashbhai' ? '#ff9f89' : (appt.doctor?.toLowerCase() === 'moksh' ? '#89c4ff' : undefined),
        extendedProps: {
          description: 'Synced from Database',
          service: appt.service,
          clientName: appt.name,
          phone: appt.phone,
          dbId: appt._id,
          doctor: appt.doctor,
          status: appt.status || 'confirmed'
        }
      });
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
    
    // Check for conflicts before creating
    const conflict = await checkOverlap(req.user.clientId, doctor, start, end);
    if (conflict) {
        return res.status(409).json({ 
            message: 'This time slot is already booked for the selected provider.',
            conflict 
        });
    }

    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) {
        return res.status(404).json({ message: 'Client not found' });
    }
    const calendarId = client.googleCalendarId || 'primary';

    // 1. Create in Google Calendar (Fail-safe)
    let eventId = null;
    try {
        const gCalEvent = await createEvent({
            summary: `${name} - ${service}`,
            description: `${notes || ''}\nPhone: ${phone}\nSource: Manual Dashboard Booking`,
            start,
            end,
            attendees: email ? [email] : [],
            calendarId
        });
        eventId = gCalEvent.eventId;
    } catch (gError) {
        console.error('Google Calendar Sync Failed (Create):', gError.message);
        // Proceed without Google Calendar event
    }

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
      eventId: eventId || req.body.existingEventId, // Use existing ID if provided (converting external/chatbot event)
      bookingSource: req.body.existingEventId ? 'chatbot' : 'manual', // If converting, assume it's from chatbot/external
      logs: [{
        action: 'create',
        changedBy: req.user._id || 'dashboard_user',
        source: 'dashboard',
        details: eventId ? 'Created via manual booking' : (req.body.existingEventId ? 'Converted from external/chatbot event' : 'Created (Local only - GCal Sync Failed)')
      }]
    });

    await appointment.save();

    // If converting an existing event, we might want to update its description/title in GCal to match our format
    if (req.body.existingEventId) {
        try {
            await updateEvent({
                eventId: req.body.existingEventId,
                calendarId,
                summary: `${name} - ${service}`,
                description: `${notes || ''}\nPhone: ${phone}\nSource: Dashboard (Converted)`,
                start,
                end
            });
        } catch (gError) {
            console.error('Failed to update converted GCal event:', gError.message);
        }
    }

    // Emit socket event for real-time update
    const io = req.app.get('socketio');
    if (io) {
        io.to(`client_${req.user.clientId}`).emit('appointments_update');
    }

    res.status(201).json(appointment);

  } catch (error) {
    console.error('Create appointment error:', error);
    if (error.code === 11000) {
        return res.status(409).json({ message: 'This time slot is already booked for the selected provider.' });
    }
    res.status(500).json({ message: 'Failed to create appointment', error: error.message });
  }
});

// @route   PUT /api/appointments/:id
// @desc    Update appointment
// @access  Private
router.put('/:id', protect, async (req, res) => {
  try {
    const { start, end, name, service, notes, email, phone, doctor } = req.body;
    const appointment = await Appointment.findOne({ _id: req.params.id, clientId: req.user.clientId });
    
    if (!appointment) return res.status(404).json({ message: 'Not found' });

    // Check for conflicts if time or doctor changes
    if (start || end || doctor) {
      const checkStart = start || appointment.start; // Assuming start is available or we need to derive it
      const checkEnd = end || appointment.end;
      const checkDoctor = doctor || appointment.doctor;
      
      const conflict = await checkOverlap(
        req.user.clientId, 
        checkDoctor, 
        checkStart, 
        checkEnd, 
        appointment.eventId // Exclude current GCal event
      );
      
      if (conflict) {
        return res.status(409).json({ 
          message: 'The new time slot is already booked for this provider.',
          conflict 
        });
      }
    }

    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) {
        return res.status(404).json({ message: 'Client not found' });
    }
    const calendarId = client.googleCalendarId || 'primary';

    // 1. Update Google Calendar (Fail-safe)
    if (appointment.eventId) {
      try {
        await updateEvent({
          eventId: appointment.eventId,
          calendarId,
          summary: `${name || appointment.name} - ${service || appointment.service}`,
          description: `${notes || ''}\nPhone: ${phone || appointment.phone}\nSource: Dashboard (Updated)`,
          start,
          end
        });
      } catch (gError) {
        console.error('Google Calendar Sync Failed (Update):', gError.message);
        // Continue to update DB
      }
    }

    // 2. Update DB
    if (name) appointment.name = name;
    if (service) appointment.service = service;
    if (email) appointment.email = email;
    if (phone) appointment.phone = phone;
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

// @route   PATCH /api/appointments/:id/status
// @desc    Update appointment status (e.g., cancel, complete)
// @access  Private
router.patch('/:id/status', protect, async (req, res) => {
  try {
    const { status } = req.body;
    const client = await Client.findOne({ clientId: req.user.clientId });
    
    // Subscription Check for cancellation
    if (status === 'cancelled' && (!client || client.subscriptionPlan === 'v1')) {
      return res.status(403).json({ message: 'Cancellation is locked for CX Agent (v1). Please upgrade to v2.' });
    }

    const appointment = await Appointment.findOne({ _id: req.params.id, clientId: req.user.clientId });
    if (!appointment) return res.status(404).json({ message: 'Not found' });

    appointment.status = status;
    if (status === 'cancelled') {
        appointment.cancelledAt = new Date();
        appointment.cancelledBy = req.user._id || 'dashboard_user';
        
        // Also delete from GCal if linked
        if (appointment.eventId) {
            try {
                const calendarId = client.googleCalendarId || 'primary';
                await deleteEvent(appointment.eventId, calendarId);
                appointment.eventId = null;
            } catch (gError) {
                console.warn('GCal delete failed during status update:', gError.message);
            }
        }
    }

    appointment.logs.push({
      action: 'status_update',
      changedBy: req.user._id || 'dashboard_user',
      source: 'dashboard',
      details: `Status changed to ${status}`
    });

    await appointment.save();

    // Emit socket event
    const io = req.app.get('socketio');
    if (io) {
        io.to(`client_${req.user.clientId}`).emit('appointments_update');
    }

    res.json(appointment);
  } catch (error) {
    console.error('Status update error:', error);
    res.status(500).json({ message: 'Server Error' });
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

// @route   DELETE /api/appointments/external/:eventId
// @desc    Delete external GCal event (not in DB)
// @access  Private
router.delete('/external/:eventId', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    
    // Subscription Check
    if (!client || client.subscriptionPlan === 'v1') {
      return res.status(403).json({ message: 'Cancellation is locked for CX Agent (v1). Please upgrade to v2.' });
    }

    const calendarId = client.googleCalendarId || 'primary';
    const eventId = req.params.eventId;

    try {
      await deleteEvent(eventId, calendarId);
      res.json({ message: 'External appointment cancelled' });
    } catch (gError) {
      console.error('Google Calendar delete failed:', gError.message);
      res.status(500).json({ message: 'Failed to delete external event' });
    }
  } catch (error) {
    console.error('External delete error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
