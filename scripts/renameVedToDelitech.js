const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const migrateVedData = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('MongoDB connected for Data Migration...');

    const collections = ['AdLead', 'Conversation', 'Message', 'Appointment', 'DailyStat', 'Order'];
    
    for (const modelName of collections) {
      const Model = require(`../models/${modelName}`);
      const updateResult = await Model.updateMany(
        { clientId: 'ved' },
        { $set: { clientId: 'delitech_smarthomes' } }
      );
      if (updateResult.modifiedCount > 0) {
        console.log(`Updated ${updateResult.modifiedCount} documents in ${modelName}`);
      }
    }

    console.log('Legacy Data Migration Complete!');
    process.exit(0);

  } catch (error) {
    console.error('Migration Error:', error);
    process.exit(1);
  }
};

migrateVedData();
