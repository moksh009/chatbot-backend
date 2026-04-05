const mongoose = require('mongoose');
const Client = require('./models/Client');

async function test() {
  await mongoose.connect('mongodb+srv://mokshp15:zNhhX16qfF9q4qAh@cluster0.6c3q0.mongodb.net/chatbot?retryWrites=true&w=majority', { useNewUrlParser: true, useUnifiedTopology: true });
  const doc = await Client.findOne({ clientId: 'delitech_smarthomes' });
  console.log("clientId:", doc.clientId);
  console.log("Top-level plan:", doc.plan);
  console.log("Billing plan:", doc.billing ? doc.billing.plan : 'none');
  process.exit(0);
}
test().catch(console.error);
