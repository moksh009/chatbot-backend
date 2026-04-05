const mongoose = require('mongoose');
const Client = require('./models/Client');

async function debug() {
  try {
    await mongoose.connect('mongodb+srv://mokshp15:zNhhX16qfF9q4qAh@cluster0.6c3q0.mongodb.net/chatbot?retryWrites=true&w=majority');
    const client = await Client.findOne({ clientId: 'delitech_smarthomes' });
    if (client) {
      console.log(JSON.stringify({
        clientId: client.clientId,
        plan: client.plan,
        billingPlan: client.billing?.plan,
        tier: client.tier
      }, null, 2));
    } else {
      console.log("NOT_FOUND");
    }
  } catch (e) { console.error(e); }
  process.exit(0);
}
debug();
