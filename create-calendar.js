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

async function createClinicCalendar() {
  try {
    const calendar = google.calendar('v3');
    
    const calendarResource = {
      summary: 'Code Clinic Appointments',
      description: 'Dental clinic appointment bookings from WhatsApp chatbot',
      timeZone: 'Asia/Kolkata',
      colorId: '2', // Blue color
      selected: true,
      accessRole: 'owner'
    };

    const response = await calendar.calendars.insert({
      auth: oAuth2Client,
      resource: calendarResource
    });

    console.log('✅ Calendar created successfully!');
    console.log('Calendar ID:', response.data.id);
    console.log('Calendar Name:', response.data.summary);
    console.log('Calendar Link:', response.data.htmlLink);
    
    // Set calendar as public for read access (optional)
    await calendar.acl.insert({
      auth: oAuth2Client,
      calendarId: response.data.id,
      resource: {
        role: 'reader',
        scope: {
          type: 'default'
        }
      }
    });

    console.log('\n📋 Add this to your .env file:');
    console.log(`GCAL_CALENDAR_ID=${response.data.id}`);
    
    return response.data.id;
  } catch (error) {
    console.error('❌ Error creating calendar:', error.message);
    throw error;
  }
}

// Run the function
createClinicCalendar()
  .then(calendarId => {
    console.log('\n🎉 Calendar setup complete!');
    console.log('Calendar ID:', calendarId);
  })
  .catch(err => {
    console.error('Failed to create calendar:', err);
  }); 