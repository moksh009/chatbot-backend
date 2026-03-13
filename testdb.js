const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Client = require('./models/Client');
  const doc = await Client.findOne({ clientId: 'topedge_ai' });
  console.log(doc);
  process.exit(0);
}).catch(console.error);
