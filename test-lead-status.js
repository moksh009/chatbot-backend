const mongoose = require('mongoose');
const dotenv = require('dotenv');
const AdLead = require('./models/AdLead');

dotenv.config();

async function checkLead() {
    await mongoose.connect(process.env.MONGODB_URI);

    const lead = await AdLead.findOne({ phoneNumber: { $regex: /919313045439$/ } });
    if (lead) {
        console.log('Lead Found:');
        console.log('cartStatus:', lead.cartStatus);
        console.log('cartSnapshot:', JSON.stringify(lead.cartSnapshot, null, 2));
        console.log('Last Interaction:', lead.lastInteraction);

        const now = new Date();
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

        console.log('--- Cron Query Logic Check ---');
        console.log('Is cartStatus active?', lead.cartStatus === 'active');
        console.log('Does cartSnapshot.items[0] exist?', lead.cartSnapshot && lead.cartSnapshot.items && lead.cartSnapshot.items.length > 0);
        console.log('Is cartSnapshot.updatedAt <= fiveMinutesAgo?', lead.cartSnapshot && new Date(lead.cartSnapshot.updatedAt) <= fiveMinutesAgo);
        console.log(`Current Time: ${now.toISOString()}`);
        console.log(`Five Min Ago: ${fiveMinutesAgo.toISOString()}`);
        console.log(`UpdatedAt:    ${lead.cartSnapshot ? new Date(lead.cartSnapshot.updatedAt).toISOString() : 'N/A'}`);

    } else {
        console.log('Lead not found.');
    }

    mongoose.disconnect();
}

checkLead();
