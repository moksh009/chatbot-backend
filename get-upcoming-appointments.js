require('dotenv').config();
const { google } = require('googleapis');

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

// Get next 7 working days
function getNext7WorkingDays() {
  const workingDays = [];
  const today = new Date();
  
  // Start from today
  let currentDate = new Date(today);
  
  while (workingDays.length < 7) {
    const dayOfWeek = currentDate.getDay();
    const workingHours = getWorkingHours(dayOfWeek);
    
    if (workingHours.isOpen) {
      workingDays.push({
        date: new Date(currentDate),
        dayOfWeek: dayOfWeek,
        workingHours: workingHours
      });
    }
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return workingDays;
}

// Format date for display
function formatDate(date) {
  const options = { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric',
    timeZone: 'Africa/Nairobi'
  };
  return date.toLocaleDateString('en-US', options);
}

// Format time for display
function formatTime(timeString) {
  const [hours, minutes] = timeString.split(':');
  const hour = parseInt(hours);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minutes} ${ampm}`;
}

// Get appointments for a specific date range
async function getAppointments(startDate, endDate) {
  try {
    const calendar = google.calendar({ version: 'v3', auth: initializeOAuth2Client() });
    const CALENDAR_ID = process.env.GCAL_CALENDAR_ID;
    
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    return response.data.items || [];
  } catch (error) {
    console.error('Error fetching appointments:', error);
    return [];
  }
}

// Main function to get upcoming appointments
async function getUpcomingAppointments() {
  try {
    console.log('🏥 Code Clinic - Upcoming Appointments Report');
    console.log('=' .repeat(50));
    
    // Get next 7 working days
    const workingDays = getNext7WorkingDays();
    
    // Calculate date range (from today to end of 7th working day)
    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(workingDays[6].date);
    endDate.setHours(23, 59, 59, 999);
    
    console.log(`📅 Date Range: ${formatDate(startDate)} to ${formatDate(endDate)}`);
    console.log(`⏰ Working Days: ${workingDays.length} days`);
    console.log('');
    
    // Get all appointments in the date range
    const allAppointments = await getAppointments(startDate, endDate);
    
    if (allAppointments.length === 0) {
      console.log('✅ No appointments found in the upcoming 7 working days!');
      return;
    }
    
    // Group appointments by day
    const appointmentsByDay = {};
    
    workingDays.forEach(day => {
      const dateKey = day.date.toISOString().split('T')[0];
      appointmentsByDay[dateKey] = {
        dayInfo: day,
        appointments: []
      };
    });
    
    // Filter and categorize appointments
    allAppointments.forEach(appointment => {
      const startTime = new Date(appointment.start.dateTime || appointment.start.date);
      const dateKey = startTime.toISOString().split('T')[0];
      
      if (appointmentsByDay[dateKey]) {
        const dayInfo = appointmentsByDay[dateKey].dayInfo;
        const workingHours = dayInfo.workingHours;
        
        // Check if appointment is within working hours
        const appointmentHour = startTime.getHours();
        const appointmentMinute = startTime.getMinutes();
        const appointmentTime = `${appointmentHour.toString().padStart(2, '0')}:${appointmentMinute.toString().padStart(2, '0')}`;
        
        const [startHour] = workingHours.start.split(':').map(Number);
        const [endHour] = workingHours.end.split(':').map(Number);
        
        const isWithinHours = appointmentHour >= startHour && appointmentHour < endHour;
        
        appointmentsByDay[dateKey].appointments.push({
          ...appointment,
          startTime: startTime,
          appointmentTime: appointmentTime,
          isWithinHours: isWithinHours
        });
      }
    });
    
    // Display results
    let totalAppointments = 0;
    let totalWithinHours = 0;
    let totalOutsideHours = 0;
    
    workingDays.forEach(day => {
      const dateKey = day.date.toISOString().split('T')[0];
      const dayData = appointmentsByDay[dateKey];
      const appointments = dayData.appointments;
      
      console.log(`📅 ${formatDate(day.date)}`);
      console.log(`⏰ Working Hours: ${formatTime(day.workingHours.start)} - ${formatTime(day.workingHours.end)}`);
      
      if (appointments.length === 0) {
        console.log('   ✅ No appointments');
      } else {
        const withinHours = appointments.filter(apt => apt.isWithinHours);
        const outsideHours = appointments.filter(apt => !apt.isWithinHours);
        
        totalAppointments += appointments.length;
        totalWithinHours += withinHours.length;
        totalOutsideHours += outsideHours.length;
        
        // Display appointments within working hours
        if (withinHours.length > 0) {
          console.log(`   📋 Appointments (${withinHours.length}):`);
          withinHours.forEach(apt => {
            const time = apt.startTime.toLocaleTimeString('en-US', { 
              hour: 'numeric', 
              minute: '2-digit',
              hour12: true,
              timeZone: 'Africa/Nairobi'
            });
            const summary = apt.summary || 'No title';
            console.log(`      ⏰ ${time} - ${summary}`);
          });
        }
        
        // Display appointments outside working hours (if any)
        if (outsideHours.length > 0) {
          console.log(`   ⚠️  Outside Working Hours (${outsideHours.length}):`);
          outsideHours.forEach(apt => {
            const time = apt.startTime.toLocaleTimeString('en-US', { 
              hour: 'numeric', 
              minute: '2-digit',
              hour12: true,
              timeZone: 'Africa/Nairobi'
            });
            const summary = apt.summary || 'No title';
            console.log(`      ⏰ ${time} - ${summary}`);
          });
        }
      }
      
      console.log('');
    });
    
    // Summary
    console.log('📊 SUMMARY');
    console.log('=' .repeat(30));
    console.log(`Total Appointments: ${totalAppointments}`);
    console.log(`Within Working Hours: ${totalWithinHours}`);
    console.log(`Outside Working Hours: ${totalOutsideHours}`);
    console.log(`Working Days Covered: ${workingDays.length}`);
    
    if (totalOutsideHours > 0) {
      console.log('\n⚠️  Note: Some appointments are scheduled outside working hours!');
    }
    
  } catch (error) {
    console.error('❌ Error generating report:', error);
  }
}

// Run the script
if (require.main === module) {
  getUpcomingAppointments()
    .then(() => {
      console.log('\n✅ Report completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { getUpcomingAppointments }; 