const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const restoreLegacy = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('MongoDB connected...');

        const Client = require('../models/Client');

        // Revert these bots to their exact legacy files (delitech_smarthomes.js and choice_salon.js)
        await Client.updateMany(
            { clientId: { $in: ['delitech_smarthomes', 'choice_salon', 'topedge_ai'] } },
            { $set: { isGenericBot: false } }
        );

        console.log('Successfully reverted bots to custom engines!');
        process.exit(0);

    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

restoreLegacy();
