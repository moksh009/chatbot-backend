const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('./models/Client');

async function verify() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
        if (client) {
            console.log('Client Status:', {
                clientId: client.clientId,
                isGenericBot: client.isGenericBot,
                businessType: client.businessType,
                plan: client.plan
            });

            if (!client.isGenericBot) {
                console.log('Setting isGenericBot to true...');
                client.isGenericBot = true;
                await client.save();
                console.log('Update successful');
            }
        } else {
            console.log('Client delitech_smarthomes not found in DB');
        }

        // Check if WhatsApp wrapper in DualBrainEngine is correct
        const { runDualBrainEngine } = require('./utils/dualBrainEngine');
        console.log('DualBrainEngine loaded successfully');
        
        const WhatsApp = require('./utils/whatsapp');
        console.log('WhatsApp Utility has sendSmartTemplate:', typeof WhatsApp.sendSmartTemplate);

    } catch (err) {
        console.error('Verification Error:', err);
    } finally {
        await mongoose.disconnect();
    }
}

verify();
