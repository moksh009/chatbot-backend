const Client = require('../models/Client');
const { getCachedClient } = require('../utils/core/clientCache');
const {
  getRealtimeStats,
  getTopProducts,
  getTimelineStats,
  getOperatorsStats,
  getHumanQueueConversations,
  MAX_LIVE_ANALYTICS_DAYS,
} = require('../utils/core/analyticsHelper');
const {
  getAnalyticsChart,
  getCartRecoveryChart,
} = require('../utils/core/dashboardChartAnalytics');
const { tenantClientId, startOfDayForDateStrIST, endOfDayForDateStrIST, istDateOffsetDays } = require('../utils/core/queryHelpers');
const { createTimer } = require('../utils/core/perfLogger');
const { dedupeAsync } = require('../utils/core/requestDedupe');
const DashboardLayout = require('../models/DashboardLayout');
const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const AdLead = require('../models/AdLead');
const Competitor = require('../models/Competitor');
const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder');
const logger = require('../utils/core/logger')('DashboardController');
const Shopify = require('../utils/shopify/shopifyGraphQL');
const { buildRecoveredRevenueSummary } = require('../utils/hub/recoveredRevenueSummary');
const {
  buildCommercePeriodKpis,
  buildPriorCommercePeriodKpis,
  mergeRealtimeWithPeriodKpis,
} = require('../utils/core/commercePeriodKpis');


/**
 * Phase 2: Single consolidated dashboard payload (replaces 4–5 parallel frontend calls).
 */
exports.getSummary = async (req, res) => {
  const timer = createTimer('GET /api/dashboard/summary', req.user?.clientId || '');
  timer.checkpoint('START');

  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      timer.finish('403 unauthorized');
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const startQuery = typeof req.query.start === 'string' ? req.query.start.slice(0, 10) : null;
    const endQuery = typeof req.query.end === 'string' ? req.query.end.slice(0, 10) : null;
    const hasCustomRange = Boolean(startQuery && endQuery);

    let requestedDays;
    let timelineRange = {};
    let topProductsOpts = {};
    let dedupeRangeKey;

    if (hasCustomRange) {
      timelineRange = { start: startQuery, end: endQuery };
      const startMs = startOfDayForDateStrIST(startQuery).getTime();
      const endMs = startOfDayForDateStrIST(endQuery).getTime();
      requestedDays = Math.min(
        Math.max(Math.floor((endMs - startMs) / 86400000) + 1, 1),
        MAX_LIVE_ANALYTICS_DAYS
      );
      topProductsOpts = {
        startDate: startOfDayForDateStrIST(startQuery),
        endDate: endOfDayForDateStrIST(endQuery),
      };
      dedupeRangeKey = `${startQuery}:${endQuery}`;
    } else {
      requestedDays = Math.min(
        parseInt(req.query.days, 10) || 30,
        MAX_LIVE_ANALYTICS_DAYS
      );
      timelineRange = { days: requestedDays };
      topProductsOpts = { days: requestedDays };
      dedupeRangeKey = String(requestedDays);
    }

    const client = await timer.time('getCachedClient', () =>
      getCachedClient(clientId, 'businessName name googleCalendarId config.calendars')
    );
    timer.checkpoint('client loaded');

    if (!client) {
      timer.finish('404');
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    const userRole = String(req.user.role || '').toUpperCase();
    const includeFullOperators = ['CLIENT_ADMIN', 'SUPER_ADMIN'].includes(userRole);
    const includeSelfOperator = userRole === 'AGENT';
    const includeOperators = includeFullOperators || includeSelfOperator;
    const agentIdFilter = includeSelfOperator ? String(req.user._id || req.user.id || '') : '';
    const dedupeKey = `dashboard-summary:${clientId}:${dedupeRangeKey}:${includeOperators}:${agentIdFilter || 'all'}`;

    const payload = await dedupeAsync(dedupeKey, async () => {
    const summaryTasks = [
      { key: 'realtime', run: () => getRealtimeStats(clientId, client, requestedDays, { timer }) },
      { key: 'topProducts', run: () => getTopProducts(clientId, { timer, ...topProductsOpts }) },
      { key: 'humanQueue', run: () => getHumanQueueConversations(clientId, { timer }) },
      { key: 'timeline', run: () => getTimelineStats(clientId, client, timelineRange, { timer }) },
    ];
    if (includeOperators) {
      summaryTasks.push({
        key: 'operators',
        run: () =>
          getOperatorsStats(clientId, requestedDays, {
            timer,
            ...(agentIdFilter ? { agentIdFilter } : {}),
            ...(hasCustomRange
              ? {
                  startDate: startOfDayForDateStrIST(startQuery),
                  endDate: endOfDayForDateStrIST(endQuery),
                }
              : {}),
          }),
      });
    }

    const settled = await Promise.allSettled(summaryTasks.map((t) => t.run()));
    timer.checkpoint('summary_parallel_complete');

    const byKey = {};
    summaryTasks.forEach((task, i) => {
      const result = settled[i];
      if (result.status === 'rejected') {
        logger.warn(`[Dashboard Summary] ${task.key} failed:`, result.reason?.message || result.reason);
        byKey[task.key] = null;
      } else {
        byKey[task.key] = result.value;
      }
    });

    let periodKpis = null;
    let priorPeriodKpis = null;
    try {
      [periodKpis, priorPeriodKpis] = await Promise.all([
        buildCommercePeriodKpis({
          clientId,
          days: requestedDays,
          timeline: byKey.timeline || [],
          ...(hasCustomRange ? { start: startQuery, end: endQuery } : {}),
        }),
        hasCustomRange
          ? buildPriorCommercePeriodKpis(clientId, requestedDays, {
              end: istDateOffsetDays(startQuery, -1),
              days: requestedDays,
            })
          : buildPriorCommercePeriodKpis(clientId, requestedDays),
      ]);
    } catch (kpiErr) {
      logger.warn('[Dashboard Summary] periodKpis failed:', kpiErr.message);
    }

    const realtime = mergeRealtimeWithPeriodKpis(byKey.realtime, periodKpis);

    return {
      success: true,
      realtime,
      timeline: byKey.timeline,
      periodKpis,
      priorPeriodKpis,
      topProducts: byKey.topProducts,
      humanQueue: byKey.humanQueue || [],
      operators: byKey.operators?.operators || [],
      teamAvgResponseTimeMs: byKey.operators?.teamAvgResponseTimeMs ?? null,
      meta: {
        days: requestedDays,
        ...(hasCustomRange ? { start: startQuery, end: endQuery } : {}),
        generatedAt: new Date().toISOString(),
      },
    };
    });

    timer.finish('200 ok');
    res.json(payload);
  } catch (err) {
    timer.finish(`error: ${err.message}`);
    logger.error('[Dashboard Summary] fatal', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getAnalyticsChart = async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, error: 'Unauthorized' });
    const field = String(req.query.field || 'customers').toLowerCase();
    const period = String(req.query.period || '30d').toLowerCase();
    const data = await getAnalyticsChart(clientId, field, period);
    res.json({ success: true, ...data });
  } catch (err) {
    const code = err.statusCode || 500;
    res.status(code).json({ success: false, error: err.message });
  }
};

/** GET /api/dashboard/recovered-summary — Phase 2 hero ₹ */
exports.getRecoveredSummary = async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, error: 'Unauthorized' });
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const data = await buildRecoveredRevenueSummary(clientId, { days });
    if (!data) return res.status(404).json({ success: false, error: 'Client not found' });
    res.json({ success: true, data });
  } catch (err) {
    logger.error('[Dashboard RecoveredSummary]', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getCartRecoveryChart = async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) return res.status(403).json({ success: false, error: 'Unauthorized' });
    const period = String(req.query.period || '30d').toLowerCase();
    const data = await getCartRecoveryChart(clientId, period);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Handle batch data fetching for multiple widgets in one request
 */
/**
 * Handle batch data fetching for multiple widgets in one request
 */
exports.getBatchData = async (req, res) => {
  try {
    const { widgets = [], days = 30 } = req.body;
    const clientIdSlug = req.user.clientId; 
    
    // Resolve actual Client document first to support both slug and ObjectId models
    const clientDoc = await Client.findOne({ clientId: clientIdSlug }).select('_id clientId').lean();
    if (!clientDoc) return res.status(404).json({ success: false, message: "Client context lost" });

    const clientId = clientIdSlug; 
    const clientObjectId = clientDoc._id; 
    
    // Use the IST-aware helper for accurate daily filtering
    function startOfDayIST() {
      const now = new Date();
      const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      ist.setHours(0, 0, 0, 0);
      return new Date(ist.getTime() - 5.5 * 60 * 60 * 1000);
    }
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const data = {};

    // Execute all widget data fetchers in parallel with allSettled to prevent global 500s
    const results = await Promise.allSettled([
      // 0: stats_grid
      widgets.includes('stats_grid') ? (async () => {
        const [leads, orders, conversations] = await Promise.all([
          AdLead.countDocuments({ clientId, createdAt: { $gte: startDate } }),
          Order.aggregate([
            { $match: { clientId, createdAt: { $gte: startDate } } },
            { $group: { _id: null, total: { $sum: "$totalPrice" }, count: { $sum: 1 } } }
          ]),
          Conversation.countDocuments({ clientId, createdAt: { $gte: startDate } })
        ]);
        return {
          leads: { total: leads },
          orders: { count: orders[0]?.count || 0, revenue: orders[0]?.total || 0 },
          conversations: { total: conversations }
        };
      })() : Promise.resolve(null),

      // 1: revenue_chart
      widgets.includes('revenue_chart') ? Order.aggregate([
        { $match: { clientId, createdAt: { $gte: startDate } } },
        { $group: { 
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$totalPrice" }
          }
        },
        { $sort: { "_id": 1 } },
        { $project: { date: "$_id", revenue: 1, _id: 0 } }
      ]) : Promise.resolve(null),

      // 2: pending_support
      widgets.includes('pending_support') ? Conversation.find({ 
        clientId, 
        status: { $in: ['HUMAN_TAKEOVER', 'OPEN', 'BOT_ACTIVE'] },
        requiresAttention: true 
      }).select('phone lastMessage snippet status lastMessageAt customerName').limit(20).lean() : Promise.resolve([]),

      // 3: competitor_intel
      widgets.includes('competitor_intel') ? Competitor.find({ 
        clientId: clientDoc._id, 
        isActive: true 
      }).select('name url lastPriceChange lastProductAdded').limit(5).lean() : Promise.resolve([]),

      // 4: demand_forecast
      widgets.includes('demand_forecast') ? (async () => {
        const recentOrders = await Order.find({ 
          clientId, 
          createdAt: { $gte: startDate } 
        }).select('totalPrice items createdAt').lean();
        
        const totalUnits = recentOrders.reduce((acc, o) => acc + (o.items?.reduce((ia, ii) => ia + (ii.quantity || 1), 0) || 1), 0);
        return {
          velocity: (totalUnits / days).toFixed(1),
          orderCount: recentOrders.length,
          isBaselining: recentOrders.length < 5
        };
      })() : Promise.resolve(null),

      // 5: top_products
      widgets.includes('top_products') ? Order.aggregate([
        { $match: { clientId: clientIdSlug, createdAt: { $gte: startDate } } },
        { $unwind: "$items" },
        { $group: { _id: "$items.name", count: { $sum: "$items.quantity" }, total: { $sum: { $multiply: ["$items.quantity", "$items.price"] } } } },
        { $sort: { count: -1 } },
        { $limit: 5 }
      ]) : Promise.resolve(null)
    ]);

    // Map results back to the data object
    const widgetOrder = [
      'stats_grid', 'revenue_chart', 'pending_support', 
      'competitor_intel', 'demand_forecast', 'top_products'
    ];

    results.forEach((res, idx) => {
      const widgetType = widgetOrder[idx];
      if (res.status === 'fulfilled' && res.value !== null) {
        data[widgetType] = res.value;
      } else if (res.status === 'rejected') {
        logger.error(`Widget ${widgetType} failed:`, res.reason);
        data[widgetType] = null;
      }
    });

    res.json({ success: true, data });
  } catch (error) {
    logger.error("Batch Data Global Error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Layout Management
 */
exports.getLayout = async (req, res) => {
  try {
    const clientId = req.user.clientId; // Slug-based id
    let layout = await DashboardLayout.findOne({ clientId }).lean();
    
    if (!layout) {
      // Optimized Default Layout (matching the screenshot structure)
      const defaultLayout = [
        { i: 'stats_grid', x: 0, y: 0, w: 4, h: 2, minW: 2, minH: 2 },
        { i: 'revenue_chart', x: 0, y: 2, w: 2, h: 4, minW: 2, minH: 3 },
        { i: 'top_products', x: 2, y: 2, w: 2, h: 4, minW: 2, minH: 3 },
        { i: 'demand_forecast', x: 0, y: 6, w: 2, h: 4, minW: 2, minH: 3 },
        { i: 'competitor_intel', x: 2, y: 6, w: 2, h: 4, minW: 2, minH: 3 }
      ];

      layout = {
        clientId,
        config: {
          layout: defaultLayout,
          hiddenWidgets: []
        }
      };
    }
    res.json({ success: true, layout });
  } catch (error) {
    logger.error("Get Layout Error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.saveLayout = async (req, res) => {
  try {
    const { config } = req.body;
    const layout = await DashboardLayout.findOneAndUpdate(
      { clientId: req.user.clientId },
      { config, lastModifiedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, layout });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.resetLayout = async (req, res) => {
  try {
    await DashboardLayout.deleteOne({ clientId: req.user.clientId });
    res.json({ success: true, message: "Layout reset to default" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Specialized Intelligence Fetchers
 */
exports.getForecast = async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const { buildDemandForecast } = require('../utils/core/demandForecastBuilder');
    let data = await buildDemandForecast(clientId);

    if (data.needsOrderSync && data.totalOrderCount === 0) {
      try {
        const Client = require('../models/Client');
        const { buildConnectionStatusPayload } = require('../utils/core/connectionStatus');
        const client = await Client.findOne({ clientId })
          .select('shopDomain shopifyAccessToken shopifyStores commerce shopifyConnectionStatus')
          .lean();
        const { shopify_connected: shopifyConnected } = buildConnectionStatusPayload(client || {});

        if (shopifyConnected) {
          const { withShopifyRetry } = require('../utils/shopify/shopifyHelper');
          const { syncShopifyOrdersToMongo } = require('../utils/shopify/shopifyOrderSync');
          await withShopifyRetry(clientId, (shop) => syncShopifyOrdersToMongo(clientId, shop));
          data = await buildDemandForecast(clientId);
          data.syncTriggered = true;
        }
      } catch (syncErr) {
        logger.warn(`Forecast order sync skipped for ${clientId}: ${syncErr.message}`);
        data.syncError = syncErr.message;
      }
    }

    res.json({ success: true, forecast: data });
  } catch (error) {
    logger.error('Forecast Error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.getCompetitorIntel = async (req, res) => {
  try {
    const { competitorUrl } = req.query;
    const Client = require('../models/Client');
    const Competitor = require('../models/Competitor');
    const clientDoc = await Client.findOne({ clientId: req.user.clientId }).select('_id').lean();
    if (!clientDoc) return res.status(404).json({ success: false, message: "Client not found" });

    // Fetch competitors
    const competitors = await Competitor.find({ clientId: clientDoc._id, isActive: true }).lean();

    res.json({ 
      success: true, 
      competitor_intel: competitors 
    });
  } catch (error) {
     res.status(500).json({ success: false, message: error.message });
  }
};

exports.getSuppliers = async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const clientDoc = await Client.findOne({ clientId }).select('_id').lean();
    if (!clientDoc) return res.status(404).json({ success: false, message: "Client not found" });

    const suppliers = await Supplier.find({ clientId: clientDoc._id }).lean();
    
    // Add business logic fields (reliability, status) based on available data
    const enrichedSuppliers = suppliers.map(s => ({
      ...s,
      reliability: Math.floor(Math.random() * (100 - 85) + 85), // Logic to be refined in Phase 7
      status: s.isActive === false ? 'inactive' : 'active'
    }));

    res.json({ success: true, suppliers: enrichedSuppliers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteSupplier = async (req, res) => {
  try {
    const { id } = req.params;
    const clientDoc = await Client.findOne({ clientId: req.user.clientId }).select('_id').lean();
    
    const supplier = await Supplier.findOneAndDelete({ _id: id, clientId: clientDoc._id });
    if (!supplier) return res.status(404).json({ success: false, message: "Supplier not found or unauthorized" });

    res.json({ success: true, message: "Supplier removed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getFlows = async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId }).select('flowHistory').lean();
    res.json({ 
      success: true, 
      data: {
        activeFlows: 4,
        topPerforming: "Order Tracking",
        completionRate: 92,
        history: client?.flowHistory || []
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.createCompetitor = async (req, res) => {
  try {
    const { name, website, products, trackingPreferences } = req.body;
    const clientDoc = await Client.findOne({ clientId: req.user.clientId }).select('_id').lean();
    if (!clientDoc) return res.status(404).json({ success: false, message: "Client not found" });

    const competitor = await Competitor.create({
      clientId: req.user.clientId,
      name,
      website,
      products,
      trackingPreferences: trackingPreferences || [],
      isActive: true
    });
    res.json({ success: true, competitor });
  } catch (error) {
    logger.error("Create Competitor Error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.generateBattlePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const Competitor = require('../models/Competitor');
    const Order = require('../models/Order');
    const Client = require('../models/Client');
    const { generateText } = require('../utils/core/gemini');
    const { scrapeWebsiteText } = require('../utils/core/urlScraper');

    const competitor = await Competitor.findById(id).lean();
    if (!competitor) return res.status(404).json({ success: false, message: "Competitor not found" });

    const clientDoc = await Client.findOne({ clientId: req.user.clientId }).lean();
    if (!clientDoc) return res.status(404).json({ success: false, message: "Client not found" });

    // Step 1: Gather Our Data
    // Get unique products with pricing from recent orders
    const ourOrders = await Order.find({ clientId: req.user.clientId }).select('items').sort({ createdAt: -1 }).limit(100).lean();
    const productMap = {};
    ourOrders.forEach(o => {
      o.items?.forEach(i => {
        if (i.name && i.price) {
          productMap[i.name] = i.price;
        }
      });
    });
    
    const ourProductPrices = Object.entries(productMap).map(([name, price]) => `${name}: ₹${price}`).slice(0, 50).join(', ');
    
    let ourWebsiteContext = '';
    if (clientDoc.website || clientDoc.shopDomain) {
      try {
        const urlToScrape = clientDoc.website || `https://${clientDoc.shopDomain}`;
        ourWebsiteContext = await scrapeWebsiteText(urlToScrape);
        // Truncate to save tokens (approx 2000 chars)
        ourWebsiteContext = ourWebsiteContext.substring(0, 2000);
      } catch (err) {
        logger.warn(`Failed to scrape our own site: ${err.message}`);
      }
    }

    // Include Knowledge Base Facts
    const kbInfo = `
About: ${clientDoc.knowledgeBase?.about || ''}
Return Policy: ${clientDoc.knowledgeBase?.returnPolicy || ''}
Shipping Policy: ${clientDoc.knowledgeBase?.shippingPolicy || ''}
    `.trim();

    const ourIdentityContext = `
Our Brand: ${clientDoc.businessName || 'Us'}
Our Website Knowledge: ${ourWebsiteContext}
Our Core Policies: ${kbInfo}
Our Catalog & Pricing: ${ourProductPrices || 'Unknown'}
    `;

    // Step 2: Gather Competitor Data
    let compWebsiteContext = '';
    if (competitor.website) {
      try {
        compWebsiteContext = await scrapeWebsiteText(competitor.website);
        compWebsiteContext = compWebsiteContext.substring(0, 3000);
      } catch (err) {
        logger.warn(`Failed to scrape competitor site ${competitor.website}: ${err.message}`);
      }
    }

    const trackingGoals = competitor.trackingPreferences?.length > 0 
      ? competitor.trackingPreferences.join(', ') 
      : 'Pricing, Catalog, Branding';

    // Step 3: Run Dual-Comparison via Gemini
    const prompt = `
You are a master business growth strategist. I need you to do a deep comparative analysis between MY BRAND and MY COMPETITOR.

--- MY BRAND INFO ---
${ourIdentityContext}

--- COMPETITOR INFO ---
Competitor Name: ${competitor.name}
Competitor Website Content (Scraped):
${compWebsiteContext || 'Unable to scan Website.'}

Their Target Tracking Goals: ${trackingGoals}

Compare our products, pricing (if found), policies, and general catalog structure.
You must return ONLY a JSON object (no markdown, no backticks) with EXACTLY the following structure:
{
  "battlePlan": [
     "Describe step 1 based on comparative analysis... e.g. We sell X for $40, they are at $35. Match them.",
     "Describe step 2...",
     "Describe step 3..."
  ],
  "priceIndex": "+5%",  // Estimate compared to ours based on text, or output 'N/A' if unknown. E.g. "-10%" if they are cheaper.
  "catalogSize": "Large", // E.g. "Broad Coverage", "Niche", "50+ items"
  "activityScore": "High", // Aggression/Activity estimate based on SEO/text
  "pricePosition": "lower" // Must be exactly one of: "lower", "higher", "equal"
}
`;

    const aiResult = await generateText(prompt, process.env.GEMINI_API_KEY, { temperature: 0.2 });
    
    let resultObj = {};
    try {
      const cleanJson = aiResult.replace(/```json/gi, '').replace(/```/g, '').trim();
      resultObj = JSON.parse(cleanJson);
      
      if (!resultObj.battlePlan || !Array.isArray(resultObj.battlePlan)) {
        throw new Error("Invalid structure");
      }
    } catch (e) {
      logger.error('Failed to parse AI dual-scrape response', e);
      // Fallback
      resultObj = {
        battlePlan: [
          `Audit ${competitor.name}'s top pricing and undercut by 5% on key "hook" items.`,
          "Deploy a WhatsApp campaign highlighting your superior return policy.",
          "Target their brand keywords in your Meta Ads."
        ],
        priceIndex: 'SCN',
        catalogSize: '...',
        activityScore: 'Medium',
        pricePosition: 'equal' 
      };
    }

    competitor.battlePlan = resultObj.battlePlan;
    competitor.priceIndex = resultObj.priceIndex || 'SCN';
    competitor.catalogSize = resultObj.catalogSize || 'Known';
    competitor.activityScore = resultObj.activityScore || 'Active';
    competitor.pricePosition = ['lower', 'higher', 'equal'].includes(resultObj.pricePosition?.toLowerCase()) 
      ? resultObj.pricePosition.toLowerCase() 
      : 'equal';
    competitor.status = 'monitored';
    competitor.lastBattlePlanGeneratedAt = new Date();
    await competitor.save();

    res.json({ success: true, battlePlan: competitor.battlePlan, competitor });
  } catch (error) {
    logger.error("Generate Battle Plan Error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createSupplier = async (req, res) => {
  try {
    const { name, phone, category } = req.body;
    const clientDoc = await Client.findOne({ clientId: req.user.clientId }).select('_id').lean();
    if (!clientDoc) return res.status(404).json({ success: false, message: "Client not found" });

    const supplier = await Supplier.create({
      clientId: clientDoc._id,
      name,
      phone,
      category,
      products: []
    });
    res.json({ success: true, supplier });
  } catch (error) {
    logger.error("Create Supplier Error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
exports.getOperationsSummary = async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const days = 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const clientDoc = await Client.findOne({ clientId }).select('_id').lean();
    if (!clientDoc) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const [orders, supplierCount] = await Promise.all([
      Order.find({ clientId, createdAt: { $gte: startDate } }).select('totalPrice items').lean(),
      Supplier.countDocuments({ clientId: clientDoc._id })
    ]);

    const actualSupplierCount = supplierCount;
    
    // Calculate Health Metrics
    const totalRevenue = orders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
    const estInventoryValue = totalRevenue * 1.5; // Estimated asset value
    
    // Calculate critical SKUs
    const skuMap = {};
    orders.forEach(o => {
        o.items?.forEach(item => {
            if (!skuMap[item.name]) skuMap[item.name] = 0;
            skuMap[item.name] += (item.quantity || 1);
        });
    });
    
    const criticalCount = Object.entries(skuMap).filter(([name, count]) => (count / days) > 5).length; // Mock critical threshold

    res.json({
      success: true,
      summary: {
        inventoryValue: estInventoryValue,
        criticalSKUs: criticalCount,
        vendorCount: actualSupplierCount,
        pendingOrders: 0 // To be linked to PurchaseOrder model in sub-phase
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getRestockDrafts = async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const { buildDemandForecast } = require('../utils/core/demandForecastBuilder');

    const clientDoc = await Client.findOne({ clientId }).select('_id brand').lean();
    if (!clientDoc) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    const [forecast, actualSuppliers] = await Promise.all([
      buildDemandForecast(clientId),
      Supplier.find({ clientId: clientDoc._id }).lean(),
    ]);

    if (!actualSuppliers.length) {
      return res.json({ success: true, drafts: [] });
    }

    const drafts = [];
    for (const item of forecast.inventoryHealth || []) {
      if (item.depletionDays == null || item.depletionDays > 21) continue;

      const linkedSupplier =
        actualSuppliers.find((s) =>
          s.products?.some(
            (p) =>
              (item.shopifyProductId && p.productId === item.shopifyProductId) ||
              (item.sku && p.sku === item.sku) ||
              p.productTitle === item.name ||
              p.productTitle === item.shortName
          )
        ) || actualSuppliers[0];

      const dailyDemand = item.dailyDemand || 0;
      const quantityToOrder = Math.max(Math.ceil(dailyDemand * 30), 20);

      drafts.push({
        id: item.shopifyProductId || item.sku || item.name,
        productName: item.name,
        imageUrl: item.imageUrl || '',
        sku: item.sku,
        currentStock: item.stock,
        dailyDemand: dailyDemand.toFixed(1),
        depletionDays: item.depletionDays,
        partner: {
          name: linkedSupplier.name,
          phone: linkedSupplier.phone,
          id: linkedSupplier._id,
        },
        draftMessage: `📦 *RESTOCK REQUEST: ${clientDoc?.brand?.name || 'TopEdge AI'}*\n\nHi ${linkedSupplier.name}, we need to restock:\n\n🔹 *Product:* ${item.name}\n🔹 *SKU:* ${item.sku || '—'}\n🔹 *Current stock:* ${item.stock} units\n🔹 *Burn rate:* ${dailyDemand.toFixed(1)}/day\n\n🚨 Please prepare an invoice for *${quantityToOrder} units*.\n\nPlease confirm availability! 🤝`,
      });
    }

    res.json({ success: true, drafts: drafts.slice(0, 10) });
  } catch (error) {
    logger.error('Restock Drafts Error', error);
    res.status(500).json({ success: false, message: error.message });
  }
};
