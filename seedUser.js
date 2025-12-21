const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('./models/User');
const connectDB = require('./db');

dotenv.config();

const seedUser = async () => {
  try {
    await connectDB();

    const email = 'admin@codeclinic.com';
    const password = 'password123';

    const userExists = await User.findOne({ email });

    if (userExists) {
      console.log('User already exists');
      process.exit();
    }

    const user = await User.create({
      name: 'Super Admin',
      email,
      password,
      role: 'SUPER_ADMIN',
      clientId: 'code_clinic_v1'
    });

    console.log(`User created: ${user.email} / ${password}`);
    process.exit();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

seedUser();
