const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('../models/Client');

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/chatbot_db');
    console.log('MongoDB Connected');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
};

const updateSubscriptionPlans = async () => {
  await connectDB();

  try {
    // 1. Set all existing clients to 'v2' (as requested to maintain current functionality)
    // Or you can modify this logic to set specific clients to 'v1'
    const result = await Client.updateMany(
      { subscriptionPlan: { $exists: false } }, // Only update if field is missing
      { $set: { subscriptionPlan: 'v2' } }
    );

    console.log(`✅ Updated ${result.modifiedCount} clients to default subscription plan (v2).`);

    // Example: Manually set a specific client to v1 for testing
    // await Client.updateOne({ clientId: 'some_client_id' }, { $set: { subscriptionPlan: 'v1' } });

  } catch (err) {
    console.error('Error updating subscription plans:', err);
  } finally {
    mongoose.connection.close();
  }
};

updateSubscriptionPlans();
