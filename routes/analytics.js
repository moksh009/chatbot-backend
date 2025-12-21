const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Appointment = require('../models/Appointment');
const { protect } = require('../middleware/auth');

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

    // Merge Data
    const stats = dates.map(date => {
      const chatCount = chatsStarted.find(c => c._id === date)?.count || 0;
      const userCount = activeUsers.find(c => c._id === date)?.count || 0;
      const apptCount = appointments.find(c => c._id === date)?.count || 0;
      const msgCount = messages.find(c => c._id === date)?.count || 0;

      return {
        date,
        totalChats: chatCount,
        uniqueUsers: userCount,
        appointmentsBooked: apptCount,
        totalMessagesExchanged: msgCount
      };
    });

    res.json(stats);
  } catch (error) {
    console.error('Analytics Aggregation Error:', error);
    res.status(500).json({ message: 'Server Error' });
  }
});

module.exports = router;
