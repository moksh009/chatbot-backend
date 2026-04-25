const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const UnrecognizedPhrase = require('../models/UnrecognizedPhrase');

async function checkPhrases() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected.');

    try {
      await UnrecognizedPhrase.create({
        clientId: 'delitech_smarthomes',
        phrase: 'test phrase from script',
        phoneNumber: '',
        source: 'SIMULATOR',
        status: 'PENDING'
      });
      console.log('Test create successful.');
    } catch (e) {
      console.error('Test create failed:', e.message);
    }

    const phrases = await UnrecognizedPhrase.find({}).lean();
    console.log(`Found ${phrases.length} pending phrases.`);
    console.log(JSON.stringify(phrases, null, 2));

    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

checkPhrases();
