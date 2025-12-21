require('dotenv').config();
const axios = require('axios');

// Get credentials from environment variables
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const TEST_PHONE = process.env.TEST_PHONE_NUMBER;

// Test message with exact template name and named parameters
const testMessage = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: `+${TEST_PHONE}`,
  type: 'template',
  template: {
    name: 'appointment_reminder_1',
    language: { 
      code: 'en'
    },
    components: [
      {
        "type": "body",
        "parameters": [
          {
            "type": "text",
            "parameter_name": "patient_name_rmndr",
            "text": "John Doe"
          },
          {
            "type": "text",
            "parameter_name": "service_name_rmndr",
            "text": "Dental Checkup"
          },
          {
            "type": "text",
            "parameter_name": "doctor_name_rmndr",
            "text": "Dr. Smith"
          },
          {
            "type": "text",
            "parameter_name": "time_slot_rmndr",
            "text": "10:00 AM"
          },
          {
            "type": "text",
            "parameter_name": "date_rmndr",
            "text": "August 4, 2025"
          }
        ]
      }
    ]
  }
};

// Function to send the test message
async function sendTestMessage() {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || !TEST_PHONE) {
    console.error('Missing required environment variables. Please check your .env file.');
    process.exit(1);
  }

  const url = `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`;
  
  console.log('Sending test message to:', TEST_PHONE);
  console.log('Using template: appointment_reminder_1');
  console.log('Request payload:', JSON.stringify(testMessage, null, 2));
  
  try {
    const response = await axios.post(url, testMessage, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Message sent successfully!');
    console.log('Response:', response.data);
  } catch (error) {
    console.error('Error sending message:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    
    // Additional debug info
    if (error.response?.data?.error?.error_data?.details) {
      console.error('\nTemplate Error Details:');
      console.error(error.response.data.error.error_data.details);
    }
  }
}

// Run the test
sendTestMessage();
