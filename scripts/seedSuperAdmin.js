const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../models/User'); // Adjust path as needed

// Load environment variables
const path = require('path');
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const seedSuperAdmin = async () => {
  try {
    const emailToUpgrade = process.argv[2];

    if (!emailToUpgrade) {
      console.error('❌ Please provide the email address to upgrade.');
      console.error('Usage: node seedSuperAdmin.js <email>');
      process.exit(1);
    }

    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✅ Connected to MongoDB');

    const user = await User.findOne({ email: emailToUpgrade });

    if (!user) {
      console.error(`❌ User with email ${emailToUpgrade} not found.`);
      process.exit(1);
    }

    user.role = 'SUPER_ADMIN';
    await user.save();

    console.log(`🎉 Success! User ${emailToUpgrade} is now a SUPER_ADMIN.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error upgrading user:', error);
    process.exit(1);
  }
};

seedSuperAdmin();
