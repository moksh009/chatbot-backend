const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('./models/Client');

dotenv.config();

const verifyToken = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/chatbot_db');
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    
    const clients = await Client.find({}, 'clientId name whatsappToken');
    console.log(`Found ${clients.length} clients:`);
    clients.forEach(c => {
        console.log(`- ID: ${c.clientId}`);
        if (c.whatsappToken) {
            console.log(`  Token Start: ${c.whatsappToken.substring(0, 20)}`);
            console.log(`  Token End:   ${c.whatsappToken.substring(c.whatsappToken.length - 10)}`);
            console.log(`  Full Token (for check): ${c.whatsappToken}`);
        } else {
            console.log('  Token: NONE');
        }
    });

  } catch (error) {
    console.error(`Error: ${error.message}`);
  } finally {
    mongoose.connection.close();
  }
};

verifyToken();
