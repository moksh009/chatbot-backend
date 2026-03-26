const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Client = require('../models/Client');

// Load env vars
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

const defaultAutomationFlows = [
  { id: 'abandoned_cart', isActive: true, config: { delayHours: 2 } },
  { id: 'cod_to_prepaid', isActive: false, config: { delayMinutes: 3, discountAmount: 50, gateway: 'razorpay' } },
  { id: 'review_collection', isActive: false, config: { delayDays: 4 } }
];

const defaultMessageTemplates = [
  {
    id: "cod_to_prepaid",
    body: "Your order #{{order_number}} for *{{product_name}}* is confirmed via COD.\n\n💳 Pay via UPI now and save ₹{{discount_amount}}!\n\nOffer expires in 2 hours.",
    buttons: [{ label: "💳 Pay via UPI" }, { label: "Keep COD" }]
  },
  {
    id: "review_request",
    body: "Hi! How's your *{{product_name}}*? 😊\n\nYour feedback helps us improve and helps other customers!",
    buttons: [{ label: "😍 Loved it!" }, { label: "😐 It's okay" }, { label: "😕 Not happy" }]
  }
];

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(async () => {
    console.log('Connected to MongoDB');
    const clients = await Client.find();
    let updated = 0;

    for (const client of clients) {
        let isModified = false;

        // Ensure automationFlows exist
        if (!client.automationFlows || client.automationFlows.length === 0) {
            client.automationFlows = defaultAutomationFlows;
            isModified = true;
        } else {
             // Merge missing flows
             for (const defaultFlow of defaultAutomationFlows) {
                 if (!client.automationFlows.find(f => f.id === defaultFlow.id)) {
                     client.automationFlows.push(defaultFlow);
                     isModified = true;
                 }
             }
        }

        // Ensure messageTemplates exist
        if (!client.messageTemplates || client.messageTemplates.length === 0) {
             client.messageTemplates = defaultMessageTemplates;
             isModified = true;
        } else {
             // Merge missing templates
             for (const defaultTemp of defaultMessageTemplates) {
                 if (!client.messageTemplates.find(f => f.id === defaultTemp.id)) {
                     client.messageTemplates.push(defaultTemp);
                     isModified = true;
                 }
             }
        }

        if (isModified) {
            await client.save();
            updated++;
        }
    }
    
    console.log(`Migration Complete: ${updated} clients updated.`);
    process.exit(0);
}).catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});
