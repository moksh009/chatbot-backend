// migrateBirthdays.js
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const BirthdayUser = require('./models/BirthdayUser');

const MONGO_URI = process.env.MONGODB_URI; // place your URI in .env file

async function migrate() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✅ Connected to MongoDB');

    const jsonFilePath = path.join(__dirname, 'birthdays.json');
    const jsonData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf-8'));

    for (const user of jsonData) {
      const exists = await BirthdayUser.findOne({ number: user.number });
      if (!exists) {
        await BirthdayUser.create(user);
        console.log(`✅ Added user: ${user.number}`);
      } else {
        console.log(`ℹ️  Skipped existing user: ${user.number}`);
      }
    }

    console.log('🎉 Migration complete');
    mongoose.disconnect();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    mongoose.disconnect();
  }
}

migrate();
