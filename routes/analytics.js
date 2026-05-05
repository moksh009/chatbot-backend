const express = require('express');
const router = express.Router();
const { resolveClient, startOfDayIST, tenantClientId } = require('../utils/queryHelpers');
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
const ActivityLog = require('../models/ActivityLog');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { apiCache } = require('../middleware/apiCache');

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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const query = { clientId };

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

// GET /api/analytics/:clientId/activities
// @desc    Get real-time activity pulse history
// @access  Private
router.get('/:clientId/activities', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId || clientId !== req.params.clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        const activities = await ActivityLog.find({ clientId })
            .sort({ createdAt: -1 })
            .limit(50);

        res.json({ success: true, activities });
    } catch (err) {
        console.error('Activities Fetch Error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

// GET /api/analytics/import-sessions
// @desc    Get CSV import history
// @access  Private
router.get('/import-sessions', protect, async (req, res) => {
    try {
        const clientId = tenantClientId(req);
        if (!clientId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }
        
        const ImportSession = require('../models/ImportSession');
        const sessions = await ImportSession.find({ clientId }).sort({ createdAt: -1 }).limit(20);
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ message: 'History fetch failed' });
    }
});

// GET /api/analytics/flow-heatmap
// @desc    Get node visit distribution for visual heatmap overlay (Phase R4: Uses FlowAnalytics)
// @access  Private
router.get('/flow-heatmap', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { start, end, phoneNumberId } = req.query;
    const FlowAnalytics = require('../models/FlowAnalytics');

    const matchQuery = { clientId };
    if (phoneNumberId) matchQuery.phoneNumberId = phoneNumberId;
    
    if (start || end) {
      matchQuery.createdAt = {};
      if (start) matchQuery.createdAt.$gte = new Date(start);
      if (end) matchQuery.createdAt.$lte = new Date(end);
    }

    // Aggregate counts by nodeId
    const heatmapData = await FlowAnalytics.aggregate([
      { $match: matchQuery },
      { $group: { _id: "$nodeId", count: { $sum: 1 } } }
    ]);

    const heatmap = {};
    heatmapData.forEach(item => {
      heatmap[item._id] = item.count;
    });
    const client = await Client.findOne({ clientId }).select('flowNodes visualFlows').lean();
    const nodeLabelMap = {};
    const labelFromNode = (node) =>
      node?.data?.label ||
      node?.data?.title ||
      node?.data?.name ||
      node?.data?.text ||
      node?.data?.body ||
      node?.data?.templateName ||
      node?.type ||
      node?.id;
    (client?.visualFlows || []).forEach((flow) => {
      (flow?.nodes || []).forEach((node) => {
        if (node?.id) nodeLabelMap[node.id] = labelFromNode(node);
      });
    });
    (client?.flowNodes || []).forEach((node) => {
      if (node?.id && !nodeLabelMap[node.id]) nodeLabelMap[node.id] = labelFromNode(node);
    });

    const nodes = heatmapData
      .map(item => ({
        id: item._id,
        label: nodeLabelMap[item._id] || item._id,
        type: 'flow-node',
        visitCount: item.count
      }))
      .sort((a, b) => b.visitCount - a.visitCount)
      .slice(0, 15);

    res.json({ success: true, heatmap, nodes });
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
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

router.get('/realtime', protect, apiCache(60), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // Performance Overhaul: Single document lookup replaces 17 aggregation queries
    const { getStats } = require('../utils/statCacheEngine');
    const stats = await getStats(clientId);

    if (!stats) {
      return res.status(404).json({ message: 'Client not found or stats unavailable' });
    }

    // Fetch client name (lightweight — indexed unique lookup)
    const client = await Client.findOne({ clientId }).select('businessName name').lean();

    // Phase 28: Timeline Selector Integration
    const days = parseInt(req.query.days) || 1;
    const startDate = new Date();
    if (days > 1) {
      startDate.setDate(startDate.getDate() - (days - 1));
    }
    startDate.setHours(0, 0, 0, 0);

    const [realtimeCarts, realtimeClicks, flowPerfAgg, optStatusAgg, pixelFunnelAgg, rtoRiskAgg] = await Promise.all([
      require('../models/PixelEvent').countDocuments({ clientId, eventName: { $in: ['product_added_to_cart', 'add_to_cart', 'checkout_started'] }, timestamp: { $gte: startDate } }),
      require('../models/LinkClickEvent').countDocuments({ clientId, timestamp: { $gte: startDate } }),
      DailyStat.aggregate([
        {
          $match: {
            clientId,
            date: {
              $gte: startDate.toISOString().split('T')[0],
              $lte: new Date().toISOString().split('T')[0]
            }
          }
        },
        {
          $group: {
            _id: null,
            flowsSent: { $sum: { $ifNull: ['$flowsSent', 0] } },
            flowsCompleted: { $sum: { $ifNull: ['$flowsCompleted', 0] } }
          }
        }
      ]),
      AdLead.aggregate([
        { $match: { clientId } },
        { $group: { _id: { $ifNull: ['$optStatus', 'unknown'] }, count: { $sum: 1 } } }
      ]),
      require('../models/PixelEvent').aggregate([
        {
          $match: {
            clientId,
            timestamp: { $gte: startDate },
            eventName: { $in: ['product_added_to_cart', 'add_to_cart', 'checkout_started', 'checkout_completed'] }
          }
        },
        { $group: { _id: '$eventName', count: { $sum: 1 } } }
      ]),
      Order.aggregate([
        { $match: { clientId, createdAt: { $gte: startDate } } },
        {
          $group: {
            _id: { $ifNull: ['$rtoRiskLevel', 'unknown'] },
            count: { $sum: 1 },
            gmv: { $sum: { $ifNull: ['$amount', 0] } }
          }
        }
      ])
    ]);

    // Task 1.2: Human Handled & AI Handled
    const ConversationAssignment = require('../models/ConversationAssignment');
    const humanHandledAgg = await ConversationAssignment.aggregate([
      { $match: { clientId, assignedAt: { $gte: startDate } } },
      { $group: { _id: "$conversationId" } },
      { $count: "count" }
    ]);
    const humanHandled = humanHandledAgg[0]?.count || 0;

    const Message = require('../models/Message');
    const aiHandledAgg = await Message.aggregate([
      { $match: { clientId, timestamp: { $gte: startDate }, direction: 'outgoing' } },
      { $group: { _id: "$conversationId" } },
      {
        $lookup: {
          from: 'conversationassignments',
          localField: '_id',
          foreignField: 'conversationId',
          pipeline: [
            { $match: { assignedAt: { $gte: startDate } } }
          ],
          as: 'assignments'
        }
      },
      { $match: { assignments: { $size: 0 } } },
      { $count: "count" }
    ]);
    const aiHandled = aiHandledAgg[0]?.count || 0;
    const totalHandled = aiHandled + humanHandled;
    const aiResolutionRate = totalHandled > 0 ? (aiHandled / totalHandled) * 100 : 0;

    const flowPerf = flowPerfAgg[0] || { flowsSent: 0, flowsCompleted: 0 };
    const flowCompletionRate = flowPerf.flowsSent > 0 ? (flowPerf.flowsCompleted / flowPerf.flowsSent) * 100 : 0;

    const optMap = Object.fromEntries(optStatusAgg.map(r => [String(r._id || 'unknown'), r.count || 0]));
    const totalOptLeads = Object.values(optMap).reduce((acc, n) => acc + n, 0);
    const optedInCount = optMap.opted_in || 0;
    const optedOutCount = optMap.opted_out || 0;
    const optInRate = totalOptLeads > 0 ? (optedInCount / totalOptLeads) * 100 : 0;

    const funnelMap = Object.fromEntries(pixelFunnelAgg.map(r => [r._id, r.count || 0]));
    const addToCartCount = (funnelMap.add_to_cart || 0) + (funnelMap.product_added_to_cart || 0);
    const checkoutCompletedCount = funnelMap.checkout_completed || 0;
    const checkoutConversionRate = addToCartCount > 0 ? (checkoutCompletedCount / addToCartCount) * 100 : 0;

    const totalRiskOrders = rtoRiskAgg.reduce((acc, row) => acc + (row.count || 0), 0);
    const highRiskRow = rtoRiskAgg.find(row => String(row._id || '').toLowerCase() === 'high');
    const highRiskOrders = highRiskRow?.count || 0;
    const highRiskGmv = highRiskRow?.gmv || 0;
    const highRiskShare = totalRiskOrders > 0 ? (highRiskOrders / totalRiskOrders) * 100 : 0;

    const attributionAgg = await require('../models/PixelEvent').aggregate([
      { $match: { clientId, timestamp: { $gte: startDate } } },
      {
        $group: {
          _id: {
            session: { $ifNull: ["$sessionId", "$ip"] },
            source: {
              $switch: {
                branches: [
                  { case: { $regexMatch: { input: { $ifNull: ["$url", ""] }, regex: /utm_source=(meta|facebook|ig|fb|instagram)/i } }, then: "Meta Ads" },
                  { case: { $regexMatch: { input: { $ifNull: ["$url", ""] }, regex: /utm_source=(google|gads)/i } }, then: "Google Ads" },
                ],
                default: "Direct/Organic"
              }
            }
          }
        }
      },
      { $group: { _id: "$_id.source", count: { $sum: 1 } } },
      { $project: { source: "$_id", count: 1, _id: 0 } }
    ]);

    // Map StatCache to the existing /realtime response shape (backward-compatible)
    res.json({
      businessName: client?.businessName || client?.name || clientId,
      leads: { total: stats.totalLeads, newToday: stats.leadsToday },
      orders: { count: stats.ordersToday, revenue: stats.revenueToday },
      linkClicks: realtimeClicks || stats.totalLinkClicks,
      agentRequests: humanHandled, // Overriding the dailyStat placeholder
      aiHandled: aiHandled,
      humanHandled: humanHandled,
      addToCarts: realtimeCarts || stats.totalAddToCarts,
      checkouts: stats.totalCheckouts,
      abandonedCarts: stats.abandonedCarts,
      recoveredCarts: stats.recoveredCarts,
      abandonedCartSent: stats.abandonedCartSent,
      abandonedCartClicks: stats.abandonedCartClicks,
      funnel: {
        totalOrdersAllTime: stats.totalOrders,
        whatsappRecoveriesPurchased: stats.whatsappRecoveriesPurchased,
        adminFollowupsPurchased: stats.adminFollowupsPurchased
      },
      attribution: attributionAgg.length > 0 ? attributionAgg : [{ source: 'Direct/Organic', count: 1 }],
      sentiment: stats.sentimentCounts || { Positive: 0, Neutral: 0, Negative: 0, Frustrated: 0, Urgent: 0, Unknown: 0 },
      enterprise: {
        aiResolutionRate,
        flowCompletionRate,
        checkoutConversionRate,
        optInRate,
        highRiskShare,
        highRiskGmv,
        counts: {
          aiHandled,
          humanHandled,
          flowsSent: flowPerf.flowsSent || 0,
          flowsCompleted: flowPerf.flowsCompleted || 0,
          addToCartCount,
          checkoutCompletedCount,
          optedInCount,
          optedOutCount,
          highRiskOrders,
          totalRiskOrders
        }
      }
    });

  } catch (error) {
    console.error('Realtime Analytics Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

router.get('/leads', protect, apiCache(30), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const query = { clientId };

    const { limit = 20, search = '', page = 1, tag, segmentScore, lastSeen, sortBy } = req.query;
    const pageNum = parseInt(page) || 1;
    const limitNum = Math.min(parseInt(limit) || 20, 100);

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { name: searchRegex },
        { phoneNumber: searchRegex }
      ];
    }
    
    // Server-side Filtering
    if (tag) {
      query.tags = tag;
    }
    
    if (segmentScore) {
      const [min, max] = segmentScore.split('-').map(Number);
      if (!isNaN(min) && !isNaN(max)) query.leadScore = { $gte: min, $lte: max };
    }
    
    if (lastSeen) {
      const days = lastSeen === '24h' ? 1 : lastSeen === '7d' ? 7 : lastSeen === '14d' ? 14 : lastSeen === '1m' ? 30 : lastSeen === '6m' ? 180 : 0;
      if (days > 0) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        query.lastInteraction = { $gte: date };
      }
    }

    const skip = (pageNum - 1) * limitNum;

    const leadListProjection =
      'name phoneNumber leadScore tags lastInteraction chatSummary cartStatus lastMessageContent lastInboundAt linkClicks email ordersCount totalSpent intentState addToCartCount meta createdAt pendingSupport lastPurchaseDate source adAttribution cartValue lifetimeValue checkoutInitiatedCount optInSource inboundMessageCount';

    let sortObj = { lastInteraction: -1 };
    if (sortBy === 'score') sortObj = { leadScore: -1 };
    else if (sortBy === 'ltv') sortObj = { totalSpent: -1 };
    else if (sortBy === 'name') sortObj = { name: 1 };
    else if (sortBy === 'clicks') sortObj = { linkClicks: -1 };
    else if (sortBy === 'lastPurchase') sortObj = { lastPurchaseDate: -1 };
    else if (sortBy === 'orders') sortObj = { ordersCount: -1 };
    else if (sortBy === 'cartValue') sortObj = { cartValue: -1 };

    const fetchLeadsPage = async () => {
      if (sortBy === 'aov') {
        return AdLead.aggregate([
          { $match: query },
          {
            $addFields: {
              __aovSort: {
                $cond: {
                  if: { $gt: ['$ordersCount', 0] },
                  then: { $divide: [{ $ifNull: ['$totalSpent', 0] }, '$ordersCount'] },
                  else: 0
                }
              }
            }
          },
          { $sort: { __aovSort: -1, _id: -1 } },
          { $skip: skip },
          { $limit: limitNum },
          { $project: { __aovSort: 0 } }
        ]);
      }
      return AdLead.find(query)
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .select(leadListProjection)
        .lean();
    };

    const [leads, total, activeToday, withConversation, highEngagement] = await Promise.all([
      fetchLeadsPage(),
      AdLead.countDocuments(query),
      AdLead.countDocuments({ clientId, lastInboundAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
      AdLead.countDocuments({ clientId, $or: [{ chatSummary: { $exists: true, $ne: "" } }, { lastMessageContent: { $exists: true, $ne: "" } }] }),
      AdLead.countDocuments({ clientId, linkClicks: { $gt: 5 } })
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.json({
      leads,
      currentPage: pageNum,
      totalPages,
      totalLeads: total,
      summary: {
        activeToday,
        withConversation,
        highEngagement
      },
      pagination: { page: pageNum, limit: limitNum, total, totalPages }
    });

  } catch (error) {
    console.error('Leads Fetch Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/lead/:id (Detailed Lead View)
router.get('/lead/:id', protect, async (req, res) => {
  try {
    const lead = await AdLead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found' });

    // BACKGROUND ENRICHMENT: If email or city is missing, fetch from Shopify
    if (!lead.email || !lead.city) {
      try {
        const { searchCustomerByPhone } = require('../utils/shopifyGraphQL');
        const shopifyCustomer = await searchCustomerByPhone(lead.clientId, lead.phoneNumber);
        
        if (shopifyCustomer) {
          lead.email = lead.email || shopifyCustomer.email;
          lead.city = lead.city || shopifyCustomer.defaultAddress?.city;
          lead.name = lead.name || `${shopifyCustomer.firstName} ${shopifyCustomer.lastName || ''}`.trim();
          await AdLead.findByIdAndUpdate(lead._id, { $set: { email: lead.email, city: lead.city, name: lead.name } });
          console.log(`[LeadEnrichment] Synced data for ${lead.phoneNumber} from Shopify`);
        }
      } catch (e) {
        console.warn(`[LeadEnrichment] Failed for ${lead.phoneNumber}: ${e.message}`);
      }
    }

    // Fetch related orders (handle stripped country code from Shopify)
    const strippedPhone = lead.phoneNumber.length > 10 && lead.phoneNumber.startsWith('91')
      ? lead.phoneNumber.substring(2)
      : lead.phoneNumber;

    const phoneDigits = Array.from(lead.phoneNumber || '').filter(c => c >= '0' && c <= '9').join('');
    const pSuf = phoneDigits.slice(-10);

    const CustomerIntelligence = require('../models/CustomerIntelligence');
    const LoyaltyWallet = require('../models/LoyaltyWallet');
    const LoyaltyTransaction = require('../models/LoyaltyTransaction');
    const CampaignMessage = require('../models/CampaignMessage');
    const FollowUpSequence = require('../models/FollowUpSequence');

    const [
      orders,
      appointments,
      conversation,
      dna,
      wallet,
      walletTransactions,
      marketingLogs,
      sequences
    ] = await Promise.all([
      Order.find({
        clientId: lead.clientId,
        $or: [
          { phone: lead.phoneNumber },
          { phone: strippedPhone },
          { phone: `+91${strippedPhone}` },
          { phone: `91${strippedPhone}` }
        ]
      }).lean(),
      Appointment.find({ phone: lead.phoneNumber, clientId: lead.clientId }).lean(),
      Conversation.findOne({ phone: lead.phoneNumber, clientId: lead.clientId }).lean(),
      CustomerIntelligence.findOne({ clientId: lead.clientId, phone: lead.phoneNumber }).lean().catch(() => null),
      LoyaltyWallet.findOne({ clientId: lead.clientId, phone: new RegExp(pSuf + '$') }).lean().catch(() => null),
      LoyaltyTransaction.find({ clientId: lead.clientId, phone: new RegExp(pSuf + '$') }).sort({ timestamp: -1 }).limit(5).lean().catch(() => []),
      CampaignMessage.find({ clientId: lead.clientId, phone: lead.phoneNumber }).populate('campaignId', 'name type').sort({ sentAt: -1 }).limit(20).lean().catch(() => []),
      FollowUpSequence.find({ clientId: lead.clientId, phone: lead.phoneNumber }).sort({ createdAt: -1 }).limit(10).lean().catch(() => [])
    ]);

    // Fetch recent messages
    let messages = [];
    if (conversation) {
      messages = await Message.find({ conversationId: conversation._id }).sort({ timestamp: -1 }).limit(20).lean();
    }

    // --- Phase 28: Customer Enrichment Engine (Super Fast) ---
    // If name/email/city is missing, inherit from the latest valid order
    let updatedNeeded = false;
    const updateData = {};

    if (orders && orders.length > 0) {
      // Sort orders by date to get latest first
      const sortedOrders = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const latestOrder = sortedOrders[0];

      if ((!lead.name || lead.name === 'Anonymous user') && latestOrder.customerName) {
        lead.name = latestOrder.customerName;
        updateData.name = latestOrder.customerName;
        updatedNeeded = true;
      }
      if (!lead.email && (latestOrder.customerEmail || latestOrder.email)) {
        lead.email = latestOrder.customerEmail || latestOrder.email;
        updateData.email = lead.email;
        updatedNeeded = true;
      }
      if (!lead.city && latestOrder.city) {
        lead.city = latestOrder.city;
        updateData.city = latestOrder.city;
        updatedNeeded = true;
      }
    }

    // --- Phase 25: Shopify Deep Search Fallback (If still missing) ---
    if (!lead.email || !lead.city) {
      try {
        const { searchCustomerByPhone } = require('../utils/shopifyGraphQL');
        const shopifyCustomer = await searchCustomerByPhone(lead.clientId, lead.phoneNumber);
        
        if (shopifyCustomer) {
          if (!lead.email && shopifyCustomer.email) {
            lead.email = shopifyCustomer.email;
            updateData.email = shopifyCustomer.email;
            updatedNeeded = true;
          }
          if ((!lead.name || lead.name === 'Anonymous user') && (shopifyCustomer.firstName || shopifyCustomer.lastName)) {
            const fullName = `${shopifyCustomer.firstName || ''} ${shopifyCustomer.lastName || ''}`.trim();
            lead.name = fullName;
            updateData.name = fullName;
            updatedNeeded = true;
          }
          if (!lead.city && shopifyCustomer.defaultAddress?.city) {
            lead.city = shopifyCustomer.defaultAddress.city;
            updateData.city = shopifyCustomer.defaultAddress.city;
            updatedNeeded = true;
          }
        }
      } catch (err) {
        console.error(`[Enrichment] Shopify search failed for ${lead.phoneNumber}:`, err.message);
      }
    }

    // --- PHASE 29: Journey Log Aggregation ---
    const journeyLog = [];
    if (lead.createdAt) {
      journeyLog.push({ eventName: 'Lead Created', timestamp: lead.createdAt });
    }
    if (orders && orders.length > 0) {
      orders.forEach(o => journeyLog.push({ 
        eventName: 'Order Placed', 
        timestamp: o.createdAt, 
        metadata: { amount: o.totalPrice, status: o.financialStatus, name: o.name } 
      }));
    }
    if (conversation && conversation.createdAt) {
      journeyLog.push({ eventName: 'Conversation Started', timestamp: conversation.createdAt });
    }
    // Sort chronological
    journeyLog.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Perf: Background update to AdLead so next load is instant
    if (updatedNeeded) {
      AdLead.findByIdAndUpdate(lead._id, { $set: updateData }).catch(e => console.error("Enrichment Background Update Failed", e));
    }

    res.json({
      lead,
      orders,
      appointments,
      conversation,
      messages,
      intelligence: dna || null,
      wallet: wallet ? { ...wallet, transactions: walletTransactions } : null,
      marketingLogs,
      sequences,
      journeyLog
    });
  } catch (error) {
    console.error('Lead Detail Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

// GET /api/analytics/lead-by-phone/:phone
router.get('/lead-by-phone/:phone', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    // --- PHASE 11 FIX: Robust Lead Lookup ---
    const rawPhone = req.params.phone;
    const phoneVariants = [
      rawPhone,
      rawPhone.startsWith('+') ? rawPhone.substring(1) : `+${rawPhone}`,
      rawPhone.startsWith('91') ? `+${rawPhone}` : rawPhone // Specific fallback for IN
    ];

    const leadQuery = { clientId, phoneNumber: { $in: phoneVariants } };

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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    
    const { name, email, tags, isNameCustom } = req.body;
    
    // Robust phone matching: strip non-digits, use last 10 for suffix match
    const cleanPhone = req.params.phone.replace(/\D/g, '');
    const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const phoneRegex = new RegExp(`${phoneSuffix}$`);
    
    let updateFields = { name, email, tags, lastInteraction: new Date() };
    if (isNameCustom !== undefined) updateFields.isNameCustom = isNameCustom;

    const lead = await AdLead.findOneAndUpdate(
      { phoneNumber: phoneRegex, clientId },
      { $set: updateFields },
      { new: true }
    );
    
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    // Also sync to Conversation if exists
    await Conversation.updateMany(
      { phone: phoneRegex, clientId },
      { $set: { customerName: name } }
    );

    res.json(lead);
  } catch (error) {
    console.error('Update Lead Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// GET /api/analytics/top-leads
router.get('/top-leads', protect, apiCache(60), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    // --- PHASE 11 FIX: Refined Hot Leads (Score >= 60) ---
    const query = { clientId, leadScore: { $gte: 60 } };

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
router.get('/top-products', protect, apiCache(60), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const query = { clientId };

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
router.get('/receptionist-overview', protect, apiCache(60), async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const daysToFetch = parseInt(req.query.days) || 1; // Default to 1 day (today)

    // ✅ Phase R3: IST midnight fix — was using UTC midnight for appointment date window
    const today = startOfDayIST();

    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + daysToFetch); // Fetch for N days

    // Fetch client for Google Calendar IDs
    const client = await Client.findOne({ clientId })
      .select('googleCalendarId config businessName name isActive')
      .lean();

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

    const query = { clientId };

    // Fetch DB appointments created/for this client
    const dbAppointments = await Appointment.find({
      ...query,
      status: { $ne: 'cancelled' }
    }).select('eventId name phone service status createdAt').lean();

    // 3. Merge Events - O(1) Hash Map approach to fix N+1 Loop
    const appointmentMap = {};
    dbAppointments.forEach(a => {
      if (a.eventId) appointmentMap[a.eventId] = a;
    });

    const mergedAppointments = googleEvents.map(event => {
      const dbAppt = appointmentMap[event.id];
      const startDateTime = event.start?.dateTime || event.start?.date;

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
    }).select('_id phone customerName updatedAt').sort({ updatedAt: -1 }).limit(10).lean();

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
    }).select('name phoneNumber leadScore tags lastInteraction').lean();

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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
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

    // --- FETCH GCAL EVENTS & AGGREGATIONS IN PARALLEL ---
    const [
      gcalResults,
      conversationActivity,
      appointments,
      messages,
      reminderStats,
      orders,
      cartEvents,
      linkClickEvents,
      humanHandledAgg,
      aiHandledAgg,
      attributionAgg
    ] = await Promise.all([
      // GCal
      Promise.all(Array.from(calendarIds).map(calId =>
        listEvents(startDate.toISOString(), endDate.toISOString(), calId).catch(() => [])
      )),
      // 1. Conversations
      Message.aggregate([
        { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, conversationId: '$conversationId' } } },
        { $group: { _id: '$_id.date', count: { $sum: 1 } } }
      ]),
      // 3. Appointments
      Appointment.aggregate([
        { $match: { ...clientIdQuery, createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$revenue", 0] } } } }
      ]),
      // 4. Messages
      Message.aggregate([
        { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, count: { $sum: 1 } } }
      ]),
      // 5. DailyStat
      DailyStat.find({ ...clientIdQuery, date: { $gte: dates[0], $lte: dates[dates.length - 1] } }),
      // 6. Orders
      Order.aggregate([
        { $match: { ...clientIdQuery, createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 }, revenue: { $sum: "$amount" } } }
      ]),
      // 7. Cart Events (Atomic)
      require('../models/PixelEvent').aggregate([
        { $match: { ...clientIdQuery, eventName: { $in: ['product_added_to_cart', 'add_to_cart', 'checkout_started'] }, timestamp: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, count: { $sum: 1 } } }
      ]),
      // 8. Link Clicks (Atomic)
      require('../models/LinkClickEvent').aggregate([
        { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, count: { $sum: 1 } } }
      ]),
      // 9. Human Handled (Task 1.2)
      require('../models/ConversationAssignment').aggregate([
        { $match: { ...clientIdQuery, assignedAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$assignedAt" } }, conversationId: "$conversationId" } } },
        { $group: { _id: "$_id.date", count: { $sum: 1 } } }
      ]),
      // 10. AI Handled (Task 1.2)
      Message.aggregate([
        { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate }, direction: 'outgoing' } },
        { $group: { _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, conversationId: "$conversationId" } } },
        {
          $lookup: {
            from: 'conversationassignments',
            let: { cId: "$_id.conversationId", d: "$_id.date" },
            pipeline: [
              { $match: { $expr: { $and: [
                { $eq: ["$conversationId", "$$cId"] },
                { $eq: [{ $dateToString: { format: "%Y-%m-%d", date: "$assignedAt" } }, "$$d"] }
              ] } } }
            ],
            as: 'assignments'
          }
        },
        { $match: { assignments: { $size: 0 } } },
        { $group: { _id: "$_id.date", count: { $sum: 1 } } }
      ]),
      // 11. Attribution (Task 1.3)
      require('../models/PixelEvent').aggregate([
        { $match: { ...clientIdQuery, timestamp: { $gte: startDate, $lte: endDate } } },
        {
          $group: {
            _id: {
              session: { $ifNull: ["$sessionId", "$ip"] },
              source: {
                $switch: {
                  branches: [
                    { case: { $regexMatch: { input: { $ifNull: ["$url", ""] }, regex: /utm_source=(meta|facebook|ig|fb|instagram)/i } }, then: "Meta Ads" },
                    { case: { $regexMatch: { input: { $ifNull: ["$url", ""] }, regex: /utm_source=(google|gads)/i } }, then: "Google Ads" },
                  ],
                  default: "Direct/Organic"
                }
              }
            }
          }
        },
        { $group: { _id: "$_id.source", count: { $sum: 1 } } },
        { $project: { source: "$_id", count: 1, _id: 0 } }
      ])
    ]);

    // Process GCal results into same flat map
    let gcalCounts = {};
    const allEvents = gcalResults.flat();
    allEvents.forEach(event => {
      const start = event.start.dateTime || event.start.date;
      if (start) {
        const dateStr = start.split('T')[0];
        gcalCounts[dateStr] = (gcalCounts[dateStr] || 0) + 1;
      }
    });

    // ------------------------------------------

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
      const humanHandled = humanHandledAgg.find(c => c._id === date)?.count || 0;
      const aiHandled = aiHandledAgg.find(c => c._id === date)?.count || 0;
      const checkoutCount = dayReminder?.checkouts || 0;
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
      const flowsSent = dayReminder?.flowsSent || 0;
      const flowsCompleted = dayReminder?.flowsCompleted || 0;
      const browseAbandonedCount = dayReminder?.browseAbandonedCount || 0;
      const upsellSentCount = dayReminder?.upsellSentCount || 0;
      const upsellConvertedCount = dayReminder?.upsellConvertedCount || 0;
      const upsellRevenue = dayReminder?.upsellRevenue || 0;
      const marketingMessagesSent = dayReminder?.marketingMessagesSent || 0;
      const aiResolutionRateDay = (humanHandled + aiHandled) > 0 ? ((aiHandled / (humanHandled + aiHandled)) * 100) : 0;
      const flowCompletionRateDay = flowsSent > 0 ? ((flowsCompleted / flowsSent) * 100) : 0;

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
        humanHandled: humanHandled,
        aiHandled: aiHandled,
        agentRequests: humanHandled, // For backwards compatibility if frontend uses this
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
        cartRevenueRecovered,
        flowsSent,
        flowsCompleted,
        browseAbandonedCount,
        upsellSentCount,
        upsellConvertedCount,
        upsellRevenue,
        marketingMessagesSent,
        aiResolutionRate: Number(aiResolutionRateDay.toFixed(2)),
        flowCompletionRate: Number(flowCompletionRateDay.toFixed(2))
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const query = { clientId };

    const [appts, orders, leads] = await Promise.all([
      Appointment.find(query).select('createdAt phone revenue').lean(),
      Order.find(query).select('createdAt amount').lean(),
      AdLead.find(query).select('createdAt lastSeen ordersCount addToCartCount phoneNumber checkoutInitiatedCount cartStatus').lean()
    ]);

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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
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
router.get('/flow-heatmap-legacy', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
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
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
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
         rtoRiskCount: RTO
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
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
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const query = { clientId };

    // 1. Fetch Conversations with FRT metrics (lean + select only needed fields)
    const convos = await Conversation.find({
        ...query,
        firstInboundAt: { $exists: true, $ne: null },
        firstResponseAt: { $exists: true, $ne: null },
    }).select('firstInboundAt firstResponseAt').lean();

    // 2. Avg first response (seconds) — ignore bad rows (inverted timestamps, absurd gaps)
    const MAX_FRT_SEC = 48 * 3600; // 48h cap; outliers / legacy bad data excluded
    const frtSamples = [];
    for (const c of convos) {
      const t0 = new Date(c.firstInboundAt).getTime();
      const t1 = new Date(c.firstResponseAt).getTime();
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      const diffSec = (t1 - t0) / 1000;
      if (diffSec < 0 || diffSec > MAX_FRT_SEC) continue;
      frtSamples.push(diffSec);
    }
    const avgFRT =
      frtSamples.length > 0 ? frtSamples.reduce((a, b) => a + b, 0) / frtSamples.length : null;

    // 3. Resolution Rate & Avg Resolution Time (parallel queries)
    const [totalConvos, resolvedConvos, csatConvos] = await Promise.all([
      Conversation.countDocuments(query),
      Conversation.find({ ...query, resolvedAt: { $exists: true, $ne: null } })
        .select('resolvedAt firstInboundAt')
        .lean(),
      Conversation.find({ ...query, "csatScore.rating": { $exists: true } }).select('csatScore').lean()
    ]);
    const resolutionRate = totalConvos > 0 ? (resolvedConvos.length / totalConvos * 100).toFixed(1) : "0";
    
    const MAX_RES_H = 24 * 30; // 30 days max; drop corrupt rows
    const resSamples = [];
    for (const c of resolvedConvos) {
      const t0 = new Date(c.firstInboundAt).getTime();
      const t1 = new Date(c.resolvedAt).getTime();
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
      const hrs = (t1 - t0) / (1000 * 60 * 60);
      if (hrs < 0 || hrs > MAX_RES_H) continue;
      resSamples.push(hrs);
    }
    const avgResolutionTime =
      resSamples.length > 0
        ? (resSamples.reduce((a, b) => a + b, 0) / resSamples.length).toFixed(1)
        : null;

    // 4. CSAT Calculation (already fetched above)
    const totalScore = csatConvos.reduce((sum, c) => sum + (c.csatScore?.rating ?? 0), 0);
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

    const resolvedCount = resolvedConvos.length;
    const agentsOut = (agentStats || []).map((a) => ({
      name: a.name,
      email: a.email,
      role: a.role,
      resolutions: a.resolutions || 0,
      totalHandled: a.totalHandled || 0,
      resolutionPct:
        a.totalHandled > 0 ? ((a.resolutions / a.totalHandled) * 100).toFixed(0) : '0',
    }));

    const avgFRTOut =
      avgFRT == null
        ? '—'
        : avgFRT > 60
          ? `${(avgFRT / 60).toFixed(1)}m`
          : `${avgFRT.toFixed(0)}s`;
    const avgResOut = avgResolutionTime == null ? '—' : `${avgResolutionTime}h`;

    res.json({
        success: true,
        avgFRT: avgFRTOut,
        resolutionRate: `${resolutionRate}%`,
        avgResolutionTime: avgResOut,
        activeAgents: agentStats.length,
        avgCSAT: `${avgCSAT}/5`,
        totalConversations: totalConvos,
        resolvedConversations: resolvedCount,
        agents: agentsOut
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
    
    // BUILD COMPREHENSIVE PAYLOAD using StatCache
    const { getStats } = require('../utils/statCacheEngine');
    const stats = await getStats(client.clientId);

    const [
      escalations,
      topLeads,
      topProductsRaw
    ] = await Promise.all([
      Conversation.find({ clientId: client.clientId, status: 'HUMAN_TAKEOVER' }).sort({ lastMessageAt: -1 }).limit(10).select('phone customerName lastMessage lastMessageAt attentionReason status').lean(),
      AdLead.find({ clientId: client.clientId, leadScore: { $gte: 60 } }).sort({ leadScore: -1 }).limit(5).select('name phoneNumber leadScore tags lastInteraction intentState').lean(),
      Order.aggregate([
        { $match: { clientId: client.clientId } },
        { $unwind: "$items" },
        { $group: { _id: "$items.name", revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } }, sold: { $sum: "$items.quantity" } } },
        { $sort: { revenue: -1 } },
        { $limit: 10 }
      ])
    ]);
    
    const revenue = stats.revenueToday || 0;
    const ordersCount = stats.ordersToday || 0;

    return res.json({
      success: true,
      data: {
        stats_grid: {
          leads: { total: stats.totalLeads, newToday: stats.leadsToday },
          orders: { 
            count: ordersCount, 
            revenue: revenue,
            cartAdds: stats.totalAddToCarts,
            checkouts: stats.totalCheckouts,
            linkClicks: stats.totalLinkClicks,
            abandonedCarts: stats.abandonedCarts,
            recoveredCarts: stats.recoveredCarts
          },
          conversations: { total: stats.totalConversations }
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


// ═══ GET /api/analytics/operators ═══════════════════════════════════════════
// @desc  Aggregate per-operator performance metrics: human agents + AI Bot.
// @access Private
// STRICT MANDATE: No dummy data. Every field derived exclusively from the
// Conversation collection aggregation. Frontend table maps directly to this shape.
router.get('/operators', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    
    const { days } = req.query;
    const dateLimit = new Date();
    if (days && days !== 'all') {
      dateLimit.setDate(dateLimit.getDate() - parseInt(days));
    } else {
      dateLimit.setFullYear(2000);
    }

    const User = require('../models/User');
    const ConversationAssignment = require('../models/ConversationAssignment');

    // 1. Human agents aggregation via ConversationAssignment
    const humanAgg = await ConversationAssignment.aggregate([
      { $match: { clientId, assignedAt: { $gte: dateLimit } } },
      {
        $lookup: {
          from: 'conversations',
          localField: 'conversationId',
          foreignField: '_id',
          as: 'conv'
        }
      },
      { $unwind: "$conv" },
      {
        $group: {
          _id: "$assignedAgentId",
          currentOpenTickets: { $sum: { $cond: [{ $in: ['$conv.status', ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT']] }, 1, 0] } },
          ticketsSolved: { $sum: { $cond: [{ $eq: ['$conv.status', 'CLOSED'] }, 1, 0] } },
          pendingTickets: { $sum: { $cond: [{ $eq: ['$conv.status', 'WAITING_FOR_INPUT'] }, 1, 0] } },
          totalHandled: { $sum: 1 },
          totalResponseTime: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$conv.firstResponseAt', null] }, { $ne: ['$conv.firstInboundAt', null] }] },
                { $subtract: ['$conv.firstResponseAt', '$conv.firstInboundAt'] },
                0
              ]
            }
          },
          countWithResponseTime: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$conv.firstResponseAt', null] }, { $ne: ['$conv.firstInboundAt', null] }] },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    // 2. AI Bot aggregation (unassigned conversations active in timeline)
    const aiAgg = await Conversation.aggregate([
      { $match: { clientId, updatedAt: { $gte: dateLimit }, assignedTo: null } },
      {
        $group: {
          _id: '__AI_BOT__',
          currentOpenTickets: { $sum: { $cond: [{ $in: ['$status', ['HUMAN_TAKEOVER', 'HUMAN_SUPPORT']] }, 1, 0] } },
          ticketsSolved: { $sum: { $cond: [{ $eq: ['$status', 'CLOSED'] }, 1, 0] } },
          pendingTickets: { $sum: { $cond: [{ $eq: ['$status', 'WAITING_FOR_INPUT'] }, 1, 0] } },
          totalHandled: { $sum: 1 },
          avgResponseTimeMs: { $avg: { $subtract: ['$firstResponseAt', '$firstInboundAt'] } }
        }
      }
    ]);

    // 3. Fetch ALL users for this client to ensure everyone is displayed
    const allUsers = await User.find({ clientId }).select('name email').lean();

    const agentMap = {};
    humanAgg.forEach(g => {
        agentMap[String(g._id)] = {
            currentOpenTickets: g.currentOpenTickets,
            pendingTickets: g.pendingTickets,
            ticketsSolved: g.ticketsSolved,
            totalHandled: g.totalHandled,
            avgResponseTimeMs: g.countWithResponseTime > 0 ? g.totalResponseTime / g.countWithResponseTime : 0
        };
    });

    let operators = allUsers.map(u => {
        const stats = agentMap[String(u._id)] || {
            currentOpenTickets: 0,
            pendingTickets: 0,
            ticketsSolved: 0,
            totalHandled: 0,
            avgResponseTimeMs: 0
        };
        
        return {
            agentId: String(u._id),
            agentName: u.name || 'Unknown Agent',
            agentEmail: u.email || '-',
            isBot: false,
            currentOpenTickets: stats.currentOpenTickets,
            pendingTickets: stats.pendingTickets,
            ticketsSolved: stats.ticketsSolved,
            totalHandled: stats.totalHandled,
            avgResponseTimeMs: Math.max(0, stats.avgResponseTimeMs)
        };
    });

    // 4. Add AI Bot
    if (aiAgg.length > 0 || true) { // Always show bot
      const ai = aiAgg[0] || { currentOpenTickets: 0, pendingTickets: 0, ticketsSolved: 0, totalHandled: 0, avgResponseTimeMs: 0 };
      operators.push({
        agentId: 'ai-bot',
        agentName: 'AI Bot',
        agentEmail: 'system@ai-bot',
        isBot: true,
        currentOpenTickets: ai.currentOpenTickets,
        pendingTickets: ai.pendingTickets,
        ticketsSolved: ai.ticketsSolved,
        totalHandled: ai.totalHandled,
        avgResponseTimeMs: Math.max(0, ai.avgResponseTimeMs || 0)
      });
    }

    operators.sort((a, b) => {
      if (a.isBot && !b.isBot) return -1;
      if (!a.isBot && b.isBot) return 1;
      return b.ticketsSolved - a.ticketsSolved;
    });

    res.json({ success: true, operators });

  } catch (err) {
    console.error('[Analytics] /operators aggregation error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/optin-overview
router.get('/optin-overview', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, message: 'Unauthorized' });

    const days = req.query.period === '7d' ? 7 : req.query.period === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [statusAgg, sourceAgg, trendAgg, recent] = await Promise.all([
      AdLead.aggregate([
        { $match: { clientId } },
        { $group: { _id: '$optStatus', count: { $sum: 1 } } },
      ]),
      AdLead.aggregate([
        { $match: { clientId } },
        { $group: { _id: '$optInSource', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
      AdLead.aggregate([
        { $match: { clientId, optStatus: 'opted_in', optInDate: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$optInDate' } },
            newOptIns: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      AdLead.find({ clientId, optStatus: { $in: ['opted_in', 'pending', 'opted_out'] } })
        .sort({ updatedAt: -1 })
        .limit(10)
        .select('name optInSource optStatus updatedAt')
        .lean(),
    ]);

    const map = {};
    statusAgg.forEach((x) => { map[x._id || 'unknown'] = x.count; });
    const totalLeads = Object.values(map).reduce((a, b) => a + b, 0);
    const optedIn = map.opted_in || 0;
    const unknown = map.unknown || 0;
    const optedOut = map.opted_out || 0;
    const pending = map.pending || 0;
    const optInRate = totalLeads > 0 ? Number(((optedIn / totalLeads) * 100).toFixed(1)) : 0;

    res.json({
      success: true,
      totalLeads,
      optedIn,
      unknown,
      optedOut,
      pending,
      optInRate,
      bySource: sourceAgg.map((x) => ({ source: x._id || 'unknown', count: x.count })),
      trend: trendAgg.map((x) => ({ date: x._id, newOptIns: x.newOptIns })),
      recentOptIns: recent.map((x) => ({
        name: x.name || 'Customer',
        source: x.optInSource || 'unknown',
        status: x.optStatus || 'unknown',
        timestamp: x.updatedAt || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

