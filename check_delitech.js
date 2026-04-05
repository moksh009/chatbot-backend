const mongoose = require('mongoose');
const Client = require('./models/Client');

async function test() {
  await mongoose.connect('mongodb+srv://mokshp15:zNhhX16qfF9q4qAh@cluster0.6c3q0.mongodb.net/chatbot?retryWrites=true&w=majority');
  const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
  if (client) {
    console.log("Client Found:", client.clientId);
    console.log("Top-level Plan:", client.plan);
    console.log("Billing Sub-doc Plan:", client.billing?.plan);
  } else {
    console.log("Client not found.");
  }
  process.exit(0);
}
test().catch(console.error);
