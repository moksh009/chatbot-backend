require('dotenv').config();
const cron = require('node-cron');
const { processUpcomingAppointments } = require('./utils/sendAppointmentReminder');

// WhatsApp API credentials
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// Time to run the job (7 AM IST)
const REMINDER_TIME = '0 7 * * *';

console.log('Scheduler started. Waiting for the next run at 7 AM IST...');

// Schedule the job to run daily at 7 AM IST
cron.schedule(REMINDER_TIME, async () => {
  try {
    console.log('Running appointment reminder job...');
    const result = await processUpcomingAppointments(PHONE_NUMBER_ID, ACCESS_TOKEN);
    console.log('Appointment reminder job completed:', result);
  } catch (error) {
    console.error('Error in appointment reminder job:', error);
  }
}, {
  scheduled: true,
  timezone: 'Asia/Kolkata' // IST
});

// For testing: Run immediately when started (comment out in production)
// (async () => {
//   try {
//     console.log('Running test reminder job...');
//     const result = await processUpcomingAppointments(PHONE_NUMBER_ID, ACCESS_TOKEN);
//     console.log('Test reminder job completed:', result);
//   } catch (error) {
//     console.error('Error in test reminder job:', error);
//   }
// })();

// Keep the process running
process.on('SIGINT', () => {
  console.log('Stopping scheduler...');
  process.exit(0);
});
