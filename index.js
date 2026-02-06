const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./db');
const Appointment = require('./models/Appointment');
const DailyStat = require('./models/DailyStat');
const Client = require('./models/Client');
const BirthdayUser = require('./models/BirthdayUser');
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
// const turfClientRoutes = require('./routes/clientcodes/turf'); // Deprecated in favor of dynamic router
// const vedClientRoutes = require('./routes/clientcodes/ved');   // Deprecated in favor of dynamic router
const dynamicClientRouter = require('./routes/dynamicClientRouter');
const trackingRoutes = require('./routes/tracking.js');

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
    console.warn(`⚠️  WARNING: Missing default WhatsApp config: ${missing.join(', ')}`);
    console.warn(`ℹ️  Server will rely on Client Database Configuration for WhatsApp credentials.`);
    // throw new Error(`Missing WhatsApp config: ${missing.join(', ')}`);
  }
})();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug Middleware: Log all incoming requests
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.originalUrl}`);
  next();
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/campaigns', campaignsRoutes);


// Dynamic Client Router (Replaces hardcoded client routes)
// Handles /api/client/:clientId/webhook
app.use('/api/client/:clientId', dynamicClientRouter);

// app.use('/api/client/0001', turfClientRoutes);
// app.use('/api/client/0002', vedClientRoutes);
app.use('/r', trackingRoutes);

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

  console.log(`⏰ It's 6:00 AM EAT — Running birthday check...`);

  try {
    const clients = await Client.find({});
    
    for (const client of clients) {
      const token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
      const phoneid = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
      const clientId = client.clientId;

      if (!token || !phoneid) {
        console.log(`⚠️ Skipping birthday check for client ${clientId} - missing WhatsApp credentials`);
        continue;
      }

      // Find birthday users for this client
      // Handle legacy data (no clientId) by assigning it to 'code_clinic_v1'
      let clientQuery = {
        day: currentDay,
        month: currentMonth,
        isOpted: true
      };

      if (clientId === 'code_clinic_v1') {
        clientQuery.$or = [{ clientId: clientId }, { clientId: { $exists: false } }];
      } else {
        clientQuery.clientId = clientId;
      }

      const todaysBirthdays = await BirthdayUser.find(clientQuery);

      if (todaysBirthdays.length === 0) continue;

      console.log(`🎉 Found ${todaysBirthdays.length} birthday(s) for client ${clientId}`);

      let successCount = 0;
      let failureCount = 0;

      async function incDaily(field) {
        const dateStr = eatNow.toISODate();
        await DailyStat.updateOne(
          { clientId: clientId, date: dateStr },
          { $inc: { [field]: 1 }, $setOnInsert: { clientId: clientId, date: dateStr } },
          { upsert: true }
        );
      }

      for (const user of todaysBirthdays) {
        try {
          const result = await sendBirthdayWishWithImage(user.number, token, phoneid, clientId);
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

      console.log(`🎂 Birthday messages for ${clientId} completed: ${successCount} sent, ${failureCount} failed`);
    }

  } catch (error) {
    console.error('❌ Error in birthday cron job:', error.message);
  }
});

// Cron job for appointment reminders (run daily at 7 AM)
cron.schedule('0 7 * * *', async () => {
  const eatNow = DateTime.utc().setZone('Africa/ahmedabad');
  const today = eatNow.toFormat('EEEE, dd MMM');

  console.log(`⏰ Running appointment reminder check for today (${today})...`);

  try {
    const clients = await Client.find({});
    const { listEvents } = require('./utils/googleCalendar');
    const { sendAppointmentReminder } = require('./utils/sendAppointmentReminder');

    for (const client of clients) {
      const token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
      const phoneid = client.phoneNumberId || process.env.WHATSAPP_PHONENUMBER_ID;
      const clientId = client.clientId;

      if (!token || !phoneid) continue;

      // Get events from both doctor calendars and main calendar
      const calendarIds = [];
      if (client.googleCalendarId) calendarIds.push(client.googleCalendarId);
      if (client.config && client.config.calendars) {
        calendarIds.push(...Object.values(client.config.calendars));
      }
      
      // Fallback for legacy Code Clinic if no specific calendars configured
      if (clientId === 'code_clinic_v1' && calendarIds.length === 0) {
        if (process.env.GCAL_CALENDAR_ID) calendarIds.push(process.env.GCAL_CALENDAR_ID);
        if (process.env.GCAL_CALENDAR_ID2) calendarIds.push(process.env.GCAL_CALENDAR_ID2);
      }

      if (calendarIds.length === 0) continue;

      const startOfDay = eatNow.startOf('day').toISO();
      const endOfDay = eatNow.endOf('day').toISO();
      
      let allTodayEvents = [];
      
      for (const calendarId of calendarIds) {
        try {
          const events = await listEvents(startOfDay, endOfDay, calendarId);
          allTodayEvents = allTodayEvents.concat(events);
        } catch (error) {
          console.error(`❌ Error fetching events from calendar ${calendarId} for client ${clientId}:`, error.message);
        }
      }

      if (allTodayEvents.length === 0) continue;

      console.log(`📅 Found ${allTodayEvents.length} events for client ${clientId}`);

      // Process each event and send reminders to users who have consented
      for (const event of allTodayEvents) {
        try {
          // Extract phone number from event description
          const phoneMatch = event.description?.match(/Phone:\s*([^\n]+)/);
          if (!phoneMatch) {
            // console.log(`⚠️ No phone number found in event: ${event.summary}`);
            continue;
          }
          
          const phoneNumber = phoneMatch[1].trim();
          
          // Check if user has consented to appointment reminders
          // Note: We search by phone. In future, we might want to verify they are associated with this client.
          const userAppointments = await Appointment.find({ 
            phone: phoneNumber,
            'consent.appointmentReminders': true 
          });
          
          if (userAppointments.length === 0) {
            // console.log(`❌ Skipping reminder for ${phoneNumber} - user has not consented to reminders`);
            continue;
          }

          // Extract appointment details from event
          const nameMatch = event.description?.match(/Name:\s*([^\n]+)/);
          const serviceMatch = event.description?.match(/Service:\s*([^\n]+)/);
          const doctorMatch = event.description?.match(/Doctor:\s*([^\n]+)/);
          
          const patientName = nameMatch ? nameMatch[1].trim() : "Valued Customer";
          const service = serviceMatch ? serviceMatch[1].trim() : "Service";
          const doctor = doctorMatch ? doctorMatch[1].trim() : "Our Professional";

          // Format appointment time
          const eventTime = DateTime.fromISO(event.start.dateTime).setZone('Africa/ahmedabad');
          const time = eventTime.toFormat('h:mm a');

          await sendAppointmentReminder(phoneid, token, phoneNumber, {
            summary: event.summary || `Appointment: ${patientName} - ${service} with ${doctor}`,
            start: event.start.dateTime,
            doctor: doctor,
            date: today,
            time: time
          }, clientId);

          console.log(`✅ Appointment reminder sent to ${phoneNumber} for ${time}`);
          try {
            const dateStr = eatNow.toISODate();
            await DailyStat.updateOne(
              { clientId: clientId, date: dateStr },
              { $inc: { appointmentRemindersSent: 1 }, $setOnInsert: { clientId: clientId, date: dateStr } },
              { upsert: true }
            );
          } catch {}
          
          // Add delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`❌ Error processing appointment reminder for event ${event.id}:`, error.message);
        }
      }
      console.log(`🎯 Appointment reminders completed for client ${clientId}`);
    }

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
