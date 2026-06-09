const express = require('express');
const { resolveClient, tenantClientId } = require('../utils/core/queryHelpers');
const router = express.Router();
const Order = require('../models/Order');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const { logAction } = require('../middleware/audit');
const { apiCache } = require('../middleware/apiCache');

const logPersonalDataAccess = logAction('PERSONAL_DATA_ACCESS');

// GET /api/orders?phone=...
router.get('/', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number required' });
    }

    // Standardize phone: strip non-digits and take last 10 digits for robust matching
    const cleanPhone = phone.replace(/\D/g, '');
    const phoneSuffix = cleanPhone.length >= 10 ? cleanPhone.slice(-10) : cleanPhone;
    const phoneRegex = new RegExp(`${phoneSuffix}$`);

    const scopedClientId = tenantClientId(req);
    if (!scopedClientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const query = { 
      clientId: scopedClientId,
      $or: [
        { phone: phoneRegex }, 
        { customerPhone: phoneRegex },
        { phone: phone }, // Fallback to exact match
        { customerPhone: phone }
      ] 
    };

    const orders = await Order.find(query).sort({ createdAt: -1 }).limit(10).lean();
    res.json({ success: true, orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/orders/products?clientId=X — distinct products from order line items
router.get('/products', protect, logPersonalDataAccess, apiCache(120), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { dedupeAsync } = require('../utils/core/requestDedupe');
  const timer = createTimer('GET /api/orders/products', tenantClientId(req) || '');
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const { getAllCatalogProductsForFilter } = require('../utils/commerce/ordersFilterAggregations');
    const products = await timer.time('getAllCatalogProductsForFilter', () =>
      dedupeAsync(`orders:products:${clientId}`, () => getAllCatalogProductsForFilter(clientId))
    );
    res.json({ success: true, products });
    timer.finish(`200 ok | count=${products?.length ?? 0}`);
  } catch (error) {
    timer.finish(`500 error=${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/orders/states?clientId=X — states extracted from shipping addresses
router.get('/states', protect, logPersonalDataAccess, apiCache(120), async (req, res) => {
  const { createTimer } = require('../utils/core/perfLogger');
  const { dedupeAsync } = require('../utils/core/requestDedupe');
  const timer = createTimer('GET /api/orders/states', tenantClientId(req) || '');
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      timer.finish('403');
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const { getDistinctOrderStates } = require('../utils/commerce/ordersFilterAggregations');
    const states = await timer.time('getDistinctOrderStates', () =>
      dedupeAsync(`orders:states:${clientId}`, () => getDistinctOrderStates(clientId))
    );
    res.json({ success: true, states });
    timer.finish(`200 ok | count=${states?.length ?? 0}`);
  } catch (error) {
    timer.finish(`500 error=${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:clientId/cod-pipeline', protect, verifyTenantScope(), logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId || clientId !== req.params.clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { limit = 50, page = 1 } = req.query;
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 200);
    const skip = (pageNum - 1) * limitNum;

    const query = { clientId, paymentGateway: 'cod' };
    const [orders, total] = await Promise.all([
      Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Order.countDocuments(query)
    ]);

    res.json({ 
      success: true, 
      orders, 
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:clientId/bulk-action', protect, verifyTenantScope(), async (req, res) => {
  try {
    const { clientId } = req.params;
    if (req.user.role !== 'SUPER_ADMIN' && req.user.clientId !== clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { targetOrderIds, action_type, new_status, template_id } = req.body;
    
    if (action_type === 'status_update') {
      await Order.updateMany({ _id: { $in: targetOrderIds }, clientId }, { $set: { status: new_status } });
    } else if (action_type === 'cod_verify') {
      const client = await Client.findOne({ clientId });
      if (client) {
        const { sendForAutomation } = require('../services/templateSender');
        const orders = await Order.find({ _id: { $in: targetOrderIds }, clientId });
        
        for (const order of orders) {
          const isCod = order.paymentMethod?.toLowerCase() === 'cod' || order.isCOD === true;
          if (isCod) {
            order.status = 'verification_pending';
            await order.save();
            const phone = order.customerPhone || order.phone;
            if (phone && client.whatsappToken) {
              try {
                await sendForAutomation({
                  clientId,
                  phone,
                  metaName: 'cod_verification_request',
                  contextType: 'order',
                  contextData: {
                    order: {
                      customerName: order.customerName || 'Customer',
                      orderId: order.orderId || order.orderNumber,
                      orderNumber: order.orderNumber || order.orderId,
                    },
                    extra: {
                      first_name: (order.customerName || 'Customer').split(' ')[0],
                      order_id: order.orderId || order.orderNumber,
                    },
                  },
                });
              } catch (e) {
                console.error('Failed to send COD verification WhatsApp', e.message);
              }
            }
          }
        }
      }
    }
    
    // In a real scenario we'd integrate Shopify updates and WhatsApp sending here

    res.json({ success: true, message: `Bulk ${action_type} executed on ${targetOrderIds.length} orders.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
