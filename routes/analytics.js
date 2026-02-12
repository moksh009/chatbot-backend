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
        
        // Fetch recent messages
        let messages = [];
        if (conversation) {
            messages = await Message.find({ conversationId: conversation._id }).sort({ timestamp: -1 }).limit(50);
        }

        res.json({
            lead,
            orders,
            appointments,
            conversation,
            messages
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
        const daysToFetch = parseInt(req.query.days) || 1; // Default to 1 day (today)
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() + daysToFetch); // Fetch for N days

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

        // 1. Fetch Google Calendar Events for Range
        let googleEvents = [];
        try {
             const calendarPromises = Array.from(calendarIds).map(calId => 
                listEvents(today.toISOString(), endDate.toISOString(), calId)
                    .catch(err => {
                        console.error(`GCal fetch error for ${calId}:`, err.message);
                        return [];
                    })
             );
             
             const results = await Promise.all(calendarPromises);
             googleEvents = results.flat();
             
             // Remove duplicates
             const uniqueEvents = new Map();
             googleEvents.forEach(e => uniqueEvents.set(e.id, e));
             googleEvents = Array.from(uniqueEvents.values());
             
        } catch (gErr) {
             console.error('GCal fetch error in receptionist-overview:', gErr.message);
        }

        // 2. Fetch DB Appointments for Range
        // We need to match the date string format used in DB: "Monday, 09 Feb"
        // This is tricky for a range. Better to fetch all future appointments and filter in memory or use ISO check if possible.
        // However, the DB stores `date` as a string (e.g., "Monday, 09 Feb"). 
        // We will fetch ALL appointments for this client that are not cancelled, and then filter/merge.
        // Ideally, we should migrate DB to use ISO dates, but for now we rely on the GCal sync.
        
        // Fetch DB appointments created/for this client
        const dbAppointments = await Appointment.find({
            clientId,
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
                source: dbAppt ? 'chatbot' : 'chatbot'
            };
        });
        
        // Add DB-only appointments (if any, though they should be in GCal)
        const gcalEventIds = new Set(googleEvents.map(e => e.id));
        
        // Filter DB appointments that fall within the requested range
        const rangeStart = today.getTime();
        const rangeEnd = endDate.getTime();

        dbAppointments.forEach(appt => {
            if (!appt.eventId || !gcalEventIds.has(appt.eventId)) {
                 // Try to parse date
                 try {
                    // This parsing is fragile without Year, but assuming current/next year
                    // If appt.date is "Monday, 09 Feb", we need to guess year.
                    // For now, we skip complex parsing and rely on GCal for accurate scheduling.
                    // Or we check if `createdAt` or `date` matches.
                    // Let's rely on GCal primarily as requested ("calculate from google calendar only").
                 } catch (e) {}
            }
        });
        
        // Sort by date
        mergedAppointments.sort((a, b) => new Date(a.date) - new Date(b.date));

        // 4. Calculate Total Upcoming Appointments (Future from Now)
        // We fetch a wider range from GCal to get the total count, OR we just trust the DB count if synced?
        // The user wants "calculate from google calendar only".
        // So we should fetch ALL future events from GCal.
        // Fetching "all future" might be expensive. Let's fetch next 30 days for the "Bookings" count.
        
        let totalUpcomingCount = 0;
        try {
            const futureEnd = new Date(today);
            futureEnd.setDate(futureEnd.getDate() + 30); // Look ahead 30 days
            
            const futurePromises = Array.from(calendarIds).map(calId => 
                listEvents(today.toISOString(), futureEnd.toISOString(), calId)
                    .catch(() => [])
            );
            const futureResults = await Promise.all(futurePromises);
            const allFutureEvents = futureResults.flat();
            // Dedup
            const uniqueFuture = new Set(allFutureEvents.map(e => e.id));
            totalUpcomingCount = uniqueFuture.size;
        } catch (e) {
            console.error('Error fetching future counts:', e);
        }

        // 5. Pending Agent Requests
        const recentChats = await Conversation.find({
            clientId,
            updatedAt: { $gte: today }
        }).sort({ updatedAt: -1 }).limit(10);

        // 6. High Value Leads active today
        const activeVIPs = await AdLead.find({
            clientId,
            lastInteraction: { $gte: today },
            leadScore: { $gt: 50 }
        }).select('name phoneNumber leadScore tags');

        res.json({
            appointments: mergedAppointments,
            totalUpcomingAppointments: totalUpcomingCount,
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

    // --- FETCH GCAL EVENTS FOR APPOINTMENTS ---
    const client = await Client.findOne({ clientId });
    const calendarIds = new Set();
    if (client?.googleCalendarId) calendarIds.add(client.googleCalendarId);
    if (client?.config?.calendars) {
        Object.values(client.config.calendars).forEach(id => calendarIds.add(id));
    }
    if (calendarIds.size === 0) calendarIds.add('primary');

    let gcalCounts = {};
    try {
        const calendarPromises = Array.from(calendarIds).map(calId => 
            listEvents(startDate.toISOString(), endDate.toISOString(), calId)
                .catch(() => [])
        );
        const results = await Promise.all(calendarPromises);
        const allEvents = results.flat();
        
        // Group by date
        allEvents.forEach(event => {
            const start = event.start.dateTime || event.start.date;
            if (start) {
                const dateStr = start.split('T')[0];
                gcalCounts[dateStr] = (gcalCounts[dateStr] || 0) + 1;
            }
        });
    } catch (e) {
        console.error('Analytics GCal Fetch Error:', e);
    }
    // ------------------------------------------

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
      // Use GCal count instead of DB aggregation
      const apptCount = gcalCounts[date] || 0; 
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
