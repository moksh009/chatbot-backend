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

    // 5. Demand Forecast (Mocked for now since DNA logic is intensive)
    if (widgets.includes('demand_forecast')) {
      data.demand_forecast = {
        velocity: 12.4,
        nextPeak: "Sunday, April 12",
        criticalSkus: 2
      };
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
  // Implement full forecasting logic...
  res.json({ success: true, forecast: {} });
};

exports.getCompetitorIntel = async (req, res) => {
  try {
    const { competitorUrl } = req.query;
    // Call Gemini utility here...
    res.json({ success: true, data: { competitorName: "Target Demo", pricingStrategy: "Competitive" } });
  } catch (error) {
     res.status(500).json({ success: false, message: error.message });
  }
};
