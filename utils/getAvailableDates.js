const { google } = require('googleapis');
const { DateTime, Interval } = require('luxon');
require('dotenv').config();

// Initialize OAuth2 client
let oAuth2Client;
function initializeOAuth2Client() {
  const CLIENT_ID = process.env.GCAL_CLIENT_ID;
  const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GCAL_REDIRECT_URI;
  const REFRESH_TOKEN = process.env.GCAL_REFRESH_TOKEN;
  
  if (!oAuth2Client) {
    oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
    oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  }
  return oAuth2Client;
}

// Get working hours for a specific day
function getWorkingHours(dayOfWeek) {
  switch (dayOfWeek) {
    case 0: // Sunday
      return { start: null, end: null, isOpen: false };
    case 6: // Saturday
      return { start: '07:00', end: '14:00', isOpen: true };
    default: // Monday to Friday (1-5)
      return { start: '07:00', end: '18:00', isOpen: true };
  }
}

// Generate all possible 30-minute slots for a given day using Luxon
function generateTimeSlots(dateEAT, workingHours) {
  if (!workingHours.isOpen) return [];
  const slots = [];
  const [startHour, startMinute] = workingHours.start.split(':').map(Number);
  const [endHour, endMinute] = workingHours.end.split(':').map(Number);
  let slotStart = dateEAT.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 });
  const endOfDay = dateEAT.set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 });
  while (slotStart < endOfDay) {
    let slotEnd = slotStart.plus({ minutes: 30 });
    if (slotEnd > endOfDay) break;
    slots.push({
      start: slotStart,
      end: slotEnd,
      startTime: slotStart.toFormat('HH:mm'),
      endTime: slotEnd.toFormat('HH:mm')
    });
    slotStart = slotEnd;
  }
  return slots;
}

// Check if a slot overlaps with any booked appointments
function isSlotAvailable(slot, bookedAppointments) {
  for (const appointment of bookedAppointments) {
    // Use Luxon for comparison
    const appointmentStart = appointment.start;
    const appointmentEnd = appointment.end;
    if (slot.start < appointmentEnd && slot.end > appointmentStart) {
      return false; // Slot overlaps with booked appointment
    }
  }
  return true; // Slot is available
}

// Get booked appointments for a specific date (returns Luxon DateTime for start/end)
async function getBookedAppointments(dateEAT, calendarId) {
  try {
    const calendar = google.calendar({ version: 'v3', auth: initializeOAuth2Client() });
    if (!calendarId) throw new Error('calendarId argument is required');
    // Get start and end of day in EAT
    const startOfDayEAT = dateEAT.startOf('day');
    const endOfDayEAT = dateEAT.endOf('day');
    // Convert to UTC ISO for Google Calendar API
    const startUTC = startOfDayEAT.toUTC().toISO();
    const endUTC = endOfDayEAT.toUTC().toISO();
    const response = await calendar.events.list({
      calendarId,
      timeMin: startUTC,
      timeMax: endUTC,
      singleEvents: true,
      orderBy: 'startTime'
    });
    // Map to Luxon DateTime for start/end
    return (response.data.items || []).map(event => {
      const start = event.start?.dateTime || event.start?.date;
      const end = event.end?.dateTime || event.end?.date;
      return {
        ...event,
        start: DateTime.fromISO(start, { zone: 'Africa/Kampala' }),
        end: DateTime.fromISO(end, { zone: 'Africa/Kampala' })
      };
    });
  } catch (error) {
    console.error('Error fetching booked appointments:', error);
    return [];
  }
}

// Check if a day has any available slots
async function hasAvailableSlots(dateEAT, calendarId) {
  const dayOfWeek = dateEAT.weekday % 7; // Luxon: Monday=1, Sunday=7
  const workingHours = getWorkingHours(dayOfWeek);
  if (!workingHours.isOpen) return false;
  const allSlots = generateTimeSlots(dateEAT, workingHours);
  if (allSlots.length === 0) return false;
  const bookedAppointments = await getBookedAppointments(dateEAT, calendarId);
  
  // Get current time in EAT
  const nowEAT = DateTime.now().setZone('Africa/Kampala');
  
  // Check if this is today
  const isToday = dateEAT.hasSame(nowEAT, 'day');
  if (isToday) {
    console.log(`🕐 Current time: ${nowEAT.toFormat('HH:mm:ss')}`);
    console.log(`📊 Total slots for today: ${allSlots.length}`);
  }
  
  for (const slot of allSlots) {
    // Check if slot is in the past (for today's date)
    if (isToday) {
      // If it's today, check if the slot has already passed
      if (slot.start <= nowEAT) {
        console.log(`⏰ Skipping past slot: ${slot.startTime} - ${slot.endTime}`);
        continue; // Skip past slots
      }
    }
    
    // Check if slot is available (not booked)
    if (isSlotAvailable(slot, bookedAppointments)) {
      if (isToday) {
        console.log(`✅ Found available future slot: ${slot.startTime} - ${slot.endTime}`);
      }
      return true;
    }
  }
  
  if (isToday) {
    console.log(`❌ No available future slots found for today`);
  }
  return false;
}

// Format date for display (EAT timezone)
function formatDateForDisplay(dateEAT) {
  return dateEAT.setZone('Africa/Kampala').toFormat('cccc, dd LLL yyyy');
}

// Main function to get available dates
async function getAvailableDates(maxDays = 8, calendarId) {
  try {
    if (!calendarId) throw new Error('calendarId argument is required');
    console.log('🔍 Checking for available appointment dates...');
    console.log('⏰ Working Hours: Mon-Fri 7 AM – 6 PM, Sat 7 AM – 2 PM, Sun Closed');
    console.log('');
    const availableDates = [];
    let currentDate = DateTime.utc().setZone('Africa/Kampala').startOf('day');
    let daysChecked = 0;
    const maxDaysToCheck = 30;
    while (availableDates.length < maxDays && daysChecked < maxDaysToCheck) {
      const dayOfWeek = currentDate.weekday % 7; // Luxon: Monday=1, Sunday=7
      const workingHours = getWorkingHours(dayOfWeek);
      if (workingHours.isOpen) {
        console.log(`📅 Checking ${formatDateForDisplay(currentDate)}...`);
        const hasSlots = await hasAvailableSlots(currentDate, calendarId);
        if (hasSlots) {
          const formattedDate = formatDateForDisplay(currentDate);
          availableDates.push({
            id: `calendar_day_${availableDates.length}`,
            title: formattedDate,
            date: currentDate,
            dayOfWeek: dayOfWeek,
            workingHours: workingHours
          });
          console.log(`   ✅ Available slots found`);
        } else {
          console.log(`   ❌ No available slots`);
        }
      } else {
        console.log(`📅 ${formatDateForDisplay(currentDate)} - Closed`);
      }
      currentDate = currentDate.plus({ days: 1 });
      daysChecked++;
    }
    console.log('');
    console.log('📋 Available Dates:');
    console.log('='.repeat(40));
    if (availableDates.length === 0) {
      console.log('❌ No available dates found in the next 30 days!');
      return [];
    }
    availableDates.forEach((date, index) => {
      const workingTime = `${date.workingHours.start} - ${date.workingHours.end}`;
      console.log(`${index + 1}. ${date.title} (${workingTime})`);
    });
    console.log('');
    console.log(`✅ Found ${availableDates.length} available dates`);
    return availableDates;
  } catch (error) {
    console.error('❌ Error getting available dates:', error);
    return [];
  }
}

// Test function
async function testGetAvailableDates() {
  console.log('🧪 Testing getAvailableDates function...');
  console.log('='.repeat(50));
  const availableDates = await getAvailableDates(8);
  console.log('');
  console.log('📊 Test Results:');
  console.log(`Total available dates: ${availableDates.length}`);
  if (availableDates.length > 0) {
    console.log('First 3 dates:');
    availableDates.slice(0, 3).forEach((date, index) => {
      console.log(`${index + 1}. ${date.title}`);
    });
  }
}

if (require.main === module) {
  testGetAvailableDates()
    .then(() => {
      console.log('\n✅ Test completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Test failed:', error);
      process.exit(1);
    });
}

module.exports = { getAvailableDates, getWorkingHours, generateTimeSlots }; 