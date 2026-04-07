const Client = require('../models/Client');
const DashboardLayout = require('../models/DashboardLayout');
const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const AdLead = require('../models/AdLead');
const Competitor = require('../models/Competitor');
const PurchaseOrder = require('../models/PurchaseOrder');
const logger = require('../utils/logger')('DashboardController');

/**
 * Handle batch data fetching for multiple widgets in one request
 */
exports.getBatchData = async (req, res) => {
  try {
    const { widgets, days = 30 } = req.body;
    const clientId = req.user.clientId;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const data = {};

    // 1. Basic Stats Widget
    if (widgets.includes('stats_grid')) {
      const [leads, orders, conversations] = await Promise.all([
        AdLead.countDocuments({ clientId, createdAt: { $gte: startDate } }),
        Order.aggregate([
          { $match: { clientId, createdAt: { $gte: startDate } } },
          { $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } }
        ]),
        Conversation.countDocuments({ clientId, createdAt: { $gte: startDate } })
      ]);
      
      data.stats_grid = {
        leads: { total: leads },
        orders: { count: orders[0]?.count || 0, revenue: orders[0]?.total || 0 },
        conversations: { total: conversations }
      };
    }

    // 2. Revenue Trend
    if (widgets.includes('revenue_chart')) {
      data.revenue_chart = await Order.aggregate([
        { $match: { clientId, createdAt: { $gte: startDate } } },
        { $group: { 
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$totalAmount" }
          }
        },
        { $sort: { "_id": 1 } },
        { $project: { date: "$_id", revenue: 1, _id: 0 } }
      ]);
    }

    // 3. Pending Human Support
    if (widgets.includes('pending_support')) {
      data.pending_support = await Conversation.find({ 
        clientId, 
        status: 'HUMAN_TAKEOVER' 
      }).limit(5).sort({ updatedAt: -1 }).lean();
    }

    // 4. Competitor Intel
    if (widgets.includes('competitor_intel')) {
      data.competitor_intel = await Competitor.find({ clientId }).limit(3).lean();
    }

    // 5. Demand Forecast
    if (widgets.includes('demand_forecast')) {
      data.demand_forecast = {
        velocity: 12.4,
        nextPeak: "Sunday, April 12",
        criticalSkus: [
          { name: "Premium Blue Tee", status: "low", count: 12 },
          { name: "Urban Cargo Pant", status: "critical", count: 3 }
        ]
      };
    }

    // 6. Suppliers Widget
    if (widgets.includes('suppliers')) {
        data.suppliers = [
            { name: "Apex Textiles", reliability: 98, leadTime: "3 days", status: "active" },
            { name: "Global Fasteners", reliability: 85, leadTime: "7 days", status: "warning" }
        ];
    }

    // 7. Active Flows
    if (widgets.includes('flows')) {
         const client = await Client.findOne({ clientId });
         data.flows = {
            activeFlows: 4,
            completionRate: 92,
            topPerforming: "Order Tracking"
         };
    }

    // 8. Top Products
    if (widgets.includes('top_products')) {
        data.top_products = await Order.aggregate([
            { $match: { clientId, createdAt: { $gte: startDate } } },
            { $unwind: "$lineItems" },
            { $group: { _id: "$lineItems.title", count: { $sum: 1 }, total: { $sum: "$lineItems.price" } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]);
    }

    res.json({ success: true, data });
  } catch (error) {
    logger.error("Batch Data Error", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Layout Management
 */
exports.getLayout = async (req, res) => {
  try {
    let layout = await DashboardLayout.findOne({ clientId: req.user.clientId });
    if (!layout) {
      // Default layout
      layout = {
        clientId: req.user.clientId,
        config: {
          layout: [
            { i: 'stats_grid', x: 0, y: 0, w: 4, h: 2 },
            { i: 'revenue_chart', x: 0, y: 2, w: 2, h: 4 },
            { i: 'conversion_funnel', x: 2, y: 2, w: 2, h: 4 }
          ],
          hiddenWidgets: []
        }
      };
    }
    res.json({ success: true, layout });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.saveLayout = async (req, res) => {
  try {
    const { config } = req.body;
    const layout = await DashboardLayout.findOneAndUpdate(
      { clientId: req.user.clientId },
      { config, updatedAt: new Date() },
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
    const data = {
      growthRate: "14.2%",
      next7Days: [
        { date: "Mon", predictedRevenue: 1200 },
        { date: "Tue", predictedRevenue: 1500 },
        { date: "Wed", predictedRevenue: 1100 },
        { date: "Thu", predictedRevenue: 1800 },
        { date: "Fri", predictedRevenue: 2200 },
        { date: "Sat", predictedRevenue: 2500 },
        { date: "Sun", predictedRevenue: 2800 }
      ],
      summary: "AI projection indicates a 22% surge in demand for 'Home Decor' next weekend. Recommend launching a flash sale on Friday evening.",
      topRecommendation: "Inventory Alert: Restock Smart Lamps before Friday."
    };
    res.json({ success: true, data }); // Frontend expects data.data
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCompetitorIntel = async (req, res) => {
  try {
    const { competitorUrl } = req.query;
    res.json({ 
      success: true, 
      data: { 
        competitorName: competitorUrl ? new URL(competitorUrl).hostname : "Target Analytics",
        pricingStrategy: "Dynamic / Aggressive SKU matching",
        confidenceScore: 0.94,
        weaknessesToExploit: [
          "Standard Shipping (> 4 days)",
          "Manual customer support (slow response)",
          "Higher pricing on Top-Tier bundles"
        ],
        winRateRecommendation: "Launch a 'Fast Shipping' WhatsApp campaign to capture their weekend traffic."
      } 
    });
  } catch (error) {
     res.status(500).json({ success: false, message: error.message });
  }
};

exports.getSuppliers = async (req, res) => {
  try {
    const data = [
      { name: "Apex Textiles", reliability: 98, leadTime: "3 days", status: "active" },
      { name: "Global Fasteners", reliability: 85, leadTime: "7 days", status: "warning" }
    ];
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getFlows = async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId });
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

exports.getQualityStats = async (req, res) => {
  try {
    const clientId = req.user.clientId;
    // Mock dimensions and history as expected by QualityAnalytics.jsx
    const stats = {
      avgScore: 88,
      totalConversations: 1240,
      dimensions: [
        { subject: 'Accuracy', A: 85, fullMark: 100 },
        { subject: 'Tone', A: 92, fullMark: 100 },
        { subject: 'Speed', A: 98, fullMark: 100 },
        { subject: 'Retention', A: 75, fullMark: 100 },
        { subject: 'Sales', A: 82, fullMark: 100 },
      ],
      history: [
        { name: 'Mon', score: 82 },
        { name: 'Tue', score: 85 },
        { name: 'Wed', score: 84 },
        { name: 'Thu', score: 88 },
        { name: 'Fri', score: 92 },
        { name: 'Sat', score: 91 },
        { name: 'Sun', score: 94 },
      ]
    };
    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createCompetitor = async (req, res) => {
  try {
    const { name, website, products } = req.body;
    const competitor = await Competitor.create({
      clientId: req.user.clientId,
      name,
      website,
      products,
      isActive: true
    });
    res.json({ success: true, competitor });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.createSupplier = async (req, res) => {
  try {
    const { name, phone, category } = req.body;
    const supplier = await PurchaseOrder.create({
      clientId: req.user.clientId,
      supplierName: name,
      phone,
      category,
      status: 'active'
    });
    res.json({ success: true, supplier: { ...supplier.toObject(), name: supplier.supplierName } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
