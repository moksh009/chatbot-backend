const mongoose = require('mongoose');
const dotenv = require('dotenv');
const AdLead = require('./models/AdLead');
const Order = require('./models/Order');

dotenv.config();

async function fixData() {
    await mongoose.connect(process.env.MONGODB_URI);

    const leadPhone = "919104245084";
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
            { phone: cleanPhone },
            { phone: `+91${cleanPhone}` }
        ]
    });

    console.log('Orders found:', orders.length);

    let ordersCount = orders.length;
    let totalSpent = orders.reduce((acc, order) => acc + (order.amount || 0), 0);

    let addToCartCount = lead.addToCartCount || 0;
    let checkoutInitiatedCount = lead.checkoutInitiatedCount || 0;

    if (ordersCount > 0) {
        if (addToCartCount === 0) addToCartCount = 1;
        if (checkoutInitiatedCount === 0) checkoutInitiatedCount = 1;
    }

    console.log(`Updating lead to -> ordersCount: ${ordersCount}, totalSpent: ${totalSpent}`);

    const updateObj = {
        $set: {
            ordersCount: ordersCount,
            totalSpent: totalSpent,
            addToCartCount: addToCartCount,
            checkoutInitiatedCount: checkoutInitiatedCount
        }
    };

    await AdLead.findByIdAndUpdate(lead._id, updateObj, { new: true });
    console.log("Lead successfully updated.");

    mongoose.disconnect();
}

fixData().catch(err => {
    console.error(err);
    mongoose.disconnect();
});
