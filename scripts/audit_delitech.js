const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const Client = require('../models/Client');
const connectDB = require('../db/index');

async function verify() {
    await connectDB();
    console.log('--- Client Audit: delitechsmarthome ---');
    const client = await Client.findOne({ clientId: { $regex: /delitech/i } });
    
    if (!client) {
        console.log('❌ Client NOT FOUND for query: delitech');
        process.exit(1);
    }

    console.log(`✅ Found Client: ${client.clientId}`);
    console.log(`Phone ID: ${client.phoneNumberId}`);
    console.log(`Nodes Count: ${client.flowNodes?.length || 0}`);
    console.log(`Edges Count: ${client.flowEdges?.length || 0}`);
    
    const trigger = client.flowNodes?.find(n => n.type === 'trigger' || n.type === 'TriggerNode');
    if (trigger) {
        console.log(`✅ Trigger Node Found: ID=${trigger.id}`);
        console.log(`   Data: ${JSON.stringify(trigger.data)}`);
    } else {
        console.log(`❌ NO TRIGGER NODE FOUND IN flowNodes!`);
    }

    console.log('--- End Audit ---');
    process.exit(0);
}

verify();
