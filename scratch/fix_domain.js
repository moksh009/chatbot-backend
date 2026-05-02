const mongoose = require('mongoose');
const Client = require('../models/Client');
require('dotenv').config();

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');
  
  const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
  if (client) {
    client.shopDomain = '81v3fg-zd.myshopify.com';
    await client.save();
    console.log('✅ Updated delitech_smarthomes to 81v3fg-zd.myshopify.com');
  } else {
    console.log('❌ Client not found');
  }
  
  // Also try to fix topedge_ai if possible
  const topedge = await Client.findOne({ clientId: 'topedge_ai' });
  if (topedge && !topedge.shopDomain) {
     // If we can find a link, parse it
     if (topedge.shopifyInstallLink) {
        // I'll manually parse it here based on what I saw in logs if I can
     }
  }

  await mongoose.disconnect();
}

fix();
