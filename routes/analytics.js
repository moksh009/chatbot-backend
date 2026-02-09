const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Appointment = require('../models/Appointment');
const DailyStat = require('../models/DailyStat');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const Client = require('../models/Client');
const { listEvents } = require('../utils/googleCalendar');
const { protect } = require('../middleware/auth');

router.get('/realtime', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    // Fallback/Merge for development: If user is on legacy default, show Delitech data
    const query = (clientId === 'code_clinic_v1') 
        ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } }
        : { clientId };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 1. Leads Count (Total & Today)
    const totalLeads = await AdLead.countDocuments(query);
    const newLeadsToday = await AdLead.countDocuments({ 
        ...query,
        createdAt: { $gte: today } 
    });

    // 2. Orders & Revenue (Today)
    const ordersToday = await Order.find({ 
        ...query,
        createdAt: { $gte: today } 
    });
    
    const revenueToday = ordersToday.reduce((sum, order) => sum + order.amount, 0);
    const orderCountToday = ordersToday.length;

    // 3. Link Clicks (Total)
    const linkClicksResult = await AdLead.aggregate([
        { $match: query },
        { $group: { _id: null, totalClicks: { $sum: "$linkClicks" } } }
    ]);
    const totalLinkClicks = linkClicksResult[0]?.totalClicks || 0;

    // 4. Agent Requests (Today)
    const todayStr = today.toISOString().split('T')[0];
    const dailyStats = await DailyStat.find({ 
        ...query,
        date: todayStr 
    });
    const agentRequestsToday = dailyStats.reduce((sum, ds) => sum + (ds.agentRequests || 0), 0);
    
    // 5. Add to Cart (Total from Leads)
    // We aggregate all addToCartCount from leads
    const cartResult = await AdLead.aggregate([
        { $match: query },
        { $group: { _id: null, totalCarts: { $sum: "$addToCartCount" } } }
    ]);
    const totalAddCarts = cartResult[0]?.totalCarts || 0;

    res.json({
        leads: { total: totalLeads, newToday: newLeadsToday },
        orders: { count: orderCountToday, revenue: revenueToday },
        linkClicks: totalLinkClicks,
        agentRequests: agentRequestsToday,
        addToCarts: totalAddCarts
    });

  } catch (error) {
    console.error('Realtime Analytics Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

router.get('/leads', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    const query = (clientId === 'code_clinic_v1') 
        ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } }
        : { clientId };

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const leads = await AdLead.find(query)
        .sort({ lastInteraction: -1 })
        .skip(skip)
        .limit(limit);

    const total = await AdLead.countDocuments(query);

    res.json({
        leads,
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalLeads: total
    });

  } catch (error) {
    console.error('Leads Fetch Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/lead/:id (Detailed Lead View)
router.get('/lead/:id', protect, async (req, res) => {
    try {
        const lead = await AdLead.findById(req.params.id);
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        
        // Fetch related orders
        const orders = await Order.find({ phone: lead.phoneNumber, clientId: lead.clientId });
        
        // Fetch related appointments
        const appointments = await Appointment.find({ phone: lead.phoneNumber, clientId: lead.clientId });

        // Fetch conversation summary
        const conversation = await Conversation.findOne({ phone: lead.phoneNumber, clientId: lead.clientId });

        res.json({
            lead,
            orders,
            appointments,
            conversation
        });
    } catch (error) {
        console.error('Lead Detail Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// GET /api/analytics/top-leads
router.get('/top-leads', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const query = (clientId === 'code_clinic_v1') 
            ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } }
            : { clientId };

        const leads = await AdLead.find(query)
            .sort({ leadScore: -1 })
            .limit(20)
            .select('name phoneNumber leadScore tags lastInteraction ordersCount totalSpent');

        res.json(leads);
    } catch (error) {
        console.error('Top Leads Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// GET /api/analytics/receptionist-overview
router.get('/receptionist-overview', protect, async (req, res) => {
    try {
        const clientId = req.user.clientId;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Fetch client for Google Calendar IDs
        const client = await Client.findOne({ clientId });
        
        // Collect all calendar IDs
        const calendarIds = new Set();
        if (client?.googleCalendarId) calendarIds.add(client.googleCalendarId);
        
        // Add stylist calendars from config
        if (client?.config?.calendars) {
            Object.values(client.config.calendars).forEach(id => calendarIds.add(id));
        }
        
        // Default to 'primary' if no calendars found
        if (calendarIds.size === 0) calendarIds.add('primary');

        // 1. Fetch Google Calendar Events for Today (from ALL calendars)
        let googleEvents = [];
        try {
             const calendarPromises = Array.from(calendarIds).map(calId => 
                listEvents(today.toISOString(), tomorrow.toISOString(), calId)
                    .catch(err => {
                        console.error(`GCal fetch error for ${calId}:`, err.message);
                        return [];
                    })
             );
             
             const results = await Promise.all(calendarPromises);
             // Flatten results
             googleEvents = results.flat();
             
             // Remove duplicates based on event ID (just in case)
             const uniqueEvents = new Map();
             googleEvents.forEach(e => uniqueEvents.set(e.id, e));
             googleEvents = Array.from(uniqueEvents.values());
             
        } catch (gErr) {
             console.error('GCal fetch error in receptionist-overview:', gErr.message);
        }

        // 2. Fetch DB Appointments for today
        // Construct date string matching DB format: "Monday, 09 Feb" (Africa/Nairobi timezone used in creation)
        const dateOptions = { weekday: 'long', day: '2-digit', month: 'short', timeZone: 'Africa/Nairobi' };
        const todayDateString = today.toLocaleDateString('en-GB', dateOptions); 
        
        const dbAppointments = await Appointment.find({
            clientId,
            date: todayDateString,
            status: { $ne: 'cancelled' }
        });

        // 3. Merge Events
        const mergedAppointments = googleEvents.map(event => {
            const dbAppt = dbAppointments.find(a => a.eventId === event.id);
            const startDateTime = event.start.dateTime || event.start.date;
            
            return {
                _id: dbAppt?._id || event.id,
                customerName: dbAppt?.name || event.summary || 'Unknown Client',
                customerPhone: dbAppt?.phone || '',
                date: startDateTime, 
                serviceType: dbAppt?.service || event.description || 'External Booking',
                status: dbAppt?.status || 'confirmed',
                source: dbAppt ? 'chatbot' : 'external'
            };
        });
        
        // Add DB-only appointments (not in GCal)
        const gcalEventIds = new Set(googleEvents.map(e => e.id));
        
        dbAppointments.forEach(appt => {
            if (!appt.eventId || !gcalEventIds.has(appt.eventId)) {
                 // Construct ISO date from time string
                 let startISO = new Date().toISOString(); 
                 try {
                    const timeParts = appt.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
                    if (timeParts) {
                        let hours = parseInt(timeParts[1]);
                        const minutes = parseInt(timeParts[2]);
                        const ampm = timeParts[3].toUpperCase();
                        if (ampm === 'PM' && hours < 12) hours += 12;
                        if (ampm === 'AM' && hours === 12) hours = 0;
                        
                        const d = new Date(today);
                        d.setHours(hours, minutes, 0, 0);
                        startISO = d.toISOString();
                    }
                 } catch (e) {}

                 mergedAppointments.push({
                     _id: appt._id,
                     customerName: appt.name,
                     customerPhone: appt.phone,
                     date: startISO,
                     serviceType: appt.service,
                     status: appt.status,
                     source: 'chatbot'
                 });
            }
        });
        
        // Sort by date
        mergedAppointments.sort((a, b) => new Date(a.date) - new Date(b.date));

        // 2. Pending Agent Requests
        const recentChats = await Conversation.find({
            clientId,
            updatedAt: { $gte: today }
        }).sort({ updatedAt: -1 }).limit(10);

        // 3. High Value Leads active today
        const activeVIPs = await AdLead.find({
            clientId,
            lastInteraction: { $gte: today },
            leadScore: { $gt: 50 }
        }).select('name phoneNumber leadScore tags');

        res.json({
            appointments: mergedAppointments,
            recentChats,
            activeVIPs
        });
    } catch (error) {
        console.error('Receptionist Overview Error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const endDate = new Date();
    const startDate = new Date();
    const days = parseInt(req.query.days) || 30;
    startDate.setDate(startDate.getDate() - days);

    // Helper to generate date range (YYYY-MM-DD)
    const dates = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().split('T')[0]);
    }

    // 1. Aggregation for Conversations (Started per day)
    const chatsStarted = await Conversation.aggregate([
      { 
        $match: { 
          clientId, 
          createdAt: { $gte: startDate, $lte: endDate } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      }
    ]);

    // 2. Aggregation for Unique Users (Active per day - using updatedAt)
    const activeUsers = await Conversation.aggregate([
      { 
        $match: { 
          clientId, 
          updatedAt: { $gte: startDate, $lte: endDate } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$updatedAt" } },
          count: { $sum: 1 } // Approximate "Unique Users active"
        }
      }
    ]);

    // 3. Aggregation for Appointments
    const appointments = await Appointment.aggregate([
      { 
        $match: { 
          clientId, 
          createdAt: { $gte: startDate, $lte: endDate } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 }
        }
      }
    ]);

    // 4. Aggregation for Messages
    const messages = await Message.aggregate([
      { 
        $match: { 
          clientId, 
          timestamp: { $gte: startDate, $lte: endDate } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
          count: { $sum: 1 }
        }
      }
    ]);

    // 5. DailyStat for reminders
    const reminderStats = await DailyStat.find({ clientId, date: { $gte: dates[0], $lte: dates[dates.length - 1] } });

    // 6. Aggregation for Orders (Revenue & Count)
    const orders = await Order.aggregate([
      { 
        $match: { 
          clientId, 
          createdAt: { $gte: startDate, $lte: endDate } 
        } 
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
          revenue: { $sum: "$amount" }
        }
      }
    ]);

    // Merge Data
    const stats = dates.map(date => {
      const chatCount = chatsStarted.find(c => c._id === date)?.count || 0;
      const userCount = activeUsers.find(c => c._id === date)?.count || 0;
      const apptCount = appointments.find(c => c._id === date)?.count || 0;
      const msgCount = messages.find(c => c._id === date)?.count || 0;
      const dayReminder = reminderStats.find(r => r.date === date);
      const bdayCount = dayReminder?.birthdayRemindersSent || 0;
      const apptRemCount = dayReminder?.appointmentRemindersSent || 0;
      const dayOrder = orders.find(c => c._id === date);
      const orderCount = dayOrder?.count || 0;
      const orderRevenue = dayOrder?.revenue || 0;

      return {
        date,
        totalChats: chatCount,
        uniqueUsers: userCount,
        appointmentsBooked: apptCount,
        totalMessagesExchanged: msgCount,
        birthdayRemindersSent: bdayCount,
        appointmentRemindersSent: apptRemCount,
        orders: orderCount,
        revenue: orderRevenue
      };
    });

    res.json(stats);
  } catch (error) {
    console.error('Analytics Aggregation Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
