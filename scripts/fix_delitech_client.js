const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('../models/Client');

// Load env vars
dotenv.config({ path: '../.env' }); // Adjust path if needed

const fixClient = async () => {
  try {
    // Connect to DB
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
        console.error('❌ MONGO_URI is missing in .env');
        process.exit(1);
    }
    
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    const clientId = 'delitech_smarthomes';
    const client = await Client.findOne({ clientId });

    if (!client) {
      console.error(`❌ Client ${clientId} not found!`);
      process.exit(1);
    }

    console.log(`🔍 Found client: ${client.name} (${client._id})`);

    // 1. Fix Business Type (Critical)
    // We can't access 'industry' via Mongoose if it's strict, so we just set businessType
    // But we want to confirm if it was 'ecommerce'
    // Since we are forcing it to 'ecommerce' based on user input, we just set it.
    if (client.businessType !== 'ecommerce') {
        console.log(`⚠️  Updating businessType from '${client.businessType}' to 'ecommerce'`);
        client.businessType = 'ecommerce';
    }

    // 2. Update Subscription Plan (For full dashboard features)
    if (client.subscriptionPlan === 'v1') {
        console.log(`⚠️  Upgrading subscriptionPlan from 'v1' to 'v2'`);
        client.subscriptionPlan = 'v2';
    }

    // 3. Fix Admin Phone (For ved.js notifications)
    // User provided "adminNumbers": ["919879095371"]
    // ved.js looks for client.config.adminPhoneNumber
    const newAdminPhone = "919879095371";
    if (!client.config) client.config = {};
    
    if (client.config.adminPhoneNumber !== newAdminPhone) {
        console.log(`⚠️  Setting config.adminPhoneNumber to '${newAdminPhone}'`);
        // We need to mix existing config with new field
        client.config = {
            ...client.config,
            adminPhoneNumber: newAdminPhone
        };
        client.markModified('config');
    }

    // 4. Add Google Calendar ID (For sync)
    if (!client.googleCalendarId) {
        console.log(`⚠️  Setting googleCalendarId to 'primary'`);
        client.googleCalendarId = 'primary';
    }

    await client.save();
    console.log('✅ Client updated successfully!');
    
    // 5. Verify by fetching lean
    const updated = await Client.findOne({ clientId }).lean();
    console.log('--- Updated Document ---');
    console.log(JSON.stringify(updated, null, 2));

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

fixClient();
