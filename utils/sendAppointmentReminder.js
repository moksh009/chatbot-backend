const { DateTime } = require('luxon');
const { listEvents } = require('./googleCalendar');
const BirthdayUser = require('../models/BirthdayUser');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');
const WhatsApp = require('./whatsapp');
const { createMessage } = require('./createMessage');

// Timezone for India (IST - Indian Standard Time)
const TIMEZONE = 'Asia/Kolkata';

/**
 * Sends a WhatsApp reminder for an upcoming appointment
 */
async function sendAppointmentReminder(unused_phoneId, unused_token, recipientPhone, appointmentDetails, clientId, templateNameOverride = null) {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) throw new Error('Client not found');

    const { summary, doctor, date, time } = appointmentDetails;

    // Extract patient name from summary
    const patientName = summary.split(':')[1]?.split('-')[0]?.trim() || "Valued Patient";
    const serviceName = summary.split('-')[1]?.split('with')[0]?.trim() || "Service";

    let templateName = templateNameOverride || (client.config?.templates?.appointment) || "appointment_reminder_1";

    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: patientName },
          { type: 'text', text: serviceName },
          { type: 'text', text: doctor || 'Our team' },
          { type: 'text', text: time || 'scheduled time' },
          { type: 'text', text: date || 'scheduled date' }
        ]
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: 'CONFIRM_APPOINTMENT' }]
      },
      {
        type: 'button',
        sub_type: 'quick_reply',
        index: '1',
        parameters: [{ type: 'payload', payload: 'RESCHEDULE_APPOINTMENT' }]
      }
    ];

    await WhatsApp.sendTemplate(client, recipientPhone, templateName, 'en_US', components);

    // Save to DB
    await createMessage({
        clientId: client.clientId,
        phone: recipientPhone,
        direction: 'outbound',
        type: 'template',
        body: `[Appointment Reminder: ${templateName}]`
    });

    return { success: true };
  } catch (error) {
    console.error('Error sending appointment reminder:', error.message);
    throw error;
  }
}

/**
 * Processes all upcoming appointments and sends reminders
 */
async function processUpcomingAppointments(phoneNumberId, accessToken) {
  try {
    const now = DateTime.now().setZone(TIMEZONE);
    const startOfDay = now.startOf('day').toISO();
    const endOfDay = now.plus({ days: 1 }).endOf('day').toISO();

    // Get all events for today
    const events = await listEvents(startOfDay, endOfDay);

    // Filter events that are in the future and have a phone number
    const upcomingAppointments = events.filter(event => {
      const eventTime = DateTime.fromISO(event.start.dateTime).setZone(TIMEZONE);
      return eventTime > now &&
        event.description &&
        event.description.includes('Phone:');
    });

    console.log(`Found ${upcomingAppointments.length} upcoming appointments`);

    // Process each appointment
    for (const event of upcomingAppointments) {
      try {
        // Extract phone number from event description
        const phoneMatch = event.description.match(/Phone:\s*([^\n]+)/);
        if (!phoneMatch) continue;

        const phoneNumber = phoneMatch[1].trim();

        // Check if user has consented to appointment reminders
        const Appointment = require('../models/Appointment');
        const userAppointments = await Appointment.find({
          phone: phoneNumber,
          'consent.appointmentReminders': true,
          clientId: { $nin: ['choice_salon', 'choice_salon_holi'] } // USER REQUEST: Stop sending reminders for Choice Salon & Choice Holi
        });

        if (userAppointments.length === 0) {
          console.log(`Skipping reminder for ${phoneNumber} - user has not consented or it's a Choice Salon appointment.`);
          continue;
        }

        // Extract doctor name if available
        const doctorMatch = event.description.match(/Doctor:\s*([^\n]+)/);
        const doctor = doctorMatch ? doctorMatch[1].trim() : '';

        // Format date and time
        const eventTime = DateTime.fromISO(event.start.dateTime).setZone(TIMEZONE);
        const date = eventTime.toFormat('EEEE, MMMM d, yyyy');
        const time = eventTime.toFormat('h:mm a');

        // Send reminder
        await sendAppointmentReminder(phoneNumberId, accessToken, phoneNumber, {
          summary: event.summary,
          start: event.start.dateTime,
          doctor,
          date,
          time
        });

        console.log(`Sent reminder for appointment: ${event.summary} at ${time} on ${date}`);

        // Add a small delay between sending reminders to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`Error processing appointment ${event.id}:`, error.message);
        // Continue with the next appointment even if one fails
      }
    }

    return { success: true, remindersSent: upcomingAppointments.length };
  } catch (error) {
    console.error('Error in processUpcomingAppointments:', error);
    throw error;
  }
}

module.exports = {
  sendAppointmentReminder,
  processUpcomingAppointments
};
