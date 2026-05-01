const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('../models/Client');

async function fixClient() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const clientId = 'delitech_smarthomes';
    const client = await Client.findOne({ clientId });

    if (!client) {
      console.log('Client not found');
      return;
    }

    console.log('Current status:', {
      instagramConnected: client.instagramConnected,
      socialInstagramConnected: client.social?.instagram?.connected
    });

    // Sync fields manually and save
    client.instagramConnected = true;
    
    await client.save();
    
    const updated = await Client.findOne({ clientId });
    console.log('Updated status:', {
      instagramConnected: updated.instagramConnected,
      socialInstagramConnected: updated.social?.instagram?.connected
    });

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fixClient();
