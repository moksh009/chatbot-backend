require('dotenv').config();
const mongoose = require('mongoose');
const Message = require('./models/Message');

async function check() {
    await mongoose.connect(process.env.MONGO_URI);
    const msgs = await Message.find({ type: 'interactive' }).sort({ _id: -1 }).limit(10);
    console.log("Recent Interactive Messages:");
    msgs.forEach(m => console.log(`Dir: ${m.direction}, Content: "${m.content}", Raw: ${JSON.stringify(m)}`));
    process.exit(0);
}
check();
