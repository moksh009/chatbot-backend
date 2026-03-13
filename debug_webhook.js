const axios = require('axios');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const Client = require('./models/Client');
  const client = await Client.findOne({ clientId: 'topedge_ai' });
  if (!client) {
    console.log("❌ CLIENT 'topedge_ai' NOT FOUND");
    process.exit(0);
  }
  console.log("✅ CLIENT FOUND");
  console.log("clientId:", client.clientId);
  console.log("businessType:", client.businessType);
  console.log("phoneNumberId:", client.phoneNumberId);
  console.log("verifyToken:", client.verifyToken);
  process.exit(0);
}
check();
