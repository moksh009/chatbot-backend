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

const updateClientToken = async () => {
  if (process.argv.length < 3) {
    console.error('Usage: node scripts/update_client_token.js <NEW_WHATSAPP_TOKEN>');
    process.exit(1);
  }

  const newToken = process.argv[2];
  const clientId = 'delitech_smarthomes';

  await connectDB();

  try {
    let client = await Client.findOne({ clientId });

    if (client) {
      client.whatsappToken = newToken;
      await client.save();
      console.log(`✅ Updated WhatsApp token for client: ${clientId}`);
    } else {
      console.log(`❌ Client ${clientId} not found.`);
    }
  } catch (err) {
    console.error('Error updating client token:', err);
  } finally {
    mongoose.connection.close();
  }
};

updateClientToken();
