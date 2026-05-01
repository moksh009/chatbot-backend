const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('../models/Client');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
  console.log('Client:', client.clientId);
  console.log('shopifyAccessToken (raw):', client.shopifyAccessToken);
  process.exit(0);
}
check();
