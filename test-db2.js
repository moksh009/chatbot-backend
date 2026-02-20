const mongoose = require('mongoose');
const dotenv = require('dotenv');
const AdLead = require('./models/AdLead');
const Order = require('./models/Order');

dotenv.config();

async function checkData() {
    await mongoose.connect(process.env.MONGODB_URI);

    const leadPhone = "919313045439";
    console.log(`Checking lead with phone: ${leadPhone}`);

    const leadMatch = await AdLead.findOne({ phoneNumber: { $regex: new RegExp(`${leadPhone}$`) } });
    if (leadMatch) {
        console.log("Found Lead:");
        console.log("- ID:", leadMatch._id);
        console.log("- Link Clicks:", leadMatch.linkClicks);
        console.log("- Add To Cart Count:", leadMatch.addToCartCount);
        console.log("- Checkout Initiated Count:", leadMatch.checkoutInitiatedCount);
        console.log("- Orders Count:", leadMatch.ordersCount);
        console.log("- Cart Status:", leadMatch.cartStatus);
        console.log("- leadScore:", leadMatch.leadScore);
    } else {
        console.log("No lead found with that phone number.");
    }

    const orders = await Order.find({
        $or: [
            { phone: leadPhone },
            { phone: leadPhone.substring(2) },
            { phone: `+91${leadPhone.substring(2)}` }
        ]
    });

    console.log("Orders found matching phone number:", orders.length);
    orders.forEach(order => {
        console.log("- Order ID:", order.orderId);
        console.log("- Status:", order.status);
        console.log("- Amount:", order.amount);
        console.log("- Phone on Order:", order.phone);
    });

    mongoose.disconnect();
}

checkData().catch(err => {
    console.error(err);
    mongoose.disconnect();
});
