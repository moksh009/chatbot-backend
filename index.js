const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./db');
const Appointment = require('./models/Appointment');
const DailyStat = require('./models/DailyStat');
const Client = require('./models/Client');
const cron = require('node-cron');
const { DateTime } = require('luxon');
// Load birthday data
const birthdayData = require('./birthdays.json');
const { sendBirthdayWishWithImage } = require('./utils/sendBirthdayMessage');
// Load environment variables
// dotenv.config();
// Silence .env missing warning
const dotenvResult = dotenv.config();
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
  console.error("Dotenv Error:", dotenvResult.error);
}
// If ENOENT, it just means no file, which is fine if envs are injected otherwise.


const cors = require('cors');
const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const appointmentRoutes = require('./routes/appointments');
const analyticsRoutes = require('./routes/analytics');
const campaignsRoutes = require('./routes/campaigns');
const turfClientRoutes = require('./routes/clientcodes/turf');
const vedClientRoutes = require('./routes/clientcodes/ved');

const app = express();
const PORT = process.env.PORT || 3000;

// WhatsApp Cloud API env validation (hard fail if missing)
function resolveWhatsAppConfig() {
  const token = process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONENUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.API_VERSION || process.env.WHATSAPP_API_VERSION || 'v18.0';
  return { token, phoneId, apiVersion };
}
(() => {
  const { token, phoneId } = resolveWhatsAppConfig();
  const required = [
    ['WHATSAPP_TOKEN', 'WHATSAPP_ACCESS_TOKEN'],
    ['WHATSAPP_PHONENUMBER_ID', 'WHATSAPP_PHONE_NUMBER_ID']
  ];
  const missing = [];
  if (!token) missing.push('WHATSAPP_TOKEN|WHATSAPP_ACCESS_TOKEN');
  if (!phoneId) missing.push('WHATSAPP_PHONENUMBER_ID|WHATSAPP_PHONE_NUMBER_ID');
  if (missing.length) {
    throw new Error(`Missing WhatsApp config: ${missing.join(', ')}`);
  }
})();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/campaigns', campaignsRoutes);


app.use('/api/client/0001', turfClientRoutes);
app.use('/api/client/0002', vedClientRoutes);

// Homepage endpoint
app.get('/homepage', (req, res) => {
  res.status(200).json({
    message: 'Hello World',
    status: 'success'
  });
});


app.post('/keepalive-ping', (req, res) => {
  console.log(`🔁 Keepalive ping received at ${new Date().toISOString()}`);
  res.status(200).json({ message: 'Server is awake!' });
});

// Cron job for birthday messages and appointment reminders
cron.schedule('0 6 * * *', async () => {
  const eatNow = DateTime.utc().setZone('Africa/ahmedabad');
  const currentDay = eatNow.day;
  const currentMonth = eatNow.month;
  const token = process.env.WHATSAPP_TOKEN;
  const phoneid = process.env.WHATSAPP_PHONENUMBER_ID;

  console.log(`⏰ It's 6:00 AM EAT — Running birthday check...`);

  try {
    // Send birthday messages to users who have consented
    const todaysBirthdays = await BirthdayUser.find({
      day: currentDay,
      month: currentMonth,
      isOpted: true,
    });

    console.log(`🎉 Found ${todaysBirthdays.length} birthday(s) to process`);

    let successCount = 0;
    let failureCount = 0;
    const clientRec = await Client.findOne({ phoneNumberId: phoneid });
    const resolvedClientId = clientRec ? clientRec.clientId : 'code_clinic_v1';
    async function incDaily(field) {
      const dateStr = eatNow.toISODate();
      await DailyStat.updateOne(
        { clientId: resolvedClientId, date: dateStr },
        { $inc: { [field]: 1 }, $setOnInsert: { clientId: resolvedClientId, date: dateStr } },
        { upsert: true }
      );
    }

    for (const user of todaysBirthdays) {
      try {
        const result = await sendBirthdayWishWithImage(user.number, token, phoneid);
        if (result.success) {
          successCount++;
          await incDaily('birthdayRemindersSent');
        } else {
          failureCount++;
          console.log(`❌ Birthday message failed for ${user.number}: ${result.reason || result.error}`);
        }
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`❌ Error sending birthday message to ${user.number}:`, error.message);
        failureCount++;
      }
    }

    console.log(`🎂 Birthday messages completed: ${successCount} sent, ${failureCount} failed`);

  } catch (error) {
    console.error('❌ Error in birthday cron job:', error.message);
  }
});

// Cron job for appointment reminders (run daily at 7 AM)
cron.schedule('0 7 * * *', async () => {
  const eatNow = DateTime.utc().setZone('Africa/ahmedabad');
  const today = eatNow.toFormat('EEEE, dd MMM');
  const token = process.env.WHATSAPP_TOKEN;
  const phoneid = process.env.WHATSAPP_PHONENUMBER_ID;

  console.log(`⏰ Running appointment reminder check for today (${today})...`);

  try {
    // Get all events from Google Calendar for today
    const startOfDay = eatNow.startOf('day').toISO();
    const endOfDay = eatNow.endOf('day').toISO();
    
    // Get events from both doctor calendars
    const calendarIds = [process.env.GCAL_CALENDAR_ID, process.env.GCAL_CALENDAR_ID2];
    const { listEvents } = require('./utils/googleCalendar');
    
    let allTodayEvents = [];
    
    for (const calendarId of calendarIds) {
      try {
        const events = await listEvents(startOfDay, endOfDay, calendarId);
        allTodayEvents = allTodayEvents.concat(events);
      } catch (error) {
        console.error(`❌ Error fetching events from calendar ${calendarId}:`, error.message);
      }
    }

    console.log(`📅 Found ${allTodayEvents.length} events in Google Calendar for today`);

    // Process each event and send reminders to users who have consented
    for (const event of allTodayEvents) {
      try {
        // Extract phone number from event description
        const phoneMatch = event.description?.match(/Phone:\s*([^\n]+)/);
        if (!phoneMatch) {
          console.log(`⚠️ No phone number found in event: ${event.summary}`);
          continue;
        }
        
        const phoneNumber = phoneMatch[1].trim();
        
        // Check if user has consented to appointment reminders
        const userAppointments = await Appointment.find({ 
          phone: phoneNumber,
          'consent.appointmentReminders': true 
        });
        
        if (userAppointments.length === 0) {
          console.log(`❌ Skipping reminder for ${phoneNumber} - user has not consented to reminders`);
          continue;
        }

        // Extract appointment details from event
        const nameMatch = event.description?.match(/Name:\s*([^\n]+)/);
        const serviceMatch = event.description?.match(/Service:\s*([^\n]+)/);
        const doctorMatch = event.description?.match(/Doctor:\s*([^\n]+)/);
        
        const patientName = nameMatch ? nameMatch[1].trim() : "Valued Player";
        const service = serviceMatch ? serviceMatch[1].trim() : "Dental Service";
        const doctor = doctorMatch ? doctorMatch[1].trim() : "Our Doctor";

        // Format appointment time
        const eventTime = DateTime.fromISO(event.start.dateTime).setZone('Africa/ahmedabad');
        const time = eventTime.toFormat('h:mm a');

        // Send appointment reminder using template
        const { sendAppointmentReminder } = require('./utils/sendAppointmentReminder');
        await sendAppointmentReminder(phoneid, token, phoneNumber, {
          summary: event.summary,
          start: event.start.dateTime,
          doctor: doctor,
          date: today,
          time: time
        });

        console.log(`✅ Appointment reminder sent to ${phoneNumber} for ${time}`);
        try {
          const clientRec = await Client.findOne({ phoneNumberId: phoneid });
          const resolvedClientId = clientRec ? clientRec.clientId : 'code_clinic_v1';
          const dateStr = eatNow.toISODate();
          await DailyStat.updateOne(
            { clientId: resolvedClientId, date: dateStr },
            { $inc: { appointmentRemindersSent: 1 }, $setOnInsert: { clientId: resolvedClientId, date: dateStr } },
            { upsert: true }
          );
        } catch {}
        
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`❌ Error processing appointment reminder for event ${event.id}:`, error.message);
      }
    }

    console.log(`🎯 Appointment reminders completed for ${today}`);

  } catch (err) {
    console.error('❌ Error in appointment reminder cron job:', err);
  }
});
  
const http = require('http');
const socketIo = require('socket.io');

console.log(`Starting server on port ${PORT}...`);

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

app.set('socketio', io);

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Join room based on clientId if provided in query
  const clientId = socket.handshake.query.clientId;
  if (clientId) {
    socket.join(`client_${clientId}`);
    console.log(`Socket ${socket.id} joined room client_${clientId}`);
  }

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`✅ Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed", err);
    process.exit(1);
  });

module.exports = app;
