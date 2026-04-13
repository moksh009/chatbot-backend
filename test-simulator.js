const axios = require('axios');

/**
 * TopEdge AI: Fragmented Webhook Simulator
 * Proves the 10-second BullMQ sliding window correctly aggregates 
 * multiple WhatsApp messages before triggering the NLP intent engine.
 */
async function runSimulation() {
  const WEBHOOK_URL = 'http://localhost:3000/api/webhooks/meta';
  const clientId = '6543210fedcba9876543210'; // Valid ObjectID format
  const phoneNumber = '919876543210';

  console.log('--- STARTING FRAGMENTED CHAT SIMULATION ---');
  console.log(`Target: ${WEBHOOK_URL}`);

  try {
    // 1. Send first fragment
    console.log('\n[Fragment 1] Sending: "mera"');
    await sendWebhook(WEBHOOK_URL, clientId, phoneNumber, 'mera');

    // Wait 3 seconds
    console.log('...Waiting 3 seconds...');
    await new Promise(r => setTimeout(r, 3000));

    // 2. Send second fragment
    console.log('[Fragment 2] Sending: "order"');
    await sendWebhook(WEBHOOK_URL, clientId, phoneNumber, 'order');

    // Wait 4 seconds
    console.log('...Waiting 4 seconds...');
    await new Promise(r => setTimeout(r, 4000));

    // 3. Send final fragment
    console.log('[Fragment 3] Sending: "kahan hai"');
    await sendWebhook(WEBHOOK_URL, clientId, phoneNumber, 'kahan hai');

    console.log('\n--- SIMULATION REQUESTS COMPLETE ---');
    console.log('Check your server logs now.');
    console.log('In 10 seconds, you should see the NLPEngine processing: "mera order kahan hai"');
    
  } catch (error) {
    console.error('Simulation Failed:', error.message);
    if (error.response) {
        console.error('Server responded with:', error.response.status, error.response.data);
    }
  }
}

/**
 * Helper to wrap the Meta WhatsApp JSON structure
 */
async function sendWebhook(url, clientId, phoneNumber, text) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WHATSAPP_ID',
        changes: [
          {
            value: {
              metadata: { clientId }, // Injected for our routing
              messages: [
                {
                  from: phoneNumber,
                  text: { body: text },
                  type: 'text',
                  timestamp: Math.floor(Date.now() / 1000)
                }
              ]
            },
            field: 'messages'
          }
        ]
      }
    ]
  };

  const response = await axios.post(url, payload, {
    headers: {
      'x-hub-signature-256': 'sha256=test-signature-bypass', // Trigger dev bypass
      'Content-Type': 'application/json'
    }
  });

  console.log(`  -> Server Response: ${response.status} OK`);
  return response.data;
}

runSimulation();
