const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('../models/Client');
const { decrypt } = require('../utils/encryption');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const client = await Client.findOne({ clientId: 'choice_salon' });
  console.log('Instagram Connected:', client.instagramConnected);
  console.log('Token:', client.instagramAccessToken);
  try {
    const decrypted = decrypt(client.instagramAccessToken);
    console.log('Decrypted:', decrypted ? 'SUCCESS' : 'EMPTY');
  } catch (e) {
    console.log('Decryption failed');
  }
  process.exit(0);
}
check();
