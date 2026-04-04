const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const AdLead = require('../models/AdLead');
const Order = require('../models/Order');
const StoreAPI = require('../utils/storeAPI');
const { protect } = require('../middleware/auth');

/**
 * POST /api/ecommerce/sync
 * Manually trigger a store sync (Orders, Customers)
 */
router.post('/sync', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const store = new StoreAPI(client);
    
    // 1. Sync Orders (last 50)
    const orders = await store.getOrders(50);
    for (const o of orders) {
      await Order.findOneAndUpdate(
        { orderId: o.id.toString(), clientId: client.clientId },
        { 
          $set: {
            orderNumber: o.order_number,
            totalPrice: o.total_price,
            status: o.status,
            customerPhone: o.customer.phone,
            customerName: o.customer.first_name,
            currency: o.currency || 'INR'
          }
        },
        { upsert: true }
      );

      // 2. Sync/Create Leads from Orders
      if (o.customer.phone) {
        const phone = o.customer.phone.replace(/\D/g, '');
        await AdLead.findOneAndUpdate(
          { phoneNumber: phone, clientId: client.clientId },
          {
            $set: {
              name: o.customer.first_name,
              isOrderPlaced: true,
              totalSpent: o.total_price,
              orderCount: 1 // Simple increment for sync
            },
            $addToSet: { tags: 'synced_from_store' }
          },
          { upsert: true }
        );
      }
    }

    res.json({ success: true, syncedCount: orders.length });
  } catch (err) {
    console.error('[EcommerceSync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
