const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Appointment = require('../models/Appointment');
const DailyStat = require('../models/DailyStat');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const { protect } = require('../middleware/auth');

router.get('/realtime', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 1. Leads Count (Total & Today)
    const totalLeads = await AdLead.countDocuments({ clientId });
    const newLeadsToday = await AdLead.countDocuments({ 
        clientId, 
        createdAt: { $gte: today } 
    });

    // 2. Orders & Revenue (Today)
    const ordersToday = await Order.find({ 
        clientId, 
        createdAt: { $gte: today } 
    });
    
    const revenueToday = ordersToday.reduce((sum, order) => sum + order.amount, 0);
    const orderCountToday = ordersToday.length;

    // 3. Link Clicks (Total)
    const linkClicksResult = await AdLead.aggregate([
        { $match: { clientId } },
        { $group: { _id: null, totalClicks: { $sum: "$linkClicks" } } }
    ]);
    const totalLinkClicks = linkClicksResult[0]?.totalClicks || 0;

    // 4. Agent Requests (Today)
    const todayStr = today.toISOString().split('T')[0];
    const dailyStat = await DailyStat.findOne({ clientId, date: todayStr });
    const agentRequestsToday = dailyStat?.agentRequests || 0;

    res.json({
        leads: { total: totalLeads, newToday: newLeadsToday },
        orders: { count: orderCountToday, revenue: revenueToday },
        linkClicks: totalLinkClicks,
        agentRequests: agentRequestsToday
    });

  } catch (error) {
    console.error('Realtime Analytics Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

router.get('/leads', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const leads = await AdLead.find({ clientId })
        .sort({ lastInteraction: -1 })
        .skip(skip)
        .limit(limit);

    const total = await AdLead.countDocuments({ clientId });

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
