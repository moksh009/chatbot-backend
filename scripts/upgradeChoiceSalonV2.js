const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('../models/Client');

async function upgradeToV2() {
    try {
        if (!process.env.MONGODB_URI) {
            console.error('❌ MONGODB_URI not found in environment variables.');
            process.exit(1);
        }

        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB.');

        const clientsToUpgrade = ['choice_salon', 'choice_salon_holi'];

        for (const clientId of clientsToUpgrade) {
            console.log(`Processing: ${clientId}...`);
            const client = await Client.findOne({ clientId });

            if (!client) {
                console.log(`⚠️ Client ${clientId} not found in database.`);
                continue;
            }

            client.subscriptionPlan = 'v2';
            await client.save();
            console.log(`✅ Successfully upgraded ${clientId} to subscriptionPlan: v2`);
        }

        console.log('🎉 Upgrade process complete!');

    } catch (error) {
        console.error('❌ Error during upgrade:', error);
    } finally {
        await mongoose.disconnect();
        console.log('MongoDB connection closed.');
        process.exit(0);
    }
}

upgradeToV2();
