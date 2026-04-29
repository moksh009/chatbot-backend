const mongoose = require('mongoose');
const Client = require('./models/Client');
mongoose.connect('mongodb+srv://mokshpatel73:Xj8kLz9E8n4wP3t@cluster0.6c3q0.mongodb.net/test?retryWrites=true&w=majority', { useNewUrlParser: true, useUnifiedTopology: true }).then(async () => {
  const client = await Client.findOne({});
  console.log('Client ID:', client.clientId);
  console.log('emailUser:', client.emailUser);
  console.log('emailAppPassword exists:', !!client.emailAppPassword);
  process.exit(0);
});
