const mongoose = require('mongoose');
const dotenv = require('dotenv');
const AdLead = require('./models/AdLead');
const Order = require('./models/Order');

dotenv.config();

async function checkData() {
    await mongoose.connect(process.env.MONGODB_URI);

    const leadId = "69635d3abda6a32231543594";
    console.log(`Checking lead: ${leadId}`);
    const lead = await AdLead.findById(leadId);
    console.log("Lead linkClicks:", lead ? lead.linkClicks : "Lead Not Found");
    console.log("Lead phone:", lead ? lead.phoneNumber : "N/A");

    if (lead) {
        const orders = await Order.find({
            $or: [
                { phone: lead.phoneNumber },
                { phone: lead.phoneNumber.substring(2) },
                { phone: `+91${lead.phoneNumber.substring(2)}` }
            ]
        });
        console.log("Orders found matching this lead:", orders.length);
        console.log("Orders:", orders);
    } else {
        console.log("Since lead was not found, could not check orders for its phone number.");
    }

    mongoose.disconnect();
}

checkData().catch(err => {
    console.error(err);
    mongoose.disconnect();
});
