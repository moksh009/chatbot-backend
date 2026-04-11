const axios = require('axios');

/**
 * Webhook Simulator
 * Tests the 10-second sliding window aggregation logic.
 * Sends 3 fragmented messages over 7 seconds.
 */
async function runSimulation() {
  const url = 'http://localhost:5001/api/webhooks/meta?clientId=test_client_001';
  const phoneNumber = '911234567890';

  console.log('--- STARTING FRAGMENTED MESSAGE SIMULATION ---');

  try {
    // 1. Send "mera"
    console.log('[Step 1] Sending "mera"...');
    await send(url, phoneNumber, 'mera');

    // 2. Wait 3 seconds
    await wait(3000);

    // 3. Send "order"
    console.log('[Step 2] Sending "order"...');
    await send(url, phoneNumber, 'order');

    // 4. Wait 4 seconds
    await wait(4000);

    // 5. Send "kahan hai"
    console.log('[Step 3] Sending "kahan hai"...');
    await send(url, phoneNumber, 'kahan hai');

    console.log('--- SIMULATION COMPLETE ---');
    console.log('Expected behavior: In 10 seconds, the server should log a single processed message: "mera order kahan hai"');
  } catch (error) {
    console.error('Simulation failed:', error.message);
  }
}

async function send(url, phoneNumber, text) {
  return axios.post(url, {
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: phoneNumber,
            type: 'text',
            text: { body: text }
          }]
        }
      }]
    }]
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runSimulation();
