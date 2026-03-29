const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const Client = require('./models/Client');

dotenv.config();

// Use URI from .env
const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin@cluster0.6c3q0.mongodb.net/codeclinic?retryWrites=true&w=majority&appName=Cluster0';

async function check() {
  console.log('Using URI:', MONGO_URI);
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to DB');

    const users = await User.find({});
    console.log('Users found:', users.length);
    users.forEach(u => {
      console.log(`- ${u.email} | Role: ${u.role} | ClientId: ${u.clientId}`);
    });

    const clients = await Client.find({});
    console.log('Clients found:', clients.length);
    clients.forEach(c => {
      console.log(`- ${c.clientId} | ${c.businessName} (ID: ${c._id})`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Connection Error:', err);
    process.exit(1);
  }
}

check();
