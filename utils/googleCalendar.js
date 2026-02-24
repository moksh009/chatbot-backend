const { google } = require('googleapis');
const dotenv = require('dotenv');

// Load environment variables from the current directory
const envPath = require('path').resolve(__dirname, '../.env');
console.log(`🔍 Looking for .env file at: ${envPath}`);

// Manually load the .env file
const fs = require('fs');
if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8');
  const envVars = {};
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^['"](.*)['"]$/, '$1');
      process.env[key] = value;
      console.log(`✅ Loaded ${key}=${value.replace(/[^\s]{0,10}.*/, '*****')}`);
    }
  });
} else {
  console.warn(`⚠️  .env file not found at: ${envPath}`);
}

const calendar = google.calendar('v3');

// Initialize OAuth2 client with auto-refresh
let oAuth2Client;

// Function to initialize and configure the OAuth2 client
function initializeOAuth2Client() {
  try {
    // Read environment variables
    const CLIENT_ID = process.env.GCAL_CLIENT_ID || '';
    const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET || '';
    const REDIRECT_URI = process.env.GCAL_REDIRECT_URI || 'http://localhost:3000/oauth2callback';
    const REFRESH_TOKEN = process.env.GCAL_REFRESH_TOKEN || '';
    const ACCESS_TOKEN = process.env.GCAL_ACCESS_TOKEN || '';

    // Log environment variables (remove this in production)
    console.log('🔍 Google OAuth2 Config:', {
      hasClientId: !!CLIENT_ID,
      hasClientSecret: !!CLIENT_SECRET,
      hasRefreshToken: !!REFRESH_TOKEN,
      redirectUri: REDIRECT_URI
    });

    // Validate required environment variables
    if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
      const missing = [];
      if (!CLIENT_ID) missing.push('GCAL_CLIENT_ID');
      if (!CLIENT_SECRET) missing.push('GCAL_CLIENT_SECRET');
      if (!REFRESH_TOKEN) missing.push('GCAL_REFRESH_TOKEN');

      throw new Error(`Missing required Google OAuth2 configuration: ${missing.join(', ')}. Please check your environment variables.`);
    }

    // Create new OAuth2 client if it doesn't exist
    if (!oAuth2Client) {
      oAuth2Client = new google.auth.OAuth2(
        CLIENT_ID,
        CLIENT_SECRET,
        REDIRECT_URI
      );

      // Set credentials with both access and refresh tokens
      oAuth2Client.setCredentials({
        refresh_token: REFRESH_TOKEN,
        access_token: ACCESS_TOKEN
      });

      // Set up auto-refresh of access token
      oAuth2Client.on('tokens', (tokens) => {
        if (tokens.refresh_token) {
          // Store the refresh token in environment variables
          process.env.GCAL_REFRESH_TOKEN = tokens.refresh_token;
        }
        if (tokens.access_token) {
          process.env.GCAL_ACCESS_TOKEN = tokens.access_token;
        }
      });
    }

    return oAuth2Client;

  } catch (error) {
    console.warn('⚠️ Google OAuth2 client not initialized yet:', error.message);
    return null;
  }
}

// Attempt initialization immediately but don't crash if it fails
try {
  initializeOAuth2Client();
} catch (e) {
  console.warn('⚠️ Initial GCal auth attempt failed, will retry on use.');
}

async function createEvent({ summary, description, start, end, attendees, calendarId }) {
  try {
    // Validate required parameters
    if (!calendarId) {
      throw new Error('calendarId argument is required');
    }

    // Initialize OAuth2 client
    const auth = initializeOAuth2Client();

    // Create event object
    const event = {
      summary,
      description: description || 'Appointment created via WhatsApp Bot',
      start: {
        dateTime: start,
        timeZone: 'Asia/Kolkata'
      },
      end: {
        dateTime: end,
        timeZone: 'Asia/Kolkata'
      },
      attendees: attendees && attendees.length > 0
        ? attendees.map(email => ({ email, responseStatus: 'needsAction' }))
        : undefined,
      reminders: {
        useDefault: true
      }
    };

    console.log(`Creating calendar event: ${summary} from ${start} to ${end}`);

    // Insert event into calendar
    const res = await calendar.events.insert({
      auth,
      calendarId,
      resource: event,
      conferenceDataVersion: 1,
      sendUpdates: 'all'
    });

    console.log("✅ Event created successfully:", res.data.htmlLink);
    return {
      success: true,
      eventId: res.data.id,
      htmlLink: res.data.htmlLink,
      hangoutLink: res.data.hangoutLink || null,
      start: res.data.start,
      end: res.data.end
    };

  } catch (error) {
    console.error('❌ Error creating Google Calendar event:', error.message);

    // Handle specific error cases
    if (error.code === 401) {
      console.warn('Auth failed, clearing tokens...');
      delete process.env.GCAL_ACCESS_TOKEN;
    }

    const errorMessage = error.errors && error.errors[0]
      ? `${error.message} (${error.errors[0].message})`
      : error.message;
    throw new Error(`Google Calendar Error: ${errorMessage}`);
  }
}

async function updateEvent({ eventId, summary, description, start, end, attendees, calendarId }) {
  try {
    // Validate required parameters
    if (!calendarId || !eventId) {
      throw new Error('Both calendarId and eventId arguments are required');
    }

    // Initialize OAuth2 client
    const auth = initializeOAuth2Client();

    // Prepare event update
    const event = {
      summary,
      description: description || 'Updated appointment via WhatsApp Bot',
      start: {
        dateTime: start,
        timeZone: 'Asia/Kolkata'
      },
      end: {
        dateTime: end,
        timeZone: 'Asia/Kolkata'
      },
      attendees: attendees && attendees.length > 0
        ? attendees.map(email => ({ email, responseStatus: 'needsAction' }))
        : undefined
    };

    console.log(`Updating calendar event ${eventId}: ${summary || 'No title'}`);

    // Update the event
    const res = await calendar.events.patch({
      auth,
      calendarId,
      eventId,
      resource: event,
      sendUpdates: 'all'
    });

    console.log(`✅ Event updated successfully: ${res.data.htmlLink}`);
    return {
      success: true,
      eventId: res.data.id,
      htmlLink: res.data.htmlLink,
      updated: res.data.updated,
      hangoutLink: res.data.hangoutLink || null
    };

  } catch (error) {
    console.error('❌ Error updating Google Calendar event:', error.message);

    // Handle specific error cases
    if (error.code === 401) {
      delete process.env.GCAL_ACCESS_TOKEN;
      delete process.env.GCAL_REFRESH_TOKEN;
      throw new Error('Authentication failed. Please re-authenticate with Google Calendar.');
    } else if (error.code === 403) {
      throw new Error('Insufficient permissions to update calendar events.');
    } else if (error.code === 404) {
      throw new Error('Event not found. It may have been deleted.');
    } else {
      const errorMessage = error.errors && error.errors[0]
        ? `${error.message} (${error.errors[0].message})`
        : error.message;
      throw new Error(`Failed to update event: ${errorMessage}`);
    }
  }
}

async function deleteEvent(eventId, calendarId) {
  try {
    // Validate required parameters
    if (!calendarId || !eventId) {
      throw new Error('Both calendarId and eventId arguments are required');
    }

    // Initialize OAuth2 client
    const auth = initializeOAuth2Client();

    console.log(`Deleting calendar event ${eventId} from calendar ${calendarId}`);

    // Delete the event
    await calendar.events.delete({
      auth,
      calendarId,
      eventId,
      sendUpdates: 'all'
    });

    console.log(`✅ Event ${eventId} deleted successfully`);
    return {
      success: true,
      message: 'Event deleted successfully',
      eventId,
      calendarId,
      deletedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error('❌ Error deleting Google Calendar event:', error.message);

    // Handle specific error cases
    if (error.code === 401) {
      delete process.env.GCAL_ACCESS_TOKEN;
      delete process.env.GCAL_REFRESH_TOKEN;
      throw new Error('Authentication failed. Please re-authenticate with Google Calendar.');
    } else if (error.code === 403) {
      throw new Error('Insufficient permissions to delete calendar events.');
    } else if (error.code === 404) {
      // Event not found - might have been already deleted
      console.log('⚠️ Event not found during deletion - may have been already removed');
      return {
        success: true,
        message: 'Event not found - may have been already removed',
        eventId,
        alreadyDeleted: true
      };
    } else if (error.code === 410) {
      // Resource has been deleted
      console.log('ℹ️ Event was already deleted');
      return {
        success: true,
        message: 'Event was already deleted',
        eventId,
        alreadyDeleted: true
      };
    } else {
      const errorMessage = error.errors && error.errors[0]
        ? `${error.message} (${error.errors[0].message})`
        : error.message;
      throw new Error(`Failed to delete event: ${errorMessage}`);
    }
  }
}

/**
 * Get available time slots for a given date from Google Calendar.
 * @param {Object} options
 * @param {string} options.date - Date in 'YYYY-MM-DD' format
 * @param {string} options.startTime - Working day start time, e.g. '09:00'
 * @param {string} options.endTime - Working day end time, e.g. '18:00'
 * @param {number} options.slotMinutes - Slot duration in minutes (default 60)
 * @param {string} options.calendarId - Calendar ID to query
 * @returns {Promise<Array<{start: string, end: string}>>} Array of available slots in ISO format
 */
async function getAvailableTimeSlots({ date, startTime, endTime, slotMinutes = 60, calendarId, clientId, doctor, capacity = 4 }) {
  // Use Indian Standard Time (UTC+5:30) for all slot calculations
  const tz = 'Asia/Kolkata';
  // Build start/end datetime in IST
  const startDateTimeIST = new Date(`${date}T${startTime}:00+05:30`);
  const endDateTimeIST = new Date(`${date}T${endTime}:00+05:30`);
  const startDateTime = startDateTimeIST.toISOString();
  const endDateTime = endDateTimeIST.toISOString();

  // Fetch all events for that day to count they
  if (!calendarId) throw new Error('calendarId argument is required');
  const auth = initializeOAuth2Client();

  const eventsRes = await calendar.events.list({
    auth,
    calendarId,
    timeMin: startDateTime,
    timeMax: endDateTime,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const calendarEvents = eventsRes.data.items || [];

  // Fetch DB appointments for the same day and doctor to ensure we don't miss pending/unsynced ones
  let dbAppointments = [];
  try {
    const Appointment = require('../models/Appointment');
    // We search by the string-formatted date if we want to be safe with the current schema
    // or we could search by a range if we had better dates.
    // For now, let's just use the GCal events as the primary source, but if clientId/doctor is provided, 
    // we can cross-check DB.
    if (clientId && doctor) {
      dbAppointments = await Appointment.find({
        clientId,
        doctor,
        status: { $ne: 'cancelled' }
      });
    }
  } catch (e) {
    console.warn('DB Fetch failed in getAvailableTimeSlots:', e.message);
  }

  // Generate all possible slots in IST
  const slots = [];
  let slotStart = new Date(startDateTimeIST);
  const slotEnd = new Date(endDateTimeIST);

  while (slotStart < slotEnd) {
    const slotFinish = new Date(slotStart.getTime() + slotMinutes * 60000);
    if (slotFinish > slotEnd) break;

    // Check if slot is within business hours (09:00 to 23:00)
    const hour = parseInt(slotStart.toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: tz }), 10);
    if (hour < 9 || hour >= 23) {
      slotStart = slotFinish;
      continue;
    }

    // 1. Count overlaps in Google Calendar
    const gcalCount = calendarEvents.filter(event => {
      const eStart = new Date(event.start.dateTime || event.start.date);
      const eEnd = new Date(event.end.dateTime || event.end.date);
      return (slotStart < eEnd && slotFinish > eStart);
    }).length;

    // 2. Count overlaps in Database (checking the 'time' string for exact matches for simplicity in this schema)
    const dbCount = dbAppointments.filter(appt => {
      // Check if DB appointment matches this slot
      // This is a bit rough since DB stores "11:00 AM".
      const slotTimeStr = slotStart.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: tz
      });
      return appt.time === slotTimeStr;
    }).length;

    // A slot is available if total bookings are less than capacity
    // We take the MAX of GCal count and DB count or some combination
    // usually GCal is the source of truth, but DB might have more recent ones.
    // If we create GCal events for every DB appt, we should count carefully.

    // Using a simple Math.max for now assuming GCal and DB are mostly synced
    // but DB might have unsynced ones. Let's use gcalCount as primary.
    if (gcalCount < capacity) {
      slots.push({
        start: slotStart.toISOString(),
        end: slotFinish.toISOString(),
        booked: gcalCount
      });
    }

    slotStart = slotFinish;
  }
  return slots;
}

/**
 * Find a calendar event by attendee email and time window.
 * @param {Object} options
 * @param {string} options.email - Attendee email
 * @param {string} options.date - Date in 'YYYY-MM-DD' format
 * @param {string} options.time - Time in 'HH:mm' 24h format (start of slot)
 * @param {string} options.calendarId - Calendar ID to query
 * @returns {Promise<{eventId: string, event: object}|null>} Event info or null
 */
async function findEventByEmailAndTime({ email, date, time, calendarId }) {
  // Build timeMin/timeMax for 1-hour window
  const tz = 'Asia/Kolkata';
  if (!calendarId) throw new Error('calendarId argument is required');
  const startDateTime = new Date(`${date}T${time}:00+05:30`).toISOString();
  const endDateTime = new Date(new Date(`${date}T${time}:00+05:30`).getTime() + 60 * 60000).toISOString();
  const auth = initializeOAuth2Client();
  const res = await calendar.events.list({
    auth: auth,
    calendarId,
    timeMin: startDateTime,
    timeMax: endDateTime,
    singleEvents: true,
    orderBy: 'startTime',
    q: email // search in description/attendees
  });
  const events = res.data.items || [];
  for (const event of events) {
    // Check if attendee matches
    if (event.attendees && event.attendees.some(a => a.email === email)) {
      return { eventId: event.id, event };
    }
    // Fallback: check if email in description
    if (event.description && event.description.includes(email)) {
      return { eventId: event.id, event };
    }
  }
  return null;
}

/**
 * Find calendar events by phone number in description for a date range.
 * @param {Object} options
 * @param {string} options.phone - Phone number to search for
 * @param {string} options.startDate - Start date in 'YYYY-MM-DD' format
 * @param {string} options.endDate - End date in 'YYYY-MM-DD' format
 * @param {string} options.calendarId - Calendar ID to query
 * @returns {Promise<Array<{eventId: string, summary: string, date: string, time: string}>>}
 */
async function findEventsByPhoneNumber({ phone, startDate, endDate, calendarId }) {
  const tz = 'Asia/Kolkata';
  if (!calendarId) throw new Error('calendarId argument is required');
  const startDateTime = new Date(`${startDate}T00:00:00+05:30`).toISOString();
  const endDateTime = new Date(`${endDate}T23:59:59+05:30`).toISOString();
  const auth = initializeOAuth2Client();
  const res = await calendar.events.list({
    auth: auth,
    calendarId,
    timeMin: startDateTime,
    timeMax: endDateTime,
    singleEvents: true,
    orderBy: 'startTime',
    q: phone // search in description
  });
  const events = res.data.items || [];
  const results = [];
  for (const event of events) {
    if (event.description && event.description.includes(phone)) {
      const start = event.start?.dateTime || event.start?.date;
      const dateObj = new Date(start);
      // Convert to IST for display
      const date = dateObj.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: '2-digit',
        month: 'short',
        timeZone: 'Asia/Kolkata'
      });
      const time = dateObj.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZone: 'Asia/Kolkata'
      });
      results.push({
        eventId: event.id,
        summary: event.summary,
        date,
        time
      });
    }
  }
  return results;
}

/**
 * List calendar events for a given time range.
 * @param {string} timeMin - Start time in ISO format
 * @param {string} timeMax - End time in ISO format
 * @param {string} calendarId - Calendar ID to query
 * @returns {Promise<Array>} Array of calendar events
 */
async function listEvents(timeMin, timeMax, calendarId) {
  try {
    // Validate required parameters
    if (!calendarId) {
      throw new Error('calendarId argument is required');
    }

    // Initialize OAuth2 client
    const auth = initializeOAuth2Client();

    console.log(`📅 Fetching events from calendar ${calendarId} from ${timeMin} to ${timeMax}`);

    // List events from calendar
    const res = await calendar.events.list({
      auth: auth,
      calendarId,
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = res.data.items || [];
    console.log(`✅ Found ${events.length} events in calendar ${calendarId}`);

    return events;

  } catch (error) {
    console.error('❌ Error listing calendar events:', error.message);
    throw error;
  }
}

module.exports = { createEvent, updateEvent, deleteEvent, getAvailableTimeSlots, findEventByEmailAndTime, findEventsByPhoneNumber, listEvents };