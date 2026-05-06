const Order     = require("../models/Order");
const Message   = require("../models/Message");
const logger    = require("./logger");
const axios     = require("axios");
const shopifyAdminApiVersion = require("./shopifyAdminApiVersion");

async function forecastDemand(client) {
  // Use either the client object or check for connection flags
  const isShopify = !!(client.shopifyAccessToken || client.commerce?.shopify?.accessToken);

  if (!isShopify) return null;
  
  // ── GET SALES VELOCITY ────────────────────────────────
  // Orders in last 30 days, grouped by product
  const salesData = await Order.aggregate([
    {
      $match: {
        clientId:  client._id,
        status:    { $in: ["paid", "processing", "completed", "fulfilled", "confirmed"] },
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) }
      }
    },
    { $unwind: "$items" },
    {
      $group: {
        _id:        "$items.productId",
        title:      { $first: "$items.name" },
        totalSold:  { $sum: "$items.quantity" },
        orderCount: { $sum: 1 },
        revenue:    { $sum: { $multiply: ["$items.price", "$items.quantity"] } }
      }
    }
  ]);
  
  const dailyVelocity = {};
  for (const product of salesData) {
    if (!product._id) continue;
    dailyVelocity[product._id] = {
      title:       product.title,
      soldPerDay:  product.totalSold / 30,
      monthlyRevenue: product.revenue
    };
  }
  
  // ── GET CURRENT INVENTORY (Mocked if API fails or for generic use) ─────
  let inventory = [];
  
  if (isShopify) {
    try {
      const domain = client.shopifyDomain || client.commerce?.shopify?.domain;
      const token  = client.shopifyAccessToken || client.commerce?.shopify?.accessToken;
      
      const { data } = await axios.get(
        `https://${domain}/admin/api/${shopifyAdminApiVersion}/inventory_levels.json`,
        {
          params:  { limit: 50 },
          headers: { "X-Shopify-Access-Token": token }
        }
      );
      inventory = data.inventory_levels || [];
    } catch (e) {
      logger.warn(`[DemandForecaster] Shopify inventory fetch failed: ${e.message}`);
    }
  }
  
  // ── COMPUTE FORECASTS ─────────────────────────────────
  const forecasts = [];
  
  // For products we have inventory data
  for (const item of inventory) {
    const productId  = String(item.inventory_item_id || item.product_id);
    const velocity   = dailyVelocity[productId];
    
    if (!velocity) continue;
    
    const currentStock  = item.available || 0;
    const soldPerDay    = velocity.soldPerDay || 0.1;
    const daysUntilOut  = soldPerDay > 0 ? (currentStock / soldPerDay) : 999;
    
    const urgency = daysUntilOut <= 0   ? "out_of_stock"
                  : daysUntilOut <= 3   ? "critical"
                  : daysUntilOut <= 7   ? "warning"
                  : daysUntilOut <= 14  ? "caution"
                  :                       "healthy";
    
    forecasts.push({
      productId,
      title:        velocity.title,
      currentStock,
      soldPerDay:   parseFloat(soldPerDay.toFixed(2)),
      daysUntilOut: parseFloat(daysUntilOut.toFixed(1)),
      urgency,
      monthlyRevenue: velocity.monthlyRevenue,
      reorderQty:   Math.ceil(soldPerDay * 30), // 30-day supply
    });
  }
  
  return forecasts.sort((a, b) => a.daysUntilOut - b.daysUntilOut);
}

/**
 * Generate WhatsApp-formatted forecast summary.
 */
function formatForecastMessage(forecasts, businessName) {
  if (!forecasts || forecasts.length === 0) return null;

  const critical   = forecasts.filter(f => f.urgency === "critical" || f.urgency === "out_of_stock");
  const warnings   = forecasts.filter(f => f.urgency === "warning");
  const healthy    = forecasts.filter(f => f.urgency === "healthy");
  
  let message = `📦 *Inventory Forecast — ${businessName}*\n\n`;
  
  if (critical.length) {
    message += `🔴 *URGENT (order now):*\n`;
    for (const p of critical.slice(0, 3)) {
      const status = p.urgency === "out_of_stock"
        ? "OUT OF STOCK"
        : `${p.currentStock} left, ${p.soldPerDay}/day → *out in ${p.daysUntilOut} days*`;
      message += `• ${p.title}: ${status}\n`;
    }
    message += "\n";
  }
  
  if (warnings.length) {
    message += `⚠️ *Reorder Soon (7-14 days):*\n`;
    for (const p of warnings.slice(0, 3)) {
      message += `• ${p.title}: ${p.currentStock} units, ~${p.daysUntilOut} days left\n`;
    }
    message += "\n";
  }
  
  if (healthy.length) {
    message += `✅ *Well Stocked:* ${healthy.length} products\n`;
  }
  
  if (critical.length) {
    message += `\nTop priority reorder:\n`;
    for (const p of critical.slice(0, 2)) {
      message += `• ${p.title}: order ~${p.reorderQty} units (30-day supply)\n`;
    }
  }
  
  return message;
}

module.exports = { forecastDemand, formatForecastMessage };
