const crypto = require('crypto');
const mongoose = require('mongoose');
const Client = require('./models/Client');
const { decrypt } = require('./utils/encryption');

async function test() {
  await mongoose.connect('mongodb+srv://mokshp15:zNhhX16qfF9q4qAh@cluster0.6c3q0.mongodb.net/chatbot?retryWrites=true&w=majority');
  const client = await Client.findOne({ shopDomain: '81v3fg-zd.myshopify.com' });
  if (!client) {
    console.log("Client not found for shop 81v3fg-zd.myshopify.com");
    process.exit(1);
  }

  const secretRaw = client.commerce?.shopify?.webhookSecret || client.shopifyWebhookSecret || client.shopifyClientSecret;
  const secret = decrypt(secretRaw);
  console.log("Found Secret (Decrypted):", secret ? "YES (hidden for security)" : "NO");

  if (!secret) {
    console.log("No secret found to test.");
    process.exit(1);
  }

  const bodyContent = JSON.stringify({ test: "webhook" });
  const hmacHeader = crypto
    .createHmac('sha256', secret)
    .update(bodyContent, 'utf8')
    .digest('base64');

  console.log("Simulated Shopify HMAC Header:", hmacHeader);

  // Now simulate the middleware's verification logic
  const middlewareHash = crypto
    .createHmac('sha256', secret)
    .update(bodyContent, 'utf8')
    .digest('base64');

  if (middlewareHash === hmacHeader) {
    console.log("✅ HMAC verification logic SUCCEEDED!");
  } else {
    console.log("❌ HMAC verification logic FAILED!");
  }
  process.exit(0);
}
test().catch(console.error);
