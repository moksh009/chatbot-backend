require('dotenv').config();
const mongoose = require('mongoose');

const Client = require('../models/Client');
const Appointment = require('../models/Appointment');
const AdLead = require('../models/AdLead');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Order = require('../models/Order');

async function run() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB');

        const clientIds = ['choice_salon', 'choice_salon_holi'];

        const collections = [
            { name: 'Appointment', model: Appointment },
            { name: 'AdLead', model: AdLead },
            { name: 'Conversation', model: Conversation },
            { name: 'Message', model: Message },
            { name: 'Order', model: Order }
        ];

        for (const clientId of clientIds) {
            console.log(`\nClearing data for clientId: ${clientId}`);
            for (const col of collections) {
                const result = await col.model.deleteMany({ clientId });
                console.log(`Deleted ${result.deletedCount} documents from ${col.name}`);
            }
        }

        console.log('\nData clearing complete!');
    } catch (error) {
        console.error('Error clearing data:', error);
    } finally {
        await mongoose.disconnect();
        console.log('MongoDB connection closed.');
        process.exit(0);
    }
}

run();
