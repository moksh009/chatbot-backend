const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../models/User');

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

const updateDelitechUser = async () => {
  await connectDB();

  try {
    const email = 'admin@delitech.com';
    let user = await User.findOne({ email });

    if (user) {
      user.business_type = 'ecommerce';
      await user.save();
      console.log(`Updated ${email} to business_type: ecommerce`);
    } else {
      console.log(`User ${email} not found. Creating...`);
      // Create if not exists (Password: 123456 - make sure to change in prod)
      user = await User.create({
          name: 'Delitech Admin',
          email: email,
          password: 'password123', // Will be hashed by pre-save hook
          role: 'CLIENT_ADMIN',
          business_type: 'ecommerce',
          clientId: 'delitech_smarthomes'
      });
      console.log(`Created ${email} with business_type: ecommerce`);
    }
  } catch (err) {
    console.error('Error updating user:', err);
  } finally {
    mongoose.connection.close();
  }
};

updateDelitechUser();
