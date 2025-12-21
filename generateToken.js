const { google } = require('googleapis');
const readline = require('readline');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// Set up OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GCAL_CLIENT_ID,
  process.env.GCAL_CLIENT_SECRET,
  process.env.GCAL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
);

// Generate the URL for OAuth2 consent page
const scopes = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];

async function generateNewToken() {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  });

  console.log('\n🔑 Authorize this app by visiting this URL:');
  console.log(authUrl);
  console.log('\nAfter authorizing, you will be redirected. Copy the code from the URL and paste it below.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve, reject) => {
    rl.question('Enter the code from the URL: ', async (code) => {
      try {
        const { tokens } = await oauth2Client.getToken(code);
        rl.close();

        // Print tokens to terminal
        console.log('\n✅ Here are your new Google Calendar tokens:');
        console.log('------------------------------------------');
        console.log('GCAL_ACCESS_TOKEN=' + tokens.access_token);
        console.log('GCAL_REFRESH_TOKEN=' + tokens.refresh_token);
        console.log('------------------------------------------');
        console.log('\nCopy these values and add them to your .env file manually.');
        resolve(tokens);
      } catch (error) {
        console.error('❌ Error getting tokens:', error.message);
        rl.close();
        reject(error);
      }
    });
  });
}

// Run the token generation
generateNewToken()
  .then(() => {
    console.log('\n🎉 Token generation complete!');
  })
  .catch(console.error);