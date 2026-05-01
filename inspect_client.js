const mongoose = require('mongoose');
require('dotenv').config();
const Client = require('./models/Client');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
  console.log(JSON.stringify(client, null, 2));
  process.exit(0);
}
run();
