const { google } = require('googleapis');
require('dotenv').config();

const CLIENT_ID = process.env.GCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;
const REDIRECT_URI = process.env.GCAL_REDIRECT_URI;
const REFRESH_TOKEN = process.env.GCAL_REFRESH_TOKEN;

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

oAuth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

async function listCalendars() {
  try {
    const calendar = google.calendar('v3');
    
    const response = await calendar.calendarList.list({
      auth: oAuth2Client
    });

    console.log('📅 Available Calendars:');
    console.log('========================');
    
    response.data.items.forEach((cal, index) => {
      console.log(`${index + 1}. ${cal.summary}`);
      console.log(`   ID: ${cal.id}`);
      console.log(`   Access Role: ${cal.accessRole}`);
      console.log(`   Primary: ${cal.primary ? 'Yes' : 'No'}`);
      console.log(`   Timezone: ${cal.timeZone}`);
      console.log(`   Link: ${cal.htmlLink}`);
      console.log('---');
    });

    // Find primary calendar
    const primaryCalendar = response.data.items.find(cal => cal.primary);
    if (primaryCalendar) {
      console.log('🎯 Primary Calendar:');
      console.log(`   Name: ${primaryCalendar.summary}`);
      console.log(`   ID: ${primaryCalendar.id}`);
    }

  } catch (error) {
    console.error('❌ Error listing calendars:', error.message);
    throw error;
  }
}

// Run the function
listCalendars()
  .then(() => {
    console.log('\n✅ Calendar listing complete!');
  })
  .catch(err => {
    console.error('Failed to list calendars:', err);
  }); 