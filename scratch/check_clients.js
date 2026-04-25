const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const Client = mongoose.model('Client', new mongoose.Schema({ clientId: String, businessName: String }));

async function checkClients() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const clients = await Client.find({}).lean();
    console.log(JSON.stringify(clients, null, 2));
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

checkClients();
