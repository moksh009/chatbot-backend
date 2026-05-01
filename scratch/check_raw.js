const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('../models/Client');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const client = await Client.findOne({ clientId: 'choice_salon' });
  console.log('Client:', client.clientId);
  console.log('whatsappToken (raw):', client.whatsappToken);
  process.exit(0);
}
check();
