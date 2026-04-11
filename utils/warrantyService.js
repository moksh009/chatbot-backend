const AdLead = require('../models/AdLead');
const log = require('./logger')('WarrantyService');
const WhatsApp = require('./whatsapp');

/**
 * Automatically assigns warranties based on order line items.
 */
async function assignWarranty(client, phoneNumber, orderData) {
  try {
    const { normalizePhone } = require('./helpers');
    const cleanPhone = normalizePhone(phoneNumber);
    
    const lead = await AdLead.findOne({ phoneNumber: cleanPhone, clientId: client.clientId });
    if (!lead) {
      log.warn(`No lead found for ${cleanPhone} to assign warranty`);
      return;
    }

    const records = [];
    const now = new Date();
    
    for (const item of orderData.line_items) {
      // 1. Determine duration
      let durationStr = client.brand?.warrantyDefaultDuration || "1 Year";
      if (client.brand?.productWarranties?.[item.sku]) {
        durationStr = client.brand.productWarranties[item.sku];
      } else if (client.brand?.productWarranties?.[item.product_id]) {
        durationStr = client.brand.productWarranties[item.product_id];
      }

      // 2. Calculate Expiry
      const expiryDate = calculateExpiry(now, durationStr);
      
      const record = {
        orderId: orderData.name || `#${orderData.id}`,
        serialNumber: `SN-${orderData.id}-${item.variant_id}-${Math.floor(Math.random() * 1000)}`, // Placeholder Serial
        productName: item.title,
        productImage: item.image_url || null,
        purchaseDate: now,
        expiryDate: expiryDate,
        status: 'active',
        registeredAt: now
      };
      
      records.push(record);
    }

    // 3. Save to Lead
    await AdLead.updateOne(
      { _id: lead._id },
      { $push: { warrantyRecords: { $each: records } } }
    );

    log.info(`Assigned ${records.length} warranties to ${cleanPhone}`);

    // 4. Send Notifications
    for (const rec of records) {
      await sendNotifications(client, cleanPhone, rec);
    }

    return records;
  } catch (err) {
    log.error('Failed to assign warranty:', err.message);
  }
}

/**
 * Calculates expiry date based on a starting date and duration string (e.g. "1 Year", "6 Months").
 */
function calculateExpiry(startDate, durationStr) {
  const date = new Date(startDate);
  const amount = parseInt(durationStr);
  const unit = durationStr.toLowerCase();

  if (unit.includes('year')) {
    date.setFullYear(date.getFullYear() + amount);
  } else if (unit.includes('month')) {
    date.setMonth(date.getMonth() + amount);
  } else if (unit.includes('day')) {
    date.setDate(date.getDate() + amount);
  } else {
    // Default 1 year if unparseable
    date.setFullYear(date.getFullYear() + 1);
  }
  return date;
}

/**
 * Dispatches Email and WhatsApp notifications.
 */
async function sendNotifications(client, phone, record) {
  const businessName = client.brand?.businessName || client.businessName || 'Our Store';
  const expiryStr = record.expiryDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  // 1. WhatsApp Notification
  if (client.brand?.warrantyWhatsappEnabled) {
    try {
      // Template: warranty_confirmation
      // Params: {{1}}=Name, {{2}}=Product, {{3}}=Expiry
      const customerName = "Customer"; // Fallback
      await WhatsApp.sendSmartTemplate(
        client,
        phone,
        'warranty_confirmation',
        [customerName, record.productName, expiryStr],
        record.productImage
      );
      log.info(`WhatsApp warranty confirmation sent to ${phone}`);
    } catch (err) {
      log.error(`WhatsApp notification failed for ${phone}:`, err.message);
    }
  }

  // 2. Email Notification
  if (client.brand?.warrantyEmailEnabled && client.adminAlertEmail) {
    // Note: In a real system, we'd use the customer's email from the order data.
    // For this implementation, we'll log it as a stub for the email service.
    log.info(`Email warranty certificate would be sent for ${record.productName}`);
  }
}

module.exports = {
  assignWarranty,
  calculateExpiry
};
