const mongoose = require('mongoose');
const dotenv = require('dotenv');
const AdLead = require('./models/AdLead');
const Order = require('./models/Order');

dotenv.config();

async function fixData() {
    await mongoose.connect(process.env.MONGODB_URI);

    const leadPhone = "919313045439";
    console.log(`Fixing lead with phone: ${leadPhone}`);

    let cleanPhone = leadPhone.replace(/\D/g, '');
    if (cleanPhone.length > 10 && cleanPhone.startsWith('91')) cleanPhone = cleanPhone.substring(2);

    const lead = await AdLead.findOne({ phoneNumber: { $regex: new RegExp(`${cleanPhone}$`) } });

    if (!lead) {
        console.log("Lead not found");
        mongoose.disconnect();
        return;
    }

    const orders = await Order.find({
        $or: [
            { phone: leadPhone },
            { phone: leadPhone.substring(2) },
            { phone: `+91${leadPhone.substring(2)}` }
        ]
    });

    let totalSpent = lead.totalSpent || 0;
    let ordersCount = lead.ordersCount || 0;

    const newActivity = [];

    for (const order of orders) {
        // Avoid duplicate counting
        if (lead.activityLog.some(log => log.details && log.details.includes(order.orderId))) {
            continue;
        }

        ordersCount += 1;
        totalSpent += order.amount;

        const itemNames = order.items.map(i => `${i.quantity}x ${i.name}`).join(', ');

        newActivity.push({
            action: 'order_placed',
            details: `Order ${order.orderId} placed | value: ₹${order.amount} | items: ${itemNames}`,
            timestamp: order.createdAt || new Date(),
            meta: {}
        });
    }

    if (newActivity.length > 0) {
        console.log(`Missing ${newActivity.length} orders on lead. Updating now...`);
        const updateObj = {
            $set: { isOrderPlaced: true, lastInteraction: new Date(), cartStatus: 'purchased' },
            $set: { totalSpent, ordersCount },
            $push: { activityLog: { $each: newActivity } }
        };
        // Patch UI funnel logic
        if (!lead.addToCartCount) updateObj.$inc = { addToCartCount: 1, checkoutInitiatedCount: 1 };

        await AdLead.findByIdAndUpdate(lead._id, updateObj, { new: true });
        console.log("Lead successfully updated.");
    } else {
        console.log("No new missing orders found to link.");
    }

    mongoose.disconnect();
}

fixData().catch(err => {
    console.error(err);
    mongoose.disconnect();
});
