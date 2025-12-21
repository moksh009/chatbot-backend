const { google } = require('googleapis');
require('dotenv').config();

const CLIENT_ID = process.env.GCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;
const REDIRECT_URI = process.env.GCAL_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GCAL_REFRESH_TOKEN;
const CALENDAR_ID = process.env.GCAL_CALENDAR_ID;

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

/**
 * Get all booked slots from calendar for a date range
 * @param {string} startDate - Start date in 'YYYY-MM-DD' format
 * @param {string} endDate - End date in 'YYYY-MM-DD' format
 * @returns {Promise<Array>} Array of day objects with booked slots
 */
async function getBookedSlots(startDate = null, endDate = null) {
  try {
    const calendar = google.calendar('v3');
    
    // Default to next 30 days if no dates provided
    if (!startDate) {
      const today = new Date();
      startDate = today.toISOString().slice(0, 10);
    }
    
    if (!endDate) {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      endDate = futureDate.toISOString().slice(0, 10);
    }

    console.log(`📅 Fetching booked slots from ${startDate} to ${endDate}...`);

    // Convert dates to ISO strings with timezone (EAT: UTC+3)
    const startDateTime = new Date(`${startDate}T00:00:00+03:00`).toISOString();
    const endDateTime = new Date(`${endDate}T23:59:59+03:00`).toISOString();

    const response = await calendar.events.list({
      auth: oAuth2Client,
      calendarId: CALENDAR_ID,
      timeMin: startDateTime,
      timeMax: endDateTime,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500 // Increase if you have more events
    });

    const events = response.data.items || [];
    console.log(`Found ${events.length} events in the calendar`);

    // Group events by date
    const daysWithSlots = {};
    
    events.forEach(event => {
      const start = event.start?.dateTime || event.start?.date;
      if (!start) return;

      const dateObj = new Date(start);
      const dateKey = dateObj.toISOString().slice(0, 10); // YYYY-MM-DD
      const dayName = dateObj.toLocaleDateString('en-GB', { 
        weekday: 'long', 
        day: '2-digit', 
        month: 'short',
        year: 'numeric'
      });

      if (!daysWithSlots[dateKey]) {
        daysWithSlots[dateKey] = {
          date: dateKey,
          dayName: dayName,
          dayOfWeek: dateObj.toLocaleDateString('en-GB', { weekday: 'long' }),
          bookedSlots: []
        };
      }

      // Extract time information
      const startTime = new Date(start);
      const endTime = new Date(event.end?.dateTime || event.end?.date);
      
      const slotInfo = {
        eventId: event.id,
        summary: event.summary || 'No title',
        description: event.description || '',
        startTime: startTime.toLocaleTimeString('en-GB', { 
          hour: '2-digit', 
          minute: '2-digit', 
          hour12: true,
          timeZone: 'Africa/Nairobi'
        }),
        endTime: endTime.toLocaleTimeString('en-GB', { 
          hour: '2-digit', 
          minute: '2-digit', 
          hour12: true,
          timeZone: 'Africa/Nairobi'
        }),
        startISO: startTime.toISOString(),
        endISO: endTime.toISOString(),
        duration: Math.round((endTime - startTime) / (1000 * 60)), // duration in minutes
        attendees: event.attendees || [],
        location: event.location || '',
        htmlLink: event.htmlLink,
        createdAt: event.created,
        updatedAt: event.updated,
        status: event.status,
        // Extract patient info from description if available
        patientInfo: extractPatientInfo(event.description || '')
      };

      daysWithSlots[dateKey].bookedSlots.push(slotInfo);
    });

    // Convert to array and sort by date
    const result = Object.values(daysWithSlots).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Add summary statistics
    result.forEach(day => {
      day.totalSlots = day.bookedSlots.length;
      day.totalDuration = day.bookedSlots.reduce((sum, slot) => sum + slot.duration, 0);
    });

    return result;

  } catch (error) {
    console.error('❌ Error fetching booked slots:', error.message);
    throw error;
  }
}

/**
 * Extract patient information from event description
 * @param {string} description - Event description
 * @returns {Object} Patient information object
 */
function extractPatientInfo(description) {
  const info = {
    name: '',
    phone: '',
    service: '',
    doctor: '',
    email: ''
  };

  // Extract name
  const nameMatch = description.match(/Name:\s*([^\n]+)/i);
  if (nameMatch) info.name = nameMatch[1].trim();

  // Extract phone
  const phoneMatch = description.match(/Phone:\s*([^\n]+)/i);
  if (phoneMatch) info.phone = phoneMatch[1].trim();

  // Extract service
  const serviceMatch = description.match(/Service:\s*([^\n]+)/i);
  if (serviceMatch) info.service = serviceMatch[1].trim();

  // Extract doctor/stylist
  const doctorMatch = description.match(/(?:Doctor|Stylist):\s*([^\n]+)/i);
  if (doctorMatch) info.doctor = doctorMatch[1].trim();

  // Extract email
  const emailMatch = description.match(/Email:\s*([^\n]+)/i);
  if (emailMatch) info.email = emailMatch[1].trim();

  return info;
}

/**
 * Display booked slots in a formatted way
 * @param {Array} daysWithSlots - Array of day objects with booked slots
 */
function displayBookedSlots(daysWithSlots) {
  console.log('\n📋 BOOKED APPOINTMENTS SUMMARY');
  console.log('================================\n');

  if (daysWithSlots.length === 0) {
    console.log('No booked appointments found in the specified date range.');
    return;
  }

  let totalAppointments = 0;
  let totalDuration = 0;

  daysWithSlots.forEach(day => {
    console.log(`📅 ${day.dayName} (${day.totalSlots} appointments, ${day.totalDuration} minutes)`);
    console.log('─'.repeat(60));

    if (day.bookedSlots.length === 0) {
      console.log('   No appointments scheduled\n');
      return;
    }

    day.bookedSlots.forEach((slot, index) => {
      console.log(`   ${index + 1}. ${slot.startTime} - ${slot.endTime} (${slot.duration} min)`);
      console.log(`      📝 ${slot.summary}`);
      
      if (slot.patientInfo.name) {
        console.log(`      👤 Patient: ${slot.patientInfo.name}`);
      }
      if (slot.patientInfo.phone) {
        console.log(`      📞 Phone: ${slot.patientInfo.phone}`);
      }
      if (slot.patientInfo.service) {
        console.log(`      🦷 Service: ${slot.patientInfo.service}`);
      }
      if (slot.patientInfo.doctor) {
        console.log(`      👨‍⚕ Doctor: ${slot.patientInfo.doctor}`);
      }
      if (slot.location) {
        console.log(`      📍 Location: ${slot.location}`);
      }
      console.log(`      🔗 Link: ${slot.htmlLink}`);
      console.log('');
    });

    totalAppointments += day.totalSlots;
    totalDuration += day.totalDuration;
  });

  console.log('📊 SUMMARY STATISTICS');
  console.log('─'.repeat(30));
  console.log(`Total Days: ${daysWithSlots.length}`);
  console.log(`Total Appointments: ${totalAppointments}`);
  console.log(`Total Duration: ${totalDuration} minutes (${Math.round(totalDuration / 60 * 10) / 10} hours)`);
  console.log(`Average per Day: ${Math.round(totalAppointments / daysWithSlots.length * 10) / 10} appointments`);
}

/**
 * Export data to JSON file
 * @param {Array} data - Data to export
 * @param {string} filename - Output filename
 */
function exportToJSON(data, filename = 'booked-slots.json') {
  const fs = require('fs');
  try {
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log(`\n💾 Data exported to ${filename}`);
  } catch (error) {
    console.error('❌ Error exporting to JSON:', error.message);
  }
}

// Main execution
async function main() {
  try {
    console.log('🔍 Fetching booked slots from Google Calendar...');
    console.log(`Calendar ID: ${CALENDAR_ID}`);
    
    // Get command line arguments for date range
    const args = process.argv.slice(2);
    let startDate = null;
    let endDate = null;
    
    if (args.length >= 1) startDate = args[0];
    if (args.length >= 2) endDate = args[1];

    const bookedSlots = await getBookedSlots(startDate, endDate);
    
    // Display results
    displayBookedSlots(bookedSlots);
    
    // Export to JSON
    exportToJSON(bookedSlots);
    
    // Return the data for programmatic use
    return bookedSlots;

  } catch (error) {
    console.error('❌ Failed to fetch booked slots:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { getBookedSlots, extractPatientInfo, displayBookedSlots }; 