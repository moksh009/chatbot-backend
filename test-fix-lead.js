const mongoose = require('mongoose');
const dotenv = require('dotenv');
const AdLead = require('./models/AdLead');

dotenv.config();

async function fixLead() {
    await mongoose.connect(process.env.MONGODB_URI);

    const lead = await AdLead.findOne({ phoneNumber: { $regex: /919313045439$/ } });
    if (lead) {
        console.log('Fixing lead...');
        const now = new Date();
        // Set updatedAt to 6 minutes ago so the cron picks it up IMMEDIATELY 
        // (cron checks <= 5 minutes ago)
        const sixMinutesAgo = new Date(now.getTime() - 6 * 60 * 1000);

        lead.cartStatus = 'active';
        lead.cartSnapshot = {
            handles: ['delitech-smart-wireless-video-doorbell-5mp'],
            titles: ['Delitech Smart Doorbell'],
            items: [{
                variant_id: 123456,
                quantity: 1,
                image: 'https://www.delitech.in/cdn/shop/files/WhatsAppImage2024-03-24at1.25.10PM.jpg',
                url: 'https://www.delitech.in/products/delitech-smart-wireless-video-doorbell-5mp'
            }],
            updatedAt: sixMinutesAgo
        };

        await lead.save();
        console.log('Lead fixed. The cron job should pick this up on its next minute run.');
    } else {
        console.log('Lead not found.');
    }

    mongoose.disconnect();
}

fixLead();
