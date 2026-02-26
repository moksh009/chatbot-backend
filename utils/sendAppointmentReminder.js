const { DateTime } = require('luxon');
const axios = require('axios');
const { listEvents } = require('./googleCalendar');
const BirthdayUser = require('../models/BirthdayUser');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Client = require('../models/Client');

// Timezone for India (IST - Indian Standard Time)
const TIMEZONE = 'Asia/Kolkata';

/**
 * Sends a WhatsApp reminder for an upcoming appointment
 */
async function sendAppointmentReminder(phoneNumberId, accessToken, recipientPhone, appointmentDetails, clientId, templateNameOverride = null) {
  try {
    const apiVersion = process.env.API_VERSION || process.env.WHATSAPP_API_VERSION || 'v18.0';
    const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
    const { summary, start, doctor, date, time } = appointmentDetails;

    // Extract patient name from summary (format: "Appointment: Name - Service with Doctor")
    const patientName = summary.split(':')[1]?.split('-')[0]?.trim() || "Valued Patient";
    const serviceName = summary.split('-')[1]?.split('with')[0]?.trim() || "Dental Service";

    // Determine template name
    // Priority: Override > Client Config > Default
    let templateName = templateNameOverride || "appointment_reminder_1";

    if (!templateNameOverride && clientId && clientId !== 'code_clinic_v1') {
      try {
        const client = await Client.findOne({ clientId });
        if (client?.config?.templates?.appointment) {
          templateName = client.config.templates.appointment;
        }
      } catch (e) { console.error('Error fetching client config for template:', e); }
    }

    // Format the reminder message according to the template
    const message = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLang },
        components: [
          // Body parameters
          {
            type: 'body',
            parameters: [
              // {{1}} patient_name_rmndr
              { type: 'text', text: patientName },
              // {{2}} service_name_rmndr
              { type: 'text', text: serviceName },
              // {{3}} doctor_name_rmndr
              { type: 'text', text: doctor || 'Our Doctor' },
              // {{4}} time_slot_rmndr
              { type: 'text', text: time },
              // {{5}} date_rmndr
              { type: 'text', text: date }
            ]
          },
          // Quick reply buttons
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [
              { type: 'payload', payload: 'CONFIRM_APPOINTMENT' }
            ]
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '1',
            parameters: [
              { type: 'payload', payload: 'RESCHEDULE_APPOINTMENT' }
            ]
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '2',
            parameters: [
              { type: 'payload', payload: 'STOP' }
            ]
          }
        ]
      }
    };

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    console.log('Sending message to:', url);
    console.log('Message payload:', JSON.stringify(message, null, 2));

    const response = await axios.post(url, message, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      validateStatus: (status) => status < 500
    });
    console.log('Appointment API response:', response.status, response.data);

    try {
      const finalClientId = clientId || 'code_clinic_v1';
      let conversation = await Conversation.findOne({ phone: recipientPhone, clientId: finalClientId });
      if (!conversation) {
        conversation = await Conversation.create({ phone: recipientPhone, clientId: finalClientId, status: 'BOT_ACTIVE', lastMessageAt: new Date() });
      }
      const saved = await Message.create({
        clientId: finalClientId,
        conversationId: conversation._id,
        from: 'bot',
        to: recipientPhone,
        content: 'Appointment reminder',
        type: 'template',
        direction: 'outgoing',
        status: 'sent'
      });
      conversation.lastMessage = 'Appointment reminder';
      conversation.lastMessageAt = new Date();
      await conversation.save();
    } catch { }
    return response.data;
  } catch (error) {
    console.error('Error sending appointment reminder:', error.response?.data || error.message);
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
