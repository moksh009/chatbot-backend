const express = require('express');
const router = express.Router();
const { resolveClient, startOfDayIST } = require('../utils/queryHelpers');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Appointment = require('../models/Appointment');
const DailyStat = require('../models/DailyStat');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const Client = require('../models/Client');
const Service = require('../models/Service');
const { listEvents } = require('../utils/googleCalendar');
const { protect } = require('../middleware/auth');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Platform-funded analytics routes always use the platform API key
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('Platform GEMINI_API_KEY is not configured');
  return new GoogleGenerativeAI(apiKey);
};


// GET /api/analytics/notifications
// @desc    Get unread conversation counts and pending order counts for sidebar badges
// @access  Private
router.get('/notifications', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }

    // --- PHASE 10 FIX: Shared Query for Delitech/CodeClinic ---
    const query = (['delitech_smarthomes', 'code_clinic_v1'].includes(clientId))
      ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } }
      : { clientId };

    const [unreadConversations, pendingOrders] = await Promise.all([
      Conversation.countDocuments({
        ...query,
        $or: [
          { status: 'HUMAN_TAKEOVER' },
          { unreadCount: { $gt: 0 } }
        ]
      }),
      Order.countDocuments({
        ...query,
        status: { $in: ['pending', 'unfulfilled'] }
      })
    ]);

    res.json({
      success: true,
      notifications: {
        conversations: unreadConversations,
        orders: pendingOrders
      }
    });
  } catch (error) {
    console.error('Notifications Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// GET /api/analytics/import-sessions
// @desc    Get CSV import history
// @access  Private
router.get('/import-sessions', protect, async (req, res) => {
    try {
        let clientId = req.user.clientId;
        if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
            clientId = req.query.clientId;
        }
        
        const ImportSession = require('../models/ImportSession');
        const sessions = await ImportSession.find({ clientId }).sort({ createdAt: -1 }).limit(20);
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ message: 'History fetch failed' });
    }
});

// GET /api/analytics/flow-heatmap
// @desc    Get node visit distribution for visual heatmap overlay
// @access  Private
router.get('/flow-heatmap', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }

    const { start, end } = req.query;
    const query = { clientId };
    if (start || end) {
      query.date = {};
      if (start) query.date.$gte = start;
      if (end) query.date.$lte = end;
    }

    const stats = await DailyStat.find(query).lean();
    
    // Aggregate node visits across selected timeframe
    const aggregatedHeatmap = {};
    stats.forEach(stat => {
      if (stat.flowHeatmap) {
        // Handle Map serialization (might be object or Map depending on lean/schema)
        const heatmap = stat.flowHeatmap instanceof Map ? Object.fromEntries(stat.flowHeatmap) : stat.flowHeatmap;
        for (const [nodeId, count] of Object.entries(heatmap)) {
          aggregatedHeatmap[nodeId] = (aggregatedHeatmap[nodeId] || 0) + count;
        }
      }
    });

    res.json({ success: true, heatmap: aggregatedHeatmap });
  } catch (error) {
    console.error('Flow Heatmap Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// GET /api/analytics/bot-health
// @desc    Get real-time health status of the bot (mocked/calculated)
// @access  Private
router.get('/bot-health', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId });
    
    // In a real scenario, we might check WhatsApp Cloud API health or recent message success rate
    // For now, we return a healthy status if the client exists and is active
    res.json({
      success: true,
      status: client?.isActive ? 'operational' : 'degraded',
      latency: Math.floor(Math.random() * (150 - 20 + 1)) + 20, // Mock latency 20-150ms
      protocol: 'WhatsApp Cloud 2.1',
      lastPulse: new Date(),
      neuralSync: true
    });
  } catch (error) {
    console.error('Bot Health Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.get('/realtime', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
    
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    // --- PHASE 10 FIX: Shared Query for Delitech/CodeClinic ---
    const query = (['delitech_smarthomes', 'code_clinic_v1'].includes(clientId))
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

    // 2. Orders & Appointments Revenue (Today)
    const ordersToday = await Order.find({
      ...query,
      createdAt: { $gte: today }
    });

    const appointmentsToday = await Appointment.find({
      ...query,
      createdAt: { $gte: today }
    });

    const orderRevenue = ordersToday.reduce((sum, order) => sum + order.amount, 0);
    const appointmentRevenue = appointmentsToday.reduce((sum, appt) => sum + (appt.revenue || 0), 0);
    const revenueToday = orderRevenue + appointmentRevenue;
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

    // 6. Checkout Initiated (Total from Leads)
    const checkoutResult = await AdLead.aggregate([
      { $match: query },
      { $group: { _id: null, totalCheckouts: { $sum: "$checkoutInitiatedCount" } } }
    ]);
    const totalCheckouts = checkoutResult[0]?.totalCheckouts || 0;

    // 7. Abandoned vs Recovered Carts
    const abandonedCarts = await AdLead.countDocuments({
      ...query,
      cartStatus: 'abandoned'
    });

    const recoveredCarts = await AdLead.countDocuments({
      ...query,
      cartStatus: 'recovered'
    });

    // 8. Abandoned Cart Messaging Stats (Total from DailyStats)
    const cartStatsResult = await DailyStat.aggregate([
      { $match: query },
      { $group: { _id: null, totalSent: { $sum: "$abandonedCartSent" }, totalClicks: { $sum: "$abandonedCartClicks" } } }
    ]);
    const totalAbandonedCartSent = cartStatsResult[0]?.totalSent || 0;
    const totalAbandonedCartClicks = cartStatsResult[0]?.totalClicks || 0;

    // 9. Conversion Funnel Metrics
    const totalOrdersAllTime = await Order.countDocuments(query);

    const whatsappRecoveriesPurchasedResult = await AdLead.aggregate([
      { $match: query },
      {
        $project: {
          purchaseAfterRecoveryCount: {
            $size: {
              $filter: {
                input: "$activityLog",
                as: "log",
                cond: { $eq: ["$$log.action", "purchase_completed_after_recovery"] }
              }
            }
          }
        }
      },
      { $group: { _id: null, total: { $sum: "$purchaseAfterRecoveryCount" } } }
    ]);
    const whatsappRecoveriesPurchased = whatsappRecoveriesPurchasedResult[0]?.total || 0;

    const adminFollowupsPurchasedResult = await AdLead.countDocuments({
      ...query,
      adminFollowUpTriggered: true,
      isOrderPlaced: true
    });
    const adminFollowupsPurchased = adminFollowupsPurchasedResult;

    // 10. Deep Attribution ROI (Phase 23)
    const attributionResult = await AdLead.aggregate([
      { $match: query },
      { $unwind: { path: "$commerceEvents", preserveNullAndEmptyArrays: false } },
      { $match: { "commerceEvents.event": "checkout_completed" } },
      {
        $group: {
          _id: { $ifNull: ["$adAttribution.source", "Organic/Direct"] },
          revenue: { $sum: "$commerceEvents.amount" },
          count: { $sum: 1 }
        }
      }
    ]);

    // 10. Sentiment Analysis Summary (Phase 23 Track 6)
    const sentimentAgg = await Conversation.aggregate([
      { $match: query },
      { $group: { _id: "$sentiment", count: { $sum: 1 } } }
    ]);
    const sentimentCounts = {
      Positive: 0,
      Neutral: 0,
      Negative: 0,
      Frustrated: 0,
      Urgent: 0,
      Unknown: 0
    };
    sentimentAgg.forEach(s => {
      const key = s._id || 'Unknown';
      if (sentimentCounts.hasOwnProperty(key)) {
        sentimentCounts[key] = s.count;
      } else {
        sentimentCounts.Unknown += s.count;
      }
    });

    res.json({
      businessName: client.businessName || client.name,
      leads: { total: totalLeads, newToday: newLeadsToday },
      orders: { count: orderCountToday, revenue: revenueToday },
      linkClicks: totalLinkClicks,
      agentRequests: agentRequestsToday,
      addToCarts: totalAddCarts,
      checkouts: totalCheckouts,
      abandonedCarts,
      recoveredCarts,
      abandonedCartSent: totalAbandonedCartSent,
      abandonedCartClicks: totalAbandonedCartClicks,
      funnel: {
        totalOrdersAllTime,
        whatsappRecoveriesPurchased,
        adminFollowupsPurchased
      },
      attribution: attributionResult.map(a => ({
        source: a._id,
        revenue: a.revenue,
        count: a.count
      })),
      sentiment: sentimentCounts
    });

  } catch (error) {
    console.error('Realtime Analytics Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

router.get('/leads', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }

    const query = (clientId === 'code_clinic_v1' || clientId === 'delitech_smarthomes') ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } } : { clientId };

    const { limit = 10, search = '', next_cursor } = req.query;

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { name: searchRegex },
        { phoneNumber: searchRegex }
      ];
    }

    if (next_cursor) {
      query._id = { $lt: next_cursor };
    }

    const leads = await AdLead.find(query)
      .sort({ _id: -1 })
      .limit(parseInt(limit));

    const total = await AdLead.countDocuments(query);
    const new_cursor = leads.length > 0 ? leads[leads.length - 1]._id : null;

    res.json({
      leads,
      next_cursor: new_cursor,
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

    // Fetch related orders (handle stripped country code from Shopify)
    const strippedPhone = lead.phoneNumber.length > 10 && lead.phoneNumber.startsWith('91')
      ? lead.phoneNumber.substring(2)
      : lead.phoneNumber;

    const orders = await Order.find({
      clientId: lead.clientId,
      $or: [
        { phone: lead.phoneNumber },
        { phone: strippedPhone },
        { phone: `+91${strippedPhone}` },
        { phone: `91${strippedPhone}` }
      ]
    });

    // Fetch related appointments
    const appointments = await Appointment.find({ phone: lead.phoneNumber, clientId: lead.clientId });

    // Fetch conversation summary
    const conversation = await Conversation.findOne({ phone: lead.phoneNumber, clientId: lead.clientId });

    // Fetch recent messages
    let messages = [];
    if (conversation) {
      messages = await Message.find({ conversationId: conversation._id }).sort({ timestamp: -1 }).limit(50);
    }

    // --- Phase 28: Customer Intelligence DNA ---
    let dna = null;
    try {
      const CustomerIntelligence = require('../models/CustomerIntelligence');
      dna = await CustomerIntelligence.findOne({ clientId: lead.clientId, phone: lead.phoneNumber }).lean();
    } catch (_) {}

    let wallet = null;
    try {
      const CustomerWallet = require('../models/CustomerWallet');
      wallet = await CustomerWallet.findOne({ clientId: lead.clientId, phone: lead.phoneNumber }).lean();
    } catch (_) {}

    // --- PHASE R2: Marketing Hub Logs ---
    let marketingLogs = [];
    try {
      const CampaignMessage = require('../models/CampaignMessage');
      marketingLogs = await CampaignMessage.find({ clientId: lead.clientId, phone: lead.phoneNumber })
        .populate('campaignId', 'name type')
        .sort({ sentAt: -1 })
        .limit(20)
        .lean();
    } catch (_) {}

    res.json({
      lead,
      orders,
      appointments,
      conversation,
      messages,
      intelligence: dna || null,
      wallet: wallet || null,
      marketingLogs
    });
  } catch (error) {
    console.error('Lead Detail Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/lead-by-phone/:phone
router.get('/lead-by-phone/:phone', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }

    // --- PHASE 11 FIX: Robust Lead Lookup ---
    const rawPhone = req.params.phone;
    const phoneVariants = [
      rawPhone,
      rawPhone.startsWith('+') ? rawPhone.substring(1) : `+${rawPhone}`,
      rawPhone.startsWith('91') ? `+${rawPhone}` : rawPhone // Specific fallback for IN
    ];

    const leadQuery = (['delitech_smarthomes', 'code_clinic_v1'].includes(clientId))
      ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] }, phoneNumber: { $in: phoneVariants } }
      : { clientId, phoneNumber: { $in: phoneVariants } };

    const lead = await AdLead.findOne(leadQuery);
    
    if (!lead) {
      return res.status(200).json({ 
        success: false, 
        message: 'Lead record not yet synchronized with CRM.',
        phoneNumber: rawPhone
      });
    }
    
    res.json(lead);
  } catch (error) {
    console.error(`[Analytics] lead-by-phone error for ${req.params.phone}:`, error);
    res.status(500).json({ message: 'Server error retrieving lead analytics.' });
  }
});

// PUT /api/analytics/lead/:phone (Update Lead CRM Details)
router.put('/lead/:phone', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
    
    const { name, email, tags } = req.body;
    
    const lead = await AdLead.findOneAndUpdate(
      { phoneNumber: req.params.phone, clientId },
      { $set: { name, email, tags, lastInteraction: new Date() } },
      { new: true }
    );
    
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // Also sync to Conversation if exists
    await Conversation.findOneAndUpdate(
      { phone: req.params.phone, clientId },
      { $set: { customerName: name } }
    );

    res.json(lead);
  } catch (error) {
    console.error('Update Lead Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/top-leads
router.get('/top-leads', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
    // --- PHASE 11 FIX: Refined Hot Leads (Score >= 60) ---
    const query = (['delitech_smarthomes', 'code_clinic_v1'].includes(clientId))
      ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] }, leadScore: { $gte: 60 } }
      : { clientId, leadScore: { $gte: 60 } };

    const leads = await AdLead.aggregate([
      { $match: query },
      {
        $lookup: {
          from: "appointments",
          let: { phoneNo: "$phoneNumber", cId: "$clientId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$phone", "$$phoneNo"] },
                    { $eq: ["$clientId", "$$cId"] }
                  ]
                }
              }
            },
            {
              $group: {
                _id: null,
                apptRevenue: { $sum: "$revenue" },
                apptCount: { $sum: 1 }
              }
            }
          ],
          as: "apptData"
        }
      },
      {
        $addFields: {
          apptStats: { $arrayElemAt: ["$apptData", 0] }
        }
      },
      {
        $addFields: {
          computedTotalSpent: { $add: [{ $ifNull: ["$totalSpent", 0] }, { $ifNull: ["$apptStats.apptRevenue", 0] }] },
          computedOrdersCount: { $add: [{ $ifNull: ["$ordersCount", 0] }, { $ifNull: ["$apptStats.apptCount", 0] }] }
        }
      },
      {
        $sort: { computedTotalSpent: -1, leadScore: -1 }
      },
      {
        $limit: 200
      },
      {
        $project: {
          name: 1,
          phoneNumber: 1,
          leadScore: 1,
          tags: 1,
          lastInteraction: 1,
          ordersCount: "$computedOrdersCount",
          totalSpent: "$computedTotalSpent"
        }
      }
    ]);

    res.json(leads);
  } catch (error) {
    console.error('Top Leads Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/top-products
router.get('/top-products', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
    // --- PHASE 10 FIX: Shared Query for Delitech/CodeClinic ---
    const query = (['delitech_smarthomes', 'code_clinic_v1'].includes(clientId))
      ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } }
      : { clientId };

    const topProducts = await Order.aggregate([
      { $match: query },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.name",
          totalRevenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
          totalSold: { $sum: "$items.quantity" }
        }
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
      {
        $project: {
          name: "$_id",
          revenue: "$totalRevenue",
          sold: "$totalSold",
          _id: 0
        }
      }
    ]);

    if (topProducts.length > 0) {
      return res.json(topProducts);
    }

    // Fallback for Service-based businesses (Clinic, Salon, Turf)
    // Directly aggregate revenue from valid Appointments regardless of pre-defined Service models
    // This allows dynamically mapped/upselled services (like "Haircut + Mirror Shine Boto Smooth") to natively track revenue.
    const topServices = await Appointment.aggregate([
      {
        $match: {
          ...query,
          status: { $ne: 'cancelled' },
          revenue: { $gt: 0 } // Only group appointments that actually generated revenue
        }
      },
      {
        $group: {
          _id: "$service",
          totalRevenue: { $sum: "$revenue" },
          totalSold: { $sum: 1 }
        }
      },
      { $sort: { totalRevenue: -1 } }, // Always sort by highest revenue, not just quantity
      { $limit: 10 },
      {
        $project: {
          name: "$_id",
          revenue: "$totalRevenue",
          sold: "$totalSold",
          _id: 0
        }
      }
    ]);

    res.json(topServices);
  } catch (error) {
    console.error('Top Products Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/receptionist-overview
router.get('/receptionist-overview', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
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

    // --- PHASE 10 FIX: Shared Query for Delitech/CodeClinic ---
    const query = (['delitech_smarthomes', 'code_clinic_v1'].includes(clientId))
      ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } }
      : { clientId };

    // Fetch DB appointments created/for this client
    const dbAppointments = await Appointment.find({
      ...query,
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
        } catch (e) { }
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
      $or: [
        { leadScore: { $gt: 50 } },
        { isOrderPlaced: true },
        { ordersCount: { $gt: 0 } },
        { totalSpent: { $gt: 0 } }
      ]
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
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }

    const clientIdQuery = { clientId };

    // Date Range Prioritization
    let { start, end, days } = req.query;
    const endDate = end ? new Date(end) : new Date();
    const startDate = start ? new Date(start) : new Date();
    
    if (!start) {
      const dayCount = parseInt(days) || 7;
      startDate.setDate(endDate.getDate() - dayCount);
    }
    
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

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

    // 1. Aggregation for Conversations active per day (based on messages)
    const conversationActivity = await Message.aggregate([
      {
        $match: {
          ...clientIdQuery,
          timestamp: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
            conversationId: '$conversationId'
          }
        }
      },
      {
        $group: {
          _id: '$_id.date',
          count: { $sum: 1 }
        }
      }
    ]);

    // 3. Aggregation for Appointments (Count & Revenue)
    const appointments = await Appointment.aggregate([
      {
        $match: {
          ...clientIdQuery,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
          revenue: { $sum: { $ifNull: ["$revenue", 0] } }
        }
      }
    ]);

    // 4. Aggregation for Messages
    const messages = await Message.aggregate([
      {
        $match: {
          ...clientIdQuery,
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
    const reminderStats = await DailyStat.find({ ...clientIdQuery, date: { $gte: dates[0], $lte: dates[dates.length - 1] } });

    // 6. Aggregation for Orders (Revenue & Count)
    const orders = await Order.aggregate([
      {
        $match: {
          ...clientIdQuery,
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

    // 7. Aggregation for Add to Cart Events (per day)
    const cartEvents = await AdLead.aggregate([
      {
        $match: {
          ...clientIdQuery,
          'activityLog.action': 'add_to_cart',
          'activityLog.timestamp': { $gte: startDate, $lte: endDate }
        }
      },
      { $unwind: '$activityLog' },
      {
        $match: {
          'activityLog.action': 'add_to_cart',
          'activityLog.timestamp': { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$activityLog.timestamp" } },
          count: { $sum: 1 }
        }
      }
    ]);

    // 8. Aggregation for Link Click Events (per day)
    const linkClickEvents = await AdLead.aggregate([
      {
        $match: {
          ...clientIdQuery,
          'activityLog.action': { $in: ['link_click', 'whatsapp_restore_link_clicked'] },
          'activityLog.timestamp': { $gte: startDate, $lte: endDate }
        }
      },
      { $unwind: '$activityLog' },
      {
        $match: {
          'activityLog.action': { $in: ['link_click', 'whatsapp_restore_link_clicked'] },
          'activityLog.timestamp': { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$activityLog.timestamp" } },
          count: { $sum: 1 }
        }
      }
    ]);

    // 9. Aggregation for Checkouts (per day)
    const checkoutEvents = await AdLead.aggregate([
      {
        $match: {
          ...clientIdQuery,
          'activityLog.action': 'checkout_initiated',
          'activityLog.timestamp': { $gte: startDate, $lte: endDate }
        }
      },
      { $unwind: '$activityLog' },
      {
        $match: {
          'activityLog.action': 'checkout_initiated',
          'activityLog.timestamp': { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$activityLog.timestamp" } },
          count: { $sum: 1 }
        }
      }
    ]);

    // Merge Data
    const stats = dates.map(date => {
      const convActivityForDay = conversationActivity.find(c => c._id === date)?.count || 0;
      const chatCount = convActivityForDay;
      const userCount = convActivityForDay;
      // Use GCal count instead of DB aggregation
      const apptCount = gcalCounts[date] || 0;
      const msgCount = messages.find(c => c._id === date)?.count || 0;
      const dayReminder = reminderStats.find(r => r.date === date);
      const bdayCount = dayReminder?.birthdayRemindersSent || 0;
      const apptRemCount = dayReminder?.appointmentRemindersSent || 0;
      const dayOrder = orders.find(c => c._id === date);
      const orderCount = dayOrder?.count || 0;
      const orderRevenue = dayOrder?.revenue || 0;
      const cartCount = cartEvents.find(c => c._id === date)?.count || 0;
      const linkClickCount = linkClickEvents.find(c => c._id === date)?.count || 0;
      const checkoutCount = checkoutEvents.find(c => c._id === date)?.count || 0;
      const abandonedCartSent = dayReminder?.abandonedCartSent || 0;
      const abandonedCartClicks = dayReminder?.abandonedCartClicks || 0;
      const recoveredViaStep1 = dayReminder?.recoveredViaStep1 || 0;
      const recoveredViaStep2 = dayReminder?.recoveredViaStep2 || 0;
      const recoveredViaStep3 = dayReminder?.recoveredViaStep3 || 0;
      const codNudgesSent = dayReminder?.codNudgesSent || 0;
      const rtoCostSaved = dayReminder?.rtoCostSaved || 0;
      const codConvertedRevenue = dayReminder?.codConvertedRevenue || 0;
      const codConvertedCount = dayReminder?.codConvertedCount || 0;
      const cartRevenueRecovered = dayReminder?.cartRevenueRecovered || 0;

      const dayAppointment = appointments.find(c => c._id === date);
      const apptRevenue = dayAppointment?.revenue || 0;

      // Unify revenue logically. If it's a salon, orderRevenue is probably 0, and apptRevenue has the value. This ensures generic tracking.
      const totalRevenue = orderRevenue + apptRevenue;

      return {
        date,
        totalChats: chatCount,
        uniqueUsers: userCount,
        appointmentsBooked: apptCount,
        totalMessagesExchanged: msgCount,
        birthdayRemindersSent: bdayCount,
        appointmentRemindersSent: apptRemCount,
        orders: orderCount,
        revenue: totalRevenue,
        apptRevenue: apptRevenue,
        orderRevenue: orderRevenue,
        addToCarts: cartCount,
        linkClicks: linkClickCount,
        checkouts: checkoutCount,
        abandonedCartSent,
        abandonedCartClicks,
        recoveredViaStep1,
        recoveredViaStep2,
        recoveredViaStep3,
        codNudgesSent,
        rtoCostSaved,
        codConvertedRevenue,
        codConvertedCount,
        cartRevenueRecovered
      };
    });

    res.json(stats);
  } catch (error) {
    console.error('Analytics Aggregation Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});


// GET /api/analytics/insights (Advanced USP Features)
router.get('/insights', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const query = (clientId === 'code_clinic_v1' || clientId === 'delitech_smarthomes') ? { clientId: { $in: ['code_clinic_v1', 'delitech_smarthomes'] } } : { clientId };

    const appts = await Appointment.find(query);
    const orders = await Order.find(query);
    const leads = await AdLead.find(query);

    // 1. Peak Hours Heatmap (Aggregate Checkouts, Orders, and Appointments)
    const heatmap = {}; 
    const addToMap = (dateStr) => {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return;
      const key = `${d.getDay()}_${d.getHours()}`;
      heatmap[key] = (heatmap[key] || 0) + 1;
    };

    appts.forEach(a => addToMap(a.createdAt));
    orders.forEach(o => addToMap(o.createdAt));
    leads.forEach(l => {
        if (l.lastSeen) addToMap(l.lastSeen);
    });

    // 2. Retention (Returning vs New)
    let returning = 0;
    let newLeads = 0;
    leads.forEach(l => {
      if ((l.ordersCount || 0) > 1 || (l.addToCartCount || 0) > 1) { returning++; } else { newLeads++; }
    });

    // Extract appointment frequencies to boost retention metric for Service businesses
    const phoneCounts = {};
    appts.forEach(a => {
      phoneCounts[a.phone] = (phoneCounts[a.phone] || 0) + 1;
    });
    Object.values(phoneCounts).forEach(count => {
      if (count > 1) { returning++; } else { newLeads++; }
    });

    // 3. Average Order/Booking Value & LTV
    let totalRev = 0;
    let totalTransactions = 0;

    appts.forEach(a => { if (a.revenue > 0) { totalRev += a.revenue; totalTransactions++; } });
    orders.forEach(o => { if (o.amount > 0) { totalRev += o.amount; totalTransactions++; } });

    const aov = totalTransactions > 0 ? Math.round(totalRev / totalTransactions) : 0;
    const uniqueCustomers = returning + newLeads;
    const ltv = uniqueCustomers > 0 ? Math.round(totalRev / uniqueCustomers) : 0;

    res.json({
      heatmap,
      returningLeads: returning,
      newLeads: newLeads,
      avgOrderValue: aov,
      avgLTV: ltv,
      totalRevenueGlobally: totalRev
    });
  } catch (e) {
    console.error('Insights API Error:', e);
    res.status(500).json({ error: 'Server Error' });
  }
});

// GET /api/analytics/:clientId/roi
router.get("/:clientId/roi", protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { period = "month" } = req.query;
    if (!clientId) return res.status(400).json({ error: "clientId required" });

    const { startOfDay } = require("date-fns");
    const periodMap = {
      today: startOfDay(new Date()),
      week:  new Date(Date.now() - 7  * 24 * 60 * 60 * 1000),
      month: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    };
    const startDate = periodMap[period] || periodMap.month;
    const startDateStr = startDate.toISOString().split('T')[0];

    const stats = await DailyStat.aggregate([
      {
        $match: {
          clientId: clientId,
          date: { $gte: startDateStr }
        }
      },
      {
        $group: {
          _id: null,
          cartRevenueRecovered: { $sum: "$cartRevenueRecovered" },
          cartsRecovered: { $sum: "$cartsRecovered" },
          recoveredViaStep1: { $sum: "$recoveredViaStep1" },
          recoveredViaStep2: { $sum: "$recoveredViaStep2" },
          recoveredViaStep3: { $sum: "$recoveredViaStep3" },
          codConvertedCount: { $sum: "$codConvertedCount" },
          codConvertedRevenue: { $sum: "$codConvertedRevenue" },
          codNudgesSent: { $sum: "$codNudgesSent" },
          rtoCostSaved: { $sum: "$rtoCostSaved" },
          reviewsCollected: { $sum: "$reviewsCollected" },
          reviewsPositive: { $sum: "$reviewsPositive" },
          reviewsNegative: { $sum: "$reviewsNegative" },
          bookingsCompleted: { $sum: "$bookingsCompleted" },
          bookingRevenue: { $sum: "$bookingRevenue" }
        }
      }
    ]);

    const data = stats[0] || {};
    const totalRecovered =
      (data.cartRevenueRecovered || 0) +
      (data.codConvertedRevenue  || 0) +
      (data.rtoCostSaved         || 0) +
      (data.bookingRevenue       || 0); // Include new Phase 9 service revenue

    res.json({
      success: true,
      period,
      totalRecovered,
      cartsRecovered: data.cartsRecovered || 0,
      recoveredViaStep1: data.recoveredViaStep1 || 0,
      recoveredViaStep2: data.recoveredViaStep2 || 0,
      recoveredViaStep3: data.recoveredViaStep3 || 0,
      cartRevenue: data.cartRevenueRecovered || 0,
      codConverted: data.codConvertedCount || 0,
      codRevenue: data.codConvertedRevenue || 0,
      codNudgesSent: data.codNudgesSent || 0,
      rtoCostSaved: data.rtoCostSaved || 0,
      reviewsCollected: data.reviewsCollected || 0,
      reviewsPositive: data.reviewsPositive || 0,
      reviewsNegative: data.reviewsNegative || 0,
      bookingsCompleted: data.bookingsCompleted || 0,
      bookingRevenue: data.bookingRevenue || 0
    });

  } catch (err) {
    console.error("ROI analytics error:", err);
    res.status(500).json({ error: "Failed to fetch ROI data" });
  }
});

// GET /api/analytics/funnel
router.get('/funnel', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
    const query = { clientId };

    const totalLeads = await AdLead.countDocuments(query);
    
    const cartResult = await AdLead.aggregate([
      { $match: query },
      { $group: { _id: null, count: { $sum: "$addToCartCount" } } }
    ]);
    const totalCarts = cartResult[0]?.count || 0;

    const checkoutResult = await AdLead.aggregate([
      { $match: query },
      { $group: { _id: null, count: { $sum: "$checkoutInitiatedCount" } } }
    ]);
    const totalCheckouts = checkoutResult[0]?.count || 0;

    const totalOrders = await Order.countDocuments(query);
    
    const revenueResult = await Order.aggregate([
      { $match: query },
      { $group: { _id: null, total: { $sum: "$amount" } } }
    ]);
    const totalRevenue = revenueResult[0]?.total || 0;

    // Aggregated recovery stats
    const recoveredCarts = await AdLead.countDocuments({ ...query, cartStatus: 'recovered' });

    res.json({
      leads: totalLeads,
      carts: totalCarts,
      checkouts: totalCheckouts,
      orders: totalOrders,
      revenue: totalRevenue,
      recoveredCarts,
      conversionRate: totalLeads > 0 ? ((totalOrders / totalLeads) * 100).toFixed(2) : 0
    });
  } catch (error) {
    console.error("Funnel Analytics Error:", error);
    res.status(500).json({ message: 'Server Error', error: error.message });
  }
});

// GET /api/analytics/flow-heatmap
router.get('/flow-heatmap', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    // Filter nodes that have visitCount > 0 or are triggers
    const heatNodes = (client.flowNodes || [])
      .map(n => ({
        id: n.id,
        label: n.data?.label || n.data?.text || n.data?.body || n.type,
        type: n.type,
        visitCount: n.data?.visitCount || n.visitCount || 0
      }))
      .filter(n => n.visitCount > 0)
      .sort((a, b) => b.visitCount - a.visitCount)
      .slice(0, 15);

    res.json(heatNodes);
  } catch (error) {
    console.error('Flow Heatmap Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/abandoned-products
router.get('/abandoned-products', protect, async (req, res) => {
  try {
    let clientId = req.user.clientId;
    if (req.user.role === 'SUPER_ADMIN' && req.query.clientId) {
      clientId = req.query.clientId;
    }
    const days = parseInt(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const stats = await DailyStat.find({
      clientId,
      date: { $gte: since.toISOString().split('T')[0] }
    });

    // Aggregate product abandon counts
    const productMap = {};
    for (const stat of stats) {
      if (stat.abandonedProducts) {
        for (const [product, count] of stat.abandonedProducts.entries()) {
          productMap[product] = (productMap[product] || 0) + count;
        }
      }
    }

    // Try to fetch images from recent orders for these products
    const productNames = Object.keys(productMap);
    const recentOrders = await Order.find({ 
      clientId, 
      "items.name": { $in: productNames } 
    }).sort({ createdAt: -1 }).limit(50);

    const imageMap = {};
    recentOrders.forEach(order => {
      order.items.forEach(item => {
        if (item.image && !imageMap[item.name]) {
          imageMap[item.name] = item.image;
        }
      });
    });

    const data = Object.entries(productMap)
      .map(([name, count]) => ({ 
        name, 
        value: count,
        image: imageMap[name] || null
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10); // Top 10

    res.json(data);
  } catch (error) {
    console.error('Abandoned Products Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/cohort/:clientId
router.get('/cohort/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    // Return dummy cohort matrix for now. In reality, requires complex MapReduce or Aggregation.
    const cohortMatrix = [
      { cohort: 'Jan Week 1', size: 120, retention: [100, 45, 30, 20, 15] },
      { cohort: 'Jan Week 2', size: 140, retention: [100, 50, 35, 22, 18] }
    ];
    res.json({ success: true, cohort: cohortMatrix });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/analytics/revenue-attribution/:clientId
router.get('/revenue-attribution/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);
    const monthAgoStr = monthAgo.toISOString().split('T')[0];

    const stats = await DailyStat.find({
      clientId,
      date: { $gte: monthAgoStr }
    });

    const smartRecovery = stats.reduce((sum, s) => sum + (s.cartRevenueRecovered || 0) + (s.codConvertedRevenue || 0), 0);
    const bookingsValue = stats.reduce((sum, s) => sum + (s.bookingRevenue || 0), 0);
    const broadcastRevenue = Math.round(bookingsValue * 0.4); // Simplified attribution for broadcast
    const organicRevenue = Math.max(0, bookingsValue - broadcastRevenue);

    const attribution = [
      { source: 'Smart Recovery', revenue: smartRecovery },
      { source: 'Broadcast Campaign', revenue: broadcastRevenue },
      { source: 'Organic WhatsApp', revenue: organicRevenue }
    ];

    res.json({ success: true, attribution });
  } catch (err) {
    console.error("Revenue attribution error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/analytics/bot-health/:clientId
router.get('/bot-health/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];

    // Fetch stats for the last 7 days
    const stats = await DailyStat.find({
      clientId,
      date: { $gte: weekAgoStr }
    });

    const totalMsgs = stats.reduce((sum, s) => sum + (s.totalMessagesExchanged || 0), 0);
    const totalFallbacks = stats.reduce((sum, s) => sum + (s.aiFallbacks || 0), 0);
    const fallbackRate = totalMsgs > 0 ? (totalFallbacks / totalMsgs) * 100 : 0;
    
    // Calculate average latency from recent outbound messages
    const recentOutbound = await Message.find({ 
      clientId, 
      direction: 'outbound',
      timestamp: { $gte: weekAgo }
    }).sort({ timestamp: -1 }).limit(20);

    // Mock latency if no messages yet, otherwise 0.8s - 1.5s range based on data
    const latency = recentOutbound.length > 0 ? "0.9s" : "1.2s"; 

    const health = {
      score: Math.max(70, Math.round(100 - (fallbackRate * 1.5))),
      latency: latency,
      fallbackRate: `${fallbackRate.toFixed(1)}%`,
      csat: 4.8, // Placeholder until CSAT model is fully connected
      resolutionRate: `${(100 - fallbackRate).toFixed(1)}%`,
      activeUsers: stats.reduce((sum, s) => sum + (s.uniqueUsers || 0), 0)
    };

    res.json({ success: true, health });
  } catch (err) {
    console.error("Bot health error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Phase 17: Conversation Quality & Bot Performance
 * GET /api/analytics/conversation-quality
 */
router.get('/conversation-quality', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const query = { clientId };
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalConvos, escalated, aiFailures] = await Promise.all([
      Conversation.countDocuments(query),
      Conversation.countDocuments({ ...query, status: 'HUMAN_TAKEOVER' }),
      Conversation.countDocuments({ ...query, consecutiveFailedMessages: { $gt: 0 } })
    ]);

    const successRate = totalConvos > 0 ? ((totalConvos - escalated) / totalConvos * 100).toFixed(1) : 100;

    res.json({
      success: true,
      metrics: {
         totalConversations: totalConvos,
         humanEscalationRate: totalConvos > 0 ? (escalated / totalConvos * 100).toFixed(1) : 0,
         aiAutomationSuccessRate: successRate,
         avgResponseTime: "1.2s", // Mocked
         aiAccuracyScore: 94.5 // Mocked
      },
      qualityLog: [
         { type: 'success', message: 'Bot successfully handled policy inquiry', weight: 'high' },
         { type: 'warning', message: 'Complexity threshold reached on "Custom Refund"', weight: 'medium' }
      ]
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Phase 17: Lead Intelligence & Funnel Depth
 * GET /api/analytics/lead-intelligence
 */
router.get('/lead-intelligence', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const query = { clientId };

    const [totalLeads, highIntent, RTO] = await Promise.all([
      AdLead.countDocuments(query),
      AdLead.countDocuments({ ...query, score: { $gte: 100 } }),
      AdLead.countDocuments({ ...query, isRTO: true })
    ]);

    const intentDistribution = await AdLead.aggregate([
      { $match: query },
      { $group: { _id: "$intentState", count: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      summary: {
         totalLeads,
         highIntentCount: highIntent,
         rtoRiskCount: RTO,
         conversionPropensity: totalLeads > 0 ? (highIntent / totalLeads * 100).toFixed(1) : 0
      },
      distribution: intentDistribution.reduce((acc, curr) => ({ ...acc, [curr._id || 'unknown']: curr.count }), {})
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Phase 17: Revenue Intelligence & Conversion Lift
 * GET /api/analytics/revenue-intelligence
 */
router.get('/revenue-intelligence', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const query = { clientId };

    const stats = await DailyStat.aggregate([
      { $match: query },
      { $group: { 
         _id: null, 
         totalRevenue: { $sum: "$totalRevenue" },
         cartRevenue: { $sum: "$cartRevenueRecovered" },
         codRecovered: { $sum: "$codRecoveredRevenue" } // If tracked
      }}
    ]);

    const result = stats[0] || { totalRevenue: 0, cartRevenue: 0, codRecovered: 0 };

    res.json({
      success: true,
      totalRevenue: result.totalRevenue,
      attribution: {
          organic: (result.totalRevenue - result.cartRevenue) * 0.7, // Simulated
          aiRecovered: result.cartRevenue,
          codToPrepaidLift: result.codRecovered || (result.totalRevenue * 0.05) // Mocked lift
      },
      roi: "12.4x"
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Phase 17: SaaS Usage Stats & Billing Limits
 * GET /api/analytics/usage-stats
 */
router.get('/usage-stats', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const stats = await require('../utils/billingService').getUsageReport(clientId);
    
    if (!stats) return res.status(404).json({ success: false, message: 'Client not found' });

    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


/**
 * Phase 23: Track 6 - Agent Performance Metrics
 * GET /api/analytics/agent-performance
 */
router.get('/agent-performance', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const query = { clientId };

    // 1. Fetch Conversations with metrics
    const convos = await Conversation.find({ 
        ...query, 
        firstInboundAt: { $exists: true },
        firstResponseAt: { $exists: true }
    });

    // 2. Calculate Avg FRT
    let totalFRT = 0;
    convos.forEach(c => {
        const diff = (c.firstResponseAt - c.firstInboundAt) / 1000; // seconds
        totalFRT += diff;
    });
    const avgFRT = convos.length > 0 ? (totalFRT / convos.length) : 0;

    // 3. Resolution Rate & Avg Resolution Time
    const totalConvos = await Conversation.countDocuments(query);
    const resolvedConvos = await Conversation.find({ ...query, resolvedAt: { $exists: true } });
    const resolutionRate = totalConvos > 0 ? (resolvedConvos.length / totalConvos * 100).toFixed(1) : "0";
    
    let totalResolutionTime = 0;
    resolvedConvos.forEach(c => {
        totalResolutionTime += (c.resolvedAt - c.firstInboundAt) / (1000 * 60 * 60); // hours
    });
    const avgResolutionTime = resolvedConvos.length > 0 ? (totalResolutionTime / resolvedConvos.length).toFixed(1) : 0;

    // 4. CSAT Calculation
    const csatConvos = await Conversation.find({ ...query, "csatScore.rating": { $exists: true } });
    const totalScore = csatConvos.reduce((sum, c) => sum + c.csatScore.rating, 0);
    const avgCSAT = csatConvos.length > 0 ? (totalScore / csatConvos.length).toFixed(1) : "0";

    // 5. Agent Leaderboard (Aggregate by assignedTo)

    const agentStats = await Conversation.aggregate([
        { $match: { ...query, assignedTo: { $exists: true } } },
        { $group: {
            _id: "$assignedTo",
            resolutions: { $sum: { $cond: [{ $gt: ["$resolvedAt", null] }, 1, 0] } },
            totalHandled: { $sum: 1 }
        }},
        { $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'agentInfo'
        }},
        { $unwind: "$agentInfo" },
        { $project: {
            name: "$agentInfo.name",
            email: "$agentInfo.email",
            role: "$agentInfo.role",
            resolutions: 1,
            totalHandled: 1
        }}
    ]);

    res.json({
        success: true,
        avgFRT: avgFRT > 60 ? `${(avgFRT/60).toFixed(1)}m` : `${avgFRT.toFixed(0)}s`,
        resolutionRate: `${resolutionRate}%`,
        avgResolutionTime: `${avgResolutionTime}h`,
        activeAgents: agentStats.length,
        avgCSAT: `${avgCSAT}/5`,
        agents: agentStats
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/analytics/:clientId/home (NEW DASHBOARD ROOT)
router.get("/:clientId/home", protect, async (req, res) => {
  try {
    const { client, clientOid } = await resolveClient(req);
    const today = startOfDayIST();
    
    // BUILD COMPREHENSIVE PAYLOAD (Phase R1 Block 9)
    const [
      leadsTotal, 
      leadsToday, 
      ordersTodayRaw, 
      convsTotal,
      escalations,
      topLeads,
      topProductsRaw,
      realtimeAgg
    ] = await Promise.all([
      AdLead.countDocuments({ clientId: client.clientId }),
      AdLead.countDocuments({ clientId: client.clientId, createdAt: { $gte: today } }),
      Order.aggregate([
        { $match: { clientId: client.clientId, createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: "$totalPrice" }, count: { $sum: 1 } } }
      ]),
      Conversation.countDocuments({ clientId: client.clientId }),
      Conversation.find({ clientId: client.clientId, status: 'HUMAN_TAKEOVER' }).sort({ lastMessageAt: -1 }).limit(10),
      AdLead.find({ clientId: client.clientId, leadScore: { $gte: 60 } }).sort({ leadScore: -1 }).limit(5),
      Order.aggregate([
        { $match: { clientId: client.clientId } },
        { $unwind: "$items" },
        { $group: { _id: "$items.name", revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } }, sold: { $sum: "$items.quantity" } } },
        { $sort: { revenue: -1 } },
        { $limit: 10 }
      ]),
      AdLead.aggregate([
        { $match: { clientId: client.clientId } },
        { $group: { 
            _id: null, 
            addToCarts: { $sum: "$addToCartCount" }, 
            checkouts: { $sum: "$checkoutInitiatedCount" },
            linkClicks: { $sum: "$linkClicks" },
            abandoned: { $sum: { $cond: [{ $eq: ["$cartStatus", "abandoned"] }, 1, 0] } },
            recovered: { $sum: { $cond: [{ $eq: ["$cartStatus", "recovered"] }, 1, 0] } }
        } }
      ])
    ]);
    
    const revenue = ordersTodayRaw[0]?.total || 0;
    const ordersCount = ordersTodayRaw[0]?.count || 0;
    const rt = realtimeAgg[0] || { addToCarts: 0, checkouts: 0, linkClicks: 0, abandoned: 0, recovered: 0 };

    return res.json({
      success: true,
      data: {
        stats_grid: {
          leads: { total: leadsTotal, newToday: leadsToday },
          orders: { 
            count: ordersCount, 
            revenue: revenue,
            cartAdds: rt.addToCarts,
            checkouts: rt.checkouts,
            linkClicks: rt.linkClicks,
            abandonedCarts: rt.abandoned,
            recoveredCarts: rt.recovered
          },
          conversations: { total: convsTotal }
        },
        pending_escalations: escalations,
        top_leads: topLeads,
        top_products: topProductsRaw.map(p => ({ name: p._id, revenue: p.revenue, sold: p.sold })),
        recent_activities: [] // Handled by separate feed or logic
      }
    });
  } catch (err) {
    console.error('[Dashboard Home] Failed:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

