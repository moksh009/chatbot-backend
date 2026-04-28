/**
 * LOCAL FLOW TESTER
 * Run: node test_wp_local.js
 */
const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('./models/Client');
const { runDualBrainEngine } = require('./utils/dualBrainEngine');

async function testLocalFlow() {
    try {
        console.log('🚀 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        
        // 1. Find the client we want to test
        const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
        if (!client) {
            console.error('❌ Client delitech_smarthomes not found in DB.');
            return;
        }

        console.log(`✅ Testing for Client: ${client.clientId}`);

        // 2. Mock an incoming WhatsApp message payload
        const mockMessage = {
            from: '919313045439', // Your test number
            phone: '919313045439',
            messageId: 'MOCK_ID_' + Date.now(),
            type: 'text',
            text: { body: 'hi' }, // Change this to 'menu', 'shop', or any keyword to test different paths
            channel: 'whatsapp',
            profileName: 'Test User'
        };

        console.log(`\n--- 📥 Simulating Incoming Message: "${mockMessage.text.body}" ---`);

        // 3. Execute the Engine
        // This will now use the fixed runDualBrainEngine and its helpers
        const handled = await runDualBrainEngine(mockMessage, client);

        console.log('\n--- 🏁 Engine Processing Complete ---');
        console.log('Handled by Engine:', handled ? '✅ YES' : '❌ NO (Passed to legacy/fallback)');

    } catch (err) {
        console.error('\n❌ Critical Test Error:', err.message);
        console.error(err.stack);
    } finally {
        await mongoose.disconnect();
        console.log('\n📡 DB Disconnected.');
    }
}

testLocalFlow();
