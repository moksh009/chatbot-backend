const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('../models/Client');
const { decrypt } = require('../utils/encryption');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const client = await Client.findOne({ clientId: 'choice_salon' });
  console.log('Client:', client.clientId);
  console.log('whatsappToken:', client.whatsappToken ? (client.whatsappToken.substring(0, 10) + '...') : 'NULL');
  
  const parts = (client.whatsappToken || '').split(':');
  console.log('Is Encrypted Format:', parts.length === 2 && parts[0].length === 32);

  try {
    const decrypted = decrypt(client.whatsappToken);
    console.log('Decryption Status:', decrypted ? 'SUCCESS' : 'FAILED');
  } catch (e) {
    console.log('Decryption crashed');
  }
  process.exit(0);
}
check();
