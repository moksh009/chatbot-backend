const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Client = require('./models/Client');
  const doc = await Client.findOne({ clientId: 'topedge_ai' });
  if (doc) {
    console.log("Client found:", doc.clientId, doc.businessType, doc.verifyToken);
  } else {
    console.log("Client 'topedge_ai' NOT FOUND in DB.");
  }
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
