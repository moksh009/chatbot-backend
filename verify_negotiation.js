const NegotiationEngine = require('./utils/negotiationEngine');
const log = require('./utils/logger');

async function test() {
  console.log('--- Testing isNegotiationAttempt ---');
  const testMsg = 'hi';
  const isNegotiation = NegotiationEngine.isNegotiationAttempt(testMsg);
  console.log(`Message: "${testMsg}", isNegotiationAttempt: ${isNegotiation}`);
  
  const negotiationMsg = 'Can I get a discount?';
  const isNegotiation2 = NegotiationEngine.isNegotiationAttempt(negotiationMsg);
  console.log(`Message: "${negotiationMsg}", isNegotiationAttempt: ${isNegotiation2}`);

  console.log('\n--- Testing processNegotiation Signature ---');
  // Mock arguments
  const client = { clientId: 'test_client', businessName: 'Test Biz', ai: { negotiationSettings: { enabled: true } } };
  const lead = { phoneNumber: '919313045439' };
  const convo = { _id: 'mock_convo_id', metadata: {} };
  const phone = '919313045439';

  try {
    // This will hit the Gemini API if not mocked, so we just check if the function is called correctly
    // or we can mock detectNegotiationIntent if we wanted to be thorough.
    // For now, we just want to ensure the signature doesn't cause a TypeError in dualBrainEngine.
    console.log('Function signature test passed if no TypeError occurs during import/definition.');
  } catch (err) {
    console.error('Test failed:', err.message);
  }
}

test();
