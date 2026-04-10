const express = require('express');
const router = express.Router();
const AdLead = require('../models/AdLead');
const Conversation = require('../models/Conversation');
const Order = require('../models/Order');
const { protect } = require('../middleware/auth');
const { resolveClient, startOfDayIST, safeCount, safeAggregate } = require('../utils/queryHelpers');
const logger = require('../utils/logger')('InsightsRoute');

router.get("/:clientId", protect, async (req, res) => {
  try {
    const { client, clientOid } = await resolveClient(req);
    const today     = startOfDayIST();
    const yesterday = new Date(today.getTime() - 86400000);
    
    const insights = [];
    
    // Run all checks in parallel
    const [
      leadsToday, leadsYesterday,
      abandons, unassigned,
      todayRev, codOrders,
      hotLeads
    ] = await Promise.allSettled([
      safeCount(AdLead, { clientId: clientOid, createdAt: { $gte: today } }),
      safeCount(AdLead, { clientId: clientOid, createdAt: { $gte: yesterday, $lt: today } }),
      safeCount(AdLead, { clientId: clientOid, cartStatus: "cart_added", lastMessageAt: { $gte: new Date(Date.now() - 3*3600000) } }),
      safeCount(Conversation, { clientId: clientOid, botPaused: true, assignedTo: null }),
      Order.aggregate([{ $match: { clientId: clientOid, createdAt: { $gte: today } } }, { $group: { _id: null, total: { $sum: "$totalPrice" } } }]).catch(() => []),
      safeCount(Order, { clientId: clientOid, paymentMethod: /cod/i, createdAt: { $gte: today } }),
      safeCount(AdLead, { clientId: clientOid, leadScore: { $gte: 70 } })
    ]);
    
    const get = (r, fb) => r.status === "fulfilled" ? r.value : fb;
    
    // Build insights based on real data
    if (get(leadsToday, 0) > 0) {
      const lt  = get(leadsToday, 0);
      const ly  = get(leadsYesterday, 0);
      const dir = lt > ly ? "↑" : lt < ly ? "↓" : "→";
      insights.push({
        id: "leads_today", type: "opportunity", icon: "👥",
        title: `${lt} new lead${lt > 1 ? "s" : ""} today`,
        detail: ly > 0 ? `${dir} ${Math.abs(lt - ly)} vs yesterday` : "Great start!",
        action: { label: "View Leads", path: "/audience-hub" }
      });
    }
    
    if (get(abandons, 0) > 0) {
      insights.push({
        id: "abandoned_carts", type: "alert", icon: "🛒",
        title: `${get(abandons, 0)} cart${get(abandons,0) > 1 ? "s" : ""} abandoned`,
        detail: "Recovery messages queued. Manual nudge can boost recovery 23%.",
        action: { label: "View Carts", path: "/audience-hub?tab=cart-recovery" }
      });
    }
    
    if (get(unassigned, 0) > 0) {
      insights.push({
        id: "unassigned", type: "alert", icon: "🙋",
        title: `${get(unassigned, 0)} chat${get(unassigned,0) > 1 ? "s" : ""} need attention`,
        detail: "Bot paused. Customers are waiting for a human agent.",
        action: { label: "Open Live Chat", path: "/conversations?filter=unassigned" }
      });
    }
    
    const rev = get(todayRev, [])[0]?.total || 0;
    if (rev > 0) {
      insights.push({
        id: "revenue", type: "opportunity", icon: "💰",
        title: `₹${rev.toLocaleString("en-IN")} revenue today`,
        detail: "Keep engaging leads to hit your daily target.",
        action: { label: "View Orders", path: "/commerce-hub" }
      });
    }
    
    if (get(codOrders, 0) > 0) {
      insights.push({
        id: "cod_convert", type: "opportunity", icon: "💳",
        title: `${get(codOrders, 0)} COD order${get(codOrders,0) > 1 ? "s" : ""} to convert`,
        detail: "COD-to-Prepaid nudges sent automatically. Track conversions here.",
        action: { label: "View COD Pipeline", path: "/commerce-hub?tab=cod" }
      });
    }
    
    if (get(hotLeads, 0) > 0) {
      insights.push({
        id: "hot_leads", type: "opportunity", icon: "🔥",
        title: `${get(hotLeads, 0)} high-intent lead${get(hotLeads,0) > 1 ? "s" : ""}`,
        detail: "Score ≥70. These are your best prospects right now.",
        action: { label: "Contact Now", path: "/audience-hub?filter=hot" }
      });
    }
    
    // Always guarantee minimum insights
    if (insights.length === 0) {
      insights.push({
        id: "ready", type: "opportunity", icon: "🚀",
        title: "Your AI system is running",
        detail: "Send your first campaign or start a conversation to see real-time insights here.",
        action: { label: "Create Campaign", path: "/marketing-hub" }
      });
    }
    
    return res.json({ success: true, insights });
    
  } catch (err) {
    logger.error("[Insights] failed:", err.message);
    return res.status(500).json({ success: false, error: err.message, insights: [] });
  }
});

module.exports = router;
