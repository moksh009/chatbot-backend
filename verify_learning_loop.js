const mongoose = require('mongoose');
const dotenv = require('dotenv');
const NlpEngineService = require('./services/NlpEngineService');
const IntentApiController = require('./controllers/IntentApiController');
const UnrecognizedPhrase = require('./models/UnrecognizedPhrase');
const IntentRule = require('./models/IntentRule');
const Client = require('./models/Client');

dotenv.config();

/**
 * Phase 5 Verification: The Self-Learning Loop
 */
async function runTest() {
  try {
    console.log('--- STARTING SELF-LEARNING LOOP TEST ---');
    
    // 1. Connection
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // 2. Setup Client
    const client = await Client.findOne({ clientId: 'test_client_001' });
    const clientId = client._id;
    const phoneNumber = '919876543210';

    // 3. Simulate low-confidence message (Unknown Pattern)
    console.log('\nSimulating Unknown Pattern: "zxcvbnm query"');
    await UnrecognizedPhrase.deleteMany({ clientId });
    await NlpEngineService.processIncomingText(clientId, phoneNumber, 'zxcvbnm query');

    // 4. Verify Capture
    // Wait a bit for the async creation to finish
    await new Promise(r => setTimeout(r, 1000));
    const captured = await UnrecognizedPhrase.findOne({ clientId, phrase: 'zxcvbnm query' });
    
    if (captured) {
        console.log('✅ SUCCESS: Pattern captured in UnrecognizedPhrase collection.');
    } else {
        console.log('❌ FAILURE: Pattern was not captured.');
        process.exit(1);
    }

    // 5. Setup an Intent to assign to
    const rule = await IntentRule.findOne({ clientId, intentName: 'Greeting' });
    if (!rule) throw new Error('Create Greeting intent first');

    // 6. Trigger Resolution (ASSIGN)
    console.log(`\nResolving Pattern: Assigning to intent "${rule.intentName}"...`);
    const mockReq = {
        user: { clientId },
        body: {
            phraseId: captured._id,
            intentId: rule._id,
            action: 'ASSIGN'
        }
    };
    const mockRes = {
        status: (code) => ({ json: (data) => console.log(`[MockRes] Status: ${code} | Msg: ${data.message}`) })
    };

    await IntentApiController.resolvePhrase(mockReq, mockRes);

    // 7. Verify Final Result
    const updatedRule = await IntentRule.findById(rule._id);
    const updatedPhrase = await UnrecognizedPhrase.findById(captured._id);

    console.log('\nFinal Verification:');
    console.log('Phrase in Training Pool:', updatedRule.trainingPhrases.includes('zxcvbnm query'));
    console.log('Phrase Status:', updatedPhrase.status);

    if (updatedRule.trainingPhrases.includes('zxcvbnm query') && updatedPhrase.status === 'RESOLVED') {
        console.log('\n✅ SUCCESS: Self-Learning Loop closed. AI has learned the new pattern.');
    } else {
        console.log('\n❌ FAILURE: Learning loop integration failed.');
    }

    process.exit(0);
  } catch (err) {
    console.error('Test Error:', err);
    process.exit(1);
  }
}

runTest();
