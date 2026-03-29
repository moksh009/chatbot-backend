const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin@cluster0.6c3q0.mongodb.net/codeclinic?retryWrites=true&w=majority&appName=Cluster0';

async function fix() {
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to DB');

    // Find user with name or email containing 'admin' or 'topedge' or 'patel'
    const users = await User.find({
      $or: [
        { email: /patel/i },
        { email: /admin/i },
        { name: /admin/i },
        { name: /topedge/i }
      ]
    });

    if (users.length === 0) {
      console.log('No matching users found.');
      process.exit(0);
    }

    for (const u of users) {
      console.log(`User: ${u.email} | Current Role: ${u.role} | Client: ${u.clientId}`);
      if (u.role !== 'SUPER_ADMIN') {
        u.role = 'SUPER_ADMIN';
        await u.save();
        console.log(`-> ROLE PROMOTED TO SUPER_ADMIN`);
      }
    }

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

fix();
